let currentPeriod = 7;
let currentMinViews = 1000000;
let countdownSeconds = 300;
let countdownTimer = null;
let creditsResetTimer = null;

let currentTab = 'feed';
let savedData = {};
let pendingSave = null;
let lastFeedCount = 0;
let lastAllShorts = [];
let lastFeedShorts = [];
let lastApiMeta = null;
let lastSavedRefreshText = '';
let selectedChannel = null;
const trackedChannels = Array.isArray(globalThis.trackedChannels) ? globalThis.trackedChannels : [];
const genericChannelAvatar = '';

const videoMap = {};

function fmt(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function fmtPercent(n) {
  const value = Number(n || 0);
  return value.toFixed(value >= 10 ? 1 : 2) + '%';
}

function fmtDate(iso) {
  const d = new Date(iso);
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getChannelKey(item) {
  return item.channelId || item.channelHandle || item.channelName;
}

function startCountdown() {
  clearInterval(countdownTimer);
  countdownSeconds = 300;
  countdownTimer = setInterval(function () {
    if (--countdownSeconds < 0) countdownSeconds = 0;
    const m = Math.floor(countdownSeconds / 60);
    const s = countdownSeconds % 60;
    document.getElementById('countdown').textContent = m + ':' + String(s).padStart(2, '0');
  }, 1000);
}

async function loadSaved() {
  const response = await fetch('/api/saved');
  savedData = await response.json();
}

async function loadCredits() {
  try {
    const creditsResponse = await fetch('/api/credits');
    const creditsData = await creditsResponse.json();
    const costResponse = await fetch('/api/credits-cost');
    const costData = await costResponse.json();
    const estimatedCost = costData.estimatedCostPerSearch?.total || 1;

    const creditsEl = document.getElementById('creditsInfo');
    const resetEl = document.getElementById('creditsResetDate');
    const creditsStatus = document.getElementById('creditsStatus');

    function updateResetCountdown() {
      const now = new Date();
      const midnight = new Date(now);
      midnight.setUTCHours(24, 0, 0, 0);
      const msToMidnight = midnight - now;
      const hours = Math.floor(msToMidnight / (1000 * 60 * 60));
      const minutes = Math.floor((msToMidnight % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((msToMidnight % (1000 * 60)) / 1000);
      resetEl.textContent = '⏱️ Reset tra: ' + hours + 'h ' + minutes + 'm ' + seconds + 's (Ricerca: ~' + estimatedCost + ' crediti)';
    }

    updateResetCountdown();
    if (!creditsResetTimer) {
      creditsResetTimer = setInterval(updateResetCountdown, 1000);
    }

    const possibleSearches = Math.floor(creditsData.total / Math.max(estimatedCost, 1));
    creditsStatus.classList.remove('low-credits', 'critical-credits');
    if (creditsData.total < 1000) {
      creditsEl.innerHTML = '⚠️ Crediti: ' + creditsData.total.toLocaleString() + ' (❌ ESAUSTI)';
      creditsEl.style.color = '#ff6b6b';
      creditsStatus.classList.add('critical-credits');
    } else if (creditsData.total < 50000) {
      creditsEl.innerHTML = '⚠️ Crediti: ' + creditsData.total.toLocaleString() + ' (Margine: ~' + possibleSearches + ' ricerche)';
      creditsEl.style.color = '#ffa94d';
      creditsStatus.classList.add('low-credits');
    } else {
      creditsEl.innerHTML = '✅ Crediti: ' + creditsData.total.toLocaleString() + ' (~' + possibleSearches + ' ricerche possibili)';
      creditsEl.style.color = '#51cf66';
    }
  } catch (error) {
    console.warn('Errore caricamento crediti');
  }
}

function getBadges(id) {
  const entry = savedData[id];
  if (!entry || !entry.users || !entry.users.length) return '';
  return entry.users.map(function (user) {
    return user === 'Arkadia'
      ? '<span class="badge badge-arkadia">Arkadia</span>'
      : '<span class="badge badge-holly">Holly</span>';
  }).join(' ');
}

function buildCard(short, forSaved) {
  const url = 'https://www.youtube.com/shorts/' + short.id;
  videoMap[short.id] = short;
  const saved = !!savedData[short.id];
  const copied = savedData[short.id]?.copied === true;
  const badges = getBadges(short.id);
  const rankClass = 'card-rank-' + (short.rank || 'gray');
  const rankEmoji = short.rank === 'diamond' ? '💎' : short.rank === 'gold' ? '🥇' : short.rank === 'silver' ? '🥈' : short.rank === 'bronze' ? '🥉' : '⚫';
  const totalEngagement = (short.likes || 0) + (short.comments || 0);

  return '<div class="card ' + rankClass + (copied ? ' copied' : '') + '" data-id="' + short.id + '">'
    + '<div class="rank-badge">' + rankEmoji + '</div>'
    + '<a class="card-thumb" href="' + url + '" target="_blank" rel="noopener noreferrer"><img src="' + esc(short.thumbnail) + '" alt="" loading="lazy"/></a>'
    + '<div class="card-body">'
    + '<a class="card-title" href="' + url + '" target="_blank" rel="noopener noreferrer">' + esc(short.title) + '</a>'
    + '<div class="card-channel">' + esc(short.channelName) + '</div>'
    + '<div class="card-stats"><span>👁 ' + fmt(short.views) + '</span><span>👍 ' + fmt(short.likes) + '</span><span>💬 ' + fmt(short.comments || 0) + '</span></div>'
    + '<div class="card-stats"><span>🔥 Eng. ' + fmt(totalEngagement) + '</span><span>⚡ ' + fmtPercent(short.engagementRatio) + '</span></div>'
    + '<div class="card-date">' + fmtDate(short.publishedAt) + '</div>'
    + '<div class="card-actions">'
    + '<button class="btn-save' + (saved ? ' saved' : '') + '" data-id="' + short.id + '">' + (saved ? '✓ Salvato' : '+ Salva') + '</button>'
    + (saved ? '<button class="btn-copied' + (copied ? ' done' : '') + '" data-id="' + short.id + '">' + (copied ? '✅ Copiato' : '📋 Segna copiato') + '</button>' : '')
    + (badges ? '<span>' + badges + '</span>' : '')
    + (forSaved ? '<button class="btn-remove" data-id="' + short.id + '">🗑</button>' : '')
    + '<button class="btn-audio" data-id="' + short.id + '">🎵 Audio</button>'
    + '</div></div></div>';
}

function collectChannels(shorts) {
  const map = new Map();
  const allowErrorMarking = lastApiMeta?.fromCache !== true;
  const failedSet = new Set(
    allowErrorMarking && Array.isArray(lastApiMeta?.failedChannels)
      ? lastApiMeta.failedChannels.map(function (item) { return String(item || '').trim(); })
      : []
  );

  trackedChannels.forEach(function (handle) {
    const normalizedHandle = typeof handle === 'string' ? handle.trim() : '';
    if (!normalizedHandle) return;
    const key = normalizedHandle;
    if (!map.has(key)) {
      map.set(key, {
        key,
        name: normalizedHandle,
        handle: normalizedHandle,
        channelId: '',
        thumbnail: genericChannelAvatar,
        shortCount: 0,
        topViews: 0,
        hasError: failedSet.has(normalizedHandle)
      });
    }
  });

  shorts.forEach(function (short) {
    const key = short.channelHandle || getChannelKey(short);
    if (!map.has(key)) {
      map.set(key, {
        key,
        name: short.channelName,
        handle: short.channelHandle || '',
        channelId: short.channelId || '',
        thumbnail: short.channelThumbnail || short.thumbnail || genericChannelAvatar,
        shortCount: 0,
        topViews: 0
      });
    }
    const channel = map.get(key);
    channel.name = short.channelName || channel.name;
    channel.handle = short.channelHandle || channel.handle;
    channel.channelId = short.channelId || channel.channelId;
    channel.shortCount += 1;
    channel.hasError = false;
    if (short.views > channel.topViews) {
      channel.topViews = short.views;
      if (short.channelThumbnail) channel.thumbnail = short.channelThumbnail;
    }
  });
  return Array.from(map.values()).sort(function (a, b) {
    if (b.shortCount !== a.shortCount) return b.shortCount - a.shortCount;
    if (b.topViews !== a.topViews) return b.topViews - a.topViews;
    return a.name.localeCompare(b.name, 'it');
  });
}

function buildChannelCard(channel) {
  const avatarHtml = channel.thumbnail
    ? '<img class="channel-avatar" src="' + esc(channel.thumbnail) + '" alt="' + esc(channel.name) + '" loading="lazy"/>'
    : '<div class="channel-avatar" style="display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff">' + esc((channel.name || '?').replace(/^@/, '').slice(0, 1).toUpperCase() || '?') + '</div>';
  return '<div class="channel-card' + (channel.hasError ? ' channel-card-error' : '') + '" data-channel-key="' + esc(channel.key) + '">'
    + avatarHtml
    + '<div class="channel-name">' + esc(channel.name) + '</div>'
    + '<div class="channel-short-count">' + (channel.hasError ? 'Errore canale' : (channel.shortCount + ' shorts')) + '</div>'
    + '</div>';
}

function getVisibleFeedShorts() {
  return lastAllShorts.filter(function (short) {
    return !savedData[short.id];
  });
}

function updateTabCounters() {
  const feedCounter = document.getElementById('feedCounter');
  const channelsCounter = document.getElementById('channelsCounter');
  const savedCounter = document.getElementById('savedCounter');
  const copiedCounter = document.getElementById('copiedCounter');
  const allSaved = Object.values(savedData || {});
  const channels = collectChannels(lastAllShorts);
  const feedShorts = getVisibleFeedShorts();
  const savedCount = allSaved.filter(function (entry) { return !entry.copied; }).length;
  const copiedCount = allSaved.filter(function (entry) { return entry.copied === true; }).length;

  lastFeedCount = feedShorts.length;
  feedCounter.textContent = lastFeedCount > 0 ? '(' + lastFeedCount + ')' : '';
  channelsCounter.textContent = channels.length > 0 ? '(' + channels.length + ')' : '';
  savedCounter.textContent = savedCount > 0 ? '(' + savedCount + ')' : '';
  copiedCounter.textContent = copiedCount > 0 ? '(' + copiedCount + ')' : '';
}

function setToolbar(title, showBack) {
  const toolbar = document.getElementById('channelBrowserToolbar');
  const backBtn = document.getElementById('channelBackBtn');
  const titleEl = document.getElementById('channelToolbarTitle');
  const savedRefreshBtn = ensureSavedRefreshButton();
  const showSavedRefresh = currentTab === 'saved';

  if (currentTab === 'channels' || showSavedRefresh) {
    toolbar.classList.add('visible');
    titleEl.textContent = title;
    backBtn.style.display = showBack ? '' : 'none';
    if (savedRefreshBtn) {
      savedRefreshBtn.style.display = showSavedRefresh ? '' : 'none';
    }
  } else {
    toolbar.classList.remove('visible');
    if (savedRefreshBtn) {
      savedRefreshBtn.style.display = 'none';
    }
  }
}

function ensureSavedRefreshButton() {
  let button = document.getElementById('savedRefreshBtn');
  if (button) return button;

  const toolbar = document.getElementById('channelBrowserToolbar');
  if (!toolbar) return null;

  button = document.createElement('button');
  button.id = 'savedRefreshBtn';
  button.className = 'saved-refresh-btn';
  button.textContent = '🔄 Aggiorna views salvati';
  button.style.display = 'none';
  button.addEventListener('click', refreshSavedViewsManually);
  toolbar.appendChild(button);
  return button;
}

function getCacheLabel(meta) {
  if (!meta) return '';
  if (meta.fromCache) {
    if (meta.cacheAgeMinutes === undefined) return ' 💾 (cache)';
    if (meta.cacheAgeMinutes < 1) return ' 💾 (cache 0m)';
    if (meta.cacheAgeMinutes < 60) return ' 💾 (cache ' + meta.cacheAgeMinutes + 'm)';
    return ' 💾 (cache ' + Math.floor(meta.cacheAgeMinutes / 60) + 'h ' + (meta.cacheAgeMinutes % 60) + 'm)';
  }
  return meta.creditsApprox ? ' 🔍 (' + meta.creditsApprox + ' crediti)' : ' 🔍';
}

function getDatasetStatus(meta) {
  if (!meta) return '';
  const totalChannels = meta.totalChannels || 0;
  const matching = Number.isInteger(meta.channelsMatchingFilter) ? meta.channelsMatchingFilter : (meta.channelCount || 0);
  const successful = Number.isInteger(meta.successfulChannels) ? meta.successfulChannels : totalChannels;
  const failed = Array.isArray(meta.failedChannels) ? meta.failedChannels.length : 0;
  const withoutMatches = Number.isInteger(meta.channelsWithoutMatches)
    ? meta.channelsWithoutMatches
    : Math.max(0, successful - matching);
  const parts = [];

  if (totalChannels > 0) parts.push('📺 ' + matching + ' con risultati su ' + totalChannels);
  if (failed > 0) parts.push('⚠️ ' + failed + ' errori');
  if (withoutMatches > 0) parts.push('∅ ' + withoutMatches + ' senza match');

  return parts.join('  •  ');
}

function showLoading() {
  document.getElementById('spinner').classList.add('visible');
  document.getElementById('emptyMsg').classList.remove('visible');
  document.getElementById('grid').innerHTML = '';
}

function hideLoading() {
  document.getElementById('spinner').classList.remove('visible');
}

function showError(message) {
  const emptyMsg = document.getElementById('emptyMsg');
  const statsInfo = document.getElementById('statsInfo');
  document.getElementById('grid').innerHTML = '';
  emptyMsg.innerHTML = message;
  emptyMsg.classList.add('visible');
  statsInfo.textContent = '';
}

function renderFeed() {
  const grid = document.getElementById('grid');
  const emptyMsg = document.getElementById('emptyMsg');
  const statsInfo = document.getElementById('statsInfo');
  const totalChannelsDisplay = document.getElementById('totalChannelsDisplay');
  const shorts = getVisibleFeedShorts();
  const datasetStatus = getDatasetStatus(lastApiMeta);

  setToolbar('Canali', false);
  grid.className = 'grid';
  emptyMsg.classList.remove('visible');
  totalChannelsDisplay.textContent = String(lastApiMeta?.totalChannels || totalChannelsDisplay.textContent || 0);
  statsInfo.title = Array.isArray(lastApiMeta?.failedChannels) && lastApiMeta.failedChannels.length
    ? 'Canali con errore: ' + lastApiMeta.failedChannels.join(', ')
    : '';

  if (!shorts.length) {
    emptyMsg.textContent = lastApiMeta?.fromCache
      ? '📺 Nessun video nuovo di Shorts. Riprova quando l\'API si resetta.'
      : 'Nessuno Short trovato con i filtri selezionati';
    emptyMsg.classList.add('visible');
    statsInfo.textContent = datasetStatus;
    return;
  }

  statsInfo.textContent = datasetStatus + (datasetStatus ? '  •  ' : '') + '🎬 ' + shorts.length + getCacheLabel(lastApiMeta);
  grid.innerHTML = shorts.map(function (short) { return buildCard(short, false); }).join('');
  attachDynamicEvents();
}

function renderChannels() {
  const grid = document.getElementById('grid');
  const emptyMsg = document.getElementById('emptyMsg');
  const statsInfo = document.getElementById('statsInfo');
  const totalChannelsDisplay = document.getElementById('totalChannelsDisplay');
  const channels = collectChannels(lastAllShorts);
  const datasetStatus = getDatasetStatus(lastApiMeta);

  emptyMsg.classList.remove('visible');
  totalChannelsDisplay.textContent = String(lastApiMeta?.totalChannels || totalChannelsDisplay.textContent || 0);
  statsInfo.title = Array.isArray(lastApiMeta?.failedChannels) && lastApiMeta.failedChannels.length
    ? 'Canali con errore: ' + lastApiMeta.failedChannels.join(', ')
    : '';

  if (!selectedChannel) {
    setToolbar('Canali', false);
    grid.className = 'channel-grid';
    if (!channels.length) {
      emptyMsg.textContent = 'Nessun canale disponibile';
      emptyMsg.classList.add('visible');
      statsInfo.textContent = datasetStatus + getCacheLabel(lastApiMeta);
      grid.innerHTML = '';
      return;
    }

    statsInfo.textContent = '📺 ' + channels.length + ' canali tracciati' + (datasetStatus ? '  •  ' + datasetStatus : '') + getCacheLabel(lastApiMeta);
    grid.innerHTML = channels.map(buildChannelCard).join('');
    attachChannelEvents(channels);
    return;
  }

  const channelShorts = lastAllShorts.filter(function (short) {
    return (short.channelHandle || getChannelKey(short)) === selectedChannel.key;
  });

  setToolbar(selectedChannel.name, true);
  grid.className = 'grid';

  if (!channelShorts.length) {
    emptyMsg.textContent = selectedChannel.hasError
      ? ('Errore nel recupero canale: ' + selectedChannel.name + '. Verifica handle o usa URL/ID canale.')
      : ('Nessuno short per ' + selectedChannel.name + ' con i filtri selezionati');
    emptyMsg.classList.add('visible');
    statsInfo.textContent = '📺 ' + selectedChannel.name + getCacheLabel(lastApiMeta);
    grid.innerHTML = '';
    return;
  }

  statsInfo.textContent = '📺 ' + selectedChannel.name + '  •  🎬 ' + channelShorts.length + getCacheLabel(lastApiMeta);
  grid.innerHTML = channelShorts.map(function (short) { return buildCard(short, false); }).join('');
  attachDynamicEvents();
}

async function renderSaved() {
  await loadSaved();
  const grid = document.getElementById('grid');
  const emptyMsg = document.getElementById('emptyMsg');
  const statsInfo = document.getElementById('statsInfo');
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  let entries = Object.values(savedData).filter(function (entry) { return !entry.copied; });
  const expired = entries.filter(function (entry) {
    return (now - new Date(entry.publishedAt).getTime()) > sevenDaysMs;
  });

  setToolbar('⭐ Salvati', false);
  grid.className = 'grid';
  emptyMsg.classList.remove('visible');

  if (expired.length > 0) {
    expired.forEach(function (entry) { delete savedData[entry.id]; });
    fetch('/api/saved?ids=' + expired.map(function (entry) { return entry.id; }).join(','), { method: 'DELETE' });
    entries = entries.filter(function (entry) { return !expired.find(function (item) { return item.id === entry.id; }); });
  }

  if (!entries.length) {
    grid.innerHTML = '';
    emptyMsg.textContent = 'Nessun video salvato.';
    emptyMsg.classList.add('visible');
    statsInfo.textContent = '';
    updateTabCounters();
    return;
  }

  const expiringToday = entries.filter(function (entry) {
    const ageMs = now - new Date(entry.publishedAt).getTime();
    return (sevenDaysMs - ageMs) / (1000 * 60 * 60 * 24) < 1;
  }).length;

  statsInfo.textContent = '⭐ ' + entries.length + ' salvati'
    + (expiringToday > 0 ? ' (⏰ ' + expiringToday + ' scadono oggi)' : '')
    + (lastSavedRefreshText ? '  •  ' + lastSavedRefreshText : '');
  grid.innerHTML = entries.map(function (entry) { return buildCard(entry, true); }).join('');
  attachDynamicEvents();
  updateTabCounters();
}

async function renderCopied() {
  await loadSaved();
  const grid = document.getElementById('grid');
  const emptyMsg = document.getElementById('emptyMsg');
  const statsInfo = document.getElementById('statsInfo');
  const entries = Object.values(savedData).filter(function (entry) { return entry.copied === true; });

  setToolbar('Canali', false);
  grid.className = 'grid';
  emptyMsg.classList.remove('visible');

  if (!entries.length) {
    grid.innerHTML = '';
    emptyMsg.textContent = 'Nessun video copiato.';
    emptyMsg.classList.add('visible');
    statsInfo.textContent = '';
    updateTabCounters();
    return;
  }

  statsInfo.textContent = '✅ ' + entries.length + ' video copiati';
  grid.innerHTML = entries.map(function (entry) { return buildCard(entry, true); }).join('');
  attachDynamicEvents();
  updateTabCounters();
}

async function refreshSavedViewsManually(options) {
  const silent = options?.silent === true;
  const source = options?.source || 'manual';
  const button = ensureSavedRefreshButton();
  if (!button) return;

  if (!silent) {
    button.disabled = true;
    button.textContent = '⏳ Aggiorno salvati...';
  }

  try {
    const response = await fetch('/api/saved', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refreshAll' })
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Errore aggiornamento salvati');
    }

    // Defensive check: if backend doesn't expose refresh counters, it is likely an old server process.
    if (!Object.prototype.hasOwnProperty.call(data, 'updated')) {
      throw new Error('Server non aggiornato: riavvia il processo Node per abilitare il refresh manuale reale.');
    }

    const timeLabel = data.refreshedAt
      ? new Date(data.refreshedAt).toLocaleTimeString('it-IT')
      : new Date().toLocaleTimeString('it-IT');
    lastSavedRefreshText = '🔄 ' + (source === 'auto' ? 'auto' : 'manuale') + ' ' + data.updated + '/' + data.total + ' alle ' + timeLabel;

    await loadSaved();
    if (currentTab === 'saved') {
      await renderSaved();
    } else {
      updateTabCounters();
    }
  } catch (error) {
    if (!silent) {
      alert(error.message || 'Errore durante l\'aggiornamento dei video salvati.');
    } else {
      console.warn('Auto-refresh salvati fallito:', error.message || error);
    }
  } finally {
    if (!silent) {
      button.disabled = false;
      button.textContent = '🔄 Aggiorna views salvati';
    }
  }
}

function renderCurrentTab() {
  if (currentTab === 'saved') return renderSaved();
  if (currentTab === 'copied') return renderCopied();
  if (currentTab === 'channels') {
    renderChannels();
    updateTabCounters();
    return;
  }
  renderFeed();
  updateTabCounters();
}

async function refreshDataAndRender(options) {
  const forceRefresh = options?.forceRefresh === true;

  if (currentTab === 'saved' || currentTab === 'copied') {
    return renderCurrentTab();
  }

  const manualRefreshBtn = document.getElementById('manualRefreshBtn');
  if (manualRefreshBtn && forceRefresh) {
    manualRefreshBtn.disabled = true;
    manualRefreshBtn.textContent = '⏳ Aggiorno...';
  }

  showLoading();
  try {
    await loadSaved();
    await loadCredits();

    const response = await fetch('/api/shorts?period=' + currentPeriod + '&minViews=' + currentMinViews + (forceRefresh ? '&forceRefresh=1' : ''));
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Errore nel caricamento');
    }

    lastApiMeta = data;
    lastAllShorts = data.shorts || [];
    lastFeedShorts = getVisibleFeedShorts();
    lastFeedCount = lastFeedShorts.length;

    renderCurrentTab();
  } catch (error) {
    const msg = String(error.message || '');
    if (msg.includes('quota') || msg.includes('esaurita')) {
      showError('⚠️ <b>Crediti API YouTube esausti</b><br>Tutte le chiavi API hanno raggiunto il limite di quota.<br>Si azzereranno a mezzanotte UTC.');
    } else {
      showError('Errore nel caricamento.');
    }
  } finally {
    hideLoading();
    startCountdown();
    if (manualRefreshBtn && forceRefresh) {
      manualRefreshBtn.disabled = false;
      manualRefreshBtn.textContent = '🔄 Aggiorna views ora';
    }
  }
}

async function saveForUser(user) {
  if (!pendingSave) return;
  await fetch('/api/saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({}, pendingSave, { user }))
  });
  document.getElementById('popupOverlay').classList.remove('visible');
  pendingSave = null;
  await loadSaved();
  renderCurrentTab();
}

async function toggleCopied(id) {
  const newVal = !(savedData[id]?.copied === true);
  await fetch('/api/saved', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, copied: newVal })
  });
  await loadSaved();
  renderCurrentTab();
}

