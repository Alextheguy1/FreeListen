const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
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
const DOWNLOAD_SOURCES = ["youtube", "soundcloud"];
const LYRICS_MODES = ["off", "embedded", "lrc", "both"];
const MAX_CONCURRENCY_LIMIT = 5;

// yt-dlp pseudo-URL prefixes. Both take "<prefix><n>:<query>" and return the
// top n results, so switching source is a prefix change and nothing else.
const SOURCE_SEARCH_PREFIX = { youtube: "ytsearch", soundcloud: "scsearch" };

// Path templates. A "/" starts a new folder; the last segment is the
// filename, and the extension is appended from the chosen audio format.
const DEFAULT_ALBUM_TEMPLATE = "{artist}/{album}/{track} - {title}";
const DEFAULT_SINGLE_TEMPLATE = "{artist}/{title}";
const TEMPLATE_TOKENS = ["artist", "album", "title", "track", "year", "genre"];

// coverArtUrl arrives in the download request body, and the server fetches it.
// Without a allowlist that is an SSRF: a caller could point it at a router
// admin page or a cloud metadata endpoint, and read the response back out of
// the saved file through /api/library/art. Only the hosts this app actually
// sources art from are permitted. Cover Art Archive redirects into
// archive.org's storage nodes, so those have to be here too.
const COVER_ART_HOSTS = ["coverartarchive.org", "archive.org", "scdn.co"];
const MAX_COVER_ART_BYTES = 10 * 1024 * 1024;

function allowedCoverArtUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return COVER_ART_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
}

// LRCLIB needs no key and asks that clients identify themselves.
const LRCLIB_UA = "FreeListen (https://github.com/Alextheguy1/FreeListen)";

// /api/get wants an exact artist, track, album and duration match, so it is
// tried first and /api/search picks up the rest. Lyrics are optional: any
// failure here leaves the download alone.
async function fetchLyrics(tags) {
  const q = new URLSearchParams({ artist_name: tags.artist || "", track_name: tags.title || "" });
  if (tags.album) q.set("album_name", tags.album);
  const opts = { headers: { "User-Agent": LRCLIB_UA } };

  try {
    const exact = await fetch(`https://lrclib.net/api/get?${q}`, opts);
    if (exact.ok) {
      const hit = await exact.json();
      if (!hit.instrumental && (hit.syncedLyrics || hit.plainLyrics)) return hit;
    }

    const search = await fetch(`https://lrclib.net/api/search?${q}`, opts);
    if (!search.ok) return null;
    const results = await search.json();
    if (!Array.isArray(results)) return null;
    // Prefer a result that carries timings, since that is what a .lrc is for.
    return results.find(r => !r.instrumental && r.syncedLyrics)
      || results.find(r => !r.instrumental && r.plainLyrics)
      || null;
  } catch (err) {
    console.warn(`Lyrics lookup failed for "${tags.title}":`, err.message || err);
    return null;
  }
}

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
    authUsername: typeof saved.authUsername === "string" ? saved.authUsername : "",
    authSalt: typeof saved.authSalt === "string" ? saved.authSalt : "",
    authHash: typeof saved.authHash === "string" ? saved.authHash : "",
    albumTemplate: validTemplate(saved.albumTemplate) ? saved.albumTemplate : DEFAULT_ALBUM_TEMPLATE,
    singleTemplate: validTemplate(saved.singleTemplate) ? saved.singleTemplate : DEFAULT_SINGLE_TEMPLATE,
    maxConcurrentDownloads: clampConcurrency(saved.maxConcurrentDownloads ?? process.env.MAX_CONCURRENT_DOWNLOADS),
    lyrics: LYRICS_MODES.includes(saved.lyrics) ? saved.lyrics : "off",
    downloadSource: DOWNLOAD_SOURCES.includes(saved.downloadSource) ? saved.downloadSource : "youtube",
  };
}

function clampConcurrency(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, MAX_CONCURRENCY_LIMIT);
}

