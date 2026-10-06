#!/usr/bin/env bash
# Fails if a tracked file is one that must never be committed: per-install
# secrets, TLS material, databases, or the third-party model weights.
#
# By NAME, on purpose. gitleaks looks at file contents and knows the formats of
# well-known keys; it did not flag server/mongo/mongo-keyfile, a random base64
# blob that grants full access to the database. A name-based list catches that
# class: things that are secret because of what they are, not how they look.
#
# Usage: scripts/ci/check-forbidden-files.sh   (from the repo root)
set -euo pipefail

# Extended regexes over `git ls-files` paths.
forbidden=(
  '(^|/)\.env($|\.)'                 # any .env file...
  '\.(pem|key|crt|csr|p12|pfx)$'     # TLS / private keys
  '(^|/)[^/]*keyfile$'              # Mongo replica-set keyfile (not keyfile-entrypoint.sh)
  '(^|/)server\.yaml$'               # LiveKit config: holds the API secret
  '(^|/)certbot/'                    # Let's Encrypt state, incl. the live private key
  '\.(db|sqlite3?)$'                 # databases
  '(^|/)data1/'                      # the Mongo data directory
  '(^|/)(yamnet_model|dac_encoder)\.onnx$'  # third-party weights, fetched by scripts/fetch-models.sh
)
allowed=(
  '(^|/)\.env\.example$'             # ...except the documented template
)

pattern=$(IFS='|'; echo "${forbidden[*]}")
allow=$(IFS='|'; echo "${allowed[*]}")

hits=$(git ls-files | grep -E "$pattern" | grep -vE "$allow" || true)
if [ -n "$hits" ]; then
  echo "These files must not be committed:" >&2
  echo "$hits" | sed 's/^/  /' >&2
  echo >&2
  echo "Secrets go in server/.env (see .env.example); certificates and data stay on the server." >&2
  exit 1
fi
echo "No forbidden files tracked."
