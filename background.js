const YT_API  = 'https://www.googleapis.com/youtube/v3';
const DR_API  = 'https://www.googleapis.com/drive/v3';
const DR_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const PLAYLIST_NAME      = 'Watch Later At';
const YT_PLAYLIST_KEY    = 'watchYtAtPlaylistId';
const DRIVE_FILE_KEY     = 'watchYtAtDriveFileId';
const BOOKMARKS_FILENAME = 'watchytvat-bookmarks.json';

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
    snippet: { title: PLAYLIST_NAME, description: 'Videos saved with timestamp by the Watch YT At extension.' },
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

async function saveVideoAt({ videoId, seconds, at, title, thumbnail }) {
  const token = await getAuthToken(true);

  // Add to YouTube playlist for cross-device visibility
  const playlistId = await findOrCreatePlaylist(token);
  const ytItem = await ytCall('POST', '/playlistItems?part=snippet', token, {
    snippet: {
      playlistId,
      resourceId: { kind: 'youtube#video', videoId },
    },
  });
  const playlistItemId = ytItem?.id || null;

  // Store timestamp + metadata in Drive appDataFolder
  const bookmarks = await readBookmarks(token);
  // Remove any prior bookmark for this video before adding the new one
  const filtered = bookmarks.filter(b => b.videoId !== videoId);
  const updated = [{
    videoId,
    playlistItemId,
    title,
    thumbnail: thumbnail || null,
    seconds,
    at,
    saved: new Date().toISOString().slice(0, 10),
  }, ...filtered];
  await writeBookmarks(token, updated);
  await updatePlaylistDescription(token, playlistId, updated);

  return { success: true };
}

function buildPlaylistDescription(bookmarks) {
  if (!bookmarks.length) return 'Resume at: —';
  return bookmarks.map(b => `${b.at} - ${b.title}`).join('\n');
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

  // Cross-reference with the actual YouTube playlist to remove stale entries
  // (items the user deleted directly from YouTube without using the extension).
  const cached = await chrome.storage.local.get(YT_PLAYLIST_KEY);
  const playlistId = cached[YT_PLAYLIST_KEY];
  if (!playlistId) return bookmarks;

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

  const synced = bookmarks.filter(b => !b.playlistItemId || activeIds.has(b.playlistItemId));
  if (synced.length < bookmarks.length) {
    await writeBookmarks(token, synced);
    await updatePlaylistDescription(token, playlistId, synced);
  }
  return synced;
}

async function removePlaylistItem(playlistItemId, videoId) {
  const token = await getAuthToken(true);

  // Remove from YouTube playlist
  if (playlistItemId) {
    await ytCall('DELETE', `/playlistItems?id=${encodeURIComponent(playlistItemId)}`, token);
  }

  // Remove from Drive bookmarks and refresh playlist description
  const bookmarks = await readBookmarks(token);
  const remaining = bookmarks.filter(b => b.videoId !== videoId && b.playlistItemId !== playlistItemId);
  await writeBookmarks(token, remaining);
  const playlistId = await getPlaylistId();
  await updatePlaylistDescription(token, playlistId, remaining);

  return { success: true };
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    switch (message.action) {
      case 'save':          return saveVideoAt(message.data);
      case 'list':          return getPlaylistItems();
      case 'getPlaylistId': return getPlaylistId();
      case 'remove':        return removePlaylistItem(message.playlistItemId, message.videoId);
      default:              throw new Error(`Unknown action: ${message.action}`);
    }
  };
  handle()
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true;
});
