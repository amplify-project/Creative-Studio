"""Simulated Physiological-Signals data: same channels and payloads as the real
pipeline, so engagement-bridge-agent can be tested without EmotiBits or a camera.

Two ways to use it:
  - ENGAGEMENT_SIMULATE=true on the agent: it generates this data itself, no Redis.
  - python simulate.py [redis-url]: publishes it to Redis, to test the real input
    path (default: $REDIS_URL, else redis://localhost:6379/0).
"""
import json
import math
import os
import random
import sys
import time
from typing import List, Tuple

DEVICES = [  # serial, base engagement, confirmed by face?
    ("MD-V5-0000334", 0.75, True),
    ("MD-V5-0000412", 0.55, True),
    ("MD-V5-0000588", 0.35, False),
    ("MD-V5-0000901", 0.65, True),
]


def messages(t: float) -> List[Tuple[str, str]]:
    """(channel, payload) pairs for one tick, t = seconds since start."""
    out: List[Tuple[str, str]] = []
    scores = []
    now = round(time.time(), 3)
    for i, (serial, base, confirmed) in enumerate(DEVICES):
        eng = max(0.0, min(1.0, base + 0.2 * math.sin(t / 20 + i) + random.uniform(-0.03, 0.03)))
        scores.append(eng)
        out.append((f"device:{serial}:engagement", json.dumps({
            "device": serial, "engagement": round(eng, 4), "confirmed": confirmed,
            "confidence": 0.9 if confirmed else 0.45, "source": "face" if confirmed else "inferred",
            "timestamp": now})))
        out.append((f"device:{serial}:physio_metrics", json.dumps({
            "device": serial, "timestamp": now, "eda_sd": round(math.sin(t / 15 + i), 3),
            "hr_sd": round(math.cos(t / 18 + i), 3), "calibrating": t < 20,
            "calibration_remaining_s": max(0, round(20 - t)), "baseline_n": int(t)})))
        out.append((f"device:{serial}:arousal_cont", json.dumps({
            "device": serial, "arousal": round(1 + math.sin(t / 25 + 2 * i), 3), "timestamp": now})))
        out.append((f"device:{serial}:valence_cont", json.dumps({
            "device": serial, "valence": round(1 + math.cos(t / 30 + i), 3), "timestamp": now})))
    out.append(("engagement_score", f"{sum(scores) / len(scores):.4f}"))
    return out


if __name__ == "__main__":
    import redis

    url = (sys.argv[1] if len(sys.argv) > 1 else None) or os.getenv("REDIS_URL") or "redis://localhost:6379/0"
    r = redis.Redis.from_url(url)
    r.ping()  # fail loudly here rather than silently in a loop
    t0 = time.time()
    print("publishing simulated data to", url.split("@")[-1], "for", [d[0] for d in DEVICES], flush=True)
    while True:
        for channel, payload in messages(time.time() - t0):
            r.publish(channel, payload)
        time.sleep(1)
