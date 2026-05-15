function formatTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Respond to popup requesting current video state
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getVideoState') {
    const video = document.querySelector('video');
    const videoId = new URLSearchParams(window.location.search).get('v');
    if (!video || !videoId) {
      sendResponse({ error: 'No video found' });
      return true;
    }
    const seconds = Math.floor(video.currentTime);
    sendResponse({
      videoId,
      seconds,
      at: formatTime(seconds),
      title: document.title.replace(/ - YouTube$/, '').trim(),
    });
  }
  return true;
});

// --- Playlist page: inject "Resume at X:XX" buttons ---

let activeItemMap = null;  // keyed by videoId, set once we're on the right playlist
let pollInterval = null;

function applyResumeButtons() {
  if (!activeItemMap) return;
  const rows = document.querySelectorAll('ytd-playlist-video-renderer:not([data-wyta-injected])');
  rows.forEach(row => {
    const anchor = row.querySelector('a#video-title');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    const videoId = new URLSearchParams(href.split('?')[1] || '').get('v');
    if (!videoId || !activeItemMap[videoId]) return;

    const { seconds, at } = activeItemMap[videoId];
    const btn = document.createElement('a');
    btn.className = 'wyta-resume-btn';
    btn.href = `https://www.youtube.com/watch?v=${videoId}&t=${seconds}`;
    btn.textContent = `▶ Resume at ${at}`;
    btn.title = `Resume from ${at} (${seconds}s)`;

    const meta = anchor.closest('#meta') || anchor.parentElement;
    meta.appendChild(btn);
    row.setAttribute('data-wyta-injected', '1');
  });
}

async function setupPlaylistInjection() {
  if (!window.location.pathname.startsWith('/playlist')) return;
  const listParam = new URLSearchParams(window.location.search).get('list');
  if (!listParam) return;

  // Get the Watch Later At playlist ID (served from cache in background, no auth needed)
  let playlistId;
  try {
    playlistId = await chrome.runtime.sendMessage({ action: 'getPlaylistId' });
  } catch (e) {
    console.warn('[WatchYTAt] getPlaylistId failed:', e);
    return;
  }

  // Guard: must be a string matching the current URL's list param
  if (typeof playlistId !== 'string' || playlistId !== listParam) {
    console.log('[WatchYTAt] Not the Watch Later At playlist:', playlistId, '≠', listParam);
    return;
  }

  // Fetch saved items with timestamps
  let items;
  try {
    items = await chrome.runtime.sendMessage({ action: 'list' });
  } catch (e) {
    console.warn('[WatchYTAt] list failed:', e);
    return;
  }
  if (!items || items.error) {
    console.warn('[WatchYTAt] list error:', items?.error);
    return;
  }

  activeItemMap = {};
  items.forEach(item => {
    if (item.seconds != null) activeItemMap[item.videoId] = { seconds: item.seconds, at: item.at };
  });
  console.log('[WatchYTAt] Loaded', Object.keys(activeItemMap).length, 'items');

  // Poll until all uninjected rows are processed (YouTube renders them lazily)
  applyResumeButtons();
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    applyResumeButtons();
    // Stop when there are no more uninjected rows left
    if (!document.querySelector('ytd-playlist-video-renderer:not([data-wyta-injected])')) {
      clearInterval(pollInterval);
    }
  }, 500);
  // Hard stop after 15 seconds regardless
  setTimeout(() => clearInterval(pollInterval), 15000);
}

// SPA navigation detection — YouTube doesn't do full page reloads
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    activeItemMap = null;
    if (pollInterval) clearInterval(pollInterval);
    setupPlaylistInjection();
  }
}).observe(document.documentElement, { childList: true, subtree: true });

setupPlaylistInjection();
