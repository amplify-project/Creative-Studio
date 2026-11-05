"""
Engagement visualisation published as a regular, visible room participant.

The bridge agent itself is hidden (and its identity contains "agent", which
the UI filters out). This opens a second connection with identity
`engagement-viz` / name "Engagement" that publishes a camera-like video track,
so the host sees it in the participant list and adds it to the stage with the
existing "add to stage" flow. No frontend changes are needed.

Whatever is on the stage is seen by everyone, so the frame shows only the
crowd average, and per person: name, engagement and arousal level. No
physiological detail.
"""

import asyncio
import logging
import os
import time
from collections import deque
from typing import Optional

from livekit import api, rtc
from PIL import Image, ImageDraw, ImageFont

logger = logging.getLogger("engagement_viz")

VIZ_IDENTITY = os.getenv("ENGAGEMENT_VIZ_IDENTITY", "engagement-viz")
VIZ_NAME = os.getenv("ENGAGEMENT_VIZ_NAME", "Engagement")
VIZ_FPS = float(os.getenv("ENGAGEMENT_VIZ_FPS", "5"))
W, H = 1280, 720
HISTORY_S = 180
MAX_ROWS = 8

BG = (24, 24, 27)
PANEL = (39, 39, 42)
TEXT = (244, 244, 245)
MUTED = (161, 161, 170)
TRACK = (63, 63, 70)


FONT_DIR = os.getenv("ENGAGEMENT_VIZ_FONT_DIR", "/usr/share/fonts/truetype/dejavu")


def _font(size: int, bold: bool = False) -> ImageFont.ImageFont:
    # DejaVu (fonts-dejavu-core in the Dockerfile) covers accents and ñ;
    # Pillow's bundled default font does not.
    try:
        return ImageFont.truetype(os.path.join(FONT_DIR, "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"), size)
    except OSError:
        logger.warning("DejaVu font not found in %s; accented characters will not render", FONT_DIR)
        return ImageFont.load_default(size=size)


F_TITLE, F_BIG, F_ROW, F_SMALL = _font(27, True), _font(92, True), _font(28), _font(20)


def score_color(v: float) -> tuple:
    """Red -> amber -> green for 0..1, matching the vision overlay's bar."""
    v = max(0.0, min(1.0, v))
    if v < 0.5:
        t = v / 0.5
        return (int(239 + (245 - 239) * t), int(68 + (158 - 68) * t), int(68 + (11 - 68) * t))
    t = (v - 0.5) / 0.5
    return (int(245 + (34 - 245) * t), int(158 + (197 - 158) * t), int(11 + (94 - 11) * t))


def arousal_label(a: Optional[float]) -> Optional[str]:
    # Expected value over 3 RF classes (0 low, 1 medium, 2 high).
    if a is None:
        return None
    return "baja" if a < 0.67 else "media" if a < 1.33 else "alta"


