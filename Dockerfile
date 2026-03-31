# ── Build stage ──────────────────────────────────────────────────
FROM python:3.11-slim AS base

# Installa dipendenze di sistema PRIMA di Python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gnupg ca-certificates \
    ffmpeg \
    deno \
    nodejs npm \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installa yt-dlp DOPO FFmpeg e deno
RUN pip install --no-cache-dir yt-dlp ShazamAPI pydub requests

# Installa dipendenze Node.js
COPY package.json package-lock.json* ./
RUN npm install --production 2>/dev/null || npm install --production --no-optional

# Copia sorgenti
COPY server.js client.js shazam_recognition_new.py ./
COPY channels.txt channel_ids.json saved_videos.json* ./

# Verifica FFmpeg disponibile
RUN which ffmpeg && ffmpeg -version | head -1

ENV PORT=3000
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV YTDLP_PATH=yt-dlp
ENV PYTHON_PATH=python3
ENV NODE_ENV=production
EXPOSE ${PORT}

CMD ["node", "server.js"]
