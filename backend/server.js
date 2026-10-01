const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const ytDlp = require("yt-dlp-exec");
const ffmpegPath = require("ffmpeg-static");

const app = express();
// No CORS middleware on purpose. The frontend is served from this same origin
// below, and GET /api/settings returns the saved Spotify secret and
// ListenBrainz token. With Access-Control-Allow-Origin: * and no auth, any
// page in any tab could read those off a known host and port.
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "frontend")));

const PORT = process.env.PORT || 5051;

// Docker bind mounts already exist, and mkdirSync throws EEXIST on those
// even with recursive:true.
function ensureDir(dir) {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
}

const SAVE_DIR = process.env.MUSIC_DIR || path.join(os.homedir(), "Downloads", "Music");
ensureDir(SAVE_DIR);

// Preferred playlist source: full playlists, no credentials. When unset or
// unreachable, /api/playlist falls back to the embed page or the Web API.
const PLAYLIST_BACKEND_URL = process.env.PLAYLIST_BACKEND_URL || "";

// Env vars seed the settings; anything saved through the UI then wins.
const CONFIG_DIR = process.env.CONFIG_DIR || __dirname;
const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.json");

// Ogg/Opus's muxer rejects an attached video stream, so Opus gets tags but
// no artwork.
const AUDIO_FORMATS = ["mp3", "flac", "opus", "m4a"];
const SUPPORTS_EMBEDDED_ART = { mp3: true, flac: true, m4a: true, opus: false };
// mp3 is LAME's 0(best)-9(worst) VBR scale; flac is lossless; opus and m4a
// take a target bitrate.
const DEFAULT_QUALITY = { mp3: "4", flac: "", opus: "192K", m4a: "192K" };

// How a one-off download is filed. "single" is Artist/Title with no album
// tag, so music servers list it by song name. Album downloads ignore this.
const SINGLE_FILING_MODES = ["single", "album"];

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
    singleFiling: SINGLE_FILING_MODES.includes(saved.singleFiling) ? saved.singleFiling
      : SINGLE_FILING_MODES.includes(process.env.SINGLE_FILING) ? process.env.SINGLE_FILING : "single",
  };
}

let settings = loadSettings();
let spotifyToken = null; // { value, expiresAt } - cached Spotify app access token

// Liveness probe for container healthchecks. Touches no disk and no upstream
// API, so it reports on this server rather than on MusicBrainz.
app.get("/api/health", (req, res) => {
  res.json({ ok: true, queued: pending.length, active: activeJobs });
});

app.get("/api/settings", (req, res) => {
  res.json(settings);
});

app.post("/api/settings", (req, res) => {
  const body = req.body || {};
  const clean = v => (typeof v === "string" ? v.trim() : undefined);
  const audioFormat = AUDIO_FORMATS.includes(body.audioFormat) ? body.audioFormat : settings.audioFormat;
  // Quality is format-specific, so a value left over from switching formats
  // falls back to the new format's default instead of reaching ffmpeg.
  const rawQuality = clean(body.audioQuality);
  const qualityValid = rawQuality != null && (/^[0-9]$/.test(rawQuality) || /^\d+K$/i.test(rawQuality));
  settings = {
    spotifyClientId: clean(body.spotifyClientId) ?? settings.spotifyClientId,
    spotifyClientSecret: clean(body.spotifyClientSecret) ?? settings.spotifyClientSecret,
    listenbrainzToken: clean(body.listenbrainzToken) ?? settings.listenbrainzToken,
    audioFormat,
    audioQuality: qualityValid ? rawQuality : DEFAULT_QUALITY[audioFormat],
    singleFiling: SINGLE_FILING_MODES.includes(body.singleFiling) ? body.singleFiling : settings.singleFiling,
  };
  spotifyToken = null; // credentials may have changed - drop the cached token
  try {
    ensureDir(CONFIG_DIR);
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    res.json({ ok: true });
  } catch (err) {
    // Usually /config not being writable by the container's uid.
    console.error("Saving settings failed:", err.message || err);
    res.status(500).json({ error: `Could not write ${SETTINGS_FILE}: ${err.message || err}` });
  }
});

