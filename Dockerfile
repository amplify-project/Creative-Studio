FROM node:24.12-alpine
WORKDIR /app
# ffmpeg: decoding and mixing, everywhere in Play2Gether.
#
# python3 + py3-numpy: ONLY for `scripts/p2g_dtw_align.py`, the on-demand DTW
# alignment of a take against the reference (docs/llm/12-dtw-alignment.md).
# Deliberately Alpine's prebuilt py3-numpy from the community repo and not
# `pip install numpy`, which on musl has no wheel and would build from source —
# gcc, gfortran and openblas-dev, several minutes of build, hundreds of MB.
#
# This is a second runtime in a Node image for exactly one feature, and it is
# not meant to be permanent. If the alignment proves itself on real takes, the
# analyser moves into TypeScript (the DSP is ~400 lines and the fixtures can
# prove the port equal); if it does not, both this and the script come out. See
# the "Where this runs" section of doc 12.
RUN apk add --no-cache ffmpeg python3 py3-numpy
# Exact dependency versions from the lockfile. `npm i` against package.json's
# ^ranges re-resolved everything on each build: on 2026-10-06 a rebuild pulled
# livekit-client 2.22.3 onto a LiveKit server it no longer negotiated with
# (a reconnect loop every ~17 s). Update deliberately: `npm update`, test, and
# commit the new package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci

# Copiar todo el proyecto
COPY . .
COPY ./server/.env .env.local

ARG NEXTAUTH_URL
ARG NEXTAUTH_SECRET
ARG GOOGLE_ID
ARG GOOGLE_SECRET
ARG LIVEKIT_URL
ARG LIVEKIT_API_KEY
ARG LIVEKIT_API_SECRET
ARG ADMIN_EMAIL
ARG DATABASE_URL
ARG INVITE_JWT_SECRET
ARG APP_BASE_URL
ARG NEXT_PUBLIC_LIVEKIT_URL
ARG NEXT_PUBLIC_NODE_IP
ARG GITHUB_ID
ARG GITHUB_SECRET
# Los exponemos al entorno de build para que Next.js los vea
ENV NEXTAUTH_URL=${NEXTAUTH_URL}
ENV NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
ENV GOOGLE_ID=${GOOGLE_ID}
ENV GOOGLE_SECRET=${GOOGLE_SECRET}
ENV LIVEKIT_URL=${LIVEKIT_URL}
ENV LIVEKIT_API_KEY=${LIVEKIT_API_KEY}
ENV LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET}
ENV ADMIN_EMAIL=${ADMIN_EMAIL}
ENV DATABASE_URL=${DATABASE_URL}
ENV INVITE_JWT_SECRET=${INVITE_JWT_SECRET}
ENV APP_BASE_URL=${APP_BASE_URL}
ENV NEXT_PUBLIC_LIVEKIT_URL=${NEXT_PUBLIC_LIVEKIT_URL}
ENV NEXT_PUBLIC_NODE_IP=${NEXT_PUBLIC_NODE_IP}
ENV GITHUB_ID=${GITHUB_ID}
ENV GITHUB_SECRET=${GITHUB_SECRET}
# NOTE: there used to be a `RUN echo "<VAR>=$<VAR>"` per build arg here. Each one
# wrote the value into the build log and into an image layer, so every secret
# (NEXTAUTH_SECRET, GOOGLE_SECRET, LIVEKIT_API_SECRET, INVITE_JWT_SECRET,
# DATABASE_URL) was readable from `docker history`. Do not reinstate them.
# Build de Next.js
RUN npx prisma generate --schema=./app/dbbackend/model/schema.prisma

RUN npm run build

# Variables de entorno
ENV NODE_ENV=production

# Exponer puerto
EXPOSE 3000

# Comando por defecto
#CMD ["npm", "start"]