async function removeSaved(id) {
  await fetch('/api/saved?id=' + encodeURIComponent(id), { method: 'DELETE' });
  await loadSaved();
  renderCurrentTab();
}

async function showAudioResult(id, button) {
  const video = videoMap[id];
  button.textContent = '⚡ Ricerca...';
  button.classList.add('loading');
  button.disabled = true;

  try {
    const title = video ? encodeURIComponent(video.title) : '';
    const response = await fetch('/api/audio?id=' + encodeURIComponent(id) + '&title=' + title);
    const data = await response.json();
    const result = document.getElementById('audioResult');

    if (data.error) {
      result.innerHTML = '<div style="background:#2a1a1a;padding:12px;border-radius:6px;border-left:4px solid #f44336">'
        + '<b style="color:#f48fb1">❌ Errore</b><br>'
        + '<span style="color:#aaa;font-size:.85rem">' + esc(data.error) + '</span>'
        + '</div>';
    } else if (!data.recognized || !data.tracks || data.tracks.length === 0) {
      result.innerHTML = '<div style="background:#1a2a1a;padding:12px;border-radius:6px;border-left:4px solid #ff9800">'
        + '<b style="color:#ffc107">⚠️ Non riconosciuto</b><br>'
        + '<span style="color:#aaa;font-size:.85rem">' + esc(data.message) + '</span>'
        + (data.audioUrl ? '<br><br><a href="' + data.audioUrl + '" target="_blank" style="color:#64b5f6;font-size:.8rem">🔗 Scarica audio</a>' : '')
        + '</div>';
    } else {
      const tracksHtml = data.tracks.map(function (track) {
        return '<div style="background:#222;padding:10px;border-radius:8px;margin-bottom:8px;display:flex;align-items:center;gap:12px;border:1px solid #333">'
          + (track.cover
            ? '<img src="' + track.cover + '" style="width:50px;height:50px;border-radius:4px;object-fit:cover"/>'
            : '<div style="width:50px;height:50px;background:#333;border-radius:4px;display:flex;justify-content:center;align-items:center">🎵</div>')
          + '<div style="flex:1">'
          + '<div style="font-weight:bold;color:#fff;font-size:.95rem">' + esc(track.title) + '</div>'
          + '<div style="color:#aaa;font-size:.85rem">' + esc(track.artist) + '</div>'
          + '<div style="margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
          + '<a href="https://www.youtube.com/results?search_query=' + encodeURIComponent(track.title + ' ' + track.artist) + '" target="_blank" style="color:#f44336;font-size:.75rem;text-decoration:none">▶️ YouTube</a>'
          + (track.link ? '<a href="' + track.link + '" target="_blank" style="color:#2196f3;font-size:.75rem;text-decoration:none">🔗 Shazam</a>' : '')
          + '<span style="color:#555;font-size:.7rem">via ' + esc(track.method || 'shazam') + '</span>'
          + '</div></div></div>';
      }).join('');

      result.innerHTML = '<div style="background:#1a2a1a;padding:12px;border-radius:6px;border-left:4px solid #4caf50">'
        + '<b style="color:#81c784;display:block;margin-bottom:8px">✅ ' + esc(data.message) + '</b>'
        + tracksHtml
        + (data.audioUrl ? '<a href="' + data.audioUrl + '" target="_blank" style="color:#64b5f6;font-size:.8rem;display:inline-block;margin-top:8px">🔗 Scarica audio completo</a>' : '')
        + '</div>';
    }

    document.getElementById('audioOverlay').classList.add('visible');
  } catch (error) {
    alert('Errore durante l\'analisi audio.');
  } finally {
    button.textContent = '🎵 Audio';
    button.classList.remove('loading');
    button.disabled = false;
  }
}

