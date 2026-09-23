import asyncio
import json
import logging
import cv2
import numpy as np
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli, WorkerPermissions
from livekit.agents import RoomInputOptions, RoomOutputOptions
import mediapipe as mp
from agent_data import AgentData


logger = logging.getLogger("hand_zoom_agent")
logger.setLevel(logging.INFO)
load_dotenv(".env.local")

# ---------- Config ----------
ROOM_NAME = "test"
AGENT_IDENTITY = "zoom-agent"

# MediaPipe instances are created PER track inside process_video — the class
# is not thread-safe internally, so a global instance shared by multiple
# concurrent tasks races and produces incoherent bboxes.

# MediaPipe is robust at low resolution; running it at the source resolution
# (often 1080p) is wasted CPU. Downsample to ~480p wide before .process()
# and keep landmark coords in the normalized [0, 1] space they already use.
MP_SMALL_WIDTH = 480

# Process 1 in N frames. At 30 fps source this gives 10 detection fps —
# enough to feel smooth once the client interpolates between updates.
FRAME_DECIMATION = 3

# How aggressively the agent smooths its own target bbox. Even with client-side
# easing on top, a small EMA here rejects single-frame MediaPipe jitter at the
# source so the target sent to the client doesn't oscillate.
BBOX_EMA_ALPHA = 0.35

# Zoom factor applied to the union of hand landmarks before sending. Combined
# with the client-side 10% padding, the singer can gesticulate freely.
HAND_ZOOM_FACTOR = 1.0


def smooth_bbox(current, target, alpha=BBOX_EMA_ALPHA):
    if current is None:
        return target
    return [current[i] + alpha * (target[i] - current[i]) for i in range(4)]


# ---------- Agent ----------
class HandZoomAgent(Agent):
    def __init__(self):
        super().__init__(instructions="Detect hands and send bbox zoom info.")
        self.room: rtc.Room | None = None
        self.active_tasks: dict[str, asyncio.Task] = {}
        self.video_tracks: dict[str, rtc.VideoStream] = {}
        self.audio_tracks: dict[str, rtc.AudioStream] = {}
       
    def attach_room(self, room: rtc.Room):
        self.room = room

    async def send_hand_info(self, bbox, track_id: str):
        # Bbox values are in normalized [0, 1] coords so the client can apply
        # them against whatever video resolution it currently has. Critical
        # for simulcast: the agent typically receives a low-res layer while
        # the client in pin mode receives a high-res one — pixel coords from
        # the agent would land in the wrong place on the client.
        payload = {
            "type": "event",
            "name": "zoom",
            "args": {
                "track_id": track_id,
                "hands": [{"bbox": [round(float(v), 4) for v in bbox]}],
            },
        }
        await self.room.local_participant.publish_data(
            json.dumps(payload).encode("utf-8"),
            reliable=False,
            topic="cmd",
        )

    async def send_no_hands(self, track_id: str):
        """Tell the client this track currently has no detected hands so it
        can start its zoom-out easing. Idempotent on the client side: a re-send
        just resets the hysteresis timer to the current moment."""
        payload = {
            "type": "event",
            "name": "zoom",
            "args": {"track_id": track_id, "hands": []},
        }
        await self.room.local_participant.publish_data(
            json.dumps(payload).encode("utf-8"),
            reliable=False,
            topic="cmd",
        )

    async def process_video(self, track: rtc.Track, track_id: str):
        # Per-track MediaPipe instance. The Hands class is not thread-safe
        # internally, so sharing one across concurrent tasks (multiple targets
        # zooming at the same time) races and produces incoherent bboxes.
        hands_detector = mp.solutions.hands.Hands(
            max_num_hands=2,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.7,
        )
        video_stream = rtc.VideoStream(track)
        try:
            frame_counter = 0
            current_bbox = None
            had_detection = False  # track edge: detection → no detection
            logger.info(f"[{track_id}] Starting video processing")

            async for event in video_stream:
                frame_counter += 1
                if frame_counter % FRAME_DECIMATION != 0:
                    continue

                frm = event.frame

                # ---------------- Frame conversion ----------------
                try:
                    f2 = frm.convert(rtc.VideoBufferType.RGB24)
                    rgb = np.frombuffer(f2.data, dtype=np.uint8).reshape(
                        (f2.height, f2.width, 3)
                    )
                    h_mp, w_mp = rgb.shape[:2]
                except Exception as e:
                    logger.error(f"[{track_id}] Frame conversion error: {e}")
                    continue

                # ---------------- Downsample for MediaPipe ----------------
                # Landmarks come back normalized to [0, 1] regardless of input
                # resolution, so we can use w_mp/h_mp directly for bbox math
                # without re-scaling. ~5× CPU saving at 1080p input.
                if w_mp > MP_SMALL_WIDTH:
                    scale = MP_SMALL_WIDTH / w_mp
                    small = cv2.resize(
                        rgb,
                        (MP_SMALL_WIDTH, int(h_mp * scale)),
                        interpolation=cv2.INTER_AREA,
                    )
                else:
                    small = rgb

                # ---------------- MediaPipe ----------------
                results = hands_detector.process(small)
                target_bbox = None

                if results.multi_hand_landmarks:
                    # MediaPipe landmarks are already normalized to [0, 1].
                    # We stay in that space all the way through so the client
                    # can map to its own video resolution (which differs from
                    # the agent's under simulcast).
                    xs = [lm.x for hand in results.multi_hand_landmarks for lm in hand.landmark]
                    ys = [lm.y for hand in results.multi_hand_landmarks for lm in hand.landmark]

                    x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
                    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
                    w, h = (x2 - x1) * HAND_ZOOM_FACTOR, (y2 - y1) * HAND_ZOOM_FACTOR

                    x1 = max(0.0, cx - w / 2)
                    y1 = max(0.0, cy - h / 2)
                    x2 = min(1.0, cx + w / 2)
                    y2 = min(1.0, cy + h / 2)

                    target_bbox = [x1, y1, x2, y2]

                # ---------------- Smooth + emit ----------------
                if target_bbox is not None:
                    current_bbox = smooth_bbox(current_bbox, target_bbox)
                    await self.send_hand_info(current_bbox, track_id)
                    had_detection = True
                else:
                    # Edge: detection → no detection. Notify the client ONCE
                    # so it starts its zoom-out hysteresis. Subsequent silent
                    # frames don't re-emit — saves data channel bandwidth and
                    # the client's hysteresis timer already tracks freshness.
                    if had_detection:
                        await self.send_no_hands(track_id)
                        had_detection = False
                    current_bbox = None

        except asyncio.CancelledError:
            logger.info(f"[{track_id}] Task cancelled")
        except Exception as e:
            logger.error(f"[{track_id}] Error in video processing: {e}")
        finally:
            await video_stream.aclose()
            hands_detector.close()
            logger.info(f"[{track_id}] Video processing ended")

    async def handle_message(self, msg: str):
        try:
            logger.info(f"Agent data received: {msg}")
            agent_data = AgentData.from_json(msg)
            logger.info(f"Agent data received: {msg}")
            if (agent_data.name !="zoom"):
                 return
            if agent_data.payload["command"] == "enable":
                track_id = agent_data.payload["track_id"]

                if track_id not in self.active_tasks:
                    logger.info(f"Enabling video processing for track {track_id}")
                    track = self.video_tracks.get(track_id)
                    if track:
                        task = asyncio.create_task(self.process_video(track, track_id))
                        self.active_tasks[track_id] = task

                # 🔥 Emitir evento al cliente en formato estándar
                await self.room.local_participant.publish_data(
                    agent_data.to_event_json().encode("utf-8"),
                    reliable=True,
                    topic="cmd",   # usa el mismo CMD_TOPIC que el cliente
                )
            elif agent_data.payload["command"] == "disable":
                track_id = agent_data.payload["track_id"]
                logger.info(f"Disabling processing for track {track_id}")
                if track_id in self.active_tasks:
                    self.active_tasks[track_id].cancel()
                    del self.active_tasks[track_id]

        except Exception as e:
            logger.error(f"Error processing message: {e}")


