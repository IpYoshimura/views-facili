import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';
import { exec } from 'child_process';
import fetch from 'node-fetch';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_MIN_VIEWS = 1_000_000;
const DEFAULT_PERIOD_DAYS = 7;
const DEFAULT_CACHE_COVERAGE_DAYS = 7;
const RECENT_EXCEPTION_MIN_VIEWS = 800_000;
const RECENT_EXCEPTION_MAX_HOURS = 24;

// ─── Config con rotazione chiavi ─────────────────────────────────────────────

let _keys = null;
let _keyIndex = 0;
const CREDITS_FILE = join(__dirname, 'key_credits.json');

function loadKeyCredits() {
  if (!existsSync(CREDITS_FILE)) return {};
  try { return JSON.parse(readFileSync(CREDITS_FILE, 'utf-8')); } catch { return {}; }
}
function saveKeyCredits(credits) {
  try { writeFileSync(CREDITS_FILE, JSON.stringify(credits, null, 2)); } catch (e) { console.error(e.message); }
}

let lastResetDate = null;
function checkAndResetCreditsIfMidnight() {
  const now = new Date();
  const currentDate = now.getUTCDate();
  
  if (lastResetDate !== currentDate) {
    lastResetDate = currentDate;
    const keys = [
      process.env.YOUTUBE_API_KEY,
      process.env.YOUTUBE_API_KEY_2,
      process.env.YOUTUBE_API_KEY_3,
      process.env.YOUTUBE_API_KEY_4,
      process.env.YOUTUBE_API_KEY_5,
      process.env.YOUTUBE_API_KEY_6,
      process.env.YOUTUBE_API_KEY_7,
      process.env.YOUTUBE_API_KEY_8,
    ].filter(Boolean);
    
    if (keys.length > 0) {
      const resetCredits = {};
      for (const key of keys) {
        resetCredits[key] = 10000;
      }
      resetCredits._resetInfo = 'Crediti si resettano ogni giorno a mezzanotte UTC';
      saveKeyCredits(resetCredits);
      console.log(`✅ Crediti resettati a 10000 per tutte le ${keys.length} chiavi`);
    }
  }
}

// ─── Tracciamento crediti consumati ───────────────────────────────────────────

let sessionCreditsUsed = 0;
const CREDITS_COST = {
  RESOLVE_CHANNEL: 1,
  GET_UPLOADS_PLAYLIST: 1,
  LIST_UPLOADS_PAGE: 1,
  GET_STATS_PER_50: 1
};

function addCreditsUsed(amount) {
  sessionCreditsUsed += amount;
  console.log(`💰 Crediti usati: +${amount} (Sessione: ${sessionCreditsUsed})`);
}

function resetSessionCredits() {
  sessionCreditsUsed = 0;
}

function estimateCreditsForFetch(channelCount, avgVideosPerChannel = 50, periodDays = DEFAULT_PERIOD_DAYS) {
  const resolveChannelCost = channelCount * CREDITS_COST.RESOLVE_CHANNEL;
  const uploadsPlaylistCost = channelCount * CREDITS_COST.GET_UPLOADS_PLAYLIST;
  const playlistPagesPerChannel = getPlaylistPageLimit(periodDays);
  const playlistItemsCost = channelCount * playlistPagesPerChannel * CREDITS_COST.LIST_UPLOADS_PAGE;
  const statsCost = Math.ceil((channelCount * avgVideosPerChannel) / 50) * CREDITS_COST.GET_STATS_PER_50;
  return {
    resolveChannels: resolveChannelCost,
    uploadsPlaylists: uploadsPlaylistCost,
    playlistItems: playlistItemsCost,
    stats: statsCost,
    total: resolveChannelCost + uploadsPlaylistCost + playlistItemsCost + statsCost
  };
}

export function loadConfig() {
  if (_keys) return _keys[_keyIndex % _keys.length];
  const keys = [
    process.env.YOUTUBE_API_KEY,
    process.env.YOUTUBE_API_KEY_2,
    process.env.YOUTUBE_API_KEY_3,
    process.env.YOUTUBE_API_KEY_4,
    process.env.YOUTUBE_API_KEY_5,
    process.env.YOUTUBE_API_KEY_6,
    process.env.YOUTUBE_API_KEY_7,
    process.env.YOUTUBE_API_KEY_8,
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
  const seen = new Set();
  return content.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'))
    .reduce((acc, line) => {
      const normalized = normalizeChannelEntry(line);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        acc.push(normalized);
      }
      return acc;
    }, []);
}

function normalizeUnicodeValue(value) {
  return String(value || '').trim().normalize('NFC');
}

function decodeUrlComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeYoutubePathSegment(segment) {
  const decoded = decodeUrlComponentSafe(String(segment || ''));
  return normalizeUnicodeValue(decoded).replace(/\/+$/, '');
}

function normalizeChannelEntry(entry) {
  const value = normalizeUnicodeValue(entry);
  if (!value) return null;
  if (/^@.+$/.test(value)) return normalizeYoutubePathSegment(value);
  if (/^UC[\w-]{20,}$/.test(value)) return value;
  if (!/^https?:\/\//i.test(value)) return null;

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'youtube.com' && host !== 'm.youtube.com') return null;

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;

    const firstPart = normalizeYoutubePathSegment(parts[0]);
    const secondPart = normalizeYoutubePathSegment(parts[1] || '');

    if (firstPart.startsWith('@')) return `@${firstPart.slice(1)}`;
    if (firstPart === 'channel' && secondPart) return secondPart;
    if ((firstPart === 'c' || firstPart === 'user') && secondPart) {
      return `https://www.youtube.com/${firstPart}/${encodeURIComponent(secondPart)}`;
    }
    return `https://www.youtube.com/${encodeURIComponent(firstPart)}`;
  } catch {
    return null;
  }
}

// ─── Channel ID cache ─────────────────────────────────────────────────────────

const CACHE_FILE = join(__dirname, 'channel_ids.json');
const SHORTS_CACHE_FILE = join(__dirname, 'shorts_cache.json');
const FEED_CACHE_FILE = join(__dirname, 'feed_cache.json');
const FEED_CACHE_TTL = 3600000; // 1 ora in ms

