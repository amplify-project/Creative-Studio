# engagement-bridge-agent

Relays the **Physiological-Signals** Redis feed (audience engagement + EmotiBit
physiology) into a Creative Studio LiveKit room as data messages on topic
`engagement`. Data only, like `shared-state-agent`: it subscribes to no tracks.

```
Physiological-Signals ──► Redis ──► engagement-bridge-agent ──► LiveKit room (topic "engagement")
 (vision + EmotiBit)                  serial → identity            host / participant UI
```

## Simplest: standalone, only the stage visualisation

If all you want is the "Engagement" tile on the stage, run `standalone.py` on
the concert PC. No agent dispatch, no web app changes, nothing in the cloud:

```bash
pip install -r requirements.txt
python standalone.py --room <room-name>              # reads redis://localhost:6379/0
python standalone.py --room <room-name> --simulate   # fake data, no Redis
```

It joins the room as "Engagement" and publishes the video; the host adds it
to the stage. `--room` is the Creative Studio session id (the LiveKit room
name). Needs `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` (env or
`.env.local`). Pulseras show as "Sin asignar · <serial>" since there is no
host binding in this mode. Don't combine it with the dispatched agent in the
same room: both publish as `engagementviz`.

## Stage visualisation (`viz.py`)

Besides the data messages, the agent opens a second, **visible** connection
as `engagementviz` ("Engagement") that publishes a 1280×720 video track at
`ENGAGEMENT_VIZ_FPS` (default 5). The host sees it in the participant list
like anyone else and adds it to the stage with the usual button; no frontend
changes. (The UI hides identities containing `agent`, hence the separate
identity.)

The frame shows the crowd average with a 3-minute sparkline and, per person,
name, engagement and arousal level (baja / media / alta). Identity guesses
(`confirmed: false`) are dimmed. **No physiological detail**: whatever is on
the stage is seen by everyone. Only people with a fresh engagement value are
listed; unbound pulseras appear as `Sin asignar · <last 4 of serial>`.

Set `ENGAGEMENT_VIZ=false` to disable it. Needs `LIVEKIT_API_KEY` /
`LIVEKIT_API_SECRET` to mint its own token, and the DejaVu font (installed in
the Dockerfile) for accents.

## Redis input

| Channel | Payload | Producer |
|---|---|---|
| `engagement_score` | crowd average, plain float string | vision |
| `device:{serial}:engagement` | `{engagement, confirmed, confidence, source}` | vision (`Handover_Oct-Dec_Concerts` build only) |
| `device:{serial}:physio_metrics` | session-z physiology (`eda_sd`, `hr_sd`, `calibrating`, …) | EmotiBit |
| `device:{serial}:valence_cont` / `arousal_cont` | `{valence}` / `{arousal}` | EmotiBit |

The older `scripts/inference/live_multiperson_binary_v2.py` publishes only
`engagement_score`; per-person engagement needs the Handover build.

## Identity: per session, host-assigned

The key per person in Redis is the EmotiBit serial. The host binds each
serial to a room participant; bindings live in memory for the agent's job,
i.e. one session, and are never persisted.

Binding is **host-only on purpose**: tokens grant `canUpdateOwnMetadata`, so a
participant-declared serial could be used to receive someone else's
physiological data.

## Messages (topic `engagement`)

Agent → room:

```jsonc
// every PUBLISH_INTERVAL_S, only when something changed
{ "type": "engagement/update", "ts": 1793900000.123, "crowd": 0.62,
  "people": [ {
    "serial": "MD-V5-0000334", "identity": "alice",   // identity null if unbound
    "engagement": 0.71, "confirmed": true, "confidence": 0.93, "source": "face",
    "physio": { "eda_sd": 0.4, "hr_sd": -0.2, "calibrating": false, ... },
    "valence": 0.1, "arousal": 0.6,
    "stale": false, "updatedAt": 1793900000.0 } ] }

// to hosts, after a bind/unbind
{ "type": "engagement/bindings", "bindings": { "MD-V5-0000334": "alice" } }
```

Client → agent:

```jsonc
{ "type": "engagement/requestSnapshot" }                                  // anyone
{ "type": "engagement/bind", "serial": "MD-V5-0000334", "identity": "alice" } // host; identity null = unbind
```

Agent → requesting client: `engagement/snapshot` (`crowd`, `people`,
`bindings`) and `engagement/bindRefused` (`reason`: `forbidden` |
`missing_serial`). A snapshot is also sent to every participant on join.

## Audience

`ENGAGEMENT_AUDIENCE=hosts` (default): hosts (`teacher` / `assistant` role)
receive every entry; a bound participant receives only their own entry;
everyone receives the crowd average. `all`: everyone receives everything.

## Environment

| Variable | Default | |
|---|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | | as the other agents (`.env.local`) |
| `REDIS_URL` | `redis://localhost:6379/0` | the Physiological-Signals hub |
| `ENGAGEMENT_AUDIENCE` | `hosts` | `hosts` \| `all` |
| `PUBLISH_INTERVAL_S` | `1.0` | |
| `STALE_AFTER_S` | `10` | entry flagged `stale` |
| `DROP_AFTER_S` | `60` | entry removed |
| `ENGAGEMENT_SIMULATE` | `false` | `true` = fake data for 4 pulseras generated in-process, **no Redis** (test the room side) |
| `ENGAGEMENT_VIZ` | `true` | publish the stage visualisation |
| `ENGAGEMENT_VIZ_FPS` | `5` | |
| `ENGAGEMENT_VIZ_IDENTITY` / `_NAME` | `engagementviz` / `Engagement` | no `agent` (UI hides it) and no `-` (UI reads `<base>-…` as a secondary camera) |
| `ENGAGEMENT_VIZ_FONT_DIR` | `/usr/share/fonts/truetype/dejavu` | |

Dispatch is **opt-in**: set `ENGAGEMENT_AGENT_ENABLED=true` for the Next.js
app (`app/api/token/route.ts`). Redis is a single hub, so dispatching to every
room would show the same people in all of them.

## Deploy

The Physiological-Signals Redis lives on the concert LAN, usually behind NAT,
and the cloud Redis is LiveKit's own (password, port closed). So the cloud
agent can't reach it. A LiveKit worker connects **outbound** to the server, so
the usual setup is:

- **Cloud**: only the web app, with `ENGAGEMENT_AGENT_ENABLED=true` in
  `server/.env` (passed to the `webapp` service), then
  `docker compose build webapp && docker compose up -d`.
- **Concert PC**, next to the Physiological-Signals Redis:

  ```bash
  pip install -r requirements.txt
  LIVEKIT_URL=wss://<your-domain> LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
  REDIS_URL=redis://localhost:6379/0 python agent.py start      # or: dev
  ```

If that Redis *is* reachable from the cloud host, run it there instead:
`ENGAGEMENT_REDIS_URL=redis://<host>:6379/0 docker compose --profile engagement up -d`.

Docker elsewhere: `docker build -t engagement-bridge-agent . && docker run --env-file .env.local engagement-bridge-agent`
