import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';
import { exec } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config con rotazione chiavi ─────────────────────────────────────────────

let _keys = null;
let _keyIndex = 0;

export function loadConfig() {
  if (_keys) return _keys[_keyIndex % _keys.length];
  const keys = [
    process.env.YOUTUBE_API_KEY,
    process.env.YOUTUBE_API_KEY_2,
    process.env.YOUTUBE_API_KEY_3,
  ].filter(Boolean);
  if (keys.length === 0) {
    console.error('Errore: nessuna YOUTUBE_API_KEY trovata nel file .env');
    process.exit(1);
  }
  _keys = keys;
  console.log(`✓ ${keys.length} chiave/i API caricate`);
  return _keys[0];
}

function rotateKey() {
  _keyIndex = (_keyIndex + 1) % _keys.length;
  console.warn(`⚠ Quota esaurita, rotazione alla chiave ${_keyIndex + 1}/${_keys.length}`);
}

async function fetchWithKeyRotation(buildUrl) {
  loadConfig();
  for (let attempt = 0; attempt < _keys.length; attempt++) {
    const key = _keys[_keyIndex % _keys.length];
    const res = await fetch(buildUrl(key));
    if (res.status === 403 || res.status === 429) { rotateKey(); continue; }
    const data = await res.json();
    if (data.error?.code === 403 || data.error?.errors?.[0]?.reason === 'quotaExceeded') { rotateKey(); continue; }
    return data;
  }
  throw new Error('Tutte le chiavi API hanno la quota esaurita');
}

// ─── Channels ────────────────────────────────────────────────────────────────

export function loadChannels() {
  const filePath = join(__dirname, 'channels.txt');
  let content;
  try { content = readFileSync(filePath, 'utf-8'); }
  catch (err) {
    if (err.code === 'ENOENT') throw new Error('File channels.txt non trovato');
    throw err;
  }
  const handleRegex = /^@[\w.-]+$/;
  const urlRegex = /^https?:\/\/(?:www\.)?youtube\.com\/@([\w.-]+)/;
  return content.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'))
    .reduce((acc, line) => {
      if (handleRegex.test(line)) acc.push(line);
      else { const m = line.match(urlRegex); if (m) acc.push(`@${m[1]}`); }
      return acc;
    }, []);
}

// ─── Channel ID cache ─────────────────────────────────────────────────────────

const CACHE_FILE = join(__dirname, 'channel_ids.json');
function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); } catch { return {}; }
}
function saveCache(cache) {
  try { writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch (e) { console.error(e.message); }
}
async function resolveChannelId(handle, cache) {
  if (cache[handle]) return cache[handle];
  const h = handle.startsWith('@') ? handle.slice(1) : handle;
  const data = await fetchWithKeyRotation(key => `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(h)}&key=${key}`);
  if (!data.items || data.items.length === 0) throw new Error(`Canale non trovato: ${handle}`);
  cache[handle] = data.items[0].id;
  saveCache(cache);
  console.log(`✓ ${handle} → ${cache[handle]}`);
  return cache[handle];
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}
export function parseDuration(duration) {
  const m = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}
export function validateMinViews(value) {
  const num = Number(value);
  return (Number.isInteger(num) && num > 0) ? num : 1_000_000;
}

// ─── RSS ─────────────────────────────────────────────────────────────────────

async function fetchRssFeed(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`RSS error ${res.status}`);
  return res.text();
}
function parseRssEntries(xml) {
  const entries = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const videoId = (b.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1];
    const title = (b.match(/<title>(.*?)<\/title>/) || [])[1];
    const published = (b.match(/<published>(.*?)<\/published>/) || [])[1];
    const channelName = (b.match(/<name>(.*?)<\/name>/) || [])[1];
    if (videoId && title && published)
      entries.push({ videoId, title: title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"'), published, channelName: channelName || '', thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` });
  }
  return entries;
}

// ─── Stats API ───────────────────────────────────────────────────────────────

async function fetchVideoStats(videoIds) {
  if (videoIds.length === 0) return {};
  const map = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50).join(',');
    const data = await fetchWithKeyRotation(key => `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${batch}&key=${key}`);
    for (const v of (data.items || []))
      map[v.id] = { 
        duration: parseDuration(v.contentDetails?.duration || 'PT0S'), 
        views: parseInt(v.statistics?.viewCount || '0', 10), 
        likes: parseInt(v.statistics?.likeCount || '0', 10),
        comments: parseInt(v.statistics?.commentCount || '0', 10)
      };
  }
  return map;
}

// ─── Fetch shorts per canale ─────────────────────────────────────────────────

