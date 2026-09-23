import os
import asyncio
import cv2
import logging
import numpy as np
import mediapipe as mp
import subprocess
import datetime
from livekit import rtc
from livekit.api import AccessToken, VideoGrants

# ---------------- Configuración ----------------
WHIP_URL = os.environ.get('WHIP_URL', 'https://localhost/ingress/w/<stream key>')
WIDTH, HEIGHT = 1280, 720
FPS = 25
LIVEKIT_URL = "wss://livekit.local/live"
TARGET_W, TARGET_H = 1280, 720
# Credentials come from the environment (server/.env), never from source.
API_KEY = os.environ["LIVEKIT_API_KEY"]
API_SECRET = os.environ["LIVEKIT_API_SECRET"]
ROOM_NAME = "i7i1-v0o4"
AGENT_IDENTITY = "agent_zoom"

# ffmpeg para enviar a WHIP
ffmpeg_cmd = [
    'ffmpeg',
    '-y',
    '-re',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-f', 'rawvideo',
    '-pix_fmt', 'bgr24',
    '-s', f'{WIDTH}x{HEIGHT}',
    '-r', str(FPS),
    '-i', '-',  # stdin video
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=48000',
    '-ac', '2',
    '-c:v', 'h264_nvenc',
    '-preset', 'p4',
    '-tune', 'ull',
    '-pix_fmt', 'yuv420p',
    '-g', '30',
    '-bf', '0',
    '-c:a', 'libopus',
    '-b:a', '96k',
    '-f', 'whip',
    '-handshake_timeout', '10000',
    WHIP_URL
]
ffmpeg = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE)

# MediaPipe Hands (opcional, lo puedes volver a meter después)
mp_hands = mp.solutions.hands.Hands(
    max_num_hands=2,
    min_detection_confidence=0.5,
    min_tracking_confidence=0.5
)

def i420_to_bgr(data, width, height):
    y_size = width * height
    uv_size = (width // 2) * (height // 2)
    y = np.frombuffer(data[0:y_size], dtype=np.uint8).reshape((height, width))
    u = np.frombuffer(data[y_size:y_size+uv_size], dtype=np.uint8).reshape((height//2, width//2))
    v = np.frombuffer(data[y_size+uv_size:], dtype=np.uint8).reshape((height//2, width//2))
    u_up = cv2.resize(u, (width, height), interpolation=cv2.INTER_LINEAR)
    v_up = cv2.resize(v, (width, height), interpolation=cv2.INTER_LINEAR)
    yuv = cv2.merge([y, u_up, v_up])
    return cv2.cvtColor(yuv, cv2.COLOR_YUV2BGR)

async def receive_frames(stream: rtc.VideoStream):
    async for frame in stream:
        frm = frame.frame
        bgr = i420_to_bgr(frm.data, frm.width, frm.height)
        
        try:
            ffmpeg.stdin.write(bgr.tobytes())
        except BrokenPipeError:
            print("FFmpeg cerró la tubería")
            break

async def main():
    grant = VideoGrants(room=ROOM_NAME, agent=True, can_subscribe=True, room_join=True)
    at = AccessToken(API_KEY, API_SECRET).with_grants(grants=grant).with_identity(AGENT_IDENTITY)
    at = at.with_ttl(datetime.timedelta(hours=1))
    token = at.to_jwt()
    print("Token generado:", token)

    room = rtc.Room()

    @room.on("track_subscribed")
    def on_track_subscribed(track: rtc.Track, publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant):
        logging.info("track subscribed: %s", publication.sid)
        if track.kind == rtc.TrackKind.KIND_VIDEO:
            video_stream = rtc.VideoStream(track)
            asyncio.ensure_future(receive_frames(video_stream))

    await room.connect(LIVEKIT_URL, token)
    print(f"Conectado a la sala {ROOM_NAME}")
    await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
