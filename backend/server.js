const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const ytDlp = require("yt-dlp-exec");
const ffmpegPath = require("ffmpeg-static");
const NodeID3 = require("node-id3");

const app = express();
app.use(cors());
app.use(express.json());
// Serves frontend/index.html and its assets - so the whole app is just
// "visit this container's URL", the way other self-hosted apps work.
app.use(express.static(path.join(__dirname, "..", "frontend")));

const PORT = process.env.PORT || 5051;

// Not hardcoded: defaults to the Windows Downloads folder for local/manual
// use, but sets from MUSIC_DIR when running in Docker - point that at a
// bind-mounted volume (e.g. a TrueNAS dataset) the same way other self-hosted
// apps expose a "downloads" or "media" directory setting.
const SAVE_DIR = process.env.MUSIC_DIR || path.join(os.homedir(), "Downloads", "Music");
fs.mkdirSync(SAVE_DIR, { recursive: true });

// Falls back to the SpotipyFree-based playlist-backend service (no Spotify
// credentials needed, full playlist) when reachable - set automatically by
// docker-compose to the sibling container's internal address. If it's not
// set or not reachable, /api/playlist falls back to the logic below (the
// public embed page, or the official Web API if Spotify credentials are set).
const PLAYLIST_BACKEND_URL = process.env.PLAYLIST_BACKEND_URL || "";

// Settings (Spotify credentials, ListenBrainz token) are saved here via the
// frontend's Settings panel (GET/POST /api/settings) instead of being
// hardcoded - env vars still work as an initial seed (useful for Docker),
// but anything saved through the UI takes precedence from then on. In
// Docker, point CONFIG_DIR at a persistent volume so settings survive
// container restarts/updates.
const CONFIG_DIR = process.env.CONFIG_DIR || __dirname;
const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.json");

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch {}
  return {
    spotifyClientId: saved.spotifyClientId ?? process.env.SPOTIFY_CLIENT_ID ?? "",
    spotifyClientSecret: saved.spotifyClientSecret ?? process.env.SPOTIFY_CLIENT_SECRET ?? "",
    listenbrainzToken: saved.listenbrainzToken ?? process.env.LISTENBRAINZ_TOKEN ?? "",
  };
}

let settings = loadSettings();
let spotifyToken = null; // { value, expiresAt } - cached Spotify app access token

app.get("/api/settings", (req, res) => {
  res.json(settings);
});

app.post("/api/settings", (req, res) => {
  const body = req.body || {};
  const clean = v => (typeof v === "string" ? v.trim() : undefined);
  settings = {
    spotifyClientId: clean(body.spotifyClientId) ?? settings.spotifyClientId,
    spotifyClientSecret: clean(body.spotifyClientSecret) ?? settings.spotifyClientSecret,
    listenbrainzToken: clean(body.listenbrainzToken) ?? settings.listenbrainzToken,
  };
  spotifyToken = null; // credentials may have changed - drop the cached token
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  res.json({ ok: true });
});

// YouTube now requires running a bit of JS to decrypt some formats' URLs;
// yt-dlp only supports Deno for that, so a portable copy lives in bin/ and
// gets added to PATH just for the yt-dlp child process below.
const DENO_DIR = path.join(__dirname, "bin");
const ytDlpEnv = { ...process.env, PATH: `${DENO_DIR}${path.delimiter}${process.env.PATH}` };

function sanitizeForFilename(s) {
  return String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

// Loose match for "is this already downloaded": same sanitized "title - artist"
// name, ignoring case and a trailing " (2)"-style suffix from an older save.
function findExistingDownload(dir, baseName) {
  const target = baseName.toLowerCase();
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith(".mp3")) continue;
    const stem = entry.slice(0, -4).toLowerCase().replace(/\s\(\d+\)$/, "");
    if (stem === target) return entry;
  }
  return null;
}

function uniquePath(dir, baseName, ext) {
  let candidate = path.join(dir, `${baseName}${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${baseName} (${n})${ext}`);
    n++;
  }
  return candidate;
}

// In-memory activity log (queue + history) for the Activity page. Doesn't
// need to survive a restart, so it's plain memory rather than a file - if
// the backend restarts, an in-flight batch just starts a fresh log.
const MAX_ACTIVITY = 300;
let activity = [];
let nextActivityId = 1;

function addActivity(entry) {
  const record = { id: nextActivityId++, status: "downloading", startedAt: Date.now(), finishedAt: null, error: null, ...entry };
  activity.unshift(record);
  if (activity.length > MAX_ACTIVITY) activity.length = MAX_ACTIVITY;
  return record;
}