// A template is a relative path of "/"-separated segments. Backslashes, "..",
// a leading "/" and a drive letter are all refused outright rather than
// sanitized, so a bad template is reported instead of silently rewritten.
function validTemplate(t) {
  if (typeof t !== "string" || !t.trim()) return false;
  if (t.includes("\\") || t.startsWith("/") || /^[a-zA-Z]:/.test(t)) return false;
  const segments = t.split("/").map(s => s.trim()).filter(Boolean);
  if (!segments.length) return false;
  if (segments.some(s => /^\.+$/.test(s))) return false;
  // Must end up with something per track, not just folders.
  if (!/\{(title|track)\}/.test(segments[segments.length - 1])) return false;
  for (const token of t.match(/\{(\w+)\}/g) || []) {
    if (!TEMPLATE_TOKENS.includes(token.slice(1, -1))) return false;
  }
  return true;
}

let settings = loadSettings();
let spotifyToken = null; // { value, expiresAt } - cached Spotify app access token

function persistSettings() {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

// ---------------- Authentication ----------------
// Credentials are chosen by whoever completes first-run setup. Until that
// happens the app is unconfigured, and the middleware below answers every
// route except setup with 403, so the window before setup cannot be used to
// download, delete or read saved API keys.

const AUTH_DISABLED = process.env.DISABLE_AUTH === "true";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiry epoch ms

function authConfigured() {
  return !!(settings.authUsername && settings.authHash && settings.authSalt);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function passwordMatches(password) {
  const expected = Buffer.from(settings.authHash, "hex");
  const actual = Buffer.from(hashPassword(password, settings.authSalt), "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function issueSession() {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function validSession(token) {
  const expiry = token && sessions.get(token);
  if (!expiry) return false;
  if (expiry < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

// SameSite=Strict means a cross-site request never carries the cookie, which
// is what stops another page driving this API in a logged-in browser.
function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie",
    `fl_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "fl_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

// /api/health stays open because the container healthcheck curls it with no
// credentials. It reports liveness only.
// Paths are relative to the /api mount point below, not absolute.
const OPEN_ROUTES = new Set(["/health", "/auth/status", "/auth/setup", "/auth/login"]);

app.use("/api", (req, res, next) => {
  if (AUTH_DISABLED || OPEN_ROUTES.has(req.path)) return next();
  if (!authConfigured()) {
    return res.status(403).json({ error: "Setup required", setupRequired: true });
  }
  if (!validSession(readCookie(req, "fl_session"))) {
    return res.status(401).json({ error: "Not signed in" });
  }
  next();
});

app.get("/api/auth/status", (req, res) => {
  res.json({
    configured: authConfigured(),
    authenticated: AUTH_DISABLED || validSession(readCookie(req, "fl_session")),
    authDisabled: AUTH_DISABLED,
    username: settings.authUsername || null,
  });
});

app.post("/api/auth/setup", (req, res) => {
  if (authConfigured()) return res.status(409).json({ error: "Already set up" });
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (username.length < 3) return res.status(400).json({ error: "Username must be at least 3 characters" });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });

  const salt = crypto.randomBytes(16).toString("hex");
  settings = { ...settings, authUsername: username, authSalt: salt, authHash: hashPassword(password, salt) };
  try {
    persistSettings();
  } catch (err) {
    settings = { ...settings, authUsername: "", authSalt: "", authHash: "" };
    return res.status(500).json({ error: `Could not write ${SETTINGS_FILE}: ${err.message || err}` });
  }
  setSessionCookie(res, issueSession());
  res.json({ ok: true });
});

app.post("/api/auth/login", (req, res) => {
  if (!authConfigured()) return res.status(403).json({ error: "Setup required", setupRequired: true });
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  const userOk = username === settings.authUsername;
  // Hash regardless of whether the username matched, so a wrong username and
  // a wrong password take the same time to reject.
  const passOk = passwordMatches(password);
  if (!userOk || !passOk) return res.status(401).json({ error: "Wrong username or password" });
  setSessionCookie(res, issueSession());
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  const token = readCookie(req, "fl_session");
  if (token) sessions.delete(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Version and commit are baked in at image build time. Without them the only
// way to tell which build is running is to grep the served HTML for a CSS
// rule, which is how three separate "did the update apply?" questions went.
const VERSION = require("./package.json").version;
const BUILD_COMMIT = process.env.BUILD_COMMIT || "dev";

// Liveness probe for container healthchecks. Touches no disk and no upstream
// API, so it reports on this server rather than on MusicBrainz.
app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: VERSION, commit: BUILD_COMMIT, queued: pending.length, active: activeJobs });
});

// Never returns the saved credentials, only whether each one is set. The UI
// shows "set"/"not set" and sends a replacement when the user types one.
app.get("/api/settings", (req, res) => {
  res.json({
    audioFormat: settings.audioFormat,
    audioQuality: settings.audioQuality,
    singleFiling: settings.singleFiling,
    spotifyClientIdSet: !!settings.spotifyClientId,
    spotifyClientSecretSet: !!settings.spotifyClientSecret,
    listenbrainzTokenSet: !!settings.listenbrainzToken,
    authUsername: settings.authUsername || null,
    albumTemplate: settings.albumTemplate,
    singleTemplate: settings.singleTemplate,
    defaultAlbumTemplate: DEFAULT_ALBUM_TEMPLATE,
    defaultSingleTemplate: DEFAULT_SINGLE_TEMPLATE,
    templateTokens: TEMPLATE_TOKENS,
    maxConcurrentDownloads: settings.maxConcurrentDownloads,
    maxConcurrencyLimit: MAX_CONCURRENCY_LIMIT,
    lyrics: settings.lyrics,
    downloadSource: settings.downloadSource,
  });
});

// A secret is replaced only when a non-empty string arrives, and cleared only
// on an explicit null. The UI never holds the saved value, so it sends nothing
// for a field the user did not touch.
function nextSecret(body, key, current) {
  if (!(key in body)) return current;
  if (body[key] === null) return "";
  const v = typeof body[key] === "string" ? body[key].trim() : "";
  return v || current;
}

app.post("/api/settings", (req, res) => {
  const body = req.body || {};
  const clean = v => (typeof v === "string" ? v.trim() : undefined);
  const audioFormat = AUDIO_FORMATS.includes(body.audioFormat) ? body.audioFormat : settings.audioFormat;
  // Quality is format-specific, so a value left over from switching formats
  // falls back to the new format's default instead of reaching ffmpeg.
  const rawQuality = clean(body.audioQuality);
  const qualityValid = rawQuality != null && (/^[0-9]$/.test(rawQuality) || /^\d+K$/i.test(rawQuality));
  const previous = settings;
  settings = {
    ...settings,
    spotifyClientId: nextSecret(body, "spotifyClientId", settings.spotifyClientId),
    spotifyClientSecret: nextSecret(body, "spotifyClientSecret", settings.spotifyClientSecret),
    listenbrainzToken: nextSecret(body, "listenbrainzToken", settings.listenbrainzToken),
    audioFormat,
    audioQuality: qualityValid ? rawQuality : DEFAULT_QUALITY[audioFormat],
    singleFiling: SINGLE_FILING_MODES.includes(body.singleFiling) ? body.singleFiling : settings.singleFiling,
    maxConcurrentDownloads: "maxConcurrentDownloads" in body
      ? clampConcurrency(body.maxConcurrentDownloads) : settings.maxConcurrentDownloads,
    lyrics: LYRICS_MODES.includes(body.lyrics) ? body.lyrics : settings.lyrics,
    downloadSource: DOWNLOAD_SOURCES.includes(body.downloadSource) ? body.downloadSource : settings.downloadSource,
  };

  // A bad template is reported rather than quietly replaced with the default,
  // so a typo does not silently refile the next download somewhere else.
  for (const [key, fallback] of [["albumTemplate", DEFAULT_ALBUM_TEMPLATE], ["singleTemplate", DEFAULT_SINGLE_TEMPLATE]]) {
    if (!(key in body)) continue;
    const value = typeof body[key] === "string" ? body[key].trim() : "";
    if (!value) { settings[key] = fallback; continue; }
    if (!validTemplate(value)) {
      settings = previous;
      return res.status(400).json({
        error: `That ${key === "albumTemplate" ? "album" : "single"} template is not usable. `
          + `Use "/" for folders, end with {title} or {track}, and only these tokens: `
          + TEMPLATE_TOKENS.map(t => `{${t}}`).join(" "),
      });
    }
    settings[key] = value;
  }

  spotifyToken = null; // credentials may have changed - drop the cached token
  try {
    persistSettings();
    res.json({ ok: true });
  } catch (err) {
    settings = previous;
    // Usually /config not being writable by the container's uid.
    console.error("Saving settings failed:", err.message || err);
    res.status(500).json({ error: `Could not write ${SETTINGS_FILE}: ${err.message || err}` });
  }
});

// Proxied rather than called from the page, so the ListenBrainz token stays
// on the server. The browser used to send it itself, which meant the token
// had to be handed out by GET /api/settings.
app.get("/api/listenbrainz/top-recordings/:artistMbid", async (req, res) => {
  const mbid = req.params.artistMbid;
  if (!/^[0-9a-f-]{36}$/i.test(mbid)) return res.status(400).json({ error: "Bad artist id" });

  const url = `https://api.listenbrainz.org/1/popularity/top-recordings-for-artist/${mbid}`;
  const opts = settings.listenbrainzToken
    ? { headers: { Authorization: `Token ${settings.listenbrainzToken}` } }
    : {};
  try {
    let upstream = await fetch(url, opts);
    // ListenBrainz gates this endpoint against scrapers and can 401 or 429 a
    // legitimate request even with a token. One retry clears most of them.
    if (upstream.status === 401 || upstream.status === 429) {
      await new Promise(r => setTimeout(r, 2000));
      upstream = await fetch(url, opts);
    }
    if (!upstream.ok) {
      const hint = settings.listenbrainzToken
        ? "it may still be rate-limiting this endpoint, try again shortly"
        : "add a free token on the Settings page";
      return res.status(502).json({ error: `ListenBrainz error (${upstream.status}): ${hint}` });
    }
    res.json(await upstream.json());
  } catch (err) {
    res.status(502).json({ error: `ListenBrainz request failed: ${err.message || err}` });
  }
});

app.post("/api/auth/password", (req, res) => {
  const current = String(req.body?.currentPassword ?? "");
  const next = String(req.body?.newPassword ?? "");
  if (!passwordMatches(current)) return res.status(401).json({ error: "Current password is wrong" });
  if (next.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters" });

  const previous = settings;
  const salt = crypto.randomBytes(16).toString("hex");
  settings = { ...settings, authSalt: salt, authHash: hashPassword(next, salt) };
  try {
    persistSettings();
  } catch (err) {
    settings = previous;
    return res.status(500).json({ error: `Could not write ${SETTINGS_FILE}: ${err.message || err}` });
  }
  // Every other session is now stale; keep only the one that made the change.
  const keep = readCookie(req, "fl_session");
  for (const token of [...sessions.keys()]) if (token !== keep) sessions.delete(token);
  res.json({ ok: true });
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
async function embedMetadata(srcPath, destPath, format, tags, coverBuffer, lyricsText) {
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
    // "lyrics" is what ffmpeg maps to USLT for id3 and to a LYRICS vorbis
    // comment for flac and opus, which is what Navidrome reads.
    if (lyricsText) meta.lyrics = lyricsText;
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

// Strips separators and the characters Windows rejects. The trailing rule
// matters most: "." and ".." survive every other replacement here, and a
// single ".." as an artist name walks the save path up a level.
function sanitizeForFilename(s) {
  return String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "");
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

// Renders a template into { dir, baseName }. The album template is used when
// the track has an album, the single template otherwise, so the two defaults
// reproduce the old Artist/Album/NN - Title and Artist/Title layouts.
//
// A token that resolves to nothing leaves a dangling separator behind, so
// "{track} - {title}" with no track number yields "Title" rather than
// " - Title". Segments that end up empty are dropped instead of becoming an
// empty folder name.
function renderDestination(tags, trackNumber) {
  const n = Number(trackNumber);
  const values = {
    artist: tags.artist || "",
    album: tags.album || "",
    title: tags.title || "",
    track: Number.isInteger(n) && n > 0 && n < 1000 ? String(n).padStart(2, "0") : "",
    year: tags.year || "",
    genre: tags.genre || "",
  };

  const template = tags.album
    ? (validTemplate(settings.albumTemplate) ? settings.albumTemplate : DEFAULT_ALBUM_TEMPLATE)
    : (validTemplate(settings.singleTemplate) ? settings.singleTemplate : DEFAULT_SINGLE_TEMPLATE);

  const segments = template.split("/").map(segment => {
    const filled = segment.replace(/\{(\w+)\}/g, (m, key) => (key in values ? values[key] : m));
    return sanitizeForFilename(
      filled
        .replace(/\s*[-_]\s*$/, "")
        .replace(/^\s*[-_]\s*/, "")
        .replace(/\s{2,}/g, " ")
    );
  }).filter(Boolean);

  if (!segments.length) segments.push("Unknown Artist", "track");
  const baseName = segments.pop() || "track";
  const dir = path.join(SAVE_DIR, ...segments);

  // The write path has no equivalent of resolveLibraryPath, so it checks
  // containment itself rather than trusting the sanitizer to have caught
  // everything.
  const root = path.resolve(SAVE_DIR);
  const resolved = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    console.warn(`Refused a destination outside the library: ${dir}`);
    return { dir: path.join(SAVE_DIR, "Unknown Artist"), baseName };
  }
  return { dir, baseName };
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
    // A .lrc written alongside the track would otherwise be orphaned, and
    // would keep the folder non-empty so the prune below skipped it.
    try { fs.unlinkSync(resolved.replace(AUDIO_EXT_RE, ".lrc")); } catch {}
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
// Each job runs yt-dlp plus ffmpeg, and a burst is the quickest way to get
// throttled, so the default stays at one and the ceiling is low.

// Identifies a track by where it lands on disk, so the same song queued twice
// resolves to one entry.
function jobKey(tags, trackNumber) {
  const { dir, baseName } = renderDestination(tags, trackNumber);
  return `${dir}|${baseName}`.toLowerCase();
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
  while (activeJobs < clampConcurrency(settings.maxConcurrentDownloads) && pending.length) {
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
// execa puts the exit code in message and the useful text in stderr, so a
// bare message is "Command failed with exit code 1" plus the whole command
// line. This pulls out yt-dlp's own ERROR line instead.
function downloadErrorText(err) {
  const stderr = typeof err?.stderr === "string" ? err.stderr : "";
  const line = stderr.split(String.fromCharCode(10)).map(l => l.trim()).filter(Boolean)
    .reverse()
    .find(l => /^ERROR[:\s]/i.test(l));
  // "ERROR: [soundcloud] 718846078: This video is DRM protected" becomes
  // "This video is DRM protected".
  if (line) {
    return line
      .replace(/^ERROR:?\s*/i, "")
      .replace(/^\[[^\]]+\]\s*/, "")
      .replace(/^[\w-]+:\s*/, "")
      .trim();
  }
  return err?.shortMessage || err?.message || String(err);
}

// Retrying is only worth it for transient failures. A DRM-protected track,
// which is most of SoundCloud's commercial catalogue, fails identically every
// time, so it is reported straight away rather than after a second attempt.
// The check runs over stderr too, since that is where yt-dlp says why.
function isPermanentFailure(err) {
  const haystack = [err?.stderr, err?.shortMessage, err?.message].filter(Boolean).join(" ");
  return /DRM protected|is not available|Private video|members-only|removed by the uploader|Video unavailable|requested format is not available/i.test(haystack);
}

async function runDownloadJob(job, record) {
  record.status = "downloading";
  record.startedAt = Date.now();
  try {
    await attemptDownload(job, record);
  } catch (err) {
    const message = downloadErrorText(err);
    if (isPermanentFailure(err)) {
      console.error(`Failed ("${job.query}"):`, message);
      finishActivity(record, "failed", { error: message });
      return;
    }
    console.warn(`Retrying "${job.query}" after: ${message}`);
    await new Promise(r => setTimeout(r, 3000));
    try {
      await attemptDownload(job, record);
    } catch (err2) {
      const message2 = downloadErrorText(err2);
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

  const { dir: destDir, baseName } = renderDestination(tags, trackNumber);

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
    const prefix = SOURCE_SEARCH_PREFIX[settings.downloadSource] || SOURCE_SEARCH_PREFIX.youtube;
    await ytDlp(`${prefix}1:${query}`, ytDlpOpts, { env: ytDlpEnv });

    const produced = fs.readdirSync(tmpDir).find(f => f.toLowerCase().endsWith(`.${format}`));
    if (!produced) throw new Error(`Conversion did not produce a .${format} file`);
    const rawPath = path.join(tmpDir, produced);

    // Best-effort: a missing/unreachable cover shouldn't fail the download.
    let coverBuffer = null;
    if (allowedCoverArtUrl(coverArtUrl) && SUPPORTS_EMBEDDED_ART[format]) {
      try {
        const imgRes = await fetch(coverArtUrl, { redirect: "follow" });
        const finalUrl = imgRes.url || coverArtUrl;
        // A redirect can leave the allowlist, so re-check where we landed.
        if (imgRes.ok && allowedCoverArtUrl(finalUrl)) {
          const len = Number(imgRes.headers.get("content-length") || 0);
          if (len <= MAX_COVER_ART_BYTES) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            if (buf.length <= MAX_COVER_ART_BYTES) coverBuffer = buf;
          }
        } else if (imgRes.ok) {
          console.warn(`Cover art redirected off-allowlist for "${title}": ${finalUrl}`);
        }
      } catch (e) {
        console.warn(`Cover art fetch failed for "${title}":`, e.message || e);
      }
    }

    const lyricsMode = LYRICS_MODES.includes(settings.lyrics) ? settings.lyrics : "off";
    const lyrics = lyricsMode === "off" ? null : await fetchLyrics(tags);
    const embedLyrics = lyrics && (lyricsMode === "embedded" || lyricsMode === "both")
      ? (lyrics.plainLyrics || lyrics.syncedLyrics)
      : null;

    const taggedPath = path.join(tmpDir, `tagged.${format}`);
    await embedMetadata(rawPath, taggedPath, format, tags, coverBuffer, embedLyrics);

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

    // A .lrc sits next to the track; music servers pick it up by filename.
    if (lyrics && (lyricsMode === "lrc" || lyricsMode === "both")) {
      const lrcBody = lyrics.syncedLyrics || lyrics.plainLyrics;
      if (lrcBody) {
        try {
          fs.writeFileSync(path.join(destDir, `${baseName}.lrc`), lrcBody, "utf8");
        } catch (err) {
          console.warn(`Could not write .lrc for "${tags.title}":`, err.message || err);
        }
      }
    }

    console.log(`Saved: ${relKey(destPath)}`);
    finishActivity(record, "completed", { filename: path.basename(destPath) });
  } finally {
    cleanup();
  }
}

// Only listen when started directly, so the test suite can require this file
// for its pure helpers without a server appearing on a port.
if (require.main === module) {
  app.listen(PORT, () => console.log(`Download backend listening on http://localhost:${PORT}`));
}

module.exports = {
  app,
  allowedCoverArtUrl,
  sanitizeForFilename,
  validTemplate,
  renderDestination,
  clampConcurrency,
  isPermanentFailure,
  downloadErrorText,
  hashPassword,
  // renderDestination reads the live settings object, so tests need a way to
  // choose templates without going through the HTTP API.
  _setSettingsForTest: patch => { settings = { ...settings, ...patch }; },
};
