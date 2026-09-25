const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const ytDlp = require("yt-dlp-exec");
const ffmpegPath = require("ffmpeg-static");

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

// Formats yt-dlp/ffmpeg can produce, and which of them ffmpeg can embed a
// cover image into. Ogg/Opus's muxer rejects an attached video stream
// entirely (confirmed by hand) - Opus downloads still get title/artist/etc
// tags, just no artwork.
const AUDIO_FORMATS = ["mp3", "flac", "opus", "m4a"];
const SUPPORTS_EMBEDDED_ART = { mp3: true, flac: true, m4a: true, opus: false };
// mp3 uses ffmpeg/LAME's 0(best)-9(worst) VBR scale; flac is lossless (no
// quality setting applies); opus/m4a use an explicit target bitrate.
const DEFAULT_QUALITY = { mp3: "4", flac: "", opus: "192K", m4a: "192K" };

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch {}
  const audioFormat = AUDIO_FORMATS.includes(saved.audioFormat) ? saved.audioFormat
    : AUDIO_FORMATS.includes(process.env.AUDIO_FORMAT) ? process.env.AUDIO_FORMAT : "mp3";
  return {
    spotifyClientId: saved.spotifyClientId ?? process.env.SPOTIFY_CLIENT_ID ?? "",
    spotifyClientSecret: saved.spotifyClientSecret ?? process.env.SPOTIFY_CLIENT_SECRET ?? "",
    listenbrainzToken: saved.listenbrainzToken ?? process.env.LISTENBRAINZ_TOKEN ?? "",
    audioFormat,
    audioQuality: typeof saved.audioQuality === "string" && saved.audioQuality
      ? saved.audioQuality : (process.env.AUDIO_QUALITY || DEFAULT_QUALITY[audioFormat]),
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
  const audioFormat = AUDIO_FORMATS.includes(body.audioFormat) ? body.audioFormat : settings.audioFormat;
  // Quality is format-specific (VBR level vs bitrate) - a value left over
  // from switching formats on the frontend wouldn't make sense here, so
  // anything not shaped like "<digit>" or "<number>K" falls back to that
  // format's default rather than getting passed straight to ffmpeg.
  const rawQuality = clean(body.audioQuality);
  const qualityValid = rawQuality != null && (/^[0-9]$/.test(rawQuality) || /^\d+K$/i.test(rawQuality));
  settings = {
    spotifyClientId: clean(body.spotifyClientId) ?? settings.spotifyClientId,
    spotifyClientSecret: clean(body.spotifyClientSecret) ?? settings.spotifyClientSecret,
    listenbrainzToken: clean(body.listenbrainzToken) ?? settings.listenbrainzToken,
    audioFormat,
    audioQuality: qualityValid ? rawQuality : DEFAULT_QUALITY[audioFormat],
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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.split("\n").slice(-5).join("\n") || err.message));
      else resolve();
    });
  });
}

// Embeds tags (and, where the format supports it, cover art) by muxing the
// already-encoded audio into a new container with -c copy - no re-encoding,
// so this doesn't touch audio quality. Ogg/Opus's muxer rejects an attached
// video stream outright, so art is skipped there regardless of canEmbedArt.
async function embedMetadata(srcPath, destPath, format, tags, coverBuffer) {
  const canEmbedArt = !!coverBuffer && SUPPORTS_EMBEDDED_ART[format];
  const coverPath = canEmbedArt ? `${srcPath}.cover.jpg` : null;

  async function run(withArt) {
    const args = ["-y", "-i", srcPath];
    if (withArt) args.push("-i", coverPath, "-map", "0:a", "-map", "1:v");
    args.push("-c", "copy");
    if (format === "mp3") args.push("-id3v2_version", "3");
    const meta = { title: tags.title, artist: tags.artist };
    if (tags.album) meta.album = tags.album;
    if (tags.year) meta.date = tags.year;
    if (tags.genre) meta.genre = tags.genre;
    if (tags.trackNumber) meta.track = tags.trackNumber;
    for (const [k, v] of Object.entries(meta)) args.push("-metadata", `${k}=${v}`);
    if (withArt) {
      args.push("-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)",
        "-disposition:v:0", "attached_pic");
    }
    args.push(destPath);
    await runFfmpeg(args);
  }

  try {
    if (canEmbedArt) fs.writeFileSync(coverPath, coverBuffer);
    try {
      await run(canEmbedArt);
    } catch (err) {
      // A malformed/unexpected image response shouldn't take the whole
      // download down - retry with just the text tags.
      if (!canEmbedArt) throw err;
      console.warn(`Tag embed with cover art failed for "${tags.title}", retrying without it:`, err.message);
      await run(false);
    }
  } finally {
    if (coverPath) fs.rm(coverPath, () => {});
  }
}

