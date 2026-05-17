let videoState = null;
let currentTab = null;

async function init() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isWatchPage = currentTab?.url?.includes('youtube.com/watch');

  if (isWatchPage) {
    try {
      videoState = await chrome.tabs.sendMessage(currentTab.id, { action: 'getVideoState' });
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
  document.getElementById('open-sidebar-btn').addEventListener('click', openSidebar);
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
    console.error('[Watch YT Videos At] Save error:', result.error);
  } else {
    btn.textContent = '✓ Saved!';
    setTimeout(() => window.close(), 900);
  }
}

async function openSidebar() {
  if (currentTab?.windowId != null) {
    await chrome.runtime.sendMessage({ action: 'openSidePanel', windowId: currentTab.windowId });
  }
  window.close();
}

init();
