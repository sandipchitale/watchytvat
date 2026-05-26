const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let refreshTimer = null;
let lastRefreshTime = null;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateLastRefreshLabel() {
  const el = document.getElementById('last-refresh');
  if (!lastRefreshTime) { el.textContent = ''; return; }
  const secs = Math.round((Date.now() - lastRefreshTime) / 1000);
  if (secs < 10) el.textContent = 'Updated just now';
  else if (secs < 3600) el.textContent = `Updated ${Math.floor(secs / 60) || 1}m ago`;
  else el.textContent = `Updated ${Math.floor(secs / 3600)}h ago`;
}

async function loadItems() {
  const list = document.getElementById('items-list');
  const empty = document.getElementById('empty-state');
  list.innerHTML = '<div class="muted loading">Loading…</div>';
  empty.classList.add('hidden');

  const items = await chrome.runtime.sendMessage({ action: 'list' });
  list.innerHTML = '';
  lastRefreshTime = Date.now();
  updateLastRefreshLabel();

  if (!items || items.error || items.length === 0) {
    empty.classList.remove('hidden');
    return;
  }

  const groupMap = new Map();
  items.forEach(item => {
    if (!groupMap.has(item.videoId)) {
      groupMap.set(item.videoId, {
        title: item.title,
        videoId: item.videoId,
        thumbnail: item.thumbnail || null,
        timestamps: [],
      });
    }
    groupMap.get(item.videoId).timestamps.push({
      entryId: item.id || item.playlistItemId,
      seconds: item.seconds ?? 0,
      at: item.at || '?',
      saved: item.saved || '',
    });
  });

  groupMap.forEach(group => {
    const groupEl = document.createElement('div');
    groupEl.className = 'item-group';

    const headerEl = document.createElement('div');
    headerEl.className = 'item-group-header';
    if (group.thumbnail) {
      const img = document.createElement('img');
      img.className = 'item-thumb';
      img.src = group.thumbnail;
      img.alt = '';
      headerEl.appendChild(img);
    }
    const titleEl = document.createElement('div');
    titleEl.className = 'item-group-title';
    titleEl.textContent = group.title;
    headerEl.appendChild(titleEl);
    groupEl.appendChild(headerEl);

    group.timestamps.forEach(ts => {
      const row = document.createElement('div');
      row.className = 'item-row';

      const link = document.createElement('a');
      link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(group.videoId)}&t=${ts.seconds}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'item-link';
      link.innerHTML = `<div class="item-meta">▶ at ${escapeHtml(ts.at)}${ts.saved ? ` &middot; ${escapeHtml(ts.saved)}` : ''}</div>`;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-btn';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove this timestamp';
      removeBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.style.opacity = '0.4';
        removeBtn.disabled = true;
        const result = await chrome.runtime.sendMessage({
          action: 'remove',
          entryId: ts.entryId,
          videoId: group.videoId,
        });
        if (result?.error) {
          row.style.opacity = '1';
          removeBtn.disabled = false;
        } else {
          row.remove();
          if (!groupEl.querySelector('.item-row')) groupEl.remove();
          if (!list.children.length) empty.classList.remove('hidden');
        }
      });

      row.appendChild(link);
      row.appendChild(removeBtn);
      groupEl.appendChild(row);
    });

    list.appendChild(groupEl);
  });
}

async function loadPlaylistLink() {
  const playlistId = await chrome.runtime.sendMessage({ action: 'getPlaylistId' });
  if (typeof playlistId !== 'string') return;
  const link = document.getElementById('playlist-link');
  link.href = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  link.classList.remove('hidden');
}

function scheduleAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(loadItems, REFRESH_INTERVAL_MS);
}

// Keep the "X min ago" label live
setInterval(updateLastRefreshLabel, 30_000);

// Refresh immediately when a save completes in the popup
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'bookmarksUpdated') loadItems();
});

async function init() {
  document.getElementById('refresh-btn').addEventListener('click', loadItems);
  await Promise.all([loadItems(), loadPlaylistLink()]);
  scheduleAutoRefresh();
}

init();