// Reads tags back via `ffmpeg -i` (no output file) rather than ffprobe -
// ffprobe-static has no Linux ARM64 build, and this app already depends on
// ffmpeg-static (which does), so this avoids a second, less-portable binary.
// ffmpeg always "fails" with no output specified, but still prints the full
// probe (container tags AND per-stream tags, which is where Ogg/Opus keeps
// them) to stderr first.
function probeMetadata(filePath) {
  return new Promise(resolve => {
    execFile(ffmpegPath, ["-i", filePath], { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      const tags = {};
      // The embedded-art picture is itself a "stream" with its own
      // title/comment ("Album cover" / "Cover (front)", set when writing) -
      // skip its metadata block so it can't overwrite the real track tags,
      // which live at the container level and/or on the audio stream.
      let inNonAudioStream = false;
      for (const line of (stderr || "").split(/\r?\n/)) {
        if (/^\s+Stream #\d+:\d+.*:\s*Audio:/.test(line)) inNonAudioStream = false;
        else if (/^\s+Stream #\d+:\d+.*:\s*(Video|Subtitle|Data):/.test(line)) inNonAudioStream = true;
        if (inNonAudioStream) continue;
        const m = line.match(/^\s{2,}([A-Za-z][\w -]*?)\s{2,}:\s(.*)$/);
        if (m) tags[m[1].trim().toLowerCase()] = m[2].trim();
      }
      resolve({
        title: tags.title || null,
        artist: tags.artist || null,
        album: tags.album || null,
        year: (tags.date || "").slice(0, 4) || null,
        genre: tags.genre || null,
      });
    });
  });
}

// Spawning ffmpeg per file makes a from-scratch library scan slow on a large
// collection, so results are cached by path+mtime - a re-scan after the
// first only re-probes files that actually changed.
const tagCache = new Map(); // absPath -> { mtimeMs, tags }
async function readAudioTags(filePath, mtimeMs) {
  const cached = tagCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.tags;
  const tags = await probeMetadata(filePath);
  tagCache.set(filePath, { mtimeMs, tags });
  return tags;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sanitizeForFilename(s) {
  return String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

const AUDIO_EXT_RE = new RegExp(`\\.(${AUDIO_FORMATS.join("|")})$`, "i");

// Loose match for "is this already downloaded": same sanitized filename,
// ignoring case, a trailing " (2)"-style suffix, and file extension - so
// switching the audio format setting later doesn't cause a redundant
// second copy of a track you already have in the old format.
function findExistingDownload(dir, baseName) {
  const target = baseName.toLowerCase();
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return null; } // dir may not exist yet
  for (const entry of entries) {
    const m = entry.match(AUDIO_EXT_RE);
    if (!m) continue;
    const stem = entry.slice(0, -m[0].length).toLowerCase().replace(/\s\(\d+\)$/, "");
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

// Library layout: SAVE_DIR/Artist/Album/NN - Title.mp3, or SAVE_DIR/Artist/Title.mp3
// for tracks with no known album - the structure Navidrome/Jellyfin/etc. expect,
// instead of one flat folder.
function destDirFor(artist, album) {
  const artistFolder = sanitizeForFilename(artist) || "Unknown Artist";
  const albumFolder = album ? sanitizeForFilename(album) : "";
  return albumFolder ? path.join(SAVE_DIR, artistFolder, albumFolder) : path.join(SAVE_DIR, artistFolder);
}

function buildFilename(title, trackNumber) {
  const clean = sanitizeForFilename(title) || "track";
  const n = Number(trackNumber);
  return Number.isInteger(n) && n > 0 && n < 1000 ? `${String(n).padStart(2, "0")} - ${clean}` : clean;
}

// A path relative to SAVE_DIR, with forward slashes regardless of host OS -
// used as the library item's id for the frontend (display + delete).
function relKey(absPath) {
  return path.relative(SAVE_DIR, absPath).split(path.sep).join("/");
}

function walkAudioFiles(dir) {
  let results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(walkAudioFiles(full));
    else if (entry.isFile() && AUDIO_EXT_RE.test(entry.name)) results.push(full);
  }
  return results;
}

// After deleting a track, prune now-empty Album/Artist folders so the
// library tree doesn't accumulate clutter. Never removes SAVE_DIR itself.
function cleanupEmptyDirs(dir) {
  const root = path.resolve(SAVE_DIR);
  let current = path.resolve(dir);
  while (current !== root && current.startsWith(root + path.sep)) {
    let entries;
    try { entries = fs.readdirSync(current); } catch { break; }
    if (entries.length > 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
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

app.get("/api/library", async (req, res) => {
  try {
    const files = walkAudioFiles(SAVE_DIR);
    const items = await mapLimit(files, 6, async filePath => {
      const stat = fs.statSync(filePath);
      const tags = await readAudioTags(filePath, stat.mtimeMs);
      const filename = path.basename(filePath);
      return {
        path: relKey(filePath),
        filename,
        title: tags.title || filename.replace(AUDIO_EXT_RE, ""),
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

// :relpath is URL-encoded by the frontend (encodeURIComponent turns each "/"
// into "%2F"), so Express's normal param decoding hands it back here as the
// full "Artist/Album/Title.mp3" relative path in one piece.
app.delete("/api/library/:relpath", (req, res) => {
  const filePath = path.join(SAVE_DIR, req.params.relpath);
  const resolved = path.resolve(filePath);
  const root = path.resolve(SAVE_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return res.status(400).json({ error: "Invalid path" });
  }
  if (!AUDIO_EXT_RE.test(resolved)) {
    return res.status(400).json({ error: "Not a valid library file" });
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: "File not found" });
  }
  try {
    fs.unlinkSync(resolved);
    tagCache.delete(resolved);
    cleanupEmptyDirs(path.dirname(resolved));
    console.log(`Deleted: ${relKey(resolved)}`);
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
    + `?limit=100&fields=next,items(track(name,track_number,artists(name),album(name,release_date,images)))`;
  while (next && tracks.length < MAX_PLAYLIST_TRACKS) {
    const pageRes = await fetch(next, { headers });
    if (!pageRes.ok) throw new Error(`Spotify error (${pageRes.status})`);
    const page = await pageRes.json();
    for (const item of page.items || []) {
      const t = item.track;
      if (!t || !t.name) continue;
      // Spotify lists images largest-first; index 1 is usually a ~300px
      // "medium" size, a reasonable embedded-art size without bloating files.
      const images = t.album?.images || [];
      tracks.push({
        title: t.name,
        artist: (t.artists || []).map(a => a.name).join(", "),
        album: t.album?.name || null,
        year: (t.album?.release_date || "").slice(0, 4) || null,
        trackNumber: Number.isInteger(t.track_number) ? t.track_number : null,
        coverArtUrl: images[1]?.url || images[0]?.url || null,
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
  const { query, title, artist, album, year, genre, trackNumber, coverArtUrl } = req.body || {};
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
  const trackNum = Number(trackNumber);
  if (Number.isInteger(trackNum) && trackNum > 0 && trackNum < 1000) tags.trackNumber = String(trackNum);

  const format = AUDIO_FORMATS.includes(settings.audioFormat) ? settings.audioFormat : "mp3";
  const quality = settings.audioQuality || DEFAULT_QUALITY[format];

  const destDir = destDirFor(artist, tags.album);
  const baseName = buildFilename(title, trackNumber);
  const activityRecord = addActivity({ title, artist, album: tags.album || null });

  const existing = findExistingDownload(destDir, baseName);
  if (existing) {
    console.log(`Skipped (already have it): ${existing}`);
    finishActivity(activityRecord, "skipped", { filename: existing });
    return res.json({ ok: true, skipped: true, filename: existing, path: path.join(destDir, existing) });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdl-"));
  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true }, () => {});

  try {
    // No API key/quota involved: yt-dlp's own "ytsearchN:" pseudo-URL scrapes
    // YouTube's search directly and downloads the top match.
    const ytDlpOpts = {
      output: path.join(tmpDir, "%(id)s.%(ext)s"),
      extractAudio: true,
      audioFormat: format,
      ffmpegLocation: ffmpegPath,
      noPlaylist: true,
    };
    // FLAC is lossless - there's no bitrate/VBR knob to set. For the others,
    // this is either an mp3 "0(best)-9(worst)" VBR level or an explicit
    // "<N>K" bitrate (opus/m4a) - yt-dlp/ffmpeg tell those apart by shape.
    if (format !== "flac" && quality) ytDlpOpts.audioQuality = quality;
    await ytDlp(`ytsearch1:${query}`, ytDlpOpts, { env: ytDlpEnv });

    const produced = fs.readdirSync(tmpDir).find(f => f.toLowerCase().endsWith(`.${format}`));
    if (!produced) throw new Error(`Conversion did not produce a .${format} file`);
    const rawPath = path.join(tmpDir, produced);

    // Best-effort: a missing/unreachable cover shouldn't fail the download.
    let coverBuffer = null;
    if (typeof coverArtUrl === "string" && coverArtUrl.trim() && SUPPORTS_EMBEDDED_ART[format]) {
      try {
        const imgRes = await fetch(coverArtUrl);
        if (imgRes.ok) coverBuffer = Buffer.from(await imgRes.arrayBuffer());
      } catch (e) {
        console.warn(`Cover art fetch failed for "${title}":`, e.message || e);
      }
    }

    const taggedPath = path.join(tmpDir, `tagged.${format}`);
    await embedMetadata(rawPath, taggedPath, format, tags, coverBuffer);

    // Re-check right before writing in case a concurrent request just saved
    // the same track while this one was downloading.
    fs.mkdirSync(destDir, { recursive: true });
    const stillMissing = !findExistingDownload(destDir, baseName);
    const destPath = stillMissing
      ? path.join(destDir, `${baseName}.${format}`)
      : uniquePath(destDir, baseName, `.${format}`);
    fs.copyFileSync(taggedPath, destPath);

    console.log(`Saved: ${relKey(destPath)}`);
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
