import asyncio
import logging
import os
import sys
import time
import numpy as np
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent, AgentSession, JobContext,
    WorkerOptions, cli, WorkerPermissions,
    RoomInputOptions, RoomOutputOptions
)
from agent_data import AgentData
from db import DB  # <-- nuestro módulo

# ---------------- Logging ----------------
logger = logging.getLogger("pose_gaze_agent")
logging.basicConfig(level=logging.INFO)

# ---------------- Env ----------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(BASE_DIR)
if PARENT_DIR not in sys.path:
    sys.path.insert(0, PARENT_DIR)

ENV_PATH = os.path.join(BASE_DIR, ".env.local")
load_dotenv(ENV_PATH, override=True)

# ---------------- Config ----------------
AGENT_IDENTITY = "pose-gaze-agent"

POSE_FPS = 10.0
FACE_FPS = 10.0
POSE_INTERVAL = 1.0 / POSE_FPS
FACE_INTERVAL = 1.0 / FACE_FPS
DOWNSCALE_WIDTH = 640

ENABLE_VIDEO_PROCESSING = os.getenv("ENABLE_VIDEO_PROCESSING", "false").lower() in {"1", "true", "yes", "on"}

if ENABLE_VIDEO_PROCESSING:
    import mediapipe as mp
else:
    mp = None

logger.info(
    "Feature flags: video=%s",
    ENABLE_VIDEO_PROCESSING,
)

# ---------------- Utils ----------------
def normalize_vector(v: np.ndarray):
    n = np.linalg.norm(v)
    return (v / n) if n > 0 else v


def resize_rgb_nearest(img: np.ndarray, new_width: int, new_height: int) -> np.ndarray:
    """Resize RGB image using nearest-neighbor sampling without OpenCV."""
    src_h, src_w = img.shape[:2]
    if src_w == new_width and src_h == new_height:
        return img

    x_idx = np.linspace(0, src_w - 1, new_width).astype(np.int32)
    y_idx = np.linspace(0, src_h - 1, new_height).astype(np.int32)
    return img[y_idx[:, None], x_idx]

# ---------------- Agent ----------------
class PoseGazeAgent(Agent):
    job_type = "participant"

    def __init__(self):
        super().__init__(instructions="Detect pose and gaze and store results.")
        self.room: rtc.Room | None = None
        self.active_tasks: dict[str, asyncio.Task] = {}
        self.db: DB | None = None

    def attach_room(self, room: rtc.Room):
        self.room = room
        room_dir = os.path.join("data", room.name)
        self.db = DB(room_dir)
        logger.info(f"Room DB initialized: {self.db.path}")

    # -------- main processing --------
    async def process_video(self, track: rtc.Track, track_id: str, show_debug: bool = False):
        mp_pose = mp.solutions.pose.Pose(
            static_image_mode=False,
            model_complexity=1,
            smooth_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.7
        )
        mp_face = mp.solutions.face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.7
        )

        video_stream = rtc.VideoStream(track)

        last_pose_ts = 0.0
        last_face_ts = 0.0

        logger.info(f"[{track_id}] Video processing started")

        try:
            async for event in video_stream:
                now = time.monotonic()
                do_pose = (now - last_pose_ts) >= POSE_INTERVAL
                do_face = (now - last_face_ts) >= FACE_INTERVAL

                frm = event.frame
                try:
                    f2 = frm.convert(rtc.VideoBufferType.BGRA)
                    bgra = np.frombuffer(f2.data, dtype=np.uint8).reshape((f2.height, f2.width, 4))
                    rgb = bgra[:, :, :3]
                except Exception:
                    continue

                if DOWNSCALE_WIDTH and f2.width > DOWNSCALE_WIDTH:
                    scale = DOWNSCALE_WIDTH / f2.width
                    down_w = int(f2.width * scale)
                    down_h = int(f2.height * scale)
                    rgb = resize_rgb_nearest(rgb, down_w, down_h)

                # ---- empty record every frame ----
                record = {
                    "ts": now,
                    "track_id": track_id,
                    "pose_detected": False,
                    "face_detected": False,
                    "pose_landmarks": None,
                    "head_xy": None,
                    "gaze_vector": None,
                }

                # ---- POSE inference ----
                if do_pose:
                    pose_res = mp_pose.process(rgb)
                    last_pose_ts = now
                    if pose_res.pose_landmarks:
                        record["pose_detected"] = True
                        record["pose_landmarks"] = [
                            {"x": lm.x, "y": lm.y, "z": lm.z}
                            for lm in pose_res.pose_landmarks.landmark
                        ]

                # ---- FACE inference ----
                if do_face:
                    face_res = mp_face.process(rgb)
                    last_face_ts = now
                    if face_res.multi_face_landmarks:
                        record["face_detected"] = True
                        face = face_res.multi_face_landmarks[0]

                        w, h = rgb.shape[1], rgb.shape[0]
                        left_eye = np.array([
                            face.landmark[474].x * w,
                            face.landmark[474].y * h,
                            face.landmark[474].z * w,
                        ])
                        right_eye = np.array([
                            face.landmark[469].x * w,
                            face.landmark[469].y * h,
                            face.landmark[469].z * w,
                        ])
                        nose = np.array([
                            face.landmark[1].x * w,
                            face.landmark[1].y * h,
                            face.landmark[1].z * w,
                        ])

                        record["head_xy"] = {"x": float(nose[0]/w), "y": float(nose[1]/h)}
                        record["gaze_vector"] = normalize_vector((left_eye+right_eye)/2 - nose).tolist()

                # ---- store in DB ----
                if self.db:
                    logger.info("PRINTING RECORD: %s", record)
                    self.db.store_pose(record)

        except asyncio.CancelledError:
            logger.info(f"[{track_id}] Task cancelled")
        finally:
            await video_stream.aclose()
            mp_pose.close()
            mp_face.close()
            logger.info(f"[{track_id}] Processing finished")