function finishActivity(record, status, extra = {}) {
  record.status = status;
  record.finishedAt = Date.now();
  Object.assign(record, extra);
}

app.get("/api/activity", (req, res) => {
  res.json({ items: activity });
});

app.delete("/api/activity", (req, res) => {
  activity = activity.filter(a => a.status === "downloading");
  res.json({ ok: true });
});

app.get("/api/library", (req, res) => {
  try {
    const files = fs.readdirSync(SAVE_DIR).filter(f => f.toLowerCase().endsWith(".mp3"));
    const items = files.map(filename => {
      const filePath = path.join(SAVE_DIR, filename);
      const stat = fs.statSync(filePath);
      const tags = NodeID3.read(filePath) || {};
      return {
        filename,
        title: tags.title || filename.replace(/\.mp3$/i, ""),
        artist: tags.artist || null,
        album: tags.album || null,
        year: tags.year || null,
        genre: tags.genre || null,
        size: stat.size,
        modified: stat.mtimeMs,
      };
    });
    items.sort((a, b) => b.modified - a.modified);
    res.json({ items, dir: SAVE_DIR });
  } catch (err) {
    console.error("Library listing failed:", err.message || err);
    res.status(500).json({ error: err.message || "Library listing failed" });
  }
});

app.delete("/api/library/:filename", (req, res) => {
  const filename = req.params.filename;
  // path.basename strips any directory components, so a filename like
  // "../../whatever" can't escape SAVE_DIR.
  const safeName = path.basename(filename);
  if (!safeName.toLowerCase().endsWith(".mp3")) {
    return res.status(400).json({ error: "Not a valid library file" });
  }
  const filePath = path.join(SAVE_DIR, safeName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }
  try {
    fs.unlinkSync(filePath);
    console.log(`Deleted: ${safeName}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete failed:", err.message || err);
    res.status(500).json({ error: err.message || "Delete failed" });
  }
});

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyToken.expiresAt) return spotifyToken.value;
  const auth = Buffer.from(`${settings.spotifyClientId}:${settings.spotifyClientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Spotify auth failed (${res.status})`);
  const data = await res.json();
  spotifyToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return spotifyToken.value;
}

const MAX_PLAYLIST_TRACKS = 500;

// Full pagination, used when SPOTIFY_CLIENT_ID/SECRET are configured.
async function fetchPlaylistViaOfficialApi(playlistId) {
  const token = await getSpotifyToken();
  const headers = { Authorization: `Bearer ${token}` };

  const metaRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=name,tracks.total`, { headers });
  if (!metaRes.ok) throw new Error(`Spotify error (${metaRes.status})`);
  const meta = await metaRes.json();

  const tracks = [];
  let next = `https://api.spotify.com/v1/playlists/${playlistId}/tracks`
    + `?limit=100&fields=next,items(track(name,artists(name),album(name,release_date)))`;
  while (next && tracks.length < MAX_PLAYLIST_TRACKS) {
    const pageRes = await fetch(next, { headers });
    if (!pageRes.ok) throw new Error(`Spotify error (${pageRes.status})`);
    const page = await pageRes.json();
    for (const item of page.items || []) {
      const t = item.track;
      if (!t || !t.name) continue;
      tracks.push({
        title: t.name,
        artist: (t.artists || []).map(a => a.name).join(", "),
        album: t.album?.name || null,
        year: (t.album?.release_date || "").slice(0, 4) || null,
      });
    }
    next = page.next;
  }

  return { name: meta.name, tracks, truncated: tracks.length >= MAX_PLAYLIST_TRACKS };
}

// No credentials needed: Spotify's own public embed page (meant for embedding
// playlist previews on external sites) server-renders the track list into a
// __NEXT_DATA__ JSON blob. It has no separate pagination call, so this is
// capped at whatever that page includes (~50 tracks) - good enough for most
// playlists, with fetchPlaylistViaOfficialApi as the full-pagination option
// once real credentials are configured.
async function fetchPlaylistViaEmbed(playlistId) {
  const res = await fetch(`https://open.spotify.com/embed/playlist/${playlistId}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" },
  });
  if (!res.ok) throw new Error(`Spotify embed page error (${res.status})`);
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Could not find playlist data on Spotify's embed page (its layout may have changed)");

  const data = JSON.parse(match[1]);
  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error("That playlist isn't public, or doesn't exist");

  const tracks = (entity.trackList || [])
    .filter(t => t.title)
    .map(t => ({ title: t.title, artist: t.subtitle || "Unknown artist", album: null, year: null }));

  return { name: entity.name || "Playlist", tracks, truncated: tracks.length >= 50 };
}

app.get("/api/playlist", async (req, res) => {
  try {
    const url = req.query.url;
    const match = typeof url === "string" && url.match(/playlist[/:]([a-zA-Z0-9]+)/);
    if (!match) return res.status(400).json({ error: "That doesn't look like a Spotify playlist link" });
    const playlistId = match[1];

    if (PLAYLIST_BACKEND_URL) {
      try {
        const proxyRes = await fetch(`${PLAYLIST_BACKEND_URL}/api/playlist?url=${encodeURIComponent(url)}`);
        const proxyData = await proxyRes.json();
        if (proxyRes.ok) return res.json(proxyData);
        console.warn("playlist-backend returned an error, falling back:", proxyData.error);
      } catch (err) {
        console.warn("playlist-backend unreachable, falling back:", err.message || err);
      }
    }

    const result = (settings.spotifyClientId && settings.spotifyClientSecret)
      ? await fetchPlaylistViaOfficialApi(playlistId)
      : await fetchPlaylistViaEmbed(playlistId);

    res.json(result);
  } catch (err) {
    console.error("Playlist fetch failed:", err.message || err);
    res.status(500).json({ error: err.message || "Playlist fetch failed" });
  }
});

app.post("/api/download", async (req, res) => {
  const { query, title, artist, album, year, genre } = req.body || {};
  if (typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "query is required" });
  }
  if (typeof title !== "string" || !title.trim() || typeof artist !== "string" || !artist.trim()) {
    return res.status(400).json({ error: "title and artist are required" });
  }

  const tags = { title, artist };
  if (typeof album === "string" && album.trim()) tags.album = album.trim();
  if (typeof year === "string" && /^\d{4}$/.test(year)) tags.year = year;
  if (typeof genre === "string" && genre.trim()) tags.genre = genre.trim();

  const baseName = sanitizeForFilename(`${title} - ${artist}`) || query;
  const activityRecord = addActivity({ title, artist, album: tags.album || null });

  const existing = findExistingDownload(SAVE_DIR, baseName);
  if (existing) {
    console.log(`Skipped (already have it): ${existing}`);
    finishActivity(activityRecord, "skipped", { filename: existing });
    return res.json({ ok: true, skipped: true, filename: existing, path: path.join(SAVE_DIR, existing) });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdl-"));
  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true }, () => {});

  try {
    // No API key/quota involved: yt-dlp's own "ytsearchN:" pseudo-URL scrapes
    // YouTube's search directly and downloads the top match.
    await ytDlp(`ytsearch1:${query}`, {
      output: path.join(tmpDir, "%(id)s.%(ext)s"),
      extractAudio: true,
      audioFormat: "mp3",
      // LAME VBR quality (0=best/~245kbps ... 9=worst/~65kbps). YouTube's
      // source audio is itself only ~128kbps, so 0 was wasting space without
      // adding real fidelity; 4 (~165kbps) stays comfortably above the
      // source's bitrate with no audible difference, at roughly half the size.
      audioQuality: 4,
      ffmpegLocation: ffmpegPath,
      noPlaylist: true,
    }, { env: ytDlpEnv });

    const produced = fs.readdirSync(tmpDir).find(f => f.endsWith(".mp3"));
    if (!produced) throw new Error("Conversion did not produce an mp3 file");
    const mp3Path = path.join(tmpDir, produced);

    const tagged = NodeID3.write(tags, mp3Path);
    if (tagged !== true) throw new Error("Writing ID3 tags failed");

    // Re-check right before writing in case a concurrent request just saved
    // the same track while this one was downloading.
    const stillMissing = !findExistingDownload(SAVE_DIR, baseName);
    const destPath = stillMissing ? path.join(SAVE_DIR, `${baseName}.mp3`) : uniquePath(SAVE_DIR, baseName, ".mp3");
    fs.copyFileSync(mp3Path, destPath);

    console.log(`Saved: ${path.basename(destPath)}`);
    finishActivity(activityRecord, "completed", { filename: path.basename(destPath) });
    res.json({ ok: true, skipped: false, filename: path.basename(destPath), path: destPath });
  } catch (err) {
    const message = err.shortMessage || err.message || String(err);
    console.error(`Failed ("${query}"):`, message);
    finishActivity(activityRecord, "failed", { error: message });
    if (!res.headersSent) res.status(500).json({ error: "Download failed" });
  } finally {
    cleanup();
  }
});

app.listen(PORT, () => console.log(`Download backend listening on http://localhost:${PORT}`));
