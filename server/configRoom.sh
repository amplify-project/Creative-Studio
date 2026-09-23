#!/usr/bin/env bash
# -u so an unset credential is an error. Without it the ${VAR} below expand to
# empty, `lk project add` accepts the empty flags, and the project is
# registered pointing nowhere.
set -euo pipefail
set -a
source .env
set +a
#sudo apt-get update && sudo apt-get install -y jq
#sudo curl -sSL https://get.livekit.io/cli | bash
lk project add portable6 \
  --url "${LIVEKIT_URL:?set LIVEKIT_URL in server/.env}" \
  --api-key "${LIVEKIT_API_KEY:?set LIVEKIT_API_KEY in server/.env}" \
  --api-secret "${LIVEKIT_API_SECRET:?set LIVEKIT_API_SECRET in server/.env}"
lk room create --name test2
lk ingress create ingress.json
lk ingress create ingress1.json
lk ingress create ingress2.json
lk ingress create ingress3.json
lk ingress create ingress4.json
lk ingress list