async function fetchShortsForChannel(handle, cutoffDate, cache) {
  try {
    const channelId = await resolveChannelId(handle, cache);
    const xml = await fetchRssFeed(channelId);
    const entries = parseRssEntries(xml).filter(e => new Date(e.published) >= cutoffDate);
    if (entries.length === 0) return { shorts: [], error: null };
    const statsMap = await fetchVideoStats(entries.map(e => e.videoId));
    const shorts = [];
    
    // Prima passa: calcola tutti i rapporti
    const allShorts = [];
    for (const e of entries) {
      const stats = statsMap[e.videoId];
      if (!stats || stats.duration > 180) continue;
      
      // Calcola views/ora (dato REALE)
      const now = Date.now();
      const publishTime = new Date(e.published).getTime();
      const hoursElapsed = Math.max(0.1, (now - publishTime) / (1000 * 60 * 60));
      const viewsPerHour = Math.round(stats.views / hoursElapsed);
      
      // Calcola rapporti di engagement
      const likeRatio = stats.views > 0 ? (stats.likes / stats.views) * 100 : 0; // %
      const commentRatio = stats.views > 0 ? (stats.comments / stats.views) * 100 : 0; // %
      const engagementRatio = likeRatio + commentRatio; // %
      
      allShorts.push({
        id: e.videoId,
        title: e.title,
        channelName: e.channelName,
        thumbnail: e.thumbnail,
        views: stats.views,
        likes: stats.likes,
        comments: stats.comments,
        viewsPerHour,
        likeRatio,
        commentRatio,
        engagementRatio,
        publishedAt: e.published,
        url: `https://www.youtube.com/shorts/${e.videoId}`,
        rank: 'gray' // default
      });
    }
    
    // Seconda passa: assegna rank basato su engagement % (threshold fisso)
    for (const short of allShorts) {
      const eng = short.engagementRatio;
      if (eng >= 4) short.rank = 'diamond';          // 💎 4%+
      else if (eng >= 2.5) short.rank = 'gold';           // 🥇 2.5%+
      else if (eng >= 2 && eng < 2.5) short.rank = 'silver';  // 🥈 2-2.5%
      else if (eng >= 1 && eng < 2) short.rank = 'bronze';  // 🥉 1-1.9%
      else short.rank = 'gray';                    // ⚫ < 1%
    }
    
    for (const short of allShorts) {
      shorts.push(short);
    }
    return { shorts, error: null };
  } catch (err) {
    console.error(`Errore per il canale ${handle}:`, err.message);
    return { shorts: [], error: { channel: handle, message: err.message } };
  }
}

// ─── Saved videos ─────────────────────────────────────────────────────────────

const SAVED_FILE = join(__dirname, 'saved_videos.json');
function loadSaved() {
  if (!existsSync(SAVED_FILE)) return {};
  try { return JSON.parse(readFileSync(SAVED_FILE, 'utf-8')); } catch { return {}; }
}
function saveSaved(data) {
  try { writeFileSync(SAVED_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error(e.message); }
}

async function handleSavedApi(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET') {
    const saved = loadSaved();
    // Aggiungi calcoli di engagement e ranking ai salvati
    for (const id in saved) {
      const item = saved[id];
      if (item.views && item.likes !== undefined && item.comments !== undefined) {
        // Calcola metriche
        const now = Date.now();
        const publishTime = new Date(item.publishedAt).getTime();
        const hoursElapsed = Math.max(0.1, (now - publishTime) / (1000 * 60 * 60));
        item.viewsPerHour = Math.round(item.views / hoursElapsed);
        item.likeRatio = item.views > 0 ? (item.likes / item.views) * 100 : 0;
        item.commentRatio = item.views > 0 ? (item.comments / item.views) * 100 : 0;
        item.engagementRatio = item.likeRatio + item.commentRatio;
        
        // Assegna rank
        const eng = item.engagementRatio;
        if (eng >= 4) item.rank = 'diamond';
        else if (eng >= 2.5) item.rank = 'gold';
        else if (eng >= 2 && eng < 2.5) item.rank = 'silver';
        else if (eng >= 1 && eng < 2) item.rank = 'bronze';
        else item.rank = 'gray';
      }
    }
    res.writeHead(200); res.end(JSON.stringify(saved)); return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id, user, title, thumbnail, channelName, views, likes, comments, publishedAt, videoUrl } = JSON.parse(body);
        const saved = loadSaved();
        if (!saved[id]) saved[id] = { id, title, thumbnail, channelName, views, likes, comments: comments || 0, publishedAt, videoUrl, users: [], copied: false };
        if (!saved[id].users.includes(user)) saved[id].users.push(user);
        saveSaved(saved);
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end('{}'); }
    }); return;
  }
  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    const saved = loadSaved();
    if (saved[id]) { delete saved[id]; saveSaved(saved); }
    res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.method === 'PATCH') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id, copied } = JSON.parse(body);
        const saved = loadSaved();
        if (saved[id]) { saved[id].copied = copied; saveSaved(saved); }
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end('{}'); }
    }); return;
  }
  res.writeHead(405); res.end('Method Not Allowed');
}

// ─── Audio recognition endpoint (Shazam-like speed) ─────────────────────────

