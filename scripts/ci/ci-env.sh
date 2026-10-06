#!/usr/bin/env bash
# Writes an env file from .env.example with every empty value filled by a
# placeholder, so `docker compose config` can validate the compose files the
# way a real install would read them. Nothing here is a real secret.
#
# Usage: scripts/ci/ci-env.sh > /tmp/ci.env
set -euo pipefail
sed -E 's/^([A-Z0-9_]+)=$/\1=ci-placeholder/' .env.example