function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')); } catch { return {}; }
}
function saveCache(cache) {
  try { writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch (e) { console.error(e.message); }
}
function loadShortsCache() {
  if (!existsSync(SHORTS_CACHE_FILE)) return { data: [], timestamp: 0 };
  try { return JSON.parse(readFileSync(SHORTS_CACHE_FILE, 'utf-8')); } catch { return { data: [], timestamp: 0 }; }
}
function saveShortsCache(shorts) {
  try { writeFileSync(SHORTS_CACHE_FILE, JSON.stringify({ data: shorts, timestamp: Date.now() }, null, 2)); } catch (e) { console.error(e.message); }
}
function loadFeedCache() {
  if (!existsSync(FEED_CACHE_FILE)) return { data: [], timestamp: 0, coverageDays: DEFAULT_CACHE_COVERAGE_DAYS, summary: null };
  try {
    const cached = JSON.parse(readFileSync(FEED_CACHE_FILE, 'utf-8'));
    return {
      data: Array.isArray(cached.data) ? cached.data : [],
      timestamp: cached.timestamp || 0,
      coverageDays: Number.isInteger(cached.coverageDays) && cached.coverageDays > 0
        ? cached.coverageDays
        : DEFAULT_CACHE_COVERAGE_DAYS,
      summary: cached.summary && typeof cached.summary === 'object' ? cached.summary : null,
      channelSignature: typeof cached.channelSignature === 'string' ? cached.channelSignature : '',
      channelCount: Number.isInteger(cached.channelCount) ? cached.channelCount : 0
    };
  } catch {
    return { data: [], timestamp: 0, coverageDays: DEFAULT_CACHE_COVERAGE_DAYS, summary: null, channelSignature: '', channelCount: 0 };
  }
}
function getChannelsSignature(channels) {
  return [...channels].map(channel => String(channel || '').trim()).filter(Boolean).sort().join('\n');
}

function saveFeedCache(shorts, coverageDays, summary = null, channels = []) {
  try {
    writeFileSync(FEED_CACHE_FILE, JSON.stringify({
      data: shorts,
      timestamp: Date.now(),
      coverageDays,
      summary,
      channelSignature: getChannelsSignature(channels),
      channelCount: channels.length
    }, null, 2));
  } catch (e) { console.error(e.message); }
}

function normalizeHandleForComparison(value) {
  return normalizeUnicodeValue(value)
    .replace(/^@+/, '')
    .toLowerCase();
}

async function resolveChannelIdBySearchQuery(query) {
  const target = normalizeHandleForComparison(query);
  if (!target) return null;

  const searchData = await fetchWithKeyRotation(apiKey =>
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(query)}&maxResults=5&key=${apiKey}`
  );

  const candidateIds = [...new Set(
    (searchData.items || [])
      .map(item => item?.id?.channelId)
      .filter(Boolean)
  )];

  if (candidateIds.length === 0) return null;
  if (candidateIds.length === 1) return candidateIds[0];

  const channelData = await fetchWithKeyRotation(apiKey =>
    `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${encodeURIComponent(candidateIds.join(','))}&key=${apiKey}`
  );

  const matchesByCustomUrl = (channelData.items || []).filter(item =>
    normalizeHandleForComparison(item?.snippet?.customUrl || '') === target
  );
  if (matchesByCustomUrl.length === 1) return matchesByCustomUrl[0].id;

  const matchesByTitle = (channelData.items || []).filter(item =>
    normalizeHandleForComparison(item?.snippet?.title || '') === target
  );
  if (matchesByTitle.length === 1) return matchesByTitle[0].id;

  const includesMatches = (channelData.items || []).filter(item => {
    const customUrl = normalizeHandleForComparison(item?.snippet?.customUrl || '');
    const title = normalizeHandleForComparison(item?.snippet?.title || '');
    return customUrl.includes(target) || title.includes(target);
  });
  if (includesMatches.length === 1) return includesMatches[0].id;

  return null;
}

async function resolveChannelId(handle, cache) {
  const key = normalizeUnicodeValue(handle);
  if (cache[key]) return cache[key];
  if (/^UC[\w-]{20,}$/.test(key)) {
    cache[key] = key;
    saveCache(cache);
    return key;
  }

  if (/^https?:\/\//i.test(key)) {
    const resolvedFromUrl = await resolveChannelIdFromUrl(key);
    cache[key] = resolvedFromUrl;
    saveCache(cache);
    console.log(`✓ ${key} → ${cache[key]}`);
    return cache[key];
  }

  const h = key.startsWith('@') ? key.slice(1) : key;

  try {
    const data = await fetchWithKeyRotation(apiKey => `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(h)}&key=${apiKey}`);
    if (data.items && data.items.length > 0) {
      cache[key] = data.items[0].id;
      saveCache(cache);
      console.log(`✓ ${key} → ${cache[key]}`);
      return cache[key];
    }
  } catch (err) {
    console.warn(`forHandle fallito per ${key}: ${err.message}`);
  }

  // Fallback robusto: per handle Unicode prova risoluzione dalla pagina canale.
  if (key.startsWith('@')) {
    const fallbackUrl = `https://www.youtube.com/@${encodeURIComponent(h)}`;
    try {
      const resolvedFromUrl = await resolveChannelIdFromUrl(fallbackUrl);
      cache[key] = resolvedFromUrl;
      saveCache(cache);
      console.log(`✓ ${key} → ${cache[key]} (fallback URL)`);
      return cache[key];
    } catch (err) {
      console.warn(`Fallback URL fallito per ${key}: ${err.message}`);
    }

    try {
      const resolvedBySearch = await resolveChannelIdBySearchQuery(h);
      if (resolvedBySearch) {
        cache[key] = resolvedBySearch;
        saveCache(cache);
        console.log(`✓ ${key} → ${cache[key]} (fallback search)`);
        return cache[key];
      }
    } catch (err) {
      console.warn(`Fallback search fallito per ${key}: ${err.message}`);
    }
  }

  throw new Error(`Canale non trovato: ${key}`);
}

async function resolveChannelIdFromUrl(channelUrl) {
  const response = await fetch(channelUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    redirect: 'follow'
  });

  if (!response.ok) throw new Error(`Canale non trovato: ${channelUrl}`);
  const html = await response.text();
  const patterns = [
    /https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[\w-]{20,})/i,
    /"externalId":"(UC[\w-]{20,})"/i,
    /"browseId":"(UC[\w-]{20,})"/i,
    /channelId=\"(UC[\w-]{20,})\"/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }

  throw new Error(`Canale non trovato: ${channelUrl}`);
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function formatViewsPerHour(vph) {
  if (!vph || vph < 0) return '0';
  return Math.round(vph).toLocaleString('it-IT');
}