// yt-dlp needs Deno to decrypt some YouTube format URLs. bin/ holds a
// portable copy, added to PATH for that child process only.
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

// Muxes the encoded audio into a new container with -c copy, so tagging never
// re-encodes. Opus skips art regardless of canEmbedArt.
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
      // A bad image response shouldn't fail the download; retry text-only.
      if (!canEmbedArt) throw err;
      console.warn(`Tag embed with cover art failed for "${tags.title}", retrying without it:`, err.message);
      await run(false);
    }
  } finally {
    if (coverPath) fs.rm(coverPath, () => {});
  }
}

// Uses `ffmpeg -i` rather than ffprobe, because ffprobe-static has no Linux
// ARM64 build. ffmpeg exits non-zero with no output file, but prints both
// container and per-stream tags to stderr first; Opus keeps them per-stream.
function probeMetadata(filePath) {
  return new Promise(resolve => {
    execFile(ffmpegPath, ["-i", filePath], { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      const tags = {};
      // The cover art is a stream carrying its own title ("Album cover"), so
      // skip its metadata block or it overwrites the real track title.
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

// Lifts the stored JPEG/PNG out with -c copy. Files with no embedded picture
// make ffmpeg exit non-zero, which is normal here and not worth logging.
function extractCoverArt(filePath) {
  return new Promise(resolve => {
    execFile(ffmpegPath, ["-i", filePath, "-an", "-c:v", "copy", "-f", "image2", "pipe:1"],
      { maxBuffer: 1024 * 1024 * 20, encoding: "buffer" },
      (err, stdout) => resolve(!err && stdout?.length ? stdout : null));
  });
}

// Cached by path and mtime, so a re-scan only re-probes changed files.
const tagCache = new Map(); // absPath -> { mtimeMs, tags }
const artCache = new Map(); // absPath -> { mtimeMs, buf } (buf null = no art)
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

// Matches on sanitized filename, ignoring case, a trailing " (2)" and the
// extension, so switching audio format doesn't re-download the library.
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

// SAVE_DIR/Artist/Album/NN - Title.ext, or SAVE_DIR/Artist/Title.ext when no
// album is known. This is the layout Navidrome and Jellyfin expect.
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

// Relative to SAVE_DIR, forward slashes on any host OS. The frontend uses it
// as the library item's id.
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

// Prunes empty Album/Artist folders after a delete. Never removes SAVE_DIR.
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

// Queue plus history for the Activity page. A restart starts a fresh log.
const MAX_ACTIVITY = 300;
let activity = [];
let nextActivityId = 1;

function addActivity(entry) {
  const record = {
    id: nextActivityId++, status: "queued",
    queuedAt: Date.now(), startedAt: null, finishedAt: null, error: null, ...entry,
  };
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
  res.json({ items: activity, queued: pending.length, active: activeJobs });
});

app.delete("/api/activity", (req, res) => {
  // Finished entries only; dropping queued work would hide it.
  activity = activity.filter(a => a.status === "queued" || a.status === "downloading");
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

// Resolves a client-supplied relative path, or null if it escapes SAVE_DIR or
// isn't audio. Every route taking a frontend path goes through this.
function resolveLibraryPath(relpath) {
  const resolved = path.resolve(path.join(SAVE_DIR, relpath || ""));
  const root = path.resolve(SAVE_DIR);
  if (resolved === root || !resolved.startsWith(root + path.sep)) return null;
  if (!AUDIO_EXT_RE.test(resolved)) return null;
  return resolved;
}

// Cached by path and mtime, so scrolling the grid doesn't spawn an ffmpeg
// per tile.
app.get("/api/library/art/:relpath", async (req, res) => {
  const resolved = resolveLibraryPath(req.params.relpath);
  if (!resolved || !fs.existsSync(resolved)) return res.status(404).end();
  try {
    const { mtimeMs } = fs.statSync(resolved);
    let hit = artCache.get(resolved);
    if (!hit || hit.mtimeMs !== mtimeMs) {
      hit = { mtimeMs, buf: await extractCoverArt(resolved) };
      artCache.set(resolved, hit);
    }
    if (!hit.buf) return res.status(404).end();
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "private, max-age=86400");
    res.send(hit.buf);
  } catch (err) {
    console.error("Cover art read failed:", err.message || err);
    res.status(404).end();
  }
});

// The frontend encodeURIComponent's the path, so Express decodes it back to
// "Artist/Album/Title.ext" in one piece.
app.delete("/api/library/:relpath", (req, res) => {
  const resolved = resolveLibraryPath(req.params.relpath);
  if (!resolved) {
    return res.status(400).json({ error: "Not a valid library file" });
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: "File not found" });
  }
  try {
    fs.unlinkSync(resolved);
    tagCache.delete(resolved);
    artCache.delete(resolved);
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
      // Spotify lists images largest-first; index 1 is the 300px medium.
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

// Spotify's public embed page server-renders the track list into a
// __NEXT_DATA__ blob. It offers no pagination call, so this caps near 50.
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

// playlist-backend's listing carries no album or year, and each lookup takes
// 2 to 5 seconds, so the frontend asks per track at download time. The embed
// and official-API sources already return album data in the listing.
app.get("/api/playlist/track/:id", async (req, res) => {
  if (!PLAYLIST_BACKEND_URL) return res.status(404).json({ error: "Not available" });
  try {
    const proxyRes = await fetch(`${PLAYLIST_BACKEND_URL}/api/track/${encodeURIComponent(req.params.id)}`);
    const data = await proxyRes.json().catch(() => ({}));
    if (!proxyRes.ok) throw new Error(data.error || `Track lookup failed (${proxyRes.status})`);
    res.json(data);
  } catch (err) {
    console.error("Track enrichment failed:", err.message || err);
    res.status(500).json({ error: err.message || "Track lookup failed" });
  }
});

// ---------------- Download queue ----------------
// Requests enqueue and return; this worker drains the queue in the background.
const pending = [];
let activeJobs = 0;
// One at a time: each job runs yt-dlp plus ffmpeg, and a burst gets throttled.
const MAX_CONCURRENT_DOWNLOADS = 1;

// Identifies a track by where it lands on disk, so the same song queued twice
// resolves to one entry.
function jobKey(tags, trackNumber) {
  return `${destDirFor(tags.artist, tags.album)}|${buildFilename(tags.title, trackNumber)}`.toLowerCase();
}

// Queued or downloading now. The on-disk check in attemptDownload can't catch
// these, since nothing is written yet.
const inFlight = new Map(); // jobKey -> activity record

function enqueueDownload(job) {
  const key = jobKey(job.tags, job.trackNumber);
  const already = inFlight.get(key);
  if (already) return { record: already, duplicate: true };

  const record = addActivity({
    title: job.tags.title,
    artist: job.tags.artist,
    album: job.tags.album || null,
  });
  inFlight.set(key, record);
  pending.push({ job, record, key });
  pumpQueue();
  return { record, duplicate: false };
}

function pumpQueue() {
  while (activeJobs < MAX_CONCURRENT_DOWNLOADS && pending.length) {
    const { job, record, key } = pending.shift();
    activeJobs++;
    runDownloadJob(job, record)
      .catch(err => console.error("Download job crashed:", err))
      .finally(() => { inFlight.delete(key); activeJobs--; pumpQueue(); });
  }
}

app.post("/api/download", (req, res) => {
  const { query, title, artist, album, year, genre, trackNumber, coverArtUrl, partOfAlbum } = req.body || {};
  if (typeof query !== "string" || !query.trim()) {
    return res.status(400).json({ error: "query is required" });
  }
  if (typeof title !== "string" || !title.trim() || typeof artist !== "string" || !artist.trim()) {
    return res.status(400).json({ error: "title and artist are required" });
  }

  // "Download album" always files as an album; the setting governs one-offs.
  const asAlbumTrack = partOfAlbum === true || settings.singleFiling === "album";

  const tags = { title, artist };
  if (asAlbumTrack && typeof album === "string" && album.trim()) tags.album = album.trim();
  if (typeof year === "string" && /^\d{4}$/.test(year)) tags.year = year;
  if (typeof genre === "string" && genre.trim()) tags.genre = genre.trim();
  const trackNum = Number(trackNumber);
  if (asAlbumTrack && Number.isInteger(trackNum) && trackNum > 0 && trackNum < 1000) {
    tags.trackNumber = String(trackNum);
  }

  const { record, duplicate } = enqueueDownload({
    query, tags, coverArtUrl,
    trackNumber: asAlbumTrack ? trackNumber : null,
  });
  res.json({ ok: true, queued: !duplicate, duplicate, id: record.id, position: pending.length });
});

// Retried once: YouTube downloads fail transiently often enough to warrant it.
async function runDownloadJob(job, record) {
  record.status = "downloading";
  record.startedAt = Date.now();
  try {
    await attemptDownload(job, record);
  } catch (err) {
    const message = err.shortMessage || err.message || String(err);
    console.warn(`Retrying "${job.query}" after: ${message}`);
    await new Promise(r => setTimeout(r, 3000));
    try {
      await attemptDownload(job, record);
    } catch (err2) {
      const message2 = err2.shortMessage || err2.message || String(err2);
      console.error(`Failed ("${job.query}"):`, message2);
      finishActivity(record, "failed", { error: message2 });
    }
  }
}

async function attemptDownload(job, record) {
  const { query, tags, trackNumber, coverArtUrl } = job;
  const { title, artist } = tags;

  const format = AUDIO_FORMATS.includes(settings.audioFormat) ? settings.audioFormat : "mp3";
  const quality = settings.audioQuality || DEFAULT_QUALITY[format];

  const destDir = destDirFor(artist, tags.album);
  const baseName = buildFilename(title, trackNumber);

  const existing = findExistingDownload(destDir, baseName);
  if (existing) {
    console.log(`Skipped (already have it): ${existing}`);
    finishActivity(record, "skipped", { filename: existing });
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdl-"));
  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true }, () => {});

  try {
    // yt-dlp's "ytsearchN:" pseudo-URL searches and downloads the top match,
    // with no API key or quota.
    const ytDlpOpts = {
      output: path.join(tmpDir, "%(id)s.%(ext)s"),
      extractAudio: true,
      audioFormat: format,
      ffmpegLocation: ffmpegPath,
      noPlaylist: true,
    };
    // FLAC has no quality knob. The others take an mp3 VBR level or a "<N>K"
    // bitrate, which ffmpeg tells apart by shape.
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

    // Re-check before writing in case the same track landed mid-download. A
    // match means it is the same track, so drop this copy rather than saving
    // a second "Title (2)".
    ensureDir(destDir);
    const landedMeanwhile = findExistingDownload(destDir, baseName);
    if (landedMeanwhile) {
      console.log(`Skipped (saved by another job while downloading): ${landedMeanwhile}`);
      finishActivity(record, "skipped", { filename: landedMeanwhile });
      return;
    }
    const destPath = path.join(destDir, `${baseName}.${format}`);
    fs.copyFileSync(taggedPath, destPath);

    console.log(`Saved: ${relKey(destPath)}`);
    finishActivity(record, "completed", { filename: path.basename(destPath) });
  } finally {
    cleanup();
  }
}

app.listen(PORT, () => console.log(`Download backend listening on http://localhost:${PORT}`));
