FROM node:20-slim

# unzip: needed by scripts/setup-deno.js to extract the Deno binary on Linux.
# ca-certificates: needed for the HTTPS downloads that postinstall does.
# python3 + python-is-python3: yt-dlp-exec's install step checks for a
# `python` binary on PATH (the package predates yt-dlp's move to a standalone
# binary) - python-is-python3 provides the `python` -> `python3` symlink.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    unzip \
    python3 \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./backend/
COPY backend/scripts/ ./backend/scripts/
RUN cd backend && npm install --omit=dev

COPY backend/ ./backend/
COPY frontend/ ./frontend/

ENV PORT=5051
ENV MUSIC_DIR=/music

EXPOSE 5051
VOLUME ["/music"]

WORKDIR /app/backend
CMD ["node", "server.js"]