function attachDynamicEvents() {
  document.querySelectorAll('.btn-save').forEach(function (button) {
    if (button.classList.contains('saved')) return;
    button.onclick = function () {
      const short = videoMap[button.dataset.id];
      if (!short) return;
      pendingSave = {
        id: short.id,
        title: short.title,
        thumbnail: short.thumbnail,
        channelName: short.channelName,
        views: short.views,
        likes: short.likes,
        comments: short.comments || 0,
        publishedAt: short.publishedAt,
        videoUrl: 'https://www.youtube.com/shorts/' + short.id
      };
      document.getElementById('popupOverlay').classList.add('visible');
    };
  });

  document.querySelectorAll('.btn-copied').forEach(function (button) {
    button.onclick = function () { toggleCopied(button.dataset.id); };
  });

  document.querySelectorAll('.btn-remove').forEach(function (button) {
    button.onclick = function () { removeSaved(button.dataset.id); };
  });

  document.querySelectorAll('.btn-audio').forEach(function (button) {
    button.onclick = function () { showAudioResult(button.dataset.id, button); };
  });
}

function attachChannelEvents(channels) {
  const map = new Map(channels.map(function (channel) { return [channel.key, channel]; }));
  document.querySelectorAll('.channel-card').forEach(function (card) {
    card.onclick = function () {
      selectedChannel = map.get(card.dataset.channelKey) || null;
      renderChannels();
    };
  });
}