export function getVelocityTrend(vph) {
  if (vph >= 100000) return { icon: '🚀', label: 'Virale', level: 'extreme' };
  if (vph >= 50000) return { icon: '🔥', label: 'Molto veloce', level: 'hot' };
  if (vph >= 10000) return { icon: '⚡', label: 'Veloce', level: 'fast' };
  if (vph >= 1000) return { icon: '📈', label: 'Moderato', level: 'moderate' };
  if (vph >= 100) return { icon: '📊', label: 'Lento', level: 'slow' };
  return { icon: '📉', label: 'Stagnante', level: 'stalled' };
}

// Calcola views per hour con decay exponenziale (stile VidIQ)
export function calculateViewsPerHour(totalViews, publishTimeIso) {
  const now = Date.now();
  const publishTime = new Date(publishTimeIso).getTime();
  const hoursElapsed = Math.max(0.1, (now - publishTime) / (1000 * 60 * 60));
  
  // Metodo: simple views/hours per le prime 24h, poi applica decay per ore successive
  const baseVph = totalViews / hoursElapsed;
  
  if (hoursElapsed <= 24) {
    // Nei primi 24h, usa il calcolo lineare diretto
    return Math.round(baseVph);
  }
  
  // Dopo 24h, applica fattore di decadimento (il video rallenta nel tempo)
  // Formula: decay_factor = 1 / (1 + (hours - 24) / 24)
  // Questo penalizza i video older perché hanno una velocità naturalmente decrescente
  const excessHours = Math.max(0, hoursElapsed - 24);
  const decayFactor = 1 / (1 + excessHours / 24);
  
  return Math.round(baseVph * decayFactor);
}

export function parseDuration(duration) {
  const m = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}
export function validateMinViews(value) {
  const num = Number(value);
  return (Number.isInteger(num) && num > 0) ? num : DEFAULT_MIN_VIEWS;
}

export function validatePeriod(value) {
  const num = Number(value);
  return (Number.isInteger(num) && num > 0) ? num : DEFAULT_PERIOD_DAYS;
}

function shouldIncludeShort(short, periodDays, minViews, now) {
  const ageMs = now - new Date(short.publishedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const ageHours = ageMs / (1000 * 60 * 60);

  if (ageDays > periodDays) return false;
  if (short.views >= minViews) return true;

  return minViews <= DEFAULT_MIN_VIEWS
    && short.views >= RECENT_EXCEPTION_MIN_VIEWS
    && ageHours <= RECENT_EXCEPTION_MAX_HOURS;
}

function filterShorts(shorts, periodDays, minViews, now) {
  return shorts.filter(short => shouldIncludeShort(short, periodDays, minViews, now));
}

// ─── Playlist uploads per canale (API v3) ───────────────────────────────────

async function fetchChannelDetails(channelId) {
  const data = await fetchWithKeyRotation(key =>
    `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&id=${encodeURIComponent(channelId)}&key=${key}`
  );
  const item = data.items?.[0];
  if (!item) return null;
  return {
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || null,
    channelTitle: item.snippet?.title || '',
    channelThumbnail: item.snippet?.thumbnails?.default?.url
      || item.snippet?.thumbnails?.medium?.url
      || item.snippet?.thumbnails?.high?.url
      || ''
  };
}

function getPlaylistPageLimit(periodDays) {
  if (periodDays <= 7) return 2;
  if (periodDays <= 30) return 4;
  if (periodDays <= 90) return 8;
  if (periodDays <= 365) return 16;
  return 24;
}

async function fetchVideosForChannel(channelId, cutoffDate, periodDays) {
  const channelDetails = await fetchChannelDetails(channelId);
  const uploadsPlaylistId = channelDetails?.uploadsPlaylistId;
  if (!uploadsPlaylistId) {
    return { entries: [], channelDetails };
  }

  const entries = [];
  const maxPages = getPlaylistPageLimit(periodDays);
  let pageToken = '';
  let pageCount = 0;
  let reachedCutoff = false;

  while (pageCount < maxPages && !reachedCutoff) {
    const data = await fetchWithKeyRotation(key =>
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${encodeURIComponent(uploadsPlaylistId)}&maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}&key=${key}`
    );

    const items = data.items || [];
    if (items.length === 0) break;

    for (const item of items) {
      const snippet = item.snippet;
      const videoId = snippet?.resourceId?.videoId;
      const published = snippet?.publishedAt;

      if (!snippet || !videoId || !published) continue;
      if (cutoffDate && new Date(published) < cutoffDate) {
        reachedCutoff = true;
        break;
      }

      entries.push({
        videoId,
        title: snippet.title,
        published,
        channelName: snippet.channelTitle || channelDetails?.channelTitle || '',
        channelId,
        channelThumbnail: channelDetails?.channelThumbnail || '',
        thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      });
    }

    pageToken = data.nextPageToken || '';
    pageCount += 1;
    if (!pageToken) break;
  }

  return { entries, channelDetails };
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
    const periodDays = cutoffDate ? Math.max(1, Math.ceil((Date.now() - cutoffDate.getTime()) / (1000 * 60 * 60 * 24))) : DEFAULT_PERIOD_DAYS;
    const { entries, channelDetails } = await fetchVideosForChannel(channelId, cutoffDate, periodDays);
    if (entries.length === 0) {
      return {
        handle,
        channelId,
        channelTitle: channelDetails?.channelTitle || handle,
        shorts: [],
        error: null
      };
    }
    const statsMap = await fetchVideoStats(entries.map(e => e.videoId));
    const shorts = [];
    
    // Prima passa: calcola tutti i rapporti
    const allShorts = [];
    for (const e of entries) {
      const stats = statsMap[e.videoId];
      if (!stats || stats.duration > 180) continue;
      
      // Calcola views/ora con decay exponenziale (stile VidIQ)
      const viewsPerHour = calculateViewsPerHour(stats.views, e.published);
      
      // Calcola rapporti di engagement
      const likeRatio = stats.views > 0 ? (stats.likes / stats.views) * 100 : 0; // %
      const commentRatio = stats.views > 0 ? (stats.comments / stats.views) * 100 : 0; // %
      const engagementRatio = likeRatio + commentRatio; // %
      
      allShorts.push({
        id: e.videoId,
        title: e.title,
        channelName: e.channelName,
        channelId: e.channelId,
        channelHandle: handle,
        channelThumbnail: e.channelThumbnail,
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
    return {
      handle,
      channelId,
      channelTitle: channelDetails?.channelTitle || shorts[0]?.channelName || handle,
      shorts,
      error: null
    };
  } catch (err) {
    console.error(`Errore per il canale ${handle}:`, err.message);
    return { handle, channelId: null, channelTitle: handle, shorts: [], error: { channel: handle, message: err.message } };
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

async function refreshSavedVideoStats(saved) {
  const ids = Object.keys(saved || {});
  if (ids.length === 0) return { total: 0, updated: 0, missing: 0 };

  loadConfig();
  const statsMap = await fetchVideoStats(ids);
  let updated = 0;
  let missing = 0;
  const refreshedAt = new Date().toISOString();

  for (const id of ids) {
    const stats = statsMap[id];
    if (!stats) {
      missing += 1;
      continue;
    }

    const item = saved[id];
    if (!item) continue;

    item.views = stats.views;
    item.likes = stats.likes;
    item.comments = stats.comments;
    item.lastStatsRefreshAt = refreshedAt;
    updated += 1;
  }

  return { total: ids.length, updated, missing, refreshedAt };
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
        item.viewsPerHour = calculateViewsPerHour(item.views, item.publishedAt);
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
    const ids = url.searchParams.get('ids');
    const saved = loadSaved();
    if (id && saved[id]) { delete saved[id]; saveSaved(saved); }
    if (ids) { 
      const idArray = ids.split(',');
      idArray.forEach(id => { if (saved[id]) delete saved[id]; });
      saveSaved(saved);
    }
    res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.method === 'PATCH') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');

        if (payload.action === 'refreshAll') {
          const saved = loadSaved();
          const result = await refreshSavedVideoStats(saved);
          saveSaved(saved);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, ...result }));
          return;
        }

        const { id, copied } = payload;
        const saved = loadSaved();
        if (saved[id]) { saved[id].copied = copied; saveSaved(saved); }
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message || 'Bad Request' }));
      }
    }); return;
  }
  res.writeHead(405); res.end('Method Not Allowed');
}

// ─── Get Audio URL from YouTube (Multiple Methods with Fallbacks) ─────────────

// Metodo 1: Invidious API (proxy YouTube, bypassa rate limiting)
async function getAudioUrlViaInvidious(videoId) {
  try {
    // Invidious instances (load balanced)
    const instances = [
      'https://inv.riverside.rocks',
      'https://yewtu.be',
      'https://invidious.snopyta.org',
      'https://invidious.kavin.rocks',
    ];
    
    for (const instance of instances) {
      try {
        console.log(`📥 Trying Invidious: ${instance}`);
        const res = await fetch(`${instance}/api/v1/videos/${videoId}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 10000
        });
        
        if (!res.ok) continue;
        const data = await res.json();
        
        // Estrai formato audio bestaudio
        const audioFormats = data.formatStreams?.filter(f => 
          f.type?.includes('audio') || (f.qualityLabel === 'tiny' && f.container === 'webm')
        );
        
        if (audioFormats?.length > 0) {
          const audioUrl = audioFormats[0].url;
          if (audioUrl) {
            console.log(`✓ Invidious URL found from ${instance}`);
            return audioUrl;
          }
        }
      } catch (err) {
        console.warn(`Invidious ${instance} failed: ${err.message?.substring(0, 50)}`);
      }
    }
  } catch (err) {
    console.warn(`Invidious method failed: ${err.message}`);
  }
  return null;
}

