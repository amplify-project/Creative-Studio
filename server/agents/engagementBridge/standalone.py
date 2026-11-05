#!/usr/bin/env python3
"""
Standalone: put the "Engagement" visualisation into a room, nothing else.

Runs on the concert PC next to the Physiological-Signals Redis. Joins the room
as the visible participant "Engagement" and publishes the visualisation video;
the host adds it to the stage like any camera. No agent dispatch, no web app
changes, nothing in the cloud.

    pip install -r requirements.txt
    python standalone.py --room <room-name>             # reads redis://localhost:6379/0
    python standalone.py --room <room-name> --simulate  # fake data, no Redis

Needs LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET (env or .env.local).
Pulseras show as "Sin asignar · <serial>": there is no host binding here.
Don't run it while the cloud engagement-bridge-agent is enabled for the same
room: both would publish as "engagementviz".
"""

import argparse
import asyncio
import logging
import os

from dotenv import load_dotenv

load_dotenv(".env.local")


async def main(args) -> None:
    # Imported after argument parsing so REDIS_URL / --simulate are in place.
    import agent
    from viz import VizPublisher

    bridge = agent.EngagementBridge(room=None)  # only its state and input loops are used
    source = bridge.simulate_loop() if args.simulate else bridge.redis_loop()
    viz = VizPublisher(None, bridge.state, room_name=args.room)
    tasks = [asyncio.create_task(source), asyncio.create_task(viz.run())]
    try:
        # viz.run() returns only if the LiveKit connection fails; stop then.
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        await viz.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--room", required=True, help="LiveKit room name (the Creative Studio session id)")
    p.add_argument("--redis", help="Physiological-Signals Redis (default: $REDIS_URL or redis://localhost:6379/0)")
    p.add_argument("--simulate", action="store_true", help="fake data for 4 pulseras, no Redis")
    args = p.parse_args()
    if args.redis:
        os.environ["REDIS_URL"] = args.redis
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
                        datefmt="%H:%M:%S")
    for k in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
        if not os.getenv(k):
            p.error(f"{k} is not set (env or .env.local)")
    try:
        asyncio.run(main(args))
    except KeyboardInterrupt:
        pass
