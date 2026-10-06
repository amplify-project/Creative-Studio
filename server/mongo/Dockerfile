# MongoDB Community 8.x
# Pinned: an unpinned `mongo:8` pulled 8.3.11 on 2026-10-06, which refuses to
# start on Linux kernel 6.19+ (SERVER-121912) — the production box runs 7.0.
# 8.2.1 is the version that has run production since 2025-11. Data files are
# 8.x format: never go back to 7.x.
FROM mongo:8.2.1

# --- Configuración de credenciales y DB por defecto ---
# Cambia estos valores en tiempo de build o mejor en 'docker run' / compose.
ENV MONGO_INITDB_DATABASE=mydb
ENV MONGO_HOST=127.0.0.1
# --- Script de inicialización del Replica Set (se ejecuta 1 vez si el volumen está vacío) ---
COPY rs-init.js /docker-entrypoint-initdb.d/01-rs-init.js
COPY init-users.js /docker-entrypoint-initdb.d/02-init-users.js
COPY mongo-keyfile /data/keyfile
RUN chown mongodb:mongodb /data/keyfile && chmod 400 /data/keyfile

# --- Importante: arrancar con --replSet ---
CMD ["mongod", "--replSet", "rs0", "--bind_ip_all"]
