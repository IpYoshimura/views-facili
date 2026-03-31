# ── Build stage ──────────────────────────────────────────────────
FROM python:3.11-slim AS base

# Installa Node.js 20, ffmpeg, e dipendenze di sistema
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl gnupg ffmpeg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installa dipendenze Node.js
COPY package.json package-lock.json* ./
RUN npm install --production || npm install --production --no-optional

# Installa dipendenze Python (mantenendo il fallback Python per backward compatibility)
RUN pip install --no-cache-dir ShazamAPI pydub requests yt-dlp

# Copia sorgenti
COPY server.js client.js shazam_recognition_new.py ./
COPY channels.txt channel_ids.json saved_videos.json* ./

# Porta configurabile (Railway la imposta automaticamente)
ENV PORT=3000
ENV FFMPEG_PATH=ffmpeg
ENV YTDLP_PATH=yt-dlp
ENV PYTHON_PATH=python3
ENV NODE_ENV=production
ENV RAILWAY_ENVIRONMENT=production

EXPOSE ${PORT}

CMD ["node", "server.js"]