# ---------------- Entrypoint ----------------
async def entrypoint(ctx: JobContext):
    await ctx.connect()
    room = ctx.room

    session = AgentSession()
    agent = PoseGazeAgent()
    agent.attach_room(room)

    @room.on("track_subscribed")
    def on_track_subscribed(track: rtc.Track, pub, participant):
        track_key = pub.sid
        if track_key in agent.active_tasks:
            return

        if track.kind == rtc.TrackKind.KIND_VIDEO:
            if not ENABLE_VIDEO_PROCESSING:
                logger.info("[%s] Skipping video track because ENABLE_VIDEO_PROCESSING is disabled", track_key)
                return
            task = asyncio.create_task(agent.process_video(track, track_key))
        elif track.kind == rtc.TrackKind.KIND_AUDIO:
            logger.info("[%s] Ignoring audio track in visual worker", track_key)
            return
        else:
            return

        agent.active_tasks[track_key] = task

    @room.on("track_unsubscribed")
    def on_track_unsubscribed(track: rtc.Track, pub, participant):
        task = agent.active_tasks.pop(pub.sid, None)
        if task:
            task.cancel()

    @room.on("data_received")
    def _on_data(pkt: rtc.DataPacket):
        if pkt.topic != "cmd":
            return

        async def _handle():
            try:
                msg = pkt.data.decode("utf-8")
                data = AgentData.from_json(msg)
            except Exception:
                return

            if data.name != "layout_snapshot":
                return

            snapshot = data.payload
            if snapshot and agent.db:
                snapshot["ts_recv"] = time.monotonic()
                agent.db.store_layout(snapshot)
                logger.info(f"layout_snapshot stored in room {room.name}")

        asyncio.create_task(_handle())

    await session.start(
        agent=agent,
        room=room,
        room_input_options=RoomInputOptions(audio_enabled=True, text_enabled=False, close_on_disconnect=True),
        room_output_options=RoomOutputOptions(audio_enabled=False, transcription_enabled=False)
    )

# ---------------- Main ----------------
if __name__ == "__main__":
    opts = WorkerOptions(
        entrypoint_fnc=entrypoint,
        permissions=WorkerPermissions(can_publish=True, can_subscribe=True, hidden=True),
        agent_name=AGENT_IDENTITY
    )
    opts.port = 0
    opts.worker_count = 1
    opts.max_jobs_per_worker = 1
    cli.run_app(opts)
