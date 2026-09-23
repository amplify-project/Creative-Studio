# MongoDB Community 8.x
FROM mongo:8

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
