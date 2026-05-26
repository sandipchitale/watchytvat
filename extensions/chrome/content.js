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
let rowObserver = null;

function applyResumeButtons() {
  if (!activeItemMap) return;
  const rows = document.querySelectorAll('ytd-playlist-video-renderer:not([data-wyta-injected])');
  rows.forEach(row => {
    const anchor = row.querySelector('a#video-title');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    const videoId = new URLSearchParams(href.split('?')[1] || '').get('v');
    const timestamps = videoId && activeItemMap[videoId];
    if (!timestamps || !timestamps.length) return;

    const meta = anchor.closest('#meta') || anchor.parentElement;

    if (timestamps.length === 1) {
      const { seconds, at } = timestamps[0];
      const btn = document.createElement('a');
      btn.className = 'wyta-resume-btn';
      btn.href = `https://www.youtube.com/watch?v=${videoId}&t=${seconds}`;
      btn.textContent = `▶ Resume at ${at}`;
      btn.title = `Resume from ${at} (${seconds}s)`;
      meta.appendChild(btn);
    } else {
      const wrapper = document.createElement('div');
      wrapper.className = 'wyta-menu-wrapper';

      const trigger = document.createElement('span');
      trigger.className = 'wyta-resume-btn wyta-menu-trigger';
      trigger.textContent = `▶ Resume ▾`;
      trigger.title = `${timestamps.length} saved timestamps — click to choose`;

      const menu = document.createElement('div');
      menu.className = 'wyta-menu';
      timestamps.forEach(({ seconds, at }) => {
        const item = document.createElement('a');
        item.className = 'wyta-menu-item';
        item.href = `https://www.youtube.com/watch?v=${videoId}&t=${seconds}`;
        item.textContent = `▶ ${at}`;
        menu.appendChild(item);
      });

      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        menu.classList.toggle('wyta-menu-open');
      });

      wrapper.appendChild(trigger);
      wrapper.appendChild(menu);
      meta.appendChild(wrapper);
    }

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
    if (item.seconds != null) {
      if (!activeItemMap[item.videoId]) activeItemMap[item.videoId] = [];
      activeItemMap[item.videoId].push({ seconds: item.seconds, at: item.at });
    }
  });
  console.log('[WatchYTAt] Loaded', Object.keys(activeItemMap).length, 'items');

  // Inject immediately, then watch for rows YouTube renders lazily
  applyResumeButtons();
  if (rowObserver) rowObserver.disconnect();

  const stopObserver = () => { rowObserver.disconnect(); rowObserver = null; };
  rowObserver = new MutationObserver(() => {
    applyResumeButtons();
    if (!document.querySelector('ytd-playlist-video-renderer:not([data-wyta-injected])')) {
      stopObserver();
    }
  });
  // Watch the playlist container; fall back to body if not yet in the DOM
  const container = document.querySelector('ytd-playlist-video-list-renderer') || document.body;
  rowObserver.observe(container, { childList: true, subtree: true });
  setTimeout(() => { if (rowObserver) stopObserver(); }, 15000);
}

// SPA navigation detection — YouTube doesn't do full page reloads
let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    activeItemMap = null;
    if (rowObserver) { rowObserver.disconnect(); rowObserver = null; }
    setupPlaylistInjection();
  }
}).observe(document.documentElement, { childList: true, subtree: true });

setupPlaylistInjection();

if (!window._wytaMenuListenerAdded) {
  window._wytaMenuListenerAdded = true;
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.wyta-menu-wrapper')) {
      document.querySelectorAll('.wyta-menu.wyta-menu-open')
        .forEach(m => m.classList.remove('wyta-menu-open'));
    }
  }, true);
}