class VizPublisher:
    def __init__(self, room: Optional[rtc.Room], state, room_name: Optional[str] = None) -> None:
        # room: the bridge agent's connection (names come from it). None when run
        # standalone (standalone.py): then this connection is the only one.
        self.main_room = room
        self.room_name = room_name or room.name
        self.state = state
        self.room = rtc.Room()
        self.history: deque = deque()
        self._last_crowd_sample = 0.0

    def _token(self) -> str:
        grants = api.VideoGrants(
            room_join=True, room=self.room_name,
            # can_subscribe must stay True: with it off the server never negotiates
            # the subscriber PeerConnection, the SDK waits for it ("wait_pc_connection
            # timed out") and no media flows, though the participant shows up.
            # Nothing is received anyway: the connection uses auto_subscribe=False.
            can_publish=True, can_subscribe=True, can_publish_data=False,
        )
        return (
            api.AccessToken(os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"])
            .with_identity(VIZ_IDENTITY)
            .with_name(VIZ_NAME)
            .with_grants(grants)
            .to_jwt()
        )

    async def run(self) -> None:
        try:
            await self.room.connect(
                os.environ["LIVEKIT_URL"], self._token(), options=rtc.RoomOptions(auto_subscribe=False)
            )
            source = rtc.VideoSource(W, H)
            track = rtc.LocalVideoTrack.create_video_track("engagement", source)
            await self.room.local_participant.publish_track(
                track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_CAMERA)
            )
            logger.info("visualisation published as %s in room %s", VIZ_IDENTITY, self.room_name)

            interval = 1.0 / VIZ_FPS
            while True:
                frame = self.render()
                source.capture_frame(rtc.VideoFrame(W, H, rtc.VideoBufferType.RGBA, frame.tobytes()))
                await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("visualisation stopped")

    async def close(self) -> None:
        try:
            await self.room.disconnect()
        except Exception:
            pass

    # ---------------- rendering ----------------
    def _name(self, entry) -> str:
        ident = entry.get("identity")
        if ident:
            p = (self.main_room or self.room).remote_participants.get(ident)
            return (p.name if p and p.name else ident)[:22]
        return f"Sin asignar · {entry['serial'][-4:]}"

    def _sample_history(self, crowd: Optional[float]) -> None:
        now = time.time()
        if now - self._last_crowd_sample >= 1.0:
            self._last_crowd_sample = now
            self.history.append((now, crowd))
        while self.history and now - self.history[0][0] > HISTORY_S:
            self.history.popleft()

    def render(self) -> Image.Image:
        crowd = self.state.crowd_value()
        self._sample_history(crowd)
        people = [e for e in self.state.entries() if e.get("engagement") is not None and not e["stale"]]
        people.sort(key=lambda e: (e.get("identity") is None, self._name(e).lower()))

        img = Image.new("RGBA", (W, H), BG + (255,))
        d = ImageDraw.Draw(img)

        # --- left: crowd ---
        d.rounded_rectangle((32, 32, 452, H - 32), 20, fill=PANEL)
        d.text((60, 56), "Engagement del grupo", font=F_TITLE, fill=TEXT)
        if crowd is None:
            d.text((60, 150), "—", font=F_BIG, fill=MUTED)
            d.text((60, 270), "Esperando datos…", font=F_SMALL, fill=MUTED)
        else:
            d.text((60, 130), f"{round(crowd * 100)}%", font=F_BIG, fill=score_color(crowd))
            d.rounded_rectangle((60, 260, 424, 278), 9, fill=TRACK)
            d.rounded_rectangle((60, 260, 60 + max(18, int(364 * crowd)), 278), 9, fill=score_color(crowd))

        # sparkline of the last HISTORY_S seconds
        gx0, gy0, gx1, gy1 = 60, 360, 424, H - 90
        d.rectangle((gx0, gy0, gx1, gy1), outline=TRACK)
        d.text((gx0, gy1 + 14), f"últimos {HISTORY_S // 60} min", font=F_SMALL, fill=MUTED)
        now = time.time()
        pts = [
            (gx0 + (gx1 - gx0) * (1 - (now - t) / HISTORY_S), gy1 - (gy1 - gy0) * v)
            for t, v in self.history if v is not None
        ]
        if len(pts) >= 2:
            d.line(pts, fill=score_color(crowd if crowd is not None else 0.5), width=4, joint="curve")

        # --- right: people ---
        x0 = 484
        d.text((x0, 56), "Por persona", font=F_TITLE, fill=TEXT)
        if not people:
            d.text((x0, 130), "Nadie con datos todavía", font=F_ROW, fill=MUTED)
        row_h = 70
        for i, e in enumerate(people[:MAX_ROWS]):
            y = 120 + i * row_h
            v = float(e["engagement"])
            guessed = e.get("confirmed") is False
            d.text((x0, y), self._name(e), font=F_ROW, fill=MUTED if guessed else TEXT)
            bx0, bx1 = x0 + 360, x0 + 600
            d.rounded_rectangle((bx0, y + 8, bx1, y + 26), 9, fill=TRACK)
            col = score_color(v) if not guessed else tuple(int(c * 0.6) for c in score_color(v))
            d.rounded_rectangle((bx0, y + 8, bx0 + max(18, int((bx1 - bx0) * v)), y + 26), 9, fill=col)
            d.text((bx1 + 16, y), f"{round(v * 100)}%", font=F_ROW, fill=TEXT)
            lbl = arousal_label(e.get("arousal"))
            if lbl:
                d.text((x0, y + 36), f"activación {lbl}", font=F_SMALL, fill=MUTED)
        if len(people) > MAX_ROWS:
            d.text((x0, 120 + MAX_ROWS * row_h), f"+{len(people) - MAX_ROWS} más", font=F_SMALL, fill=MUTED)
        return img