// Metodo 2: yt-dlp con retry (fallback)
async function getAudioUrlFromYoutube(videoUrl, retryCount = 3) {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  for (let attempt = 1; attempt <= retryCount; attempt++) {
    try {
      console.log(`📥 yt-dlp attempt ${attempt}/${retryCount}...`);
      
      const { stdout, stderr } = await execFileAsync(YTDLP, [
        '--get-url',
        '-f', 'bestaudio',
        '--no-playlist',
        '--no-warnings',
        '--socket-timeout', '30',
        '--retries', '5',
        '--fragment-retries', '5',
        '-j',
        videoUrl,
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      ], { 
        timeout: 45000,
        maxBuffer: 10 * 1024 * 1024
      });
      
      const lines = stdout.trim().split('\n');
      if (lines.length > 0) {
        try {
          const jsonLine = lines[0];
          if (jsonLine.startsWith('{')) {
            const data = JSON.parse(jsonLine);
            if (data.url) return data.url;
          }
        } catch (e) {
          if (lines[0].startsWith('http')) return lines[0];
        }
      }
      
      if (stdout.includes('http')) {
        return stdout.trim().split('\n').find(l => l.startsWith('http'));
      }
      
    } catch (err) {
      const errorMsg = err.stderr?.toString() || err.message || '';
      
      if (errorMsg.includes('429') || errorMsg.includes('Too Many Requests')) {
        console.warn(`⚠️ HTTP 429 (rate limit)`);
        if (attempt < retryCount) {
          await new Promise(r => setTimeout(r, 5000 * attempt));
          continue;
        }
      }
      
      if (attempt < retryCount) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
  }
  
  return null;
}

// Metodo 3: Hybrid function - prova Invidious prima, poi yt-dlp
async function getAudioUrlHybrid(videoId, videoUrl) {
  console.log(`🎵 Tentativo ibrido per ${videoId}...`);
  
  // Prova 1: Invidious (non bloccato da YouTube)
  const invidUrl = await getAudioUrlViaInvidious(videoId);
  if (invidUrl) return invidUrl;
  
  // Prova 2: yt-dlp
  const ytdlUrl = await getAudioUrlFromYoutube(videoUrl);
  if (ytdlUrl) return ytdlUrl;
  
  return null;
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

// ─── AudD.io API Recognition (Reliable, No Python Dependency) ──────────────────

async function recognizeAudioViaAudD(audioUrl, videoTitle = '') {
  try {
    console.log('🎵 Tentativo 1: AudD.io API (no Python dependency)...');
    
    // AudD API unofficial endpoint (free, no auth needed)
    const params = new URLSearchParams({
      url: audioUrl,
      return: 'apple_music,spotify,deezer'
    });
    
    const res = await fetch(`https://api.audd.io/?${params}`, {
      timeout: 15000
    });
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    if (data.result) {
      const result = data.result;
      return {
        success: true,
        results: [{
          title: result.title || 'Sconosciuto',
          artist: result.artist || 'Sconosciuto',
          cover: result.image || '',
          link: result.apple_music?.url || result.spotify?.external_urls?.spotify || result.deezer?.link || '',
          method: 'audd'
        }]
      };
    }
    
    return { success: false, results: [], message: 'Nessun risultato da AudD' };
  } catch (err) {
    console.warn('AudD error:', err.message);
    return { success: false, results: [], error: err.message };
  }
}

// ─── MusicBrainz Fallback (Free API, No Rate Limiting) ─────────────────────

async function queryMusicBrainz(title, artist = '') {
  try {
    // Build simple query without special syntax (MusicBrainz Lucene query)
    const searchTitle = title.replace(/[()[\]{}]/g, '').trim().substring(0, 100);
    const params = new URLSearchParams({
      query: searchTitle,
      type: 'recording',
      limit: '1',
      fmt: 'json'
    });
    
    const url = `https://musicbrainz.org/ws/2/recording?${params}`;
    console.log(`🔍 MusicBrainz query: ${searchTitle.substring(0, 50)}...`);
    
    const res = await fetch(url, {
      headers: { 'User-Agent': 'YouTubeShortViewer/1.0' },
      timeout: 8000
    });
    
    if (!res.ok) {
      console.warn(`MusicBrainz HTTP ${res.status} for: "${searchTitle}"`);
      return null;
    }
    
    const data = await res.json();
    const recordings = data.recordings || [];
    
    if (recordings.length > 0) {
      const rec = recordings[0];
      const artistName = rec['artist-credit']?.[0]?.artist?.name || 'Sconosciuto';
      const result = {
        title: rec.title || 'Sconosciuto',
        artist: artistName,
        link: `https://musicbrainz.org/recording/${rec.id}`,
        method: 'musicbrainz'
      };
      console.log(`✓ MusicBrainz found: ${result.title} - ${result.artist}`);
      return result;
    }
  } catch (err) {
    console.warn(`MusicBrainz error: ${err.message}`);
  }
  return null;
}

// ─── Title-based Recognition Fallback ──────────────────────────────────────

async function recognizeByTitle(videoTitle) {
  if (!videoTitle) return null;
  
  console.log(`🎵 Tentativo 2: Ricerca per titolo video: "${videoTitle}"`);
  
  const candidates = [];
  
  // Extract text in parentheses
  const parens = videoTitle.match(/\(([^)]{3,})\)/g) || [];
  for (const p of parens) {
    const clean = p.slice(1, -1).trim();
    if (!['official video', 'official audio', 'lyrics', 'music video', 'audio', 'visualizer'].includes(clean.toLowerCase())) {
      candidates.push(clean);
    }
  }
  
  // Extract text after separator
  for (const sep of [' - ', ' | ', ' — ']) {
    if (videoTitle.includes(sep)) {
      const parts = videoTitle.split(sep);
      for (const part of parts) {
        const clean = part.trim();
        if (clean.length > 2 && clean.length < 200) candidates.push(clean);
      }
    }
  }
  
  // Remove duplicates
  const uniqueCandidates = [...new Set(candidates)];
  
  for (const candidate of uniqueCandidates) {
    const result = await queryMusicBrainz(candidate);
    if (result) return result;
  }
  
  return null;
}

// ─── Enhanced Recognition Pipeline ────────────────────────────────────────

async function recognizeAudioPipeline(audioUrl, videoTitle = '') {
  const tracks = [];
  const seen = new Set();
  
  const addTrack = (track) => {
    const key = `${track.title}_${track.artist}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tracks.push(track);
    }
  };
  
  // Strategy 1: AudD.io (most reliable, no Python needed)
  try {
    const auddResult = await recognizeAudioViaAudD(audioUrl, videoTitle);
    if (auddResult.success && auddResult.results?.length > 0) {
      for (const track of auddResult.results) {
        addTrack(track);
      }
      return { success: true, results: tracks, source: 'audd' };
    }
  } catch (err) {
    console.warn('AudD pipeline error:', err.message);
  }
  
  // Strategy 2: Title-based fallback
  if (!tracks.length) {
    try {
      const titleResult = await recognizeByTitle(videoTitle);
      if (titleResult) {
        addTrack(titleResult);
        return { success: true, results: tracks, source: 'title' };
      }
    } catch (err) {
      console.warn('Title recognition error:', err.message);
    }
  }
  
  return { success: false, results: [], message: 'Audio non riconosciuto' };
}

function shouldVerifyAudDWithPython(result, videoTitle = '') {
  if (!result?.success || result?.source !== 'audd' || !Array.isArray(result.results) || result.results.length === 0) {
    return false;
  }

  const firstTrack = result.results[0];
  const recognizedText = `${firstTrack?.title || ''} ${firstTrack?.artist || ''}`.toLowerCase();
  const titleText = String(videoTitle || '').toLowerCase();

  // Heuristic mirata: riduce falsi positivi vocali su shorts Minecraft/C418.
  const minecraftContext = /(minecraft|c418|マイクラ|마크|майнкрафт)/i.test(titleText);
  const suspiciousWords = /\bnegro\b/i.test(recognizedText);

  return minecraftContext && suspiciousWords;
}

async function runPythonAudioRecognition(audioUrl, videoTitle = '') {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const { stdout } = await execFileAsync(PYTHON, [
    join(__dirname, 'shazam_recognition_new.py'),
    audioUrl,
    videoTitle
  ], { timeout: 60000, maxBuffer: 20 * 1024 * 1024 });

  return JSON.parse(stdout);
}

async function shazamRecognize(audioUrl, videoTitle = '') {
  // Try new pipeline first (AudD + Title-based)
  try {
    const result = await recognizeAudioPipeline(audioUrl, videoTitle);
    if (result.success) {
      if (shouldVerifyAudDWithPython(result, videoTitle)) {
        console.warn('⚠ Match AudD sospetto in contesto Minecraft: verifica con Python+Demucs...');
        try {
          const verified = await runPythonAudioRecognition(audioUrl, videoTitle);
          if (verified?.success && Array.isArray(verified.results) && verified.results.length > 0) {
            return verified;
          }
        } catch (verifyErr) {
          console.warn('Verifica Python fallita, uso comunque AudD:', verifyErr.message);
        }
      }

      return {
        success: true,
        results: result.results,
        source: result.source
      };
    }
  } catch (err) {
    console.warn('Pipeline error, falling back to Python:', err.message);
  }
  
  // Fallback: Python script (for backward compatibility)
  try {
    console.log(`⚡ Fallback: Python script...`);
    const parsed = await runPythonAudioRecognition(audioUrl, videoTitle);
    try {
      return parsed;
    } catch (parseErr) {
      console.warn('Python script JSON parse error:', parseErr.message);
      return { success: false, message: 'Errore nel parsing della risposta' };
    }
  } catch (err) {
    console.error(`Python fallback failed:`, err.message?.substring(0, 300));
    return { 
      success: false, 
      error: 'Riconoscimento non disponibile',
      message: 'Tutti i metodi di riconoscimento falliti'
    };
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

  // Prova il metodo ibrido (Invidious + yt-dlp)
  let audioUrl = await getAudioUrlHybrid(videoId, videoUrl);
  
  if (!audioUrl) {
    console.error('❌ Tutti i metodi di download falliti - fallback a riconoscimento per titolo');
    
    // Fallback: Prova riconoscimento per titolo senza audio
    if (videoTitle) {
      const titleResult = await recognizeByTitle(videoTitle);
      if (titleResult) {
        res.writeHead(200);
        res.end(JSON.stringify({
          recognized: true,
          tracks: [titleResult],
          message: `✨ Riconosciuto da titolo (download audio non disponibile)`,
          source: 'title-fallback',
          tip: 'YouTube ha bloccato il download. Prova tra poco.'
        }));
        return;
      }
    }
    
    res.writeHead(503);
    res.end(JSON.stringify({ 
      error: '⚠️ Servizi di download YouTube temporaneamente non disponibili',
      message: 'YouTube sta bloccando i download. Prova tra 5-10 minuti.',
      tip: 'Tutti i proxy sono bloccati contemporaneamente. Riprova tra poco.'
    }));
    return;
  }

  // Riconoscimento audio
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
    
    const viewsPerHour = calculateViewsPerHour(views, publishedAt);
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

async function handleStatsApi(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    const saved = loadSaved();
    const totalSaved = Object.keys(saved).length;
    const copiedCount = Object.values(saved).filter(item => item.copied === true).length;
    res.writeHead(200);
    res.end(JSON.stringify({ totalSaved, copied: copiedCount }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
}

export async function handleApiShorts(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const period = validatePeriod(url.searchParams.get('period') ?? String(DEFAULT_PERIOD_DAYS));
  const minViews = validateMinViews(url.searchParams.get('minViews') ?? String(DEFAULT_MIN_VIEWS));
  const forceRefresh = ['1', 'true', 'yes'].includes((url.searchParams.get('forceRefresh') || '').toLowerCase());
  
  res.setHeader('Content-Type', 'application/json');

  let channels;
  try { channels = loadChannels(); }
  catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
  const totalChannels = channels.length;
  const currentChannelSignature = getChannelsSignature(channels);
  
  // Controlla il cache del feed - se è fresco (< 1 ora), usalo senza fare nuove richieste
  const cachedFeed = loadFeedCache();
  const now = Date.now();
  const cacheAge = now - (cachedFeed.timestamp || 0);
  const cacheCoverageDays = validatePeriod(cachedFeed.coverageDays || DEFAULT_CACHE_COVERAGE_DAYS);
  const cacheHasChannelMetadata = Array.isArray(cachedFeed.data)
    && cachedFeed.data.every(short => typeof short.channelId === 'string' && short.channelId.length > 0 && typeof short.channelThumbnail === 'string');
  const cacheMatchesTrackedChannels = cachedFeed.channelSignature === currentChannelSignature && cachedFeed.channelCount === totalChannels;

  if (!forceRefresh && cacheAge < FEED_CACHE_TTL && cachedFeed.data && cachedFeed.data.length > 0 && cacheCoverageDays >= period && cacheHasChannelMetadata && cacheMatchesTrackedChannels) {
    console.log(`✅ Cache feed valido (${Math.floor(cacheAge / 60000)}m fa) - 0 crediti consumati`);
    const filteredCache = filterShorts(cachedFeed.data, period, minViews, now);
    const uniqueChannels = new Set(filteredCache.map(s => s.channelName)).size;
    const cachedSummary = cachedFeed.summary || {};
    const successfulChannels = Number.isInteger(cachedSummary.successfulChannels) ? cachedSummary.successfulChannels : totalChannels;
    const failedChannels = Array.isArray(cachedSummary.failedChannels) ? cachedSummary.failedChannels : [];
    res.writeHead(200);
    res.end(JSON.stringify({ 
      shorts: filteredCache, 
      fromCache: true, 
      cacheAgeMinutes: Math.floor(cacheAge / 60000),
      errors: Array.isArray(cachedSummary.errors) ? cachedSummary.errors : [],
      channelCount: uniqueChannels,
      channelsMatchingFilter: uniqueChannels,
      successfulChannels,
      failedChannels,
      channelsWithoutMatches: Math.max(0, successfulChannels - uniqueChannels),
      totalChannels: totalChannels
    }));
    return;
  }

  if (forceRefresh) {
    console.log('🔄 Refresh manuale richiesto: cache bypassata');
  }
  
  const cutoffDate = new Date(now - period * 24 * 60 * 60 * 1000);
  loadConfig();
  const cache = loadCache();
  
  console.log(`🔍 Ricerca completa: ultimi ${period} giorni su ${channels.length} canali`);
  
  const results = await Promise.all(channels.map(ch => fetchShortsForChannel(ch, cutoffDate, cache)));
  const allShorts = [];
  const allErrors = [];
  for (const { shorts, error } of results) { allShorts.push(...shorts); if (error) allErrors.push(error); }
  const successfulChannels = results.filter(result => !result.error).length;
  
  const allForCache = allShorts
    .sort((a, b) => b.views - a.views);
  const filtered = filterShorts(allForCache, period, minViews, now);
  const uniqueChannels = new Set(filtered.map(s => s.channelName)).size;
  const summary = {
    successfulChannels,
    failedChannels: allErrors.map(error => error.channel),
    errors: allErrors
  };
  
  if (allForCache.length > 0) {
    saveFeedCache(allForCache, period, summary, channels);
    console.log(`💾 Feed cache aggiornato (${allForCache.length} video totali, copertura ${period} giorni)`);
  }
  
  res.writeHead(200);
  res.end(JSON.stringify({ 
    shorts: filtered, 
    fromCache: false, 
    errors: allErrors, 
    channelCount: uniqueChannels,
    channelsMatchingFilter: uniqueChannels,
    successfulChannels,
    failedChannels: allErrors.map(error => error.channel),
    channelsWithoutMatches: Math.max(0, successfulChannels - uniqueChannels),
    totalChannels: totalChannels,
    creditsApprox: estimateCreditsForFetch(channels.length, 50, period).total
  }));
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

export function getHtml() {
  const trackedChannels = (() => {
    try {
      return loadChannels();
    } catch {
      return [];
    }
  })();
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
    .tab-btns{display:flex;gap:8px;flex-wrap:wrap}
    .tab-btn{background:#2a2a2a;color:#ccc;border:1px solid #3a3a3a;border-radius:6px;padding:6px 16px;cursor:pointer;font-size:0.9rem;transition:background .15s;position:relative}
    .tab-btn.active{background:#ff0000;color:#fff;border-color:#ff0000}
    .tab-counter{display:inline-block;background:rgba(0,0,0,.4);padding:2px 8px;border-radius:12px;font-size:.75rem;margin-left:6px;font-weight:600;color:#ccc}
    .tab-btn.active .tab-counter{background:rgba(0,0,0,.6);color:#fff}
    .controls{background:#1a1a1a;padding:12px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;border-bottom:1px solid #2a2a2a}
    .period-group{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .period-group label{font-size:.85rem;color:#aaa}
    .btn-period{background:#2a2a2a;color:#ccc;border:1px solid #3a3a3a;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:.9rem;transition:background .15s}
    .btn-period:hover{background:#333;color:#fff}
    .btn-period.active{background:#ff0000;color:#fff;border-color:#ff0000}
    .period-group input{background:#2a2a2a;color:#e0e0e0;border:1px solid #3a3a3a;border-radius:6px;padding:6px 10px;font-size:.9rem;width:96px;outline:none}
    .period-group input:focus{border-color:#ff0000}
    .views-group{display:flex;align-items:center;gap:8px}
    .views-group label{font-size:.85rem;color:#aaa}
    .views-group input{background:#2a2a2a;color:#e0e0e0;border:1px solid #3a3a3a;border-radius:6px;padding:6px 10px;font-size:.9rem;width:130px;outline:none}
    .views-group input:focus{border-color:#ff0000}
    .views-search-btn{background:#ff0000;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;font-size:1rem;transition:background .15s}
    .views-search-btn:hover{background:#cc0000}
    .manual-refresh-btn{background:#2a7d2e;color:#fff;border:1px solid #37a13d;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:.86rem;font-weight:700;transition:background .15s,border-color .15s}
    .manual-refresh-btn:hover{background:#218a2b;border-color:#45b34d}
    .manual-refresh-btn:disabled{opacity:.65;cursor:wait}
    .refresh-info{margin-left:auto;font-size:.8rem;color:#888;text-align:right;line-height:1.6}
    .refresh-info .countdown{color:#ff0000;font-weight:600}
    #creditsStatus{background:#1a1a1a;border:2px solid #2a2a2a;border-radius:8px;padding:10px 16px;margin-left:auto;transition:border-color .3s,background .3s}
    #channelsTracked{font-size:.9rem;color:#e0e0e0;margin-left:16px;padding:8px 12px;background:#1a1a1a;border-radius:6px;border:1px solid #2a2a2a}
    #creditsStatus.low-credits{border-color:#ffa94d;background:rgba(255,169,77,.08)}
    #creditsStatus.critical-credits{border-color:#ff6b6b;background:rgba(255,107,107,.12);animation:pulse-red .8s ease-in-out infinite}
    @keyframes pulse-red{0%,100%{background:rgba(255,107,107,.12)}50%{background:rgba(255,107,107,.18)}}
    #creditsInfo{font-size:1rem;font-weight:600;color:#ccc;display:flex;align-items:center;gap:6px}
    #creditsResetDate{font-size:.75rem;color:#666;margin-top:4px}
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
    .card-velocity{display:flex;align-items:center;gap:10px;font-size:.8rem;margin:8px 0;flex-wrap:wrap;background:#0a2a0a;padding:8px 10px;border-radius:4px;border-left:3px solid #4caf50}
    .card-velocity.trend-extreme{background:#2a0a0a;border-left-color:#ff6b00}.card-velocity.trend-hot{background:#2a1a0a;border-left-color:#ff4500}.card-velocity.trend-fast{background:#0a2a0a;border-left-color:#ffaa00}.card-velocity.trend-moderate{background:#0a1a0a;border-left-color:#4caf50}.card-velocity.trend-slow{background:#0a0a1a;border-left-color:#ffeb3b}.card-velocity.trend-stalled{background:#0a0a0a;border-left-color:#999}
    .vph-metric{display:flex;align-items:baseline;gap:4px;font-weight:600;color:#fff}.vph-icon{font-size:1rem}.vph-value{font-size:.95rem;font-weight:700;color:#64b5f6}.vph-unit{font-size:.7rem;color:#aaa;font-weight:400}
    .vph-trend{padding:2px 6px;background:#1a1a1a;border-radius:3px;font-size:.75rem;color:#aaa;white-space:nowrap}
    .eng-ratio{font-size:.75rem;color:#4caf50}
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
    .channel-toolbar{display:none;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}
    .channel-toolbar.visible{display:flex}
    .channel-back-btn{background:#2a2a2a;color:#eee;border:1px solid #3a3a3a;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:.9rem}
    .channel-back-btn:hover{background:#333}
    .channel-toolbar-title{font-size:1rem;font-weight:700;color:#fff}
    .saved-refresh-btn{margin-left:auto;background:#2a7d2e;color:#fff;border:1px solid #37a13d;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:.85rem;font-weight:700;transition:background .15s,border-color .15s}
    .saved-refresh-btn:hover{background:#218a2b;border-color:#45b34d}
    .saved-refresh-btn:disabled{opacity:.65;cursor:wait}
    .channel-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px}
    .channel-card{background:#1a1a1a;border:1px solid #2f2f2f;border-radius:16px;padding:18px 14px;cursor:pointer;transition:transform .15s,border-color .15s,background .15s;text-align:center}
    .channel-card:hover{transform:translateY(-3px);border-color:#ff0000;background:#202020}
    .channel-card-error{border-color:#7a2e2e;background:#231616}
    .channel-card-error:hover{border-color:#d65b5b;background:#2b1a1a}
    .channel-avatar{width:72px;height:72px;border-radius:50%;object-fit:cover;display:block;margin:0 auto 10px;background:#2a2a2a;border:2px solid #343434}
    .channel-name{font-size:.88rem;font-weight:600;color:#fff;line-height:1.35;word-break:break-word}
    .channel-short-count{margin-top:8px;font-size:.76rem;color:#aaa}

    /* ── Mobile responsive ─────────────────── */
    @media(max-width:768px){
      header{padding:10px 12px;gap:10px}
      header h1{font-size:1.05rem}
      .tab-btn{padding:5px 12px;font-size:.82rem}
      .controls{padding:10px 12px;gap:10px;flex-direction:column;align-items:stretch}
      .period-group{flex-wrap:wrap;gap:6px}
      .btn-period{padding:5px 10px;font-size:.82rem}
      .views-group{width:100%}
      .manual-refresh-btn{width:100%}
      .views-group input{flex:1;width:auto}
      .refresh-info{margin-left:0;text-align:center;font-size:.75rem}
      .search-bar{flex-direction:column}
      .search-bar input{width:100%}
      .search-bar button{width:100%}
      main{padding:10px}
      .grid{grid-template-columns:repeat(2,1fr);gap:10px}
      .card-body{padding:8px 10px}
      .card-title{font-size:.8rem}
      .card-channel{font-size:.72rem}
      .card-stats{font-size:.72rem;gap:8px}
      .card-velocity{font-size:.68rem;padding:6px 8px;gap:6px}.vph-value{font-size:.85rem}.vph-unit{font-size:.65rem}.vph-trend{font-size:.65rem;padding:1px 4px}
      .card-date{font-size:.68rem}
      .card-actions{gap:4px}
      .btn-save,.btn-copied,.btn-audio,.btn-remove{font-size:.72rem;padding:3px 7px}
      .rank-badge{font-size:1rem;padding:3px 6px;top:5px;right:5px}
      .popup{padding:20px 16px;min-width:auto;margin:0 16px}
      .popup h3{font-size:.95rem}
      .btn-arkadia,.btn-holly,.btn-cancel{padding:8px 16px;font-size:.85rem}
      #audioResult{font-size:.82rem}
      .channel-grid{grid-template-columns:repeat(2,1fr);gap:10px}
      .channel-card{padding:14px 10px}
      .channel-avatar{width:60px;height:60px}
      .saved-refresh-btn{margin-left:0;width:100%}
    }
    @media(max-width:420px){
      .grid{grid-template-columns:1fr}
      .card-thumb img{aspect-ratio:9/16}
      header h1{font-size:.95rem}
      .tab-btn{padding:4px 10px;font-size:.78rem}
    }
  </style>
</head>
<body>
  <header>
    <h1><span>YouTube</span> Shorts Viewer</h1>
    <div class="tab-btns">
      <button class="tab-btn active" id="tabFeed">Feed <span class="tab-counter" id="feedCounter"></span></button>
      <button class="tab-btn" id="tabChannels">📺 Canali <span class="tab-counter" id="channelsCounter"></span></button>
      <button class="tab-btn" id="tabCopied">✅ Copiati <span class="tab-counter" id="copiedCounter"></span></button>
      <button class="tab-btn" id="tabSaved">⭐ Salvati <span class="tab-counter" id="savedCounter"></span></button>
    </div>
    <div id="channelsTracked">📺 Canali tracciati: <strong id="totalChannelsDisplay">66</strong></div>
    <div id="creditsStatus">
      <div id="creditsInfo">🔑 Crediti: ...</div>
      <div id="creditsResetDate">Reset: ...</div>
    </div>
  </header>
  <div class="controls" id="controls">
    <div class="period-group">
      <label for="periodDays">Periodo:</label>
      <button class="btn-period" data-period="1">1g</button>
      <button class="btn-period" data-period="2">2g</button>
      <button class="btn-period active" data-period="7">7g</button>
      <input type="number" id="periodDays" value="7" min="1" step="1" title="Giorni da cercare"/>
    </div>
    <div class="views-group">
      <label for="minViews">Min. views:</label>
      <input type="number" id="minViews" value="1000000" min="1" step="1"/>
      <button class="views-search-btn" id="searchBtn" title="Cerca">🔍</button>
    </div>
    <button class="manual-refresh-btn" id="manualRefreshBtn" title="Aggiorna subito le views">🔄 Aggiorna views ora</button>
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
    <div class="channel-toolbar" id="channelBrowserToolbar">
      <button class="channel-back-btn" id="channelBackBtn">← Tutti i canali</button>
      <div class="channel-toolbar-title" id="channelToolbarTitle">Canali</div>
    </div>
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
  <script>
    globalThis.trackedChannels = ${JSON.stringify(trackedChannels)};
  </script>
  <script src="/client.js?v=${Date.now()}"></script>
</body>
</html>`;
}

// ─── Server ───────────────────────────────────────────────────────────────────

export function startServer() {
  const server = http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];
    // Aggiungi header no-cache a tutte le risposte
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
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
    } else if (req.method === 'GET' && urlPath === '/api/stats') {
      await handleStatsApi(req, res);
    } else if (urlPath === '/api/saved') {
      await handleSavedApi(req, res);
    } else if (req.method === 'GET' && urlPath === '/api/audio') {
      await handleAudioApi(req, res);
    } else if (req.method === 'GET' && urlPath === '/api/lookup') {
      await handleLookupApi(req, res);
    } else if (req.method === 'GET' && urlPath === '/api/credits') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const credits = loadKeyCredits();
      const keyList = Object.keys(credits).filter(k => k !== '_resetInfo');
      const allKeysStatus = keyList.map((k, idx) => ({
        index: idx + 1,
        credits: credits[k] || 10000,
        key: k.substring(0, 10) + '...'
      }));
      const totalCredits = allKeysStatus.reduce((sum, k) => sum + k.credits, 0);
      res.end(JSON.stringify({ keys: allKeysStatus, total: totalCredits, resetDate: 'Mezzanotte UTC (ogni notte)' }));
    } else if (req.method === 'GET' && urlPath === '/api/credits-cost') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const channels = loadChannels();
      const cost = estimateCreditsForFetch(channels.length);
      res.end(JSON.stringify({ 
        channelCount: channels.length,
        estimatedCostPerSearch: cost,
        sessionUsed: sessionCreditsUsed,
        cacheValidityMinutes: 60,
        costBreakdown: {
          '💾 Risolvi canali': `${cost.resolveChannels} crediti (1 per canale)`,
          '📚 Playlist uploads': `${cost.uploadsPlaylists} crediti (1 per canale)`,
          '📄 Pagine playlist': `${cost.playlistItems} crediti (dipende dai giorni richiesti)`,
          '📊 Statistiche': `${cost.stats} crediti (1 ogni 50 video)`,
          '✅ TOTALE': `${cost.total} crediti per ricerca completa`,
          '📌 Strategie': 'Il cache viene riusato solo se copre abbastanza giorni per il filtro richiesto'
        }
      }));
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
  
  // Controlla e resetta crediti ogni minuto a mezzanotte UTC
  setInterval(checkAndResetCreditsIfMidnight, 60000);
  checkAndResetCreditsIfMidnight(); // Controlla subito all'avvio
  
  server.listen(PORT, HOST, () => {
    try {
      const channels = loadChannels();
      console.log(`📺 ${channels.length} canali caricati e tracciati`);
    } catch (e) {
      console.log('Errore nel caricamento canali');
    }
    console.log(`Server avviato su http://${HOST}:${PORT}`);
    if (!process.env.RAILWAY_ENVIRONMENT) {
      const cmd = process.platform === 'win32' ? `start http://localhost:${PORT}` : process.platform === 'darwin' ? `open http://localhost:${PORT}` : `xdg-open http://localhost:${PORT}`;
      exec(cmd, () => {});
    }
  });
}

startServer();
