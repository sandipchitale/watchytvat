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

  items.forEach(item => {
    // Bookmarks stored flat: item.seconds, item.at, item.saved
    const at      = item.at || '?';
    const seconds = item.seconds ?? 0;
    const saved   = item.saved || '';

    const row = document.createElement('div');
    row.className = 'item-row';

    const link = document.createElement('a');
    link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}&t=${seconds}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'item-link';
    link.innerHTML = `
      <div class="item-title">${escapeHtml(item.title)}</div>
      <div class="item-meta">at ${escapeHtml(at)}${saved ? ` &middot; ${escapeHtml(saved)}` : ''}</div>
    `;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove from Watch Later At';
    removeBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.style.opacity = '0.4';
      removeBtn.disabled = true;
      const result = await chrome.runtime.sendMessage({
        action: 'remove',
        playlistItemId: item.playlistItemId,
        videoId: item.videoId,
      });
      if (result?.error) {
        row.style.opacity = '1';
        removeBtn.disabled = false;
      } else {
        row.remove();
        if (!list.children.length) empty.classList.remove('hidden');
      }
    });

    row.appendChild(link);
    row.appendChild(removeBtn);
    list.appendChild(row);
  });
}

init();
