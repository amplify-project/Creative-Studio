"""Publishes simulated Physiological-Signals data to Redis, same channels and payloads
as the real pipeline, so engagement-bridge-agent can be tested without EmotiBits.

    python simulate.py [redis-url]        # default: $REDIS_URL, else redis://localhost:6379/0

Inside the compose container: docker exec -it agent_engagement_bridge python simulate.py
"""
import json, math, os, random, sys, time
import redis

url = (sys.argv[1] if len(sys.argv) > 1 else None) or os.getenv("REDIS_URL") or "redis://localhost:6379/0"
r = redis.Redis.from_url(url)
DEVICES = [  # serial, base engagement, confirmed by face?
    ("MD-V5-0000334", 0.75, True),
    ("MD-V5-0000412", 0.55, True),
    ("MD-V5-0000588", 0.35, False),
    ("MD-V5-0000901", 0.65, True),
]
t0 = time.time()
print("publishing simulated data for", [d[0] for d in DEVICES], flush=True)
while True:
    t = time.time() - t0
    scores = []
    for i, (serial, base, confirmed) in enumerate(DEVICES):
        eng = max(0.0, min(1.0, base + 0.2 * math.sin(t / 20 + i) + random.uniform(-0.03, 0.03)))
        scores.append(eng)
        now = round(time.time(), 3)
        r.publish(f"device:{serial}:engagement", json.dumps({
            "device": serial, "engagement": round(eng, 4), "confirmed": confirmed,
            "confidence": 0.9 if confirmed else 0.45, "source": "face" if confirmed else "inferred",
            "timestamp": now}))
        r.publish(f"device:{serial}:physio_metrics", json.dumps({
            "device": serial, "timestamp": now, "eda_sd": round(math.sin(t / 15 + i), 3),
            "hr_sd": round(math.cos(t / 18 + i), 3), "calibrating": t < 20,
            "calibration_remaining_s": max(0, round(20 - t)), "baseline_n": int(t)}))
        r.publish(f"device:{serial}:arousal_cont", json.dumps({
            "device": serial, "arousal": round(1 + math.sin(t / 25 + 2 * i), 3), "timestamp": now}))
        r.publish(f"device:{serial}:valence_cont", json.dumps({
            "device": serial, "valence": round(1 + math.cos(t / 30 + i), 3), "timestamp": now}))
    r.publish("engagement_score", f"{sum(scores) / len(scores):.4f}")
    time.sleep(1)
