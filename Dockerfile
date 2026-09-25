FROM node:20-slim

# unzip: needed by backend/scripts/setup-deno.js to extract the Deno binary.
# ca-certificates: needed for the HTTPS downloads that postinstall does.
# python3 + python-is-python3: yt-dlp-exec's install step checks for a
# `python` binary on PATH (the package predates yt-dlp's move to a standalone
# binary) - python-is-python3 provides the `python` -> `python3` symlink.
# python3-venv: playlist-backend's own Python dependencies install into an
# isolated venv rather than system Python (avoids Debian's PEP 668
# "externally managed environment" restriction on plain pip installs).
# supervisor: runs the Node backend and the Python playlist service as two
# processes inside this one container/image, the same way Lidarr and similar
# single-image apps bundle more than one internal service - so this deploys
# as one Docker app instead of two, while keeping the two backends as
# separate codebases as before.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    unzip \
    python3 \
    python3-venv \
    python-is-python3 \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./backend/
COPY backend/scripts/ ./backend/scripts/
RUN cd backend && npm install --omit=dev

COPY backend/ ./backend/
COPY frontend/ ./frontend/

COPY playlist-backend/requirements.txt ./playlist-backend/
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r playlist-backend/requirements.txt
COPY playlist-backend/ ./playlist-backend/

COPY supervisord.conf /etc/supervisor/conf.d/freelisten.conf

# PORT/MUSIC_DIR/CONFIG_DIR are music-search's; playlist-backend's own PORT
# is set separately in supervisord.conf, since it needs a different value.
# PLAYLIST_BACKEND_URL points at localhost now - both processes share this
# container's network namespace, so there's no inter-container hop anymore.
ENV PORT=5051
ENV MUSIC_DIR=/music
ENV CONFIG_DIR=/config
ENV PLAYLIST_BACKEND_URL=http://localhost:5058

EXPOSE 5051
VOLUME ["/music"]

CMD ["supervisord", "-n", "-c", "/etc/supervisor/conf.d/freelisten.conf"]