function setActiveTab(tab) {
  currentTab = tab;
  document.getElementById('tabFeed').classList.toggle('active', tab === 'feed');
  document.getElementById('tabChannels').classList.toggle('active', tab === 'channels');
  document.getElementById('tabCopied').classList.toggle('active', tab === 'copied');
  document.getElementById('tabSaved').classList.toggle('active', tab === 'saved');
  document.getElementById('controls').style.display = (tab === 'saved' || tab === 'copied') ? 'none' : '';
  document.getElementById('emptyMsg').textContent = 'Nessuno Short trovato con i filtri selezionati';
}

function syncPeriodButtons() {
  document.querySelectorAll('.btn-period').forEach(function (button) {
    button.classList.toggle('active', parseInt(button.dataset.period, 10) === currentPeriod);
  });
}

function applyPeriodDays() {
  const input = document.getElementById('periodDays');
  const value = parseInt(input.value, 10);
  if (!Number.isInteger(value) || value < 1) {
    currentPeriod = 7;
    input.value = '7';
  } else {
    currentPeriod = value;
  }
  syncPeriodButtons();
}

function applyMinViews() {
  const input = document.getElementById('minViews');
  const value = parseInt(input.value, 10);
  if (!Number.isInteger(value) || value < 1) {
    currentMinViews = 1000000;
    input.value = '1000000';
  } else {
    currentMinViews = value;
  }
}

