#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/devsetup.sh"

ROOM_ID="${1:-69e8a6f1181161cc3eed6aa3}"

lk dispatch create \
	--agent-name pose-gaze-agent \
	--room "$ROOM_ID" \
	--url "$LIVEKIT_URL" \
	--api-key "$LIVEKIT_API_KEY" \
	--api-secret "$LIVEKIT_API_SECRET"

lk dispatch create \
	--agent-name audio-analysis-agent \
	--room "$ROOM_ID" \
	--url "$LIVEKIT_URL" \
	--api-key "$LIVEKIT_API_KEY" \
	--api-secret "$LIVEKIT_API_SECRET"

