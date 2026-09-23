# Fill these in from your own deployment, or source them from server/.env.
# Generate a key pair with:  docker run --rm livekit/livekit-server generate-keys
export LIVEKIT_API_KEY="${LIVEKIT_API_KEY:?set LIVEKIT_API_KEY}"
export LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:?set LIVEKIT_API_SECRET}"
export LIVEKIT_URL=wss://creativestudio.amplifyproject.eu/live