const YTDLP = process.env.YTDLP_PATH || (process.platform === 'win32'
  ? 'C:\\Users\\Hollylamiglioryoutub\\AppData\\Local\\Packages\\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\\LocalCache\\local-packages\\Python313\\Scripts\\yt-dlp.exe'
  : 'yt-dlp');
const FFMPEG_PATH = process.env.FFMPEG_PATH || (process.platform === 'win32'
  ? 'F:\\Cose Mie\\ffmpeg-7.1.1-essentials_build\\bin\\ffmpeg.exe'
  : 'ffmpeg');
const PYTHON = process.env.PYTHON_PATH || (process.platform === 'win32'
  ? join(__dirname, '.venv', 'Scripts', 'python.exe')
  : 'python3');

async function shazamRecognize(audioUrl, videoTitle = '') {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  try {
    console.log(`⚡ Ricerca rapida da titolo video...`);
    const { stdout } = await execFileAsync(PYTHON, [
      join(__dirname, 'shazam_recognition_new.py'),
      audioUrl,
      videoTitle
    ], { timeout: 180000, maxBuffer: 20 * 1024 * 1024 });

    try {
      return JSON.parse(stdout);
    } catch (parseErr) {
      console.warn('JSON parse error from shazam script stdout:', parseErr.message);
      return { error: 'Impossibile interpretare la risposta di Shazam' };
    }
  } catch (err) {
    // Proviamo comunque a leggere stdout, se presente
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch (parseErr) {
        console.warn('JSON parse error from shazam script err.stdout:', parseErr.message);
      }
    }
    console.error(`Errore riconoscimento:`, err.message?.substring(0, 300));
    // Non mostrare l'intero comando + stderr all'utente
    const shortMsg = err.killed ? 'Timeout riconoscimento audio' :
      err.code ? `Processo terminato con codice ${err.code}` :
      'Errore nel riconoscimento audio';
    return { error: shortMsg };
  }
}

async function handleAudioApi(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.writeHead(405); res.end('{}'); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const videoId = url.searchParams.get('id');
  const videoTitle = url.searchParams.get('title') || '';
  if (!videoId) { res.writeHead(400); res.end(JSON.stringify({ error: 'id mancante' })); return; }

  const videoUrl = `https://www.youtube.com/shorts/${videoId}`;
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  let audioUrl;
  try {
    const { stdout } = await execFileAsync(YTDLP, [
      '--get-url', '-f', 'bestaudio', '--no-playlist', videoUrl,
      '--ffmpeg-location', FFMPEG_PATH
    ], { timeout: 30000 });
    audioUrl = stdout.trim().split('\n')[0];
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Impossibile ottenere URL audio: ' + err.message }));
    return;
  }

  // Riconoscimento veloce tipo Shazam (usa titolo video se disponibile)
  const result = await shazamRecognize(audioUrl, videoTitle);

  res.writeHead(200);
  if (result.success && result.results && result.results.length > 0) {
    res.end(JSON.stringify({
      audioUrl,
      recognized: true,
      tracks: result.results,
      message: `⚡ Riconosciuto! (${result.results.length} traccia/e trovata/e)`
    }));
  } else if (result.error) {
    res.end(JSON.stringify({
      audioUrl,
      recognized: false,
      error: result.error,
      message: '❌ ' + result.error
    }));
  } else {
    res.end(JSON.stringify({
      audioUrl,
      recognized: false,
      message: result.message || '❌ Audio non riconosciuto. Potrebbe essere un audio meme o custom.',
      results: []
    }));
  }
}

// ─── Lookup singolo short da link ────────────────────────────────────────────

