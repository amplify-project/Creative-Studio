# AMPLIFY Creative Studio

**A web tool for making music together at a distance** — synchronous sessions
where a host directs what everyone sees and hears, participants record together
over a shared reference, and the result is mixed server-side into a single take.

AMPLIFY Creative Studio is a user-friendly digital tool designed to unite people across
distances for learning, performing, and creating together. Ideal for community
settings, it combines AI-driven audio-visual production with phygital
engagement, making collaborative experiences seamless and accessible.

It is one of the two open-source tools built by the [AMPLIFY](https://amplifyproject.eu)
project (Horizon Europe, Grant Agreement No 101177413) and is being trialled in
the project's pilots, among them the remote teaching and performance of Gaelic
traditional music.

---

## What it does

- **Directed sessions.** A host composes the stage — who is on it, how it is
  laid out, what is pinned — and every participant's client converges to that
  same description through a shared-state protocol carried over LiveKit's data
  channel.
- **Play2Gether.** Participants record their part against a shared reference
  track with a count-in, on a clock that compensates each device's own capture
  and monitoring latency. Takes are uploaded and mixed on the server, and a
  mix can be promoted to become the reference for the next round, which is how
  a choir is built one layer at a time.
- **More than one camera per person.** A phone joins as an extra video source
  by scanning a QR code, and a second camera or a screen share can be published
  from the session itself. Every stream is its own entity on the stage.
- **Hand-zoom.** A Python agent tracks hands in the video and the client crops
  and eases toward them, so a tutor can put an instrument's fingering on the
  stage without touching anything.
- **An audio-aware assistant.** ONNX classifiers listen to the room and put
  suggestions in front of the host, which the host confirms or dismisses —
  never actions taken on their own.
- **Diagnostics built for a field session.** Connection telemetry, quality
  auto-pause, a pre-join microphone and speaker check, and bug reports that
  carry the session's own state with them.

## How it fits together

```
  Browser (Next.js 15 / React 19)  ─┐
                                    ├─►  LiveKit SFU (WebRTC)  ◄─┬─  shared-state agent
  Browser (participant, phone)     ─┘         │                  ├─  hand-zoom agent
                                              │                  ├─  assistant host (ONNX)
  Next.js API routes (Prisma/MongoDB) ────────┘                  └─  data-collection agent
```

The web client handles presentation and interaction; the host role drives
orchestration and propagates it as shared state; and computation, tracking and
persistence are delegated to independent Python agents that join the LiveKit
room as ordinary — if hidden — participants. The full reasoning is in
[`docs/architecture.md`](docs/architecture.md).

## Requirements

- **Docker** and **Docker Compose** for the full stack.
- **Node.js 20+** to run the web app on its own.
- **Python 3.10+** for the agents (see `server/agents/*/requirements.txt`).
- Free ports: TCP 443, 3000, 6379, 7880, 8080 and UDP 50000–60000.

## Quick start

The full procedure — configuration, TLS, firewall, and how to update a running
server — is in [`docs/deployment.md`](docs/deployment.md). In short:

```bash
git clone https://github.com/amplify-project/Creative-Studio.git
cd Creative-Studio
./scripts/fetch-models.sh                          # third-party ONNX weights, not in git
cp .env.example server/.env                        # fill in: every secret generated fresh
cp server/server.yaml.example server/server.yaml   # LiveKit keys + Redis password, by hand
# a TLS certificate — self-signed is fine locally, see docs/deployment.md
cd server
docker compose build                               # `up` alone never rebuilds
docker compose up -d
```

### Running only the web app

See "Developing without rebuilding the image" in
[`docs/deployment.md`](docs/deployment.md): the stack runs in Docker and Next.js
runs on the host behind its nginx. `npm run build` runs `prisma generate`
first; to typecheck without a build, use `npx tsc --noEmit`.

## Configuration

Every variable is documented in [`.env.example`](.env.example). The ones with
no sensible default:

| Variable | What it is |
|---|---|
| `NODE_IP` | The address browsers and agents reach this deployment at |
| `NEXT_PUBLIC_LIVEKIT_URL` | LiveKit as the browser sees it (through nginx) |
| `LIVEKIT_URL` | LiveKit as the server and the agents see it |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | **Secret.** Must match `server/server.yaml` |
| `DATABASE_URL` | MongoDB connection string |
| `NEXTAUTH_SECRET` / `INVITE_JWT_SECRET` | **Secret.** Sessions and invitation links |
| `GOOGLE_*` / `GITHUB_*` | **Secret.** OAuth providers; blank disables one |
| `ADMIN_EMAIL` | The account granted the `/admin` pages |
| `ENABLE_ONNX_AUDIO_ANALYSIS` | Four models per audio track — the first thing to turn off on a small machine |

No deployment should reuse another's keys: generate a fresh set per install.

## Repository layout

```
app/              Next.js App Router — pages and API routes
  host/           the host's session view
  participant/    the participant's session view
  publish/        the page a phone lands on after scanning the QR
  spaces/         spaces, sessions and invitations
  api/            token minting, Play2Gether endpoints, reports, auth
components/       React components (stage, controls, Play2Gether, panels)
server/           Docker stack: LiveKit, nginx, MongoDB, Redis, agents
  agents/         Python LiveKit workers (shared state, zoom, assistant, data)
docs/             architecture, deployment and engineering notes
utils/            WHIP/GStreamer ingress helpers
```

## Documentation

| Document | What it covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | The architecture in prose: roles, agents, shared state, media flows |
| [`docs/deployment.md`](docs/deployment.md) | Docker install, ports, ingress and WHIP publishing |
| [`docs/llm/`](docs/llm/README.md) | Per-feature engineering notes: where things live, why they are built this way, and what not to break |

The notes under `docs/llm/` are written to be read start to finish — including
by a language model given the repository as context — and are the honest record
of what broke and why a decision was taken. Start with
[`00-project-tour.md`](docs/llm/00-project-tour.md).

## Contributing

Issues and pull requests are welcome. Please open an issue describing the
problem or the change before a substantial pull request, and do not include
credentials, recordings or personal data in reports — the bug-report flow in
the app already attaches the session state that is needed.

## Third-party models

The assistant's audio analysis uses two third-party ONNX models that are not kept in this repository — 97 MB of weights that are not ours to redistribute:
- YAMNet, Google, Apache-2.0 — content classification embeddings.
- The encoder half of the Descript Audio Codec, MIT — distortion embeddings.

*(For a complete overview of third-party licenses, see [Licensing_summary.txt](LICENSING_SUMMARY.txt))*.

`./scripts/fetch-models.sh` downloads both and verifies their SHA-256. The two small MLPs beside them are in the repository: they were trained for this project, they are covered by the licence below, and nothing public reproduces them. Do not substitute your own export of the third-party pair — see `server/agents/assistantHost/audioAnalysis/README.md` for why that silently degrades the classifiers.


## License

GPLv3. See [`LICENSE`](LICENSE).

*(For a complete overview of third-party licenses, see [Licensing_summary.txt](LICENSING_SUMMARY.txt))*.

## Contributions
- Iñigo Tamayo (Vicomtech): Core
- Will Wedgwood (Salsa sound) : Speech/Music/Distorsion agent.
- Patricia De Torres (Vicomtech) : Attention agent.

## Funding

<!-- Add the EU emblem here before publication: the official file is at
     https://commission.europa.eu/about/visual-identity_en -->

Co-funded by the European Union under Grant Agreement No **101177413**
(**AMPLIFY** — *Phygital Solutions for the Cultural and Creative Industries*),
Horizon Europe call `HORIZON-CL2-2024-HERITAGE-01-03`, November 2024 – October
2027, coordinated by [Vicomtech](https://www.vicomtech.org).

> Views and opinions expressed are however those of the author(s) only and do
> not necessarily reflect those of the European Union or the European Research
> Executive Agency (REA). Neither the European Union nor the granting authority
> can be held responsible for them.