function applyFilters() {
  applyPeriodDays();
  applyMinViews();
  refreshDataAndRender();
}

function ensureManualRefreshButton() {
  let button = document.getElementById('manualRefreshBtn');
  if (button) return button;

  const controls = document.getElementById('controls');
  if (!controls) return null;

  button = document.createElement('button');
  button.id = 'manualRefreshBtn';
  button.className = 'manual-refresh-btn';
  button.title = 'Aggiorna subito le views';
  button.textContent = '🔄 Aggiorna views ora';

  // Fallback style if HTML/CSS is from an older server instance.
  button.style.background = '#2a7d2e';
  button.style.color = '#fff';
  button.style.border = '1px solid #37a13d';
  button.style.borderRadius = '6px';
  button.style.padding = '6px 12px';
  button.style.cursor = 'pointer';
  button.style.fontSize = '.86rem';
  button.style.fontWeight = '700';

  const refreshInfo = document.querySelector('.refresh-info');
  if (refreshInfo) {
    controls.insertBefore(button, refreshInfo);
  } else {
    controls.appendChild(button);
  }

  return button;
}

function extractVideoId(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/(?:youtube\.com\/shorts\/|youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

async function doLookup() {
  const input = document.getElementById('shortLinkInput');
  const button = document.getElementById('shortLookupBtn');
  const videoId = extractVideoId(input.value);

  if (!videoId) {
    input.style.border = '2px solid #e74c3c';
    return;
  }

  input.style.border = '';
  button.disabled = true;
  button.textContent = '⏳ Cerco...';

  try {
    await loadSaved();
    const response = await fetch('/api/lookup?id=' + encodeURIComponent(videoId));
    const data = await response.json();
    if (data.error) {
      alert('Errore: ' + data.error);
      return;
    }

    const grid = document.getElementById('grid');
    grid.className = 'grid';
    grid.innerHTML = buildCard(data.short, false) + grid.innerHTML;
    attachDynamicEvents();
    input.value = '';
  } catch (error) {
    alert('Errore di rete.');
  } finally {
    button.disabled = false;
    button.textContent = '🔍 Cerca Short';
  }
}

document.getElementById('popupArkadia').addEventListener('click', function () { saveForUser('Arkadia'); });
document.getElementById('popupHolly').addEventListener('click', function () { saveForUser('Holly'); });
document.getElementById('popupCancel').addEventListener('click', function () {
  document.getElementById('popupOverlay').classList.remove('visible');
  pendingSave = null;
});
document.getElementById('audioClose').addEventListener('click', function () {
  document.getElementById('audioOverlay').classList.remove('visible');
});

document.getElementById('tabFeed').addEventListener('click', function () {
  selectedChannel = null;
  setActiveTab('feed');
  renderCurrentTab();
  if (!lastApiMeta) refreshDataAndRender();
});

document.getElementById('tabChannels').addEventListener('click', function () {
  setActiveTab('channels');
  renderCurrentTab();
  if (!lastApiMeta) refreshDataAndRender();
});

document.getElementById('tabCopied').addEventListener('click', function () {
  selectedChannel = null;
  setActiveTab('copied');
  renderCopied();
});

document.getElementById('tabSaved').addEventListener('click', function () {
  selectedChannel = null;
  setActiveTab('saved');
  renderSaved();
});

document.getElementById('channelBackBtn').addEventListener('click', function () {
  selectedChannel = null;
  renderChannels();
});

document.querySelectorAll('.btn-period').forEach(function (button) {
  button.addEventListener('click', function () {
    currentPeriod = parseInt(button.dataset.period, 10);
    document.getElementById('periodDays').value = String(currentPeriod);
    syncPeriodButtons();
    refreshDataAndRender();
  });
});

document.getElementById('periodDays').addEventListener('blur', applyPeriodDays);
document.getElementById('periodDays').addEventListener('keydown', function (event) {
  if (event.key === 'Enter') applyFilters();
});
document.getElementById('minViews').addEventListener('blur', applyMinViews);
document.getElementById('minViews').addEventListener('keydown', function (event) {
  if (event.key === 'Enter') applyFilters();
});
document.getElementById('searchBtn').addEventListener('click', applyFilters);
const manualRefreshButton = ensureManualRefreshButton();
if (manualRefreshButton) {
  manualRefreshButton.addEventListener('click', function () {
    refreshDataAndRender({ forceRefresh: true });
  });
}

document.getElementById('shortLookupBtn').addEventListener('click', doLookup);
document.getElementById('shortLinkInput').addEventListener('keydown', function (event) {
  if (event.key === 'Enter') doLookup();
});

setInterval(function () {
  if (currentTab === 'feed' || currentTab === 'channels') refreshDataAndRender();
  loadCredits();
}, 5 * 60 * 1000);

setInterval(function () {
  refreshSavedViewsManually({ silent: true, source: 'auto' });
}, 60 * 60 * 1000);

setInterval(loadCredits, 30 * 1000);

syncPeriodButtons();
loadCredits();
refreshDataAndRender();
