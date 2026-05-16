# Watch YT Videos At

Save a YouTube video at its current timestamp into a private **"Watch Later At"** playlist. Resume from exactly that point — on any device — without losing your place.

## Features

- **Save at any timestamp** — click the extension icon while watching, hit "Save at X:XX"
- **Multiple timestamps per video** — save the same video at different points; each is tracked separately
- **Cross-device sync** — timestamps are stored in your Google Drive `appDataFolder` and sync automatically via your Google account
- **Resume buttons on the playlist page** — opening the "Watch Later At" playlist injects a **▶ Resume at X:XX** button (or a **▶ Resume ▾** dropdown for multiple timestamps) next to each video
- **Popup quick-list** — the toolbar popup shows all saved videos grouped by thumbnail + title, with individual ✕ buttons to remove any timestamp; includes a direct link to the playlist

## How it works

```
YouTube Data API v3          Google Drive appDataFolder
──────────────────           ──────────────────────────
"Watch Later At" playlist    watchytvat-bookmarks.json
  • one playlist item         • one bookmark entry per
    per video (for            saved timestamp:
    cross-device              { id, videoId,
    visibility)                 playlistItemId, title,
                                thumbnail, seconds,
                                at, saved }
```

1. **Saving** — the extension reads the current video time from the page, adds the video to the "Watch Later At" YouTube playlist (first save only; subsequent timestamps reuse the same playlist item), then prepends a bookmark entry to the Drive JSON file. The thumbnail URL is derived for free from the `videoId` — no extra API call.
2. **Listing** — the popup reads the Drive file. To keep things snappy, it only cross-references against the live YouTube playlist if the last sync was more than 5 minutes ago (lazy sync with `watchYtAtLastSync` in `chrome.storage.local`). When a sync does run, any bookmark whose playlist item was deleted outside the extension is automatically pruned. The sync cache is invalidated immediately on manual removal so deleted items never linger.
3. **Resume injection** — on the playlist page the content script matches each row's `videoId` against the Drive bookmarks and injects a resume button or timestamp-picker dropdown. Row injection uses a `MutationObserver` on the playlist container so it fires exactly when YouTube adds new rows, with a 15-second hard disconnect as a safety net.
4. **Removing** — the ✕ button removes the specific bookmark entry from Drive; the YouTube playlist item is only deleted when the last timestamp for that video is removed.

The playlist description is updated on every save/remove to show all current timestamps (readable on any device even without the extension):
```
53:46, 25:23 - The Uncomfortable Truth About AI | World Science Festival
1:02:10 - Another Video Title
```

## One-time setup

### 1. Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (or reuse an existing one).
2. **APIs & Services → Library** — enable both:
   - **YouTube Data API v3**
   - **Google Drive API**

### 2. OAuth consent screen

1. **APIs & Services → OAuth consent screen**
2. Choose **External**, fill in app name and your email.
3. Add two scopes:
   - `https://www.googleapis.com/auth/youtube`
   - `https://www.googleapis.com/auth/drive.appdata`
4. Under **Test users**, add the Google account you use in Chrome (required while the app is unverified).

### 3. OAuth 2.0 Client ID

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Chrome App**
3. Load the extension as unpacked first (see step 5) to get its ID from `chrome://extensions`, then paste it as the **Application ID**.
4. Click **Create** and copy the Client ID (`123456789-abc....apps.googleusercontent.com`).

### 4. Add the client ID to the extension

Edit `manifest.json`:

```json
"oauth2": {
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "scopes": [
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/drive.appdata"
  ]
}
```

### 5. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder
4. The Watch YT Videos At icon appears in your toolbar

On first use Chrome shows a one-time consent screen. After that the extension uses your existing Google login silently. If you ever add a new scope to the manifest, Chrome may return a stale cached token; the extension handles this automatically by detecting 401/403 scope errors and re-requesting a fresh token.

## Files

```
manifest.json      MV3 manifest — permissions, OAuth2, content scripts
background.js      Service worker — YouTube & Drive API calls, auth, message router
content.js         Injected on youtube.com — reads video time; injects resume UI on playlist page
content.css        Styles for injected resume button and timestamp-picker dropdown
popup.html         Toolbar popup markup
popup.js           Popup logic — save, grouped list, remove, playlist link
popup.css          Popup styles
icons/             icon16.png, icon48.png, icon128.png (red rounded rect + play triangle + clock face)
```

