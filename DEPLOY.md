# YouTube Shorts Viewer - Shazam Integration

## 🎵 Novità: Riconoscimento Audio Migliorato

Il server ha ricevuto un **upgrade completo del sistema di riconoscimento audio** per risolvere i problemi su Railway:

### 🚀 Tre strategie di riconoscimento in pipeline:

1. **AudD.io API** (Primary) ⭐
   - Nessuna dipendenza Python
   - Affidabile e veloce
   - Supporta: Spotify, Apple Music, Deezer links

2. **MusicBrainz Database** (Fallback 1)
   - Free API, no rate limiting
   - Ricerca basata su titolo video
   - Database pubblico di 100M+ tracce

3. **Python Script** (Fallback 2)
   - Mantenuto per retrocompatibilità
   - Usa ShazamAPI + Demucs se disponibile

---

## 🔧 Installazione

```bash
npm install
```

### Dipendenze aggiornate:
- `node-fetch` per HTTP requests
- `dotenv` per variabili ambiente
- Python 3.11+ con ShazamAPI, pydub, yt-dlp (per fallback)

---

## 🚢 Deploy su Railway

### Prerequisiti:
- Account Railway.com
- Progetto connesso a GitHub (opzionale)

### Opzione 1: Deploy automatico via GitHub

```bash
git add .
git commit -m "Shazam integration: AudD + MusicBrainz pipeline"
git push origin main
```
Railway sincronizzerà automaticamente e depploierà.

### Opzione 2: Deploy via Railway CLI

```bash
npm install -g @railway/cli
railway login
railway link [project-id]
railway up
```

---

## 📝 Variabili di Ambiente

Configura su Railway:

```
PORT=3000
YOUTUBE_API_KEY=your_key_1
YOUTUBE_API_KEY_2=your_key_2  
YOUTUBE_API_KEY_3=your_key_3
FFMPEG_PATH=/usr/bin/ffmpeg
YTDLP_PATH=yt-dlp
PYTHON_PATH=python3
RAILWAY_ENVIRONMENT=production
NODE_ENV=production
```

---

## ✅ Testing Locale

```bash
# Terminal 1: Avvia il server
PORT=3001 node server.js

# Terminal 2: Testa l'endpoint
curl "http://localhost:3001/api/audio?id=dQw4w9WgXcQ&title=Never+Gonna+Give+You+Up"
```

---

## 📊 Architettura

```
User Request (YouTube Short ID)
    ↓
yt-dlp (Scarica URL audio)
    ↓
recognizeAudioPipeline()
    ├─→ AudD.io API (15s timeout)
    │   └─→ Se timeout → Tentativo seguente
    │
    ├─→ MusicBrainz Search by Title (8s timeout)
    │   └─→ Se fallisce → Tentativo seguente
    │
    └─→ Python Script (60s timeout, backward compat)
        └─→ Ritorna risultati o errore

    ↓
Response JSON con tracks
```

---

## 🐛 Troubleshooting

### "Port already in use"
```bash
PORT=3002 node server.js
```

### AudD timeout
Normale quando la connessione è lenta. Il fallback a MusicBrainz/Python gestisce il caso.

### MusicBrainz HTTP 400
Titoli con caratteri speciali vengono ripuliti automaticamente. Non è un errore critico.

### Python script fallisce
Controlla che ShazamAPI sia installato:
```bash
pip list | grep ShazamAPI
```

---

## 📦 Dockerfile

L'immagine Docker include:
- Python 3.11-slim
- Node.js 20
- FFmpeg
- ShazamAPI + dipendenze Python

Build automatico su Railway ~2min.

---

## 🔗 API Endpoints

- `GET /` - HTML front-end
- `GET /api/shorts` - Lista shorts con filtri
- `GET /api/audio?id=VIDEO_ID&title=TITLE` - **Riconoscimento audio** ⭐
- `GET /api/lookup?id=VIDEO_ID` - Info dettagliate video
- `GET /api/saved` - Video salvati
- `POST /api/saved` - Salva video
- `DELETE /api/saved?id=VIDEO_ID` - Elimina salvato

---

## 📄 Licenza

MIT

---

## 👨‍💻 Supporto

Se Shazam non funziona su Railway:

1. Controlla i logs: `railway logs`
2. Verifica connessione internet da Railway
3. Riavvia il deployment: `railway restart`
4. Controlla variabili di ambiente su Dashboard → Variables

Buon deployment! 🚀