## Job request filter

# async def request_fnc(req: JobRequest):
#     # accept the job request
#     await req.accept(
#         # the agent's name (Participant.name), defaults to ""
#         name="",

#     )

# ---------- Entrypoint ----------
async def entrypoint(ctx: JobContext):
    logger.info(f"[zoom-agent] entrypoint START — job={ctx.job.id if ctx.job else 'no-job'} room={ctx.room.name if ctx.room else '?'}")
    await ctx.connect()
    room = ctx.room
    logger.info(f"[zoom-agent] connected to room '{room.name}' — waiting for tracks + data")

    session = AgentSession()
    agent = HandZoomAgent()
    agent.attach_room(room)

    await session.start(
        agent=agent,
        room=room,
        room_input_options=RoomInputOptions(audio_enabled=False, text_enabled=False,close_on_disconnect=False),
        room_output_options=RoomOutputOptions(audio_enabled=False, transcription_enabled=False),
    )

    @room.on("track_subscribed")
    def _on_track_subscribed(track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant):
        if track.kind == rtc.TrackKind.KIND_VIDEO:
            agent.video_tracks[pub.sid] = track
            logger.info(f"Video track saved: {pub.sid}")

    @room.on("track_unsubscribed")
    def _on_track_unsubscribed(track: rtc.Track, pub: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant):
        if track.kind == rtc.TrackKind.KIND_VIDEO:
            if pub.sid in agent.active_tasks:
                    logger.info(f"Removing task {agent.active_tasks}")
                    agent.active_tasks[pub.sid].cancel()
                    del agent.active_tasks[pub.sid]
            del agent.video_tracks[pub.sid]
            logger.info(f"Video track removed: {pub.sid}")

    @room.on("data_received")
    def _on_data(pkt: rtc.DataPacket):
        async def _handle():
            try:
                msg = pkt.data.decode("utf-8")
                await agent.handle_message(msg)
            except Exception:
                logger.exception("Error processing data packet")
        asyncio.create_task(_handle())

if __name__ == "__main__":
    opts = WorkerOptions(entrypoint_fnc=entrypoint, permissions=WorkerPermissions(
        can_publish=True,
        can_subscribe=True,
        hidden=True,),agent_name=AGENT_IDENTITY)
    opts.port = 0
    cli.run_app(opts)
