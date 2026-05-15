# Watch YT At

Save a YouTube video at its current timestamp into a private **"Watch Later At"** playlist. Resume from exactly that point on any device.

## How it works

- Click the extension icon while watching a YouTube video → **Save at 12:34**
- The video is added to your "Watch Later At" YouTube playlist with a note:
  ```json
  {"seconds": 754, "at": "12:34", "saved": "2026-05-15"}
  ```
- On any device with the extension, opening the "Watch Later At" playlist shows a **▶ Resume at 12:34** button next to each video
- Without the extension, the note is visible in the playlist item so you can seek manually

## One-time setup

Before loading the extension you need a Google Cloud project with a registered OAuth client.

### 1. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project (or pick an existing one)
2. In **APIs & Services → Library**, search for **YouTube Data API v3** and enable it

### 2. Create an OAuth 2.0 Client ID

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Choose **Chrome App** as the application type
3. For **Application ID**, enter your extension's ID:
   - Load the extension as unpacked (see below) first — Chrome will assign it an ID shown in `chrome://extensions`
   - Paste that ID here (e.g. `abcdefghijklmnopabcdefghijklmnop`)
4. Click **Create** and copy the **Client ID** (looks like `123456789-abc....apps.googleusercontent.com`)

### 3. Add the client ID to the extension

Edit `manifest.json` and replace `REPLACE_ME`:

```json
"oauth2": {
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/youtube"]
}
```

### 4. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** and select this folder
4. The extension icon appears in your toolbar

On first use, Chrome will show a one-time consent screen to allow the extension to manage your YouTube playlists. After that it uses your existing YouTube login silently.

## Files

```
manifest.json   Extension manifest (MV3)
background.js   Service worker — YouTube Data API calls & auth
content.js      Injected on youtube.com — reads video time, injects resume buttons
content.css     Styles for the injected resume button
popup.html/js/css  Toolbar popup UI
icons/          Extension icons
```
