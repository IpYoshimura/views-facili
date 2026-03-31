# ── Lightweight multi-purpose build ──────────────────────────────────────────
# Build timestamp: 2026-03-31T00:00:00Z (force rebuild)
FROM node:20-slim

# Installa Python + dipendenze di sistema
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installa yt-dlp + ShazamAPI
RUN pip install --no-cache-dir --break-system-packages yt-dlp ShazamAPI pydub requests

# Installa dipendenze Node.js
COPY package.json package-lock.json* ./
RUN npm install --production --omit=optional 2>/dev/null || npm install --production

# Copia sorgenti
COPY server.js client.js shazam_recognition_new.py ./
COPY channels.txt channel_ids.json saved_videos.json* ./

ENV PORT=3000
ENV NODE_ENV=production
EXPOSE ${PORT}

CMD ["node", "server.js"]
