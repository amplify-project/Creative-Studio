# Engagement bridge — Physiological-Signals on the stage

> **Experimental, branch `feature/pilot2`, not merged. It may not be used.**
> Built and tested 2026-11-05. Everything lives in
> `server/agents/engagementBridge/` plus three small, opt-in hooks
> (`app/api/token/route.ts`, `app/api/setupAgent/route.tsx`,
> `server/docker-compose.yaml`). With `ENGAGEMENT_AGENT_ENABLED` unset and the
> compose profile off, the branch behaves exactly like `main`.

## What it is

[Physiological-Signals](https://github.com/amplify-project/Physiological-Signals)
estimates audience engagement from a camera (pose + a trained transformer) and
reads EmotiBit wristbands (EDA, heart rate, temperature → valence/arousal). It
publishes everything to a **local Redis** on the concert PC. This branch puts
that information into a Creative Studio room as a **video tile, "Engagement"**,
that the host adds to the stage like any camera.

```
Physiological-Signals ──► Redis (concert PC) ──► standalone.py ──► LiveKit room ──► host adds "Engagement" to the stage
 (camera + EmotiBits)                             (concert PC)      (cloud)
```

The tile shows the crowd average with a 3-minute sparkline and, per person,
name, engagement and arousal level (baja/media/alta). **No physiological
detail**: whatever is on the stage is seen by everyone.

## Three ways to run it

| Mode | Command | Needs | Use |
|---|---|---|---|
| **Standalone** (recommended) | `python standalone.py --room <room>` | the concert PC reaching LiveKit | Only the stage tile. No dispatch, no web app or cloud changes. |
| Standalone, simulated | `python standalone.py --room <room> --simulate` | nothing else | Demo / test without Physiological-Signals. |
| Dispatched agent | `python agent.py start` + `ENGAGEMENT_AGENT_ENABLED=true` on the web app | the web app rebuilt | Adds data messages on topic `engagement` (per-person, filtered by role) and host-only serial→participant binding (`engagement/bind`). No UI consumes them yet. |

The agent connects **outbound** to LiveKit, so it runs on the concert PC
behind NAT; nothing has to run in the cloud. The compose service
`engagement_bridge` (profile `engagement`) exists only for the case where that
Redis is reachable from the cloud host, and was used as a test stand-in.

Full protocol, environment variables and payloads:
`server/agents/engagementBridge/README.md`.

## Running it on the concert PC (Linux paths)

```bash
# 1. Redis (Physiological-Signals ships redis-server.exe for Windows only)
docker run -d --rm -p 6379:6379 --name redis redis:7

# 2. Physiological-Signals, in ITS venv
cd ~/projects/Physiological-Signals/Handover_Oct-Dec_Concerts
source ../.venv/bin/activate
export QT_QPA_PLATFORM_PLUGIN_PATH=$(python -c "import cv2,os;print(os.path.join(os.path.dirname(cv2.__file__),'qt','plugins'))")
python live_multiperson_binary_v2.py --camera 0 --redis-host 127.0.0.1 --no-discover   # + --no-face-id without wristbands

# 3. The bridge, in a SEPARATE venv (see traps)
cd ~/projects/amplify/Creative-Studio/server/agents/engagementBridge
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python standalone.py --room <room>     # LiveKit creds from .env.local
```

`<room>` is the session id (the LiveKit room name). Check reachability first:
`curl https://<domain>/live/` must answer `OK`.

## What was verified

- Agent logic (bindings, role filtering, snapshots, no-op when unchanged): 6
  tests against a real Redis with a fake room.
- **End to end with their real software**: Handover vision pipeline on a
  concert video and on a webcam → Redis → `standalone.py` → a local LiveKit
  server → a subscriber received the 1280×720 frames with the live crowd score.
- In the production cloud: the tile appeared and could be added to the stage
  (simulated data).
- **Not verified**: per-person rows with real EmotiBits and enrolled faces.
  Physiological-Signals publishes `device:{serial}:engagement` only for
  face-registered wristband wearers, so without them the tile shows the crowd
  score and "Nadie con datos todavía".

## Traps found (worth knowing even if this is never used)

- **`can_subscribe=False` breaks publishing.** With it off the server never
  negotiates the subscriber PeerConnection; the Python SDK waits for it
  (`wait_pc_connection timed out`) and no media flows, though the participant
  shows up. Keep `can_subscribe=True` and use `auto_subscribe=False` instead.
- **Participant identities must not contain `-`.** `ParticipantList` and
  `useTracksByUser` group by `identity.split("-")[0]` (the
  `<base>-secondary-…` convention for extra cameras). `engagement-viz` was read
  as a secondary camera of a non-existent user and could not be staged; it is
  now `engagementviz`.
- **Identities containing `agent` are hidden** by the UI. Good for workers,
  wrong for a tile the host must see.
- **Agents are dispatched from two places**: `/api/token` (host token) and
  `/api/setupAgent` (`/spaces`, invite flow), each with its own list.
- **Compose interpolates profiled services too**: a `${VAR:?…}` in an opt-in
  service breaks every deploy that doesn't set it. Use `${VAR:-}`.
- **Never install `livekit` into the Physiological-Signals venv.** It upgrades
  protobuf to 7 and MediaPipe stops loading (`FieldDescriptor has no attribute
  'label'`); they pin `protobuf==4.25.9`. The bridge has its own venv.
- Physiological-Signals also needs exactly one OpenCV package
  (`opencv-contrib-python`); `ultralytics` drags in `opencv-python`, and two
  Qt copies (plus Anaconda's) flood `QObject::moveToThread`.
- On the Vicomtech network the TLS connection to the cloud domain hung; the
  concert PC's network has to be checked before a session.
- The browser holding the webcam (a Creative Studio session on the same PC)
  stops Physiological-Signals from opening it.

## Open fronts if it is picked up

- **Names**: standalone shows wristbands as "Sin asignar · 0334". Binding
  exists only in the dispatched agent (`engagement/bind`) and has no UI.
- **Host tab** with per-person detail (physiology relative to baseline) and
  the binding selector; nothing in the frontend consumes the `engagement`
  topic.
- **Security, pre-existing**: `/api/token` takes `identity` and `role` from the
  query string, so anyone can mint a host token or impersonate a publisher.
  It matters more once physiological data is in the room.
- Choose one deployment and delete the other (standalone vs dispatched agent
  vs the compose profile).
