FROM node:20-slim

# unzip, ca-certificates: setup-deno.js fetches and extracts Deno over HTTPS.
# python-is-python3: yt-dlp-exec's install step looks for `python` on PATH.
# python3-venv: Debian's PEP 668 rules reject pip into system Python.
# curl: unused by the app. TrueNAS's catalog template generates a curl
# healthcheck, and Debian slim ships neither curl nor wget.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
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

ENV PORT=5051
ENV MUSIC_DIR=/music
ENV CONFIG_DIR=/config
ENV PLAYLIST_BACKEND_URL=http://localhost:5058
# Runs as an unprivileged uid (TrueNAS uses 568), which cannot write /root.
ENV HOME=/tmp

EXPOSE 5051
VOLUME ["/music"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5051)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["supervisord", "-n", "-c", "/etc/supervisor/conf.d/freelisten.conf"]
