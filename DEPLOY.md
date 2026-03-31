# YouTube Shorts Viewer - Shazam Integration

## 🎵 Novità: Riconoscimento Audio Migliorato

Il server ha ricevuto un **upgrade completo del sistema di riconoscimento audio** per risolvere i problemi su Render/Railway:

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

## ⚠️ Problemi Comuni su Render

### Errore: "Cannot fetch audio from YouTube"

YouTube **blocca i download da datacenter** (incluso Render) con:
- ❌ HTTP 429: Too Many Requests
- ❌ "Sign in to confirm you're not a bot"
- ❌ FFmpeg not found
- ❌ No JavaScript runtime

**Soluzione Implementata (v2):**

✅ **Metodo Ibrido (2-Step Fallback):**
1. **Invidious API** (Primary) - Proxy pubblico di YouTube
   - Bypasssa il bot-check
   - Bypasssa HTTP 429
   - Funziona da qualsiasi datacenter
   - Free, no auth, mirror globali

2. **yt-dlp + MusicBrainz** (Fallback) - Per quando Invidious è down
   - Retry logic (3 tentativi)
   - Riconoscimento per titolo se tutto fallisce

✅ **Dockerfile Semplificato:**
- Node.js 20-slim base (più veloce)
- Python 3 + yt-dlp (fallback)
- Niente FFmpeg richiesto (usa proxy streaming)

---

## 🔧 Installazione

```bash
npm install
```

### Dipendenze aggiornate:
- `node-fetch` per HTTP requests
- `dotenv` per variabili ambiente
- Python 3.11+ con ShazamAPI, pydub, yt-dlp
- FFmpeg + Deno (in Docker)

---

## 🚢 Deploy su Render

### Step 1: Fork/Clone dal GitHub

```bash
git clone https://github.com/IpYoshimura/views-facili.git
cd views-facili
```

### Step 2: Connetti a Render

1. Vai su https://render.com
2. Crea nuovo "Web Service"
3. Seleziona il repository GitHub
4. Configura:
   - **Name**: `youtube-shorts-viewer`
   - **Environment**: `Docker`
   - **Plan**: Free (o Starter)

### Step 3: Configura Variabili di Ambiente

Su Render Dashboard → Environment:

```
PORT=3000
YOUTUBE_API_KEY=your_key_1
YOUTUBE_API_KEY_2=your_key_2  
YOUTUBE_API_KEY_3=your_key_3
FFMPEG_PATH=/usr/bin/ffmpeg
YTDLP_PATH=yt-dlp
PYTHON_PATH=python3
NODE_ENV=production
```

### Step 4: Deploy

```
Render deploya automaticamente quando pushate a GitHub
```

---

## 📝 Variabili di Ambiente

### Obbligatorie:
- `YOUTUBE_API_KEY` - Almeno una chiave API YouTube

### Consigliate (Render):
- `PORT=3000`
- `FFMPEG_PATH=/usr/bin/ffmpeg` ← critica per Render
- `YTDLP_PATH=yt-dlp`
- `NODE_ENV=production`

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
getAudioUrlFromYoutube() [con retry logic]
    ├─→ yt-dlp attempt 1 (30s timeout)
    ├─→ Se HTTP 429: attendi 5s + yt-dlp attempt 2
    ├─→ Se timeout/error: attendi 2s + yt-dlp attempt 3
    └─→ Se fallisce: Fallback a recognition-by-title
    
    ↓ (Se URL ottenuto)
    
recognizeAudioPipeline()
    ├─→ AudD.io API (15s timeout)
    ├─→ MusicBrainz (8s timeout)
    └─→ Python Script (60s timeout)
    
    ↓
Response JSON con tracks
```

---

## 🐛 Troubleshooting

### Errore: "ffmpeg-location ffmpeg does not exist"
**Soluzione:** 
- Render: FFmpeg è installato nel nuovo Dockerfile → rebuild
- Locale: Installa FFmpeg
  ```bash
  # Windows: scaricare da https://ffmpeg.org/download.html
  # Mac: brew install ffmpeg
  # Linux: apt-get install ffmpeg
  ```

### "HTTP Error 429" su Render
**Soluzione:**
- Normale con rate limiting YouTube
- Server adesso ha retry Logic (3 tentativi)
- Fallback a riconoscimento per titolo
- Attendi 5-10 minuti tra request

### "No supported JavaScript runtime"
**Soluzione:**
- Nuovo Dockerfile include Deno
- Forza rebuild: `git commit --allow-empty && git push`

### "Sign in to confirm you're not a bot"
**Soluzione:**
- Aggiunti headers User-Agent anti-bot
- Server adesso ha retry con 3s attesa
- Se persiste: YouTube blocca yt-dlp da datacenter

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

## 👨‍💻 Supporto Render

Se continua a non funzionare:

1. **Leggi i log:**
   ```bash
   # Render Dashboard → Logs → Service Logs
   ```

2. **Verifica FFmpeg:**
   - Render Shell: `which ffmpeg && ffmpeg -version | head -1`

3. **Forza rebuild:**
   - Render Dashboard → Environment → Clear build cache
   - Push un commit: `git commit --allow-empty && git push`

4. **Come ultimo rimedio: Cookiesyt-dlp**
   - Scarica cookies YouTube localmente
   - Aggiungi `--cookies cookies.txt` in server.js
   - Carica cookies.txt su Render

Buon deployment! 🚀
