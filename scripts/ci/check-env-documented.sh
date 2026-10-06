#!/usr/bin/env bash
# Fails if docker-compose requires a variable that .env.example does not list.
#
# Compose refuses to start when a `${VAR:?...}` is unset, which is the right
# behaviour on a server — but it means a PR that adds a required variable and
# forgets .env.example breaks the next fresh install, and nothing notices until
# then. This makes the PR notice.
#
# Usage: scripts/ci/check-env-documented.sh   (from the repo root)
set -euo pipefail

required=$(grep -ohE '\$\{[A-Z0-9_]+:\?' server/docker-compose.yaml server/docker-compose.dev.yaml \
  | sed -E 's/^\$\{([A-Z0-9_]+):\?$/\1/' | sort -u)

missing=""
for var in $required; do
  grep -qE "^${var}=" .env.example || missing="$missing $var"
done

if [ -n "$missing" ]; then
  echo "Required by docker-compose but missing from .env.example:$missing" >&2
  exit 1
fi
echo "All $(echo "$required" | wc -w) required variables are documented in .env.example."
