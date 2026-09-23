#!/usr/bin/env bash
set -e
set -a
source .env
set +a
#sudo apt-get update && sudo apt-get install -y jq
#sudo curl -sSL https://get.livekit.io/cli | bash
lk project add portable6 --url ${LIVEKIT_URL} --api-key ${LIVEKIT_API_KEY} --api-secret ${LIVEKIT_API_SECRET}
lk room create --name test2
lk ingress create ingress.json
lk ingress create ingress1.json
lk ingress create ingress2.json
lk ingress create ingress3.json
lk ingress create ingress4.json
lk ingress list
