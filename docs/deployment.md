# Deployment

Two procedures: [installing from scratch](#fresh-install) — on your own machine
for development, or on a server with a domain — and
[updating a server that is already running](#updating-an-existing-server).

Everything runs from `server/docker-compose.yaml`: LiveKit and its ingress,
Redis, MongoDB, nginx, the Python agents and the web app.

---

## Fresh install

### Requirements

- Linux with **Docker** and the **Docker Compose** plugin.
- `git`, `openssl`, `curl`.
- Production: a domain pointing at the server. Around 15 participants with the
  assistant enabled need 8 vCPU / 32 GB.

### 1. Clone and fetch the models

```bash
git clone https://github.com/amplify-project/Creative-Studio.git
cd Creative-Studio
./scripts/fetch-models.sh        # 97 MB of third-party ONNX weights, not in git
```

### 2. Configuration: `server/.env`

```bash
cp .env.example server/.env
```

Fill it in. Every variable is explained in the file itself; the ones with no
default:

| Variable | Value |
|---|---|
| `NODE_IP` | Local: the machine's LAN IP. Production: the domain. |
| `NEXT_PUBLIC_APP_URL`, `APP_BASE_URL`, `NEXTAUTH_URL` | `https://<NODE_IP>` |
| `NEXT_PUBLIC_LIVEKIT_URL` | `wss://<NODE_IP>/live` |
| `LIVEKIT_URL` | `ws://localhost:7880` |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | `docker run --rm livekit/livekit-server:v1.13.7 generate-keys` |
| `REDIS_PASSWORD` | `openssl rand -hex 24` |
| `MONGO_ADMIN_PASSWORD` / `MONGO_APP_PASSWORD` | `openssl rand -hex 24` each — **hex**, they go inside a URL |
| `MONGO_REPLICA_KEY` | `openssl rand -base64 756 \| tr -d '\n'` |
| `DATABASE_URL` | `mongodb://nextauth:<MONGO_APP_PASSWORD>@localhost:27017/mydb?authSource=mydb&replicaSet=rs0&directConnection=true` |
| `NEXTAUTH_SECRET` / `INVITE_JWT_SECRET` | `openssl rand -base64 32` each |
| `GOOGLE_ID` / `GOOGLE_SECRET`, `GITHUB_ID` / `GITHUB_SECRET` | OAuth apps whose callback is `https://<NODE_IP>/api/auth/callback/<google\|github>`. Blank disables a provider; at least one is needed to sign in. |
| `ADMIN_EMAIL` | The account that gets the `/admin` pages |

Generate every secret fresh; never reuse another install's values. If a
required variable is missing, `docker compose` refuses to start and names it.

### 3. LiveKit's own config: `server/server.yaml`

```bash
cp server/server.yaml.example server/server.yaml
```

LiveKit cannot read environment variables, so two values are written into it by
hand and must match `server/.env`:

| `server/server.yaml` | must equal |
|---|---|
| `keys:` → `<key>: <secret>` | `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` |
| `redis:` → `password:` | `REDIS_PASSWORD` |

On a cloud server (EC2 and the like) also set `rtc: use_external_ip: true`, so
LiveKit advertises the public address rather than the private one; otherwise
the page loads but media never connects.

### 4. TLS certificate

nginx serves HTTPS only, and reads the certificate from
`server/certbot/certs/live/creativestudio.amplifyproject.eu/`. **That domain is
written into `server/nginx/templates/nginx.conf.template`** (`server_name`
twice, the two `ssl_certificate` lines) **and into the `certbot` service in
`server/docker-compose.yaml`.** On any other domain, replace it in both files
first.

**Local (self-signed).** Browsers allow the microphone and camera only over
HTTPS, so even a local install needs a certificate. A self-signed one is fine;
the browser asks you to accept it once.

```bash
D=server/certbot/certs/live/creativestudio.amplifyproject.eu
sudo mkdir -p $D
sudo openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
  -subj "/CN=localhost" -keyout $D/privkey.pem -out $D/fullchain.pem
```

**Production (Let's Encrypt).** nginx will not start without a certificate, and
the `certbot` service needs nginx running — so the first certificate is issued
in standalone mode, before the stack is up, with port 80 free:

```bash
cd server
sudo docker run --rm -p 80:80 -v "$PWD/certbot/certs:/etc/letsencrypt" \
  certbot/certbot certonly --standalone -d <your-domain> \
  --non-interactive --agree-tos -m <your-email>
```

Renewals then go through the running nginx:

```bash
docker compose run --rm certbot && docker compose exec nginx nginx -s reload
```

`server/certbot/` holds the private key. It is ignored by git — never add it.

### 5. Firewall (production)

Open to the internet:

| Port | What |
|---|---|
| TCP 80 | Let's Encrypt challenge |
| TCP 443 | The app, and LiveKit signalling under `/live` |
| TCP 7881 | LiveKit's TCP fallback for media |
| UDP 50000–60000 | Media |

Keep everything else closed — in particular 7880 (LiveKit API), 6379 (Redis),
8080 (ingress) and 3000 (the web app, behind nginx). MongoDB is published on
`127.0.0.1` only.

### 6. Build and start

```bash
cd server
docker compose build
docker compose up -d
```

`build` is not optional: `up -d` reuses whatever images are already on the
machine and never rebuilds them.

The first start takes a minute: MongoDB creates its replica set and the two
users, and the web app runs `prisma db push` before it starts.

### 7. Check

```bash
docker compose ps                              # everything "Up"
docker logs webapp --tail 20                   # Next.js ready, no Prisma error
docker logs agent_shared_state --tail 5        # "registered worker"
```

Open `https://<NODE_IP>`, sign in, create a session, and join it from a second
browser **with a different account** — the same account in two tabs kicks the
first one out, in a loop.

### Developing without rebuilding the image

For day-to-day work on the web app, run the stack as above, stop its web app
container, and run Next.js on the host in its place. nginx keeps providing
HTTPS in front of it, on port 3000 as before:

```bash
docker compose -f server/docker-compose.yaml stop webapp
npm ci
npx prisma generate --schema app/dbbackend/model/schema.prisma
cp server/.env .env.local
npm run dev
```

Then open `https://<NODE_IP>` as usual. To typecheck without building:
`npx tsc --noEmit`.

---

## Updating an existing server

### Routine update

The server runs `main`. To deploy what has been merged:

```bash
cd Creative-Studio
git log --oneline -1                             # note it: this is your way back
git pull --ff-only
cd server
docker compose build webapp                      # plus any other service that changed
docker compose up -d
```

Rebuild only what changed — `git diff --stat <old>..HEAD` shows which:

| Changed | Do |
|---|---|
| `app/`, `components/`, `package*.json`, `Dockerfile`, **or `server/.env`** | `docker compose build webapp` |
| `server/agents/<agent>/` | `docker compose build <agent>` |
| `server/mongo/` | `docker compose build mongo` |
| `server/nginx/templates/` | `docker compose restart nginx` |
| an image version in `docker-compose.yaml` | `docker compose pull <service>` |

then `docker compose up -d`.

**Changing `server/.env` requires rebuilding the web app.** Its values are baked
into the image at build time, so a restart alone keeps the old ones.

Uploaded Play2Gether takes live inside the web app container and are lost when
it is recreated.

### Rolling back

```bash
git checkout <the commit you noted>
cd server
docker compose build webapp && docker compose up -d
```

The database is not versioned with the code: a rollback does not undo schema
changes that `prisma db push` already applied. In practice these are additive
(new optional fields), and older code ignores them.

### Upgrading pinned versions

MongoDB, LiveKit, its ingress and Redis are pinned in `server/mongo/Dockerfile`
and `server/docker-compose*.yaml`; the web app's dependencies in
`package-lock.json`. Change them on purpose, never as a side effect of a build:

- **The LiveKit server and `livekit-client` go together.** A newer client
  against an older server loops on "negotiation timed out", reconnecting every
  ~17 s.
- **MongoDB stays on 8.x**: the data files are 8.x format. Check a new release
  against the server's kernel first — 8.3 refuses to start on Linux 6.19+.

### Rotating the Mongo credentials

`MONGO_ADMIN_PASSWORD` and `MONGO_APP_PASSWORD` are only read when
`server/data1` is empty, to create the users. On a running install, changing
them in `server/.env` alone locks the web app out: change them in the database
first, then in `.env`. `MONGO_REPLICA_KEY` has no such state — a new value
takes effect on the next start.

```bash
cd server
NEW_ADMIN=$(openssl rand -hex 24)
NEW_APP=$(openssl rand -hex 24)
NEW_KEY=$(openssl rand -base64 756 | tr -d '\n')

# 1. In the database, while it runs (asks for the CURRENT admin password)
docker exec -it mongo1_portable mongosh -u admin -p --authenticationDatabase admin --eval "
  db.getSiblingDB('mydb').changeUserPassword('nextauth', '$NEW_APP');
  db.getSiblingDB('admin').changeUserPassword('admin', '$NEW_ADMIN');"

# 2. In server/.env: MONGO_ADMIN_PASSWORD, MONGO_APP_PASSWORD, MONGO_REPLICA_KEY,
#    and the password inside DATABASE_URL.

# 3. Restart Mongo, and REBUILD the web app (DATABASE_URL is baked into it)
docker compose build mongo webapp
docker compose up -d mongo webapp
```

Run all three steps in the same shell: between step 1 and step 3 the web app
cannot reach the database.