## Data model

Drive file `watchytvat-bookmarks.json` (in `appDataFolder`, invisible to the user):

```json
{
  "bookmarks": [
    {
      "id": "lz3k8a7f",
      "videoId": "dQw4w9WgXcQ",
      "playlistItemId": "PLxxxxxxx-item-id",
      "title": "Video Title",
      "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
      "seconds": 3226,
      "at": "53:46",
      "saved": "2026-05-15"
    }
  ]
}
```

- `id` — unique per bookmark entry (base-36 timestamp + random suffix); used for targeted removal
- `playlistItemId` — YouTube playlist item ID; shared across all timestamps for the same video
- `thumbnail` — derived from `videoId` at save time (`i.ytimg.com/vi/{videoId}/mqdefault.jpg`); displayed as a 64×36 px thumbnail in the popup
- `seconds` / `at` — the saved position (integer seconds and human-readable string)
- `saved` — ISO date the bookmark was created

---

## Appendix A — One-shot prompt

The following prompt, given to a capable code-generation model, should reproduce this extension in a single pass. Supply your own Google Cloud OAuth client ID where indicated.

---

```
Build a Chrome extension (Manifest V3) called "Watch YT Videos At" that saves YouTube videos at
their current playback timestamp so the user can resume from exactly that position on any
device. Use only the user's existing Google account in Chrome — no separate login flow.

──────────────────────────────────────────────────────────────────────────────
STORAGE DESIGN
──────────────────────────────────────────────────────────────────────────────
Two stores work together:

1. YouTube playlist "Watch Later At" (private) — holds the actual videos so they appear
   on any device in the YouTube app. One playlist item per video regardless of how many
   timestamps are saved. IMPORTANT: YouTube's contentDetails.note field silently discards
   writes — do NOT use it to store timestamps.

2. Google Drive appDataFolder file "watchytvat-bookmarks.json" — hidden per-app storage,
   syncs via Google account, invisible in Drive UI. Stores an array of bookmark objects:

   {
     id: string,            // unique per entry: Date.now().toString(36) + random suffix
     videoId: string,       // YouTube video ID
     playlistItemId: string,// YouTube playlist item ID (shared across timestamps for same video)
     title: string,         // video title from document.title
     thumbnail: string,     // "https://i.ytimg.com/vi/{videoId}/mqdefault.jpg" — free, no API call
     seconds: number,       // integer seconds
     at: string,            // formatted "m:ss" or "h:mm:ss"
     saved: string          // "YYYY-MM-DD"
   }

Multiple timestamps per video are supported. All bookmark entries for the same video share
the same playlistItemId. A new YouTube playlist item is only created on the very first save
for a given video; subsequent saves for the same video reuse the existing playlistItemId.

──────────────────────────────────────────────────────────────────────────────
MANIFEST (manifest.json)
──────────────────────────────────────────────────────────────────────────────
- manifest_version: 3
- permissions: ["identity", "storage", "activeTab", "scripting"]
- host_permissions: ["https://www.youtube.com/*", "https://www.googleapis.com/*"]
- background service_worker: background.js
- content_scripts: content.js + content.css on https://www.youtube.com/*, run_at document_idle
- action: popup.html, icon set
- oauth2:
    client_id: "REPLACE_WITH_YOUR_CLIENT_ID.apps.googleusercontent.com"
    scopes:
      - "https://www.googleapis.com/auth/youtube"
      - "https://www.googleapis.com/auth/drive.appdata"

──────────────────────────────────────────────────────────────────────────────
BACKGROUND SERVICE WORKER (background.js)
──────────────────────────────────────────────────────────────────────────────
Constants:
  YT_API     = "https://www.googleapis.com/youtube/v3"
  DR_API     = "https://www.googleapis.com/drive/v3"
  DR_UPLOAD  = "https://www.googleapis.com/upload/drive/v3"
  PLAYLIST_NAME      = "Watch Later At"
  YT_PLAYLIST_KEY    = "watchYtAtPlaylistId"   // chrome.storage.local key
  DRIVE_FILE_KEY     = "watchYtAtDriveFileId"  // chrome.storage.local key
  BOOKMARKS_FILENAME = "watchytvat-bookmarks.json"

Auth helpers:
  getAuthToken(interactive=true)  — wraps chrome.identity.getAuthToken
  removeCachedToken(token)        — wraps chrome.identity.removeCachedAuthToken
  refreshAuthToken()              — removes stale token then calls getAuthToken(true)
    (needed when Chrome returns a cached token that predates a new scope being added)

YouTube helpers:
  ytCall(method, endpoint, token, body?)
    — fetch wrapper; returns null on 204, throws on error
  findOrCreatePlaylist(token)
    — paginates GET /playlists?part=snippet&mine=true, finds title === PLAYLIST_NAME,
      creates private playlist if not found, caches ID in chrome.storage.local
  getPlaylistId()
    — returns cached playlist ID from storage (no network call needed if already set);
      falls back to findOrCreatePlaylist only when cache is empty

Drive helpers:
  driveCall(method, endpoint, token, body?)
    — fetch wrapper; on 401 or 403-with-"scope" sets e.needsTokenRefresh=true and throws
  getDriveFileId(token)
    — GET /files?spaces=appDataFolder&q=name='watchytvat-bookmarks.json'&fields=files(id)
    — caches file ID in chrome.storage.local
  readBookmarks(token)  / readBookmarksWithToken(token)
    — fetches file content with ?alt=media, returns bookmarks array; auto-retries once
      via refreshAuthToken() on needsTokenRefresh errors
  writeBookmarks(token, bookmarks)  / writeBookmarksWithToken(token, bookmarks)
    — PATCH to DR_UPLOAD/files/{id}?uploadType=media if file exists;
      otherwise multipart POST to DR_UPLOAD/files?uploadType=multipart to create it
    — auto-retries via refreshAuthToken() on needsTokenRefresh errors

Extension actions:
  generateId()
    — returns Date.now().toString(36) + Math.random().toString(36).slice(2,5)

  saveVideoAt({ videoId, seconds, at, title, thumbnail })
    1. getAuthToken(true)
    2. readBookmarks — check if any existing entry has this videoId
    3. If yes: reuse its playlistItemId and the cached playlist ID
       If no: findOrCreatePlaylist, POST /playlistItems to add video, get new playlistItemId
    4. Derive thumbnail URL: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` (no API call)
    5. Prepend new bookmark object (with fresh generateId()) to bookmarks array
    6. writeBookmarks
    7. updatePlaylistDescription

  buildPlaylistDescription(bookmarks)
    — groups by videoId, produces one line per video:
      "53:46, 25:23 - Video Title\n1:02:10 - Other Title"
    — QUOTA GUARD: drops whole-video lines from the end once adding the next line
      would exceed 5000 characters (YouTube's playlist description limit)

  updatePlaylistDescription(token, playlistId, bookmarks)
    — PUT /playlists?part=snippet with id, snippet.title, snippet.description

  getPlaylistItems()
    1. getAuthToken(true), readBookmarks
    2. LAZY SYNC: read watchYtAtLastSync from chrome.storage.local;
       if Date.now() - lastSync < SYNC_STALE_MS (5 min), skip steps 3-5 and return bookmarks
    3. Paginate GET /playlistItems?part=id&playlistId=...&maxResults=50
       to collect all active YouTube playlist item IDs into a Set
    4. Store Date.now() as watchYtAtLastSync
    5. Filter bookmarks to those whose playlistItemId is in the Set;
       if any were pruned: writeBookmarks + updatePlaylistDescription
    6. Return (possibly pruned) bookmarks

  removePlaylistItem also calls chrome.storage.local.remove(LAST_SYNC_KEY) after writing,
  so a manually removed item is never hidden by a stale sync cache.

  removePlaylistItem(entryId, videoId)
    1. readBookmarks
    2. Find target entry: match b.id === entryId; fall back to b.playlistItemId === entryId
       for legacy entries that pre-date the id field
    3. Filter target out of bookmarks → remaining
    4. If no remaining entry has the same videoId:
       DELETE /playlistItems?id={playlistItemId} from YouTube
    5. writeBookmarks, updatePlaylistDescription

Message router (chrome.runtime.onMessage):
  "save"          → saveVideoAt(message.data)
  "list"          → getPlaylistItems()
  "getPlaylistId" → getPlaylistId()
  "remove"        → removePlaylistItem(message.entryId, message.videoId)
  Return true from the listener to keep the channel open for async sendResponse.

──────────────────────────────────────────────────────────────────────────────
CONTENT SCRIPT (content.js)
──────────────────────────────────────────────────────────────────────────────
formatTime(totalSeconds) → "m:ss" or "h:mm:ss"

Message listener for "getVideoState":
  — reads document.querySelector("video").currentTime (floor to integer)
  — reads videoId from URLSearchParams("v")
  — reads title from document.title replacing / - YouTube$/ with ""
  — sends { videoId, seconds, at: formatTime(seconds), title }

Playlist page injection:
  activeItemMap = null  // Map<videoId, Array<{seconds, at}>>
  rowObserver = null    // MutationObserver for lazy playlist rows

  applyResumeButtons():
    — queries ytd-playlist-video-renderer:not([data-wyta-injected])
    — for each row: parse videoId from a#video-title href
    — look up activeItemMap[videoId] (an array)
    — if array has 1 entry: append an <a class="wyta-resume-btn"> to #meta
    — if array has 2+ entries: append a .wyta-menu-wrapper containing:
        <span class="wyta-resume-btn wyta-menu-trigger">▶ Resume ▾</span>
        <div class="wyta-menu"> with one <a class="wyta-menu-item"> per timestamp
      click on trigger toggles .wyta-menu-open on the menu
    — mark row with data-wyta-injected="1"

  setupPlaylistInjection():
    — only runs on /playlist?list=... pages
    — sends "getPlaylistId" to background; verifies it matches the URL's list param
      (guard: typeof playlistId !== "string" → return)
    — sends "list" to background; builds activeItemMap:
        items.forEach(item => {
          if (!activeItemMap[item.videoId]) activeItemMap[item.videoId] = [];
          activeItemMap[item.videoId].push({ seconds: item.seconds, at: item.at });
        })
    — calls applyResumeButtons() immediately
    — MUTATIONOBSERVER: creates a MutationObserver on the playlist container
      (document.querySelector("ytd-playlist-video-list-renderer") || document.body)
      watching childList+subtree; on each mutation calls applyResumeButtons() and
      disconnects when no uninjected rows remain
    — hard-disconnects the observer after 15 seconds regardless

  SPA navigation detection:
    MutationObserver on document.documentElement watching childList+subtree;
    when location.href changes: reset activeItemMap, disconnect rowObserver, call
    setupPlaylistInjection()

  Global menu close handler (add once via window._wytaMenuListenerAdded guard):
    document.addEventListener("click", handler, true) — on any click outside a
    .wyta-menu-wrapper, remove .wyta-menu-open from all open menus

──────────────────────────────────────────────────────────────────────────────
CONTENT STYLES (content.css)
──────────────────────────────────────────────────────────────────────────────
.wyta-resume-btn — red (#ff0000) inline-flex pill, white bold text, margin-top 6px
.wyta-resume-btn:hover — darker red (#cc0000)
.wyta-menu-wrapper — position:relative, display:inline-flex
.wyta-menu-trigger — cursor:pointer, user-select:none
.wyta-menu — position:absolute, top:calc(100%+4px), left:0, white bg, border,
             border-radius:4px, box-shadow, z-index:9999, display:none
.wyta-menu.wyta-menu-open — display:block
.wyta-menu-item — display:block, red bg, white text, padding, no underline;
                  separator between items via border-top on + sibling

──────────────────────────────────────────────────────────────────────────────
POPUP (popup.html + popup.js + popup.css)
──────────────────────────────────────────────────────────────────────────────
HTML layout:
  .header — red bar with icon48 + "Watch YT VideosAt" title
  #current-video.section.hidden — video title + "Save at X:XX" button (shown on watch pages)
  #not-on-video.section — "Open a YouTube video to save your position."
  .section — "Saved in 'Watch Later At'" header with #playlist-link (↗ icon, initially hidden)
           — #items-list
           — #empty-state.muted.hidden "No saved items yet."

popup.js:
  init():
    — queries active tab; if youtube.com/watch: sends "getVideoState" to content script
    — if response is valid: shows #current-video, fills title + time, hides #not-on-video
    — registers save-btn click → onSave()
    — calls loadItems() and loadPlaylistLink()

  onSave():
    — sends "save" action with { videoId, seconds, at, title, thumbnail:null }
      (thumbnail is derived server-side in background.js from videoId)
    — on success: shows "✓ Saved!", closes popup after 900 ms

  loadItems():
    — sends "list"; groups results by videoId (Map, preserving insertion order)
    — renders one .item-group per video:
        .item-group-header (flex row) containing:
          <img class="item-thumb" src="{thumbnail}"> — 64×36 px video thumbnail
          .item-group-title — video title (2-line clamp, not a link)
        one .item-row per timestamp:
          <a class="item-link"> "▶ at X:XX · YYYY-MM-DD" → watch?v=...&t=seconds
          <button class="remove-btn"> ✕
            on click: sends "remove" with { entryId: item.id || item.playlistItemId, videoId }
            on success: removes row; if group has no more rows removes group;
                        shows empty-state if list is now empty

  loadPlaylistLink():
    — sends "getPlaylistId"; if string result: sets href on #playlist-link and removes .hidden

popup.css:
  .item-group — padding 6px 0, border-bottom 1px #f2f2f2; last-child no border
  .item-group-header — flex row, gap 7px, align-items center
  .item-thumb — 64×36 px, object-fit cover, border-radius 3px, grey bg placeholder
  .item-group-title — 12px, 500 weight, 2-line clamp
  .item-row — flex, gap 6px, padding 2px 0 2px 8px (indented under header)
  .item-link hover — .item-meta turns red
  .item-meta — 11px, #888
  .remove-btn — no bg/border, grey ✕; hover shows light grey bg
  .playlist-link — small grey ↗ link floated right in .section-header; red on hover

──────────────────────────────────────────────────────────────────────────────
ICONS
──────────────────────────────────────────────────────────────────────────────
Generate icons/icon16.png, icons/icon48.png, icons/icon128.png using Python + Pillow.
Each icon: square canvas, red rounded-rectangle background.
Left side: white solid play triangle (pointing right), centered at 36% of width.
Right side: white clock face circle (center at 70% of width, radius 26% of size):
  — white filled circle
  — grey border ring
  — 12 tick marks (for 48px and 128px; skip for 16px)
  — NO clock hands
  — one small solid red triangle on the rim at the 7 o'clock position
    (angle = 7×30 − 90 = 120°), pointing inward toward the center
  — small grey center dot

──────────────────────────────────────────────────────────────────────────────
KNOWN PITFALLS / NON-OBVIOUS DECISIONS
──────────────────────────────────────────────────────────────────────────────
1. contentDetails.note is silently broken — YouTube's API accepts the field but always
   returns null. All timestamp data must live elsewhere (Drive appDataFolder chosen here).

2. Stale OAuth token after adding a new scope — Chrome caches the old token indefinitely.
   Detect by checking for 401 or 403 with "scope" in the error message; call
   removeCachedAuthToken then getAuthToken(true) to get a fresh token with all scopes.

3. getPlaylistId must check chrome.storage.local BEFORE calling getAuthToken — if auth
   is called non-interactively and fails, it returns an error object, not a string,
   causing the playlist ID guard (typeof !== "string") to silently abort injection.

4. YouTube playlist items API returns the video only once — each save for the same video
   must reuse the existing playlistItemId. Adding the video again creates a duplicate
   playlist entry (the video appears twice in the playlist page).

5. YouTube SPA does not trigger page reloads — use a MutationObserver on
   document.documentElement to detect URL changes and re-run setupPlaylistInjection.

6. Playlist rows are lazy-rendered — a single DOM pass on page load will miss most rows.
   Use a MutationObserver on the playlist container (ytd-playlist-video-list-renderer, or
   document.body as fallback) watching childList+subtree. Disconnect when all rows are
   injected or after a 15-second hard timeout. Do NOT use setInterval polling — it fires
   constantly even when nothing has changed and is harder to clean up on SPA navigation.

7. Removing a timestamp entry should only delete the YouTube playlist item when it is the
   last bookmark for that video — otherwise the video disappears from the playlist even
   though the user still has other saved timestamps for it.

8. Per-entry unique IDs are required for individual timestamp removal — entries must carry
   an "id" field (not just playlistItemId) because all timestamps for the same video share
   the same playlistItemId. Legacy entries without "id" can fall back to playlistItemId
   for removal.

9. YouTube playlist description has a 5000-character limit — buildPlaylistDescription must
   guard against exceeding it. Drop whole-video lines from the end of the output rather
   than truncating mid-string, so every line that does appear is complete and readable.

10. Sync-on-every-list-call adds noticeable latency to popup open — the YouTube playlist
    cross-reference is an extra paginated API round-trip. Cache a lastSync timestamp and
    skip the sync if it ran within the last 5 minutes. Invalidate the cache immediately on
    any manual remove so deleted items never linger past the TTL.
```
