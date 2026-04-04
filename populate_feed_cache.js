import { readFileSync, writeFileSync } from 'fs';

// Leggi i video salvati
const saved = JSON.parse(readFileSync('saved_videos.json', 'utf8'));
const savedIds = new Set(Object.keys(saved));

// Leggi il cache generale
const shortsCache = JSON.parse(readFileSync('shorts_cache.json', 'utf8'));
let videosFromCache = (shortsCache.data || shortsCache).slice(0, 10); // Prendi i primi 10

// Filtra: escludendo video salvati
const feedVideos = videosFromCache.filter(v => !savedIds.has(v.id));

// Se nessun video disponibile dopo il filtro, usa tutti (contrassegnati come cache)
if (feedVideos.length === 0) {
  console.log('⚠️  Nessun video nel cache feed (tutti i video nel cache sono salvati)');
  const testVideos = videosFromCache.slice(0, 3).map(v => ({...v, title: '[CACHE] ' + v.title}));
  writeFileSync('feed_cache.json', JSON.stringify(testVideos, null, 2));
  console.log('✓ Feed cache riempito con', testVideos.length, 'video di test dal cache');
} else {
  writeFileSync('feed_cache.json', JSON.stringify(feedVideos, null, 2));
  console.log('✓ Feed cache riempito con', feedVideos.length, 'video (esclusi i salvati)');
}