async function handleLookupApi(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const videoId = url.searchParams.get('id');
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'ID video non valido' }));
    return;
  }
  loadConfig();
  try {
    // Fetch snippet + statistics + contentDetails
    const data = await fetchWithKeyRotation(key =>
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoId}&key=${key}`
    );
    if (!data.items || data.items.length === 0) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Video non trovato' }));
      return;
    }
    const v = data.items[0];
    const snippet = v.snippet || {};
    const stats = v.statistics || {};
    const dur = parseDuration(v.contentDetails?.duration || 'PT0S');
    
    const views = parseInt(stats.viewCount || '0', 10);
    const likes = parseInt(stats.likeCount || '0', 10);
    const comments = parseInt(stats.commentCount || '0', 10);
    const publishedAt = snippet.publishedAt || new Date().toISOString();
    
    const now = Date.now();
    const publishTime = new Date(publishedAt).getTime();
    const hoursElapsed = Math.max(0.1, (now - publishTime) / (1000 * 60 * 60));
    const viewsPerHour = Math.round(views / hoursElapsed);
    const likeRatio = views > 0 ? (likes / views) * 100 : 0;
    const commentRatio = views > 0 ? (comments / views) * 100 : 0;
    const engagementRatio = likeRatio + commentRatio;
    
    let rank = 'gray';
    if (engagementRatio >= 4) rank = 'diamond';
    else if (engagementRatio >= 2.5) rank = 'gold';
    else if (engagementRatio >= 2) rank = 'silver';
    else if (engagementRatio >= 1) rank = 'bronze';
    
    const short = {
      id: videoId,
      title: snippet.title || '',
      channelName: snippet.channelTitle || '',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      views, likes, comments,
      viewsPerHour, likeRatio, commentRatio, engagementRatio,
      publishedAt,
      duration: dur,
      rank,
      url: `https://www.youtube.com/shorts/${videoId}`
    };
    res.writeHead(200);
    res.end(JSON.stringify({ short }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

export async function handleApiShorts(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const periodParam = parseInt(url.searchParams.get('period') ?? '7', 10);
  const period = [1, 2, 7].includes(periodParam) ? periodParam : 7;
  const minViews = validateMinViews(url.searchParams.get('minViews') ?? '1000000');
  const cutoffDate = new Date(Date.now() - period * 24 * 60 * 60 * 1000);
  res.setHeader('Content-Type', 'application/json');
  let channels;
  try { channels = loadChannels(); }
  catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
  loadConfig();
  const cache = loadCache();
  const results = await Promise.all(channels.map(ch => fetchShortsForChannel(ch, cutoffDate, cache)));
  const allShorts = [], allErrors = [];
  for (const { shorts, error } of results) { allShorts.push(...shorts); if (error) allErrors.push(error); }
  const now = Date.now();
  const filtered = allShorts.filter(s => {
    const ageMs = now - new Date(s.publishedAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    // Mostra se ≥1M, oppure se ha meno di 2 giorni e ≥800k
    return s.views >= minViews || (ageDays <= 2 && s.views >= 800_000);
  }).sort((a, b) => b.views - a.views);
  res.writeHead(200);
  res.end(JSON.stringify({ shorts: filtered, errors: allErrors, channelCount: channels.length }));
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

export function getHtml() {
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>YouTube Shorts Viewer</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f0f0f;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh}
    header{background:#1a1a1a;border-bottom:2px solid #ff0000;padding:14px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
    header h1{font-size:1.3rem;font-weight:700;color:#fff}
    header h1 span{color:#ff0000}
    .tab-btns{display:flex;gap:8px}
    .tab-btn{background:#2a2a2a;color:#ccc;border:1px solid #3a3a3a;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:0.9rem;transition:background .15s}
    .tab-btn.active{background:#ff0000;color:#fff;border-color:#ff0000}
    .controls{background:#1a1a1a;padding:12px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;border-bottom:1px solid #2a2a2a}
    .period-group{display:flex;gap:8px;align-items:center}
    .period-group label{font-size:.85rem;color:#aaa}
    .btn-period{background:#2a2a2a;color:#ccc;border:1px solid #3a3a3a;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:.9rem;transition:background .15s}
    .btn-period:hover{background:#333;color:#fff}
    .btn-period.active{background:#ff0000;color:#fff;border-color:#ff0000}
    .views-group{display:flex;align-items:center;gap:8px}
    .views-group label{font-size:.85rem;color:#aaa}
    .views-group input{background:#2a2a2a;color:#e0e0e0;border:1px solid #3a3a3a;border-radius:6px;padding:6px 10px;font-size:.9rem;width:130px;outline:none}
    .views-group input:focus{border-color:#ff0000}
    .views-search-btn{background:#ff0000;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:1rem;transition:background .15s}
    .views-search-btn:hover{background:#cc0000}
    .refresh-info{margin-left:auto;font-size:.8rem;color:#888;text-align:right;line-height:1.6}
    .refresh-info .countdown{color:#ff0000;font-weight:600}
    #statsInfo{color:#ccc;font-size:.85rem;display:block;margin-bottom:2px}
    main{padding:24px}
    .spinner{display:none;justify-content:center;align-items:center;padding:60px 0}
    .spinner.visible{display:flex}
    .spinner-ring{width:48px;height:48px;border:4px solid #2a2a2a;border-top-color:#ff0000;border-radius:50%;animation:spin .8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .empty-msg{display:none;text-align:center;padding:60px 0;color:#888;font-size:1rem}
    .empty-msg.visible{display:block}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}
    .card{background:#1a1a1a;border-radius:10px;overflow:hidden;border:3px solid #2a2a2a;transition:transform .15s,border-color .15s;position:relative}
    .card:hover{transform:translateY(-3px);border-color:#ff0000}
    .card.copied{border-color:#444;opacity:.55}
    .card-rank-diamond{border-color:#00bfff !important;border-width:3px;box-shadow:0 0 16px rgba(0,191,255,.4),inset 0 0 8px rgba(0,191,255,.1)}
    .card-rank-diamond:hover{border-color:#00e5ff !important;box-shadow:0 0 20px rgba(0,191,255,.5),inset 0 0 12px rgba(0,191,255,.15)}
    .card-rank-gold{border-color:#ffd700 !important;box-shadow:0 0 12px rgba(255,215,0,.3)}
    .card-rank-gold:hover{border-color:#ffed4e !important}
    .card-rank-silver{border-color:#c0c0c0 !important;box-shadow:0 0 8px rgba(192,192,192,.2)}
    .card-rank-silver:hover{border-color:#e0e0e0 !important}
    .card-rank-bronze{border-color:#cd7f32 !important;box-shadow:0 0 8px rgba(205,127,50,.2)}
    .card-rank-bronze:hover{border-color:#e8a567 !important}
    .card-rank-gray{border-color:#555 !important}
    .card-rank-gray:hover{border-color:#666 !important}
    .rank-badge{position:absolute;top:8px;right:8px;font-size:1.3rem;z-index:10;background:rgba(0,0,0,.7);padding:4px 8px;border-radius:6px;text-shadow:0 0 4px rgba(255,255,255,.3)}
    .card-thumb{display:block;width:100%;aspect-ratio:9/16;overflow:hidden;background:#111}
    .card-thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:opacity .15s}
    .card-thumb:hover img{opacity:.85}
    .card-body{padding:12px 14px}
    .card-title{font-size:.9rem;font-weight:600;color:#fff;text-decoration:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;margin-bottom:6px}
    .card-title:hover{color:#ff0000}
    .card-channel{font-size:.8rem;color:#aaa;margin-bottom:6px}
    .card-stats{display:flex;gap:12px;font-size:.8rem;color:#ccc;flex-wrap:wrap}
    .card-velocity{display:flex;gap:12px;font-size:.8rem;color:#4caf50;font-weight:600;margin:6px 0;flex-wrap:wrap;background:#0a2a0a;padding:6px 8px;border-radius:4px}
    .card-date{font-size:.75rem;color:#777;margin-top:5px;pointer-events:none;user-select:none}
    .card-actions{display:flex;align-items:center;gap:6px;margin-top:10px;flex-wrap:wrap}
    .btn-save{background:#2a2a2a;border:1px solid #3a3a3a;border-radius:6px;color:#ccc;cursor:pointer;font-size:.82rem;padding:4px 10px;transition:background .15s}
    .btn-save:hover{background:#333;color:#fff}
    .btn-save.saved{background:#1a3a1a;border-color:#2a6a2a;color:#4caf50;cursor:default}
    .btn-copied{background:#2a2a2a;border:1px solid #3a3a3a;border-radius:6px;color:#ccc;cursor:pointer;font-size:.82rem;padding:4px 10px;transition:background .15s}
    .btn-copied:hover{background:#333}
    .btn-copied.done{background:#1a2a3a;border-color:#2a4a6a;color:#64b5f6}
    .btn-remove{background:#3a1a1a;border:1px solid #6a2a2a;border-radius:6px;color:#f44336;cursor:pointer;font-size:.8rem;padding:4px 8px;transition:background .15s}
    .btn-remove:hover{background:#4a1a1a}
    .btn-audio{background:#1a2a3a;border:1px solid #2a4a6a;border-radius:6px;color:#64b5f6;cursor:pointer;font-size:.82rem;padding:4px 10px;transition:background .15s}
    .btn-audio:hover{background:#1e3a5a}
    .btn-audio.loading{opacity:.6;cursor:wait}
    .search-bar{display:flex;gap:8px;align-items:center;width:100%;margin-top:8px}
    .search-bar input{flex:1;background:#2a2a2a;color:#e0e0e0;border:1px solid #3a3a3a;border-radius:6px;padding:8px 12px;font-size:.9rem;outline:none}
    .search-bar input:focus{border-color:#ff0000}
    .search-bar input::placeholder{color:#666}
    .search-bar button{background:#ff0000;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:.9rem;color:#fff;font-weight:600;transition:background .15s;white-space:nowrap}
    .search-bar button:hover{background:#cc0000}
    .search-bar button:disabled{opacity:.5;cursor:wait}
    .badge{display:inline-block;border-radius:4px;padding:2px 7px;font-size:.72rem;font-weight:700}
    .badge-arkadia{background:#1a3a5c;color:#64b5f6}
    .badge-holly{background:#3a1a2a;color:#f48fb1}
    /* Popup */
    .popup-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;justify-content:center;align-items:center}
    .popup-overlay.visible{display:flex}
    .popup{background:#1a1a1a;border:1px solid #3a3a3a;border-radius:14px;padding:28px 32px;min-width:280px;text-align:center}
    .popup h3{color:#fff;margin-bottom:20px;font-size:1.05rem}
    .popup-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
    .btn-arkadia{background:#1a3a5c;color:#64b5f6;border:1px solid #2a5a8c;border-radius:8px;padding:10px 22px;cursor:pointer;font-size:.95rem;font-weight:700;transition:background .15s}
    .btn-arkadia:hover{background:#1e4a7a}
    .btn-holly{background:#3a1a2a;color:#f48fb1;border:1px solid #6a2a4a;border-radius:8px;padding:10px 22px;cursor:pointer;font-size:.95rem;font-weight:700;transition:background .15s}
    .btn-holly:hover{background:#4a1a3a}
    .btn-cancel{background:#2a2a2a;color:#aaa;border:1px solid #3a3a3a;border-radius:8px;padding:10px 22px;cursor:pointer;font-size:.95rem;transition:background .15s}
    .btn-cancel:hover{background:#333}
  </style>
</head>
<body>
  <header>
    <h1><span>YouTube</span> Shorts Viewer</h1>
    <div class="tab-btns">
      <button class="tab-btn active" id="tabFeed">Feed</button>
      <button class="tab-btn" id="tabSaved">⭐ Salvati</button>
    </div>
  </header>
  <div class="controls" id="controls">
    <div class="period-group">
      <label>Periodo:</label>
      <button class="btn-period" data-period="1">1g</button>
      <button class="btn-period" data-period="2">2g</button>
      <button class="btn-period active" data-period="7">7g</button>
    </div>
    <div class="views-group">
      <label for="minViews">Min. views:</label>
      <input type="number" id="minViews" value="1000000" min="1" step="1"/>
      <button class="views-search-btn" id="searchBtn" title="Cerca">🔍</button>
    </div>
    <div class="refresh-info">
      <span id="statsInfo"></span>
      Auto-refresh ogni 5 min &nbsp;|&nbsp; Prossimo: <span class="countdown" id="countdown">5:00</span>
    </div>
    <div class="search-bar">
      <input type="text" id="shortLinkInput" placeholder="Incolla link Short (es. https://youtube.com/shorts/abc123)" />
      <button id="shortLookupBtn">🔍 Cerca Short</button>
    </div>
  </div>
  <main>
    <div class="spinner" id="spinner"><div class="spinner-ring"></div></div>
    <div class="empty-msg" id="emptyMsg">Nessuno Short trovato con i filtri selezionati</div>
    <div class="grid" id="grid"></div>
  </main>

  <div class="popup-overlay" id="popupOverlay">
    <div class="popup">
      <h3>Chi salva questo video?</h3>
      <div class="popup-btns">
        <button class="btn-arkadia" id="popupArkadia">🔵 Arkadia</button>
        <button class="btn-holly" id="popupHolly">🌸 Holly</button>
        <button class="btn-cancel" id="popupCancel">Annulla</button>
      </div>
    </div>
  </div>

  <div class="popup-overlay" id="audioOverlay">
    <div class="popup" style="min-width:320px;text-align:left">
      <h3 style="text-align:center;margin-bottom:16px">🎵 Riconoscimento Audio</h3>
      <div id="audioResult" style="font-size:.9rem;line-height:1.7;color:#e0e0e0"></div>
      <div style="text-align:center;margin-top:20px">
        <button class="btn-cancel" id="audioClose">Chiudi</button>
      </div>
    </div>
  </div>
  <script src="/client.js"></script>
</body>
</html>`;
    let currentTab='feed',savedData={},pendingSave=null;
    const videoMap={};

    function fmt(n){if(n>=1000000)return(n/1000000).toFixed(1)+'M';if(n>=1000)return(n/1000).toFixed(1)+'K';return String(n)}
    function fmtDate(iso){const d=new Date(iso);return String(d.getDate()).padStart(2,'0')+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+d.getFullYear()}

    function startCountdown(){
      clearInterval(countdownTimer);countdownSeconds=300;
      countdownTimer=setInterval(()=>{
        if(--countdownSeconds<0)countdownSeconds=0;
        const m=Math.floor(countdownSeconds/60),s=countdownSeconds%60;
        document.getElementById('countdown').textContent=m+':'+String(s).padStart(2,'0');
      },1000);
    }

    async function loadSaved(){const r=await fetch('/api/saved');savedData=await r.json()}

    function getBadges(id){
      const e=savedData[id];if(!e||!e.users||!e.users.length)return '';
      return e.users.map(u=>u==='Arkadia'?'<span class="badge badge-arkadia">Arkadia</span>':'<span class="badge badge-holly">Holly</span>').join(' ');
    }

    function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

    function buildCard(s,forSaved){
      const url='https://www.youtube.com/shorts/'+s.id;
      videoMap[s.id]=s;
      const saved=!!savedData[s.id];
      const copied=savedData[s.id]?.copied===true;
      const badges=getBadges(s.id);
      const rankClass='card-rank-'+(s.rank||'gray');
      const rankEmoji=s.rank==='diamond'?'💎':s.rank==='gold'?'🥇':s.rank==='silver'?'🥈':s.rank==='bronze'?'🥉':'⚫';
      const fireIcon=s.viewsPerHour>100000?'🔥':'';
      return '<div class="card '+rankClass+(copied?' copied':'')+'" data-id="'+s.id+'">'+'<div class="rank-badge">'+rankEmoji+'</div>'
        +'<a class="card-thumb" href="'+url+'" target="_blank" rel="noopener noreferrer"><img src="'+esc(s.thumbnail)+'" alt="" loading="lazy"/></a>'
        +'<div class="card-body">'
        +'<a class="card-title" href="'+url+'" target="_blank" rel="noopener noreferrer">'+esc(s.title)+'</a>'
        +'<div class="card-channel">'+esc(s.channelName)+'</div>'
        +'<div class="card-stats"><span>👁 '+fmt(s.views)+'</span><span>👍 '+fmt(s.likes)+'</span></div>'
        +'<div class="card-velocity"><span>⚡ '+fmt(s.viewsPerHour||0)+'/h'+fireIcon+'</span><span>📊 '+((s.engagementRatio||0).toFixed(2))+'% eng.</span></div>'
        +'<div class="card-date">'+fmtDate(s.publishedAt)+'</div>'
        +'<div class="card-actions">'
        +'<button class="btn-save'+(saved?' saved':'')+'" data-id="'+s.id+'">'+(saved?'✓ Salvato':'+ Salva')+'</button>'
        +(saved?'<button class="btn-copied'+(copied?' done':'')+'" data-id="'+s.id+'">'+(copied?'✅ Copiato':'📋 Segna copiato')+'</button>':'')
        +(badges?'<span>'+badges+'</span>':'')
        +(forSaved?'<button class="btn-remove" data-id="'+s.id+'">🗑</button>':'')
        +'<button class="btn-audio" data-id="'+s.id+'">🎵 Audio</button>'
        +'</div></div></div>';
    }

    function attachEvents(){
      document.querySelectorAll('.btn-save').forEach(btn=>{
        if(btn.classList.contains('saved'))return;
        btn.addEventListener('click',()=>{
          const id=btn.dataset.id;
          const s=videoMap[id];
          if(!s)return;
          pendingSave={id:s.id,title:s.title,thumbnail:s.thumbnail,channelName:s.channelName,views:s.views,likes:s.likes,publishedAt:s.publishedAt,videoUrl:'https://www.youtube.com/shorts/'+s.id};
          document.getElementById('popupOverlay').classList.add('visible');
        });
      });
      document.querySelectorAll('.btn-copied').forEach(btn=>{
        btn.addEventListener('click',async()=>{
          const id=btn.dataset.id,newVal=!(savedData[id]?.copied===true);
          await fetch('/api/saved',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,copied:newVal})});
          await loadSaved();
          currentTab==='saved'?renderSaved():fetchShorts();
        });
      });
      document.querySelectorAll('.btn-remove').forEach(btn=>{
        btn.addEventListener('click',async()=>{
          await fetch('/api/saved?id='+btn.dataset.id,{method:'DELETE'});
          await loadSaved();renderSaved();
        });
      });
      document.querySelectorAll('.btn-audio').forEach(btn=>{
        btn.addEventListener('click',async()=>{
          const id=btn.dataset.id;
          btn.textContent='⏳ Analisi...';btn.classList.add('loading');btn.disabled=true;
          try{
            const r=await fetch('/api/audio?id='+id);
            const data=await r.json();
            const res=document.getElementById('audioResult');
            if(data.error){res.innerHTML='<span style="color:#f44336">Errore: '+data.error+'</span>';}
            else{
              const a=data.audd?.result;
              let html='';
              if(a&&a.title){
                html+='<b>🎵 Canzone:</b> '+a.title+'<br>';
                html+='<b>🎤 Artista:</b> '+a.artist+'<br>';
                if(a.album)html+='<b>💿 Album:</b> '+a.album+'<br>';
                if(a.release_date)html+='<b>📅 Data:</b> '+a.release_date+'<br>';
                if(a.spotify?.external_urls?.spotify)html+='<br><a href="'+a.spotify.external_urls.spotify+'" target="_blank" style="color:#1db954">▶ Apri su Spotify</a><br>';
                if(a.apple_music?.url)html+='<a href="'+a.apple_music.url+'" target="_blank" style="color:#fc3c44">🍎 Apri su Apple Music</a><br>';
              }else{
                html='<span style="color:#aaa">Canzone non riconosciuta.</span><br>';
              }
              html+='<br><a href="'+data.audioUrl+'" target="_blank" style="color:#64b5f6;font-size:.8rem">🔗 URL audio diretto</a>';
              res.innerHTML=html;
            }
            document.getElementById('audioOverlay').classList.add('visible');
          }catch(e){
            alert('Errore durante l\'analisi audio.');
          }finally{
            btn.textContent='🎵 Audio';btn.classList.remove('loading');btn.disabled=false;
          }
        });
      });
    }

    async function fetchShorts(){
      if(currentTab!=='feed')return;
      const spinner=document.getElementById('spinner'),grid=document.getElementById('grid'),emptyMsg=document.getElementById('emptyMsg'),statsInfo=document.getElementById('statsInfo');
      spinner.classList.add('visible');grid.innerHTML='';emptyMsg.classList.remove('visible');
      try{
        await loadSaved();
        const res=await fetch('/api/shorts?period='+currentPeriod+'&minViews='+currentMinViews);
        const data=await res.json();const shorts=data.shorts||[];
        if(!shorts.length){emptyMsg.classList.add('visible');statsInfo.textContent='';}
        else{
          statsInfo.textContent='📺 '+(data.channelCount||0)+' canali  •  🎬 '+shorts.length+' video';
          grid.innerHTML=shorts.map(s=>buildCard(s,false)).join('');
          attachEvents();
        }
      }catch(e){emptyMsg.textContent='Errore nel caricamento.';emptyMsg.classList.add('visible');}
      finally{spinner.classList.remove('visible');startCountdown();}
    }

    async function renderSaved(){
      await loadSaved();
      const grid=document.getElementById('grid'),emptyMsg=document.getElementById('emptyMsg'),statsInfo=document.getElementById('statsInfo');
      emptyMsg.classList.remove('visible');
      const entries=Object.values(savedData);
      if(!entries.length){grid.innerHTML='';emptyMsg.textContent='Nessun video salvato.';emptyMsg.classList.add('visible');statsInfo.textContent='';}
      else{
        statsInfo.textContent='⭐ '+entries.length+' video salvati';
        grid.innerHTML=entries.map(s=>buildCard(s,true)).join('');
        attachEvents();
      }
    }

    async function saveForUser(user){
      if(!pendingSave)return;
      await fetch('/api/saved',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...pendingSave,user})});
      document.getElementById('popupOverlay').classList.remove('visible');
      pendingSave=null;await loadSaved();
      currentTab==='saved'?renderSaved():fetchShorts();
    }

    document.getElementById('popupArkadia').addEventListener('click',()=>saveForUser('Arkadia'));
    document.getElementById('popupHolly').addEventListener('click',()=>saveForUser('Holly'));
    document.getElementById('popupCancel').addEventListener('click',()=>{document.getElementById('popupOverlay').classList.remove('visible');pendingSave=null;});
    document.getElementById('audioClose').addEventListener('click',()=>document.getElementById('audioOverlay').classList.remove('visible'));

    document.getElementById('tabFeed').addEventListener('click',()=>{
      currentTab='feed';
      document.getElementById('tabFeed').classList.add('active');document.getElementById('tabSaved').classList.remove('active');
      document.getElementById('controls').style.display='';
      document.getElementById('emptyMsg').textContent='Nessuno Short trovato con i filtri selezionati';
      fetchShorts();
    });
    document.getElementById('tabSaved').addEventListener('click',()=>{
      currentTab='saved';
      document.getElementById('tabSaved').classList.add('active');document.getElementById('tabFeed').classList.remove('active');
      document.getElementById('controls').style.display='none';
      renderSaved();
    });

    document.querySelectorAll('.btn-period').forEach(btn=>{
      btn.addEventListener('click',()=>{
        document.querySelectorAll('.btn-period').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');currentPeriod=parseInt(btn.dataset.period,10);fetchShorts();
      });
    });
    const minViewsInput=document.getElementById('minViews');
    function applyMinViews(){
      const val=parseInt(minViewsInput.value,10);
      if(!Number.isInteger(val)||val<=0){currentMinViews=1000000;minViewsInput.value=1000000;}
      else currentMinViews=val;
      fetchShorts();
    }
    minViewsInput.addEventListener('blur',applyMinViews);
}

// ─── Server ───────────────────────────────────────────────────────────────────

export function startServer() {
  const server = http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];
    if (req.method === 'GET' && urlPath === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getHtml());
    } else if (req.method === 'GET' && urlPath === '/client.js') {
      const { readFileSync } = await import('fs');
      const { join, dirname } = await import('path');
      const { fileURLToPath } = await import('url');
      const dir = dirname(fileURLToPath(import.meta.url));
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(readFileSync(join(dir, 'client.js'), 'utf-8'));
    } else if (req.method === 'GET' && urlPath === '/api/shorts') {
      await handleApiShorts(req, res);
    } else if (urlPath === '/api/saved') {
      await handleSavedApi(req, res);
    } else if (req.method === 'GET' && urlPath === '/api/audio') {
      await handleAudioApi(req, res);
    } else if (req.method === 'GET' && urlPath === '/api/lookup') {
      await handleLookupApi(req, res);
    } else {
      res.writeHead(404); res.end('Not Found');
    }
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') { console.error(`Porta ${process.env.PORT || 3000} già in uso`); process.exit(1); }
    throw err;
  });
  const PORT = process.env.PORT || 3000;
  const HOST = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');
  server.listen(PORT, HOST, () => {
    console.log(`Server avviato su http://${HOST}:${PORT}`);
    if (!process.env.RAILWAY_ENVIRONMENT) {
      const cmd = process.platform === 'win32' ? `start http://localhost:${PORT}` : process.platform === 'darwin' ? `open http://localhost:${PORT}` : `xdg-open http://localhost:${PORT}`;
      exec(cmd, () => {});
    }
  });
}

startServer();
