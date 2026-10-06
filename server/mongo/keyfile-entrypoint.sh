#!/bin/sh
# Writes the replica-set keyfile from the environment, then hands over to the
# official entrypoint.
#
# The keyfile used to be a file in git, COPYed into the image — which put the
# one secret that grants full access to the database (keyfile auth logs in as
# __system) into a public repository and into every image layer. It now lives
# only in server/.env as MONGO_REPLICA_KEY.
#
# Written here rather than bind-mounted because mongod refuses a keyfile not
# owned by the `mongodb` user with mode 400; a host file would need a chown on
# the host. This runs as root, before the official entrypoint drops privileges.
set -eu
: "${MONGO_REPLICA_KEY:?MONGO_REPLICA_KEY must be set in server/.env (openssl rand -base64 756 | tr -d '\n')}"
printf '%s' "$MONGO_REPLICA_KEY" > /data/keyfile
chown mongodb:mongodb /data/keyfile
chmod 400 /data/keyfile
exec docker-entrypoint.sh "$@"
