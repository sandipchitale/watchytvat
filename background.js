const YT_API = 'https://www.googleapis.com/youtube/v3';
const DR_API = 'https://www.googleapis.com/drive/v3';
const DR_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const PLAYLIST_NAME = 'Watch Later At';
const YT_PLAYLIST_KEY = 'watchYtAtPlaylistId';
const DRIVE_FILE_KEY = 'watchYtAtDriveFileId';
const BOOKMARKS_FILENAME = 'watchytvat-bookmarks.json';
const LAST_SYNC_KEY = 'watchYtAtLastSync';
const SYNC_STALE_MS = 5 * 60 * 1000; // skip YT cross-reference if synced within 5 min

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(token);
    });
  });
}

async function removeCachedToken(token) {
  return new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

// Clears the cached token and gets a fresh one with all current scopes.
async function refreshAuthToken() {
  const stale = await getAuthToken(false).catch(() => null);
  if (stale) await removeCachedToken(stale);
  return getAuthToken(true);
}

// ---------------------------------------------------------------------------
// YouTube playlist helpers
// ---------------------------------------------------------------------------

async function ytCall(method, endpoint, token, body = null) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${YT_API}${endpoint}`, opts);
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `YT API ${res.status}`);
  return data;
}

async function findOrCreatePlaylist(token) {
  const cached = await chrome.storage.local.get(YT_PLAYLIST_KEY);
  if (cached[YT_PLAYLIST_KEY]) return cached[YT_PLAYLIST_KEY];

  let pageToken = '';
  do {
    const qs = `/playlists?part=snippet&mine=true&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const data = await ytCall('GET', qs, token);
    const match = data.items?.find(p => p.snippet.title === PLAYLIST_NAME);
    if (match) {
      await chrome.storage.local.set({ [YT_PLAYLIST_KEY]: match.id });
      return match.id;
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  const created = await ytCall('POST', '/playlists?part=snippet,status', token, {
    snippet: { title: PLAYLIST_NAME, description: 'Videos saved with timestamp by the Watch YT Videos At extension.' },
    status: { privacyStatus: 'private' },
  });
  await chrome.storage.local.set({ [YT_PLAYLIST_KEY]: created.id });
  return created.id;
}

async function getPlaylistId() {
  // Return cached ID without requiring a network call — ID never changes after creation
  const cached = await chrome.storage.local.get(YT_PLAYLIST_KEY);
  if (cached[YT_PLAYLIST_KEY]) return cached[YT_PLAYLIST_KEY];
  const token = await getAuthToken(true);
  return findOrCreatePlaylist(token);
}

// ---------------------------------------------------------------------------
// Google Drive appDataFolder helpers
// Stores a single JSON file: { bookmarks: [...] }
// Each bookmark: { videoId, playlistItemId, title, thumbnail, seconds, at, saved }
// ---------------------------------------------------------------------------

async function driveCall(method, endpoint, token, body = null) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${DR_API}${endpoint}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || `Drive API ${res.status}`;
    // Stale token with missing scopes — caller should refresh and retry
    if (res.status === 401 || (res.status === 403 && msg.includes('scope'))) {
      const e = new Error(msg);
      e.needsTokenRefresh = true;
      throw e;
    }
    throw new Error(msg);
  }
  return res.json();
}

async function getDriveFileId(token) {
  const cached = await chrome.storage.local.get(DRIVE_FILE_KEY);
  if (cached[DRIVE_FILE_KEY]) return cached[DRIVE_FILE_KEY];

  const data = await driveCall(
    'GET',
    `/files?spaces=appDataFolder&q=name%3D'${BOOKMARKS_FILENAME}'&fields=files(id)`,
    token
  );
  const fileId = data.files?.[0]?.id || null;
  if (fileId) await chrome.storage.local.set({ [DRIVE_FILE_KEY]: fileId });
  return fileId;
}

async function readBookmarksWithToken(token) {
  const fileId = await getDriveFileId(token);
  if (!fileId) return [];
  const res = await fetch(`${DR_API}/files/${fileId}?alt=media`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) {
    const e = new Error(`Drive read ${res.status}`);
    e.needsTokenRefresh = true;
    throw e;
  }
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.bookmarks) ? data.bookmarks : [];
}

async function readBookmarks(token) {
  try {
    return await readBookmarksWithToken(token);
  } catch (e) {
    if (e.needsTokenRefresh) {
      const fresh = await refreshAuthToken();
      return readBookmarksWithToken(fresh);
    }
    throw e;
  }
}

