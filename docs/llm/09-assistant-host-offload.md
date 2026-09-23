# Offloading the assistant-host agent — deferred plan

**Status: nothing implemented. Written 2026-08-26 as a decision record so the
analysis does not have to be redone.**

Plan for moving the `assistant_host` LiveKit worker (the ONNX audio analysis)
off the single EC2 box and onto AWS Fargate. Read together with
[07-assistant-suggestions.md](07-assistant-suggestions.md) (what the agent does)
and `../feature-distortion_suggestions.md` (why the audio-analysis plugin looks
the way it does).

## Why this came up, and what it does NOT solve

The trigger was cost: one `m6i.xlarge` (~0,222 $/h ≈ 162 $/mes in London) runs
24×7 but is used maybe 20% of the day.

**Moving the classifier does not fix that.** The classifier is a slice of a box
that stays billed. Pay-per-use for the box means *stopping the instance* — a
separate, larger win, tracked in the "also deferred" section below.

The reasons to move `assistant_host` that actually hold up:

- It is the heaviest and most elastic thing in the stack (four ONNX sessions
  **per audio track**), so it is what makes the box need to be big.
- It is **optional**: if it is not running the room works fine, only without
  suggestions. Nothing else in the stack degrades this gracefully.
- It is **latency-tolerant**: one window/second, and `CONTENT_HOLD_WINDOWS`
  already spends ~3 s confirming a class before anything is suggested. Tens of
  milliseconds of network are invisible here.
- Deploying a model would stop meaning redeploying the room stack.

## What the agent is today

- `server/agents/assistantHost/assistant_host.py:553` — a standard LiveKit
  worker, `WorkerOptions(..., agent_name=AGENT_IDENTITY)`, i.e. **explicit
  dispatch per session**, connecting *outbound* to `LIVEKIT_URL`.
- Audio arrives over the SFU: `rtc.AudioStream(track)` in
  `plugins/audio_analysis.py:423`. **There is no audio transport to invent** —
  the SFU already delivers it as Opus (~32 kbps/track).
- `audioAnalysis/` holds four ONNX models, tracked in git, 102 MB total
  (`dac_encoder` 83 MB, `yamnet` 16 MB, `content_mlp` 2,6 MB,
  `distortion_mlp` 1,2 MB).
- `assistantHost/Dockerfile` already does `COPY . .`, so **the image is
  self-contained**. The `volumes: ./agents/assistantHost:/app` in
  `server/docker-compose.yaml:100` is dev convenience that shadows it.

## Decision: move the whole worker, not the model behind an API

Two shapes were considered.

| Shape | Verdict |
|---|---|
| **Whole worker on Fargate** — the container connects to the SFU and receives audio exactly as now | **Chosen.** Zero changes to the audio path. Small, reversible, and does not foreclose the API split later. |
| **Model behind an inference API** — the worker stays local and ships 16 kHz windows to a shared service | Deferred. Its prizes (one model instance serving all tracks and all rooms; reusing the classifier outside a room, e.g. on P2G takes or uploaded files) are real but **independent of where the worker runs**. |

The per-track model duplication is worth fixing *regardless of location* — it is
a few lines in `audio_analysis.py` to instantiate the `InferenceSession`s once
instead of per track (`InferenceSession.run()` is thread-safe). Do it as its own
change; do not use it to justify the move.

Not moved, and why:

- **`shared_state`** — no AI, negligible CPU, and it is the backbone of the
  shared-state protocol (see [03-shared-state.md](03-shared-state.md)). Moving
  it off-box buys nothing and adds a network hop and a failure mode.
- **`zoom_agent`** — also AI and also heavy (mediapipe hand tracking), but the
  zoom *follows the hand*, so latency is visible on screen. If it ever moves,
  move the whole worker (it receives video over the SFU); never split its model
  behind a per-frame API.

## Steps

1. **Trim `assistantHost/requirements.txt`.** Verified: nothing under
   `assistantHost/` imports `cv2`, `mediapipe`, `matplotlib` or `PIL` — they
   were copied wholesale from the zoom agent. Dropping those plus `pillow`,
   `kiwisolver`, `cycler`, `pyparsing` and `python-dateutil` is roughly
   300-500 MB of image, which on Fargate is paid in cold start and ECR storage.
   Do this **before** measuring anything, or the numbers describe an image you
   do not want.
2. **Config.** `LIVEKIT_URL` goes from `ws://localhost:7880` to
   `wss://creativestudio.amplifyproject.eu/live`. `server/nginx/nginx.conf` has
   `location /live/ { proxy_pass http://livekit_upstream/; }`, which strips the
   prefix, so the LiveKit API (`/twirp/...`) is reachable through the same URL.
   The API key/secret currently sit in clear text at
   `server/docker-compose.yaml:102-103` — they move to Secrets Manager.
3. **Networking.** Public subnet with `assignPublicIp: ENABLED`. The worker only
   makes outbound connections, so it needs no inbound path. A private subnet
   would require a NAT Gateway (~32 $/mes), which eats the entire saving.
4. **Start/stop.** Tie the service to the same window as the box
   (`ecs update-service --desired-count`). Simple, and adds no new failure mode.

## Traps

- **Do not drive the task from LiveKit room webhooks.** The obvious design is
  `room_started` → 1, `room_finished` → 0, but `server/server.yaml` sets
  `empty_timeout: 40000000` (~463 days), so **rooms never finish** and
  `room_finished` would essentially never fire, leaving the task up forever. The
  same setting defeats any idle check based on counting rooms — count
  *participants* instead.
- **`pip3 install --no-deps`** (`assistantHost/Dockerfile`) means
  `requirements.txt` is a hand-maintained transitive closure. Removing a line
  can break a non-obvious import, so step 1 must be validated by building and
  running the image, not by reading the file.
- **Startup order.** If the task comes up before the box, there is nothing to
  connect to. The worker retries, so it self-heals, but give it slack.
- **Graceful degradation is assumed, not accidental.** A missing worker leaves
  the room fully functional without suggestions — the same assumption the
  room-activity suspend design relies on.

## Also deferred, and larger

- **Stopping the box on a schedule.** EventBridge Scheduler can call
  `ec2:startInstances` / `ec2:stopInstances` directly (no Lambda), and unlike
  classic EventBridge rules it accepts `Europe/London`, so BST/GMT is handled.
  Safer than a fixed clock: an idle guard on the box that counts LiveKit
  *participants* and only then calls `shutdown -h now` — after confirming
  `instanceInitiatedShutdownBehavior` is `stop`, not `terminate`.
- **Egress is the dominant production cost**, not idle compute: ~16 $ per two-hour
  session of 15 people, versus 162 $/mes for the whole instance. At ten sessions
  a month, egress alone matches the entire box. `simulcast`, `adaptiveStream`
  and `dynacast` are already on (`app/host/page.tsx:30-38`), so the remaining
  lever is a product decision — the default `VideoPresets.h720`, and who
  subscribes to whom.
- **Redis may be unnecessary.** It exists for LiveKit's distributed mode; with a
  single node it can probably go. One less piece.
- **certbot becomes unnecessary** if TLS terminates on an ALB/CloudFront with
  ACM — free certificates, automatic renewal.
