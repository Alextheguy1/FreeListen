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
# yt-dlp, Deno and ffmpeg are all fetched by install scripts that log their
# failures and still exit 0, so a runner that cannot reach GitHub would
# otherwise produce a green image that can download nothing. Size-check rather
# than execute: these run under QEMU on the arm64 build, and a truncated
# download or an error page saved as the binary is the failure worth catching.
RUN cd backend && npm install --omit=dev \
    && for b in node_modules/yt-dlp-exec/bin/yt-dlp bin/deno node_modules/ffmpeg-static/ffmpeg; do \
         test -x "$b" || { echo "missing binary: $b"; exit 1; }; \
         test "$(stat -c%s "$b")" -gt 1000000 || { echo "truncated binary: $b"; exit 1; }; \
       done

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
