let videoState = null;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isWatchPage = tab?.url?.includes('youtube.com/watch');

  if (isWatchPage) {
    try {
      videoState = await chrome.tabs.sendMessage(tab.id, { action: 'getVideoState' });
    } catch {
      videoState = null;
    }

    if (videoState && !videoState.error) {
      document.getElementById('current-video').classList.remove('hidden');
      document.getElementById('not-on-video').classList.add('hidden');
      document.getElementById('video-title').textContent = videoState.title;
      document.getElementById('current-time').textContent = videoState.at;
    }
  }

  document.getElementById('save-btn').addEventListener('click', onSave);
  loadItems();
  loadPlaylistLink();
}

async function onSave() {
  if (!videoState) return;
  const btn = document.getElementById('save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const result = await chrome.runtime.sendMessage({
    action: 'save',
    data: {
      videoId: videoState.videoId,
      seconds: videoState.seconds,
      at: videoState.at,
      title: videoState.title,
      thumbnail: null,
    },
  });

  if (result?.error) {
    btn.textContent = 'Error — try again';
    btn.disabled = false;
    console.error('[Watch YT At] Save error:', result.error);
  } else {
    btn.textContent = '✓ Saved!';
    setTimeout(() => window.close(), 900);
  }
}

async function loadItems() {
  const list = document.getElementById('items-list');
  const empty = document.getElementById('empty-state');
  list.innerHTML = '<div class="muted loading">Loading…</div>';

  const items = await chrome.runtime.sendMessage({ action: 'list' });
  list.innerHTML = '';

  if (!items || items.error || items.length === 0) {
    empty.classList.remove('hidden');
    return;
  }

  // Group by videoId, preserving order of first occurrence
  const groupMap = new Map();
  items.forEach(item => {
    if (!groupMap.has(item.videoId)) {
      groupMap.set(item.videoId, { title: item.title, videoId: item.videoId, timestamps: [] });
    }
    groupMap.get(item.videoId).timestamps.push({
      entryId: item.id || item.playlistItemId,  // id for new entries, playlistItemId fallback for legacy
      seconds: item.seconds ?? 0,
      at: item.at || '?',
      saved: item.saved || '',
    });
  });

  groupMap.forEach(group => {
    const groupEl = document.createElement('div');
    groupEl.className = 'item-group';

    const titleEl = document.createElement('div');
    titleEl.className = 'item-group-title';
    titleEl.textContent = group.title;
    groupEl.appendChild(titleEl);

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

init();