async function writeBookmarksWithToken(token, bookmarks) {
  const content = JSON.stringify({ bookmarks });
  const fileId = await getDriveFileId(token);

  if (fileId) {
    // Update existing file content
    await fetch(`${DR_UPLOAD}/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: content,
    });
  } else {
    // Create new file in appDataFolder using multipart upload
    const boundary = 'wyta_boundary_x7z';
    const meta = JSON.stringify({ name: BOOKMARKS_FILENAME, parents: ['appDataFolder'] });
    const multipart = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      meta,
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      content,
      `--${boundary}--`,
    ].join('\r\n');

    const res = await fetch(`${DR_UPLOAD}/files?uploadType=multipart`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipart,
    });
    const data = await res.json();
    if (data.id) await chrome.storage.local.set({ [DRIVE_FILE_KEY]: data.id });
  }
}

async function writeBookmarks(token, bookmarks) {
  try {
    await writeBookmarksWithToken(token, bookmarks);
  } catch (e) {
    if (e.needsTokenRefresh) {
      const fresh = await refreshAuthToken();
      await writeBookmarksWithToken(fresh, bookmarks);
    } else {
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Extension actions
// ---------------------------------------------------------------------------

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

async function saveVideoAt({ videoId, seconds, at, title, thumbnail }) {
  const token = await getAuthToken(true);
  const bookmarks = await readBookmarks(token);

  // Reuse the existing YouTube playlist item if the video was saved before;
  // only add a new playlist item on the very first save for this video.
  const existingForVideo = bookmarks.find(b => b.videoId === videoId);
  let playlistItemId;
  let playlistId;

  if (existingForVideo) {
    playlistItemId = existingForVideo.playlistItemId;
    playlistId = (await chrome.storage.local.get(YT_PLAYLIST_KEY))[YT_PLAYLIST_KEY];
  } else {
    playlistId = await findOrCreatePlaylist(token);
    const ytItem = await ytCall('POST', '/playlistItems?part=snippet', token, {
      snippet: {
        playlistId,
        resourceId: { kind: 'youtube#video', videoId },
      },
    });
    playlistItemId = ytItem?.id || null;
  }

  const updated = [{
    id: generateId(),
    videoId,
    playlistItemId,
    title,
    thumbnail: thumbnail || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    seconds,
    at,
    saved: new Date().toISOString().slice(0, 10),
  }, ...bookmarks];
  await writeBookmarks(token, updated);
  if (playlistId) await updatePlaylistDescription(token, playlistId, updated);

  return { success: true };
}

const YT_DESCRIPTION_LIMIT = 5000;

function buildPlaylistDescription(bookmarks) {
  if (!bookmarks.length) return '—';
  const byVideo = new Map();
  bookmarks.forEach(b => {
    if (!byVideo.has(b.videoId)) byVideo.set(b.videoId, { title: b.title, ats: [] });
    byVideo.get(b.videoId).ats.push(b.at);
  });
  const lines = [...byVideo.values()].map(v => `${v.ats.join(', ')} - ${v.title}`);
  // Drop whole-video lines from the end rather than cutting mid-string
  const kept = [];
  let len = 0;
  for (const line of lines) {
    const needed = (kept.length > 0 ? 1 : 0) + line.length;
    if (len + needed > YT_DESCRIPTION_LIMIT) break;
    kept.push(line);
    len += needed;
  }
  return kept.join('\n') || '—';
}

async function updatePlaylistDescription(token, playlistId, bookmarks) {
  const description = buildPlaylistDescription(bookmarks);
  await ytCall('PUT', '/playlists?part=snippet', token, {
    id: playlistId,
    snippet: {
      title: PLAYLIST_NAME,
      description,
    },
  });
}

async function getPlaylistItems() {
  const token = await getAuthToken(true);
  const bookmarks = await readBookmarks(token);
  if (!bookmarks.length) return bookmarks;

  // Lazy sync: skip the YouTube API cross-reference if we synced recently.
  const store = await chrome.storage.local.get([YT_PLAYLIST_KEY, LAST_SYNC_KEY]);
  const playlistId = store[YT_PLAYLIST_KEY];
  if (!playlistId) return bookmarks;

  const lastSync = store[LAST_SYNC_KEY] || 0;
  if (Date.now() - lastSync < SYNC_STALE_MS) return bookmarks;

  // Cross-reference with the actual YouTube playlist to remove stale entries
  // (items the user deleted directly from YouTube without using the extension).
  let activeIds;
  try {
    activeIds = new Set();
    let pageToken = '';
    do {
      const qs = `/playlistItems?part=id&playlistId=${encodeURIComponent(playlistId)}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const data = await ytCall('GET', qs, token);
      data.items?.forEach(item => activeIds.add(item.id));
      pageToken = data.nextPageToken || '';
    } while (pageToken);
  } catch {
    return bookmarks; // sync failed — return what Drive has
  }

  await chrome.storage.local.set({ [LAST_SYNC_KEY]: Date.now() });

  const synced = bookmarks.filter(b => !b.playlistItemId || activeIds.has(b.playlistItemId));
  if (synced.length < bookmarks.length) {
    await writeBookmarks(token, synced);
    await updatePlaylistDescription(token, playlistId, synced);
  }
  return synced;
}

async function removePlaylistItem(entryId, videoId) {
  const token = await getAuthToken(true);
  const bookmarks = await readBookmarks(token);

  // Find the specific Drive entry (by id; fall back to playlistItemId for legacy entries)
  const target = bookmarks.find(b => b.id ? b.id === entryId : b.playlistItemId === entryId);
  if (!target) return { success: true };

  const remaining = bookmarks.filter(b => b !== target);

  // Remove from YouTube playlist only when this was the last timestamp for the video
  const videoStillSaved = remaining.some(b => b.videoId === videoId);
  if (target.playlistItemId && !videoStillSaved) {
    await ytCall('DELETE', `/playlistItems?id=${encodeURIComponent(target.playlistItemId)}`, token);
  }

  await writeBookmarks(token, remaining);
  const playlistId = await getPlaylistId();
  await updatePlaylistDescription(token, playlistId, remaining);
  // Invalidate sync cache so the next list call re-checks the YouTube playlist
  await chrome.storage.local.remove(LAST_SYNC_KEY);

  return { success: true };
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    switch (message.action) {
      case 'save': return saveVideoAt(message.data);
      case 'list': return getPlaylistItems();
      case 'getPlaylistId': return getPlaylistId();
      case 'remove': return removePlaylistItem(message.entryId, message.videoId);
      default: throw new Error(`Unknown action: ${message.action}`);
    }
  };
  handle()
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true;
});
