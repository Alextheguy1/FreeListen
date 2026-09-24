# FreeListen

A self-hosted app for searching songs, albums, and artists in the
[MusicBrainz](https://musicbrainz.org) database (with play-count data from
[ListenBrainz](https://listenbrainz.org) and cover art from
[Cover Art Archive](https://coverartarchive.org)), or loading a Spotify
playlist - with one-click downloads of tagged MP3s, a download queue, and a
library view, all through a single web UI.

![status](https://img.shields.io/badge/status-personal%20project-blue)
![license](https://img.shields.io/badge/license-MIT-green)

## Screenshots

The app has four pages, reachable from the sidebar: **Search**, **Activity**
(live download queue + history), **Library** (everything saved to disk, with
delete), and **Settings**.

## Features

- Search **Songs**, **Albums**, or **Artists**, sorted by popularity or
  relevance. Narrow a search with `artist:name` syntax.
- Load a **Playlists** tab: paste a public Spotify playlist link to list its
  tracks, with per-track or "download all" buttons.
- Per-song **Download**: finds a lyrics-video version of the track (to avoid
  the sound effects/crowd noise/intros that often come with official music
  videos), downloads it as an MP3, and tags it with title, artist, album,
  year, and genre where available.
- Per-artist **Download top N tracks**: downloads an artist's N most popular
  tracks (by real ListenBrainz play count), skipping remaster/live/concert
  versions and near-duplicate titles. N is adjustable in the UI.
- Playlist **Download all**: downloads every track in a loaded playlist the
  same way, tagged with the metadata Spotify has for each track.
- **Activity page**: a live queue and history of every download - what's in
  progress, what completed, what failed and why.
- **Library page**: everything currently saved to disk, read back from each
  file's actual ID3 tags, with a delete button per track.
- Duplicate detection: re-downloading a track you already have is a no-op
  (matched by sanitized `"<title> - <artist>"` filename), so batch downloads
  are safe to re-run.
- Automatic retry with backoff on the transient failures YouTube downloads
  occasionally hit.
- Settings page for API keys - nothing is hardcoded in source.

## Architecture

Three independent pieces:

- **`frontend/`** - a static page, no build step, no framework. Served by
  `backend/` (so the whole app is just "visit one URL"); can also be opened
  directly as a local file for manual/non-Docker use.
- **`backend/`** - a Node/Express server. Resolves a search query to a
  YouTube video with [yt-dlp](https://github.com/yt-dlp/yt-dlp), downloads
  and converts the audio, tags it, and saves it to disk. Also serves the
  frontend, tracks download activity, lists/deletes library files, and holds
  saved settings.
- **`playlist-backend/`** - a small Python service using
  [SpotipyFree](https://github.com/TzurSoffer/spotipyFree) to read full
  Spotify playlists without needing a Spotify account or API credentials.
  `backend/` proxies playlist requests to it when available, falling back to
  its own (credential-optional, ~50-track-capped) logic otherwise.

## Option A: Docker (recommended - e.g. for TrueNAS)

```bash
cp .env.example .env
# edit .env - at minimum set MUSIC_DIR_HOST to where you want MP3s to land
docker compose up -d --build
```

Then visit `http://<the-host's-address>:5051` - that's the whole app,
frontend included. On TrueNAS, `MUSIC_DIR_HOST` in `.env` should point at a
dataset path (e.g. `/mnt/tank/Music`), the same way apps like Sonarr/Radarr
let you map a media directory instead of hardcoding one - nothing about the
save location is baked into the image.

This starts both services (`music-search` and `playlist-backend`) wired
together automatically. Playlists work fully (no cap, no credentials) out of
the box via `playlist-backend`.

### Deploying to TrueNAS SCALE specifically

TrueNAS SCALE's "Custom App" wizard installs one pre-built image per app
rather than a multi-container Compose file, so the straightforward path is
the Shell, not that wizard:

1. Copy this folder onto the NAS (SMB share, or `scp -O -r`).
2. SSH/Shell in, `cd` into the folder, `cp .env.example .env` and edit it.
3. `sudo docker compose up -d --build`.

If you specifically want it to show up in the Apps page with its own
start/stop controls, build the two images with `docker build` and register
each as its own Custom App instead - see the comments in `docker-compose.yml`
for the equivalent settings (env vars, volumes, ports) to enter by hand.

## Option B: Run it directly (no Docker)

```bash
cd backend
npm install
npm start
```

`npm install` also runs a `postinstall` script
(`backend/scripts/setup-deno.js`) that downloads a portable copy of
[Deno](https://deno.com) into `backend/bin/`. This is required: YouTube now
requires running a bit of JS to decrypt some video formats' URLs, and yt-dlp
only supports Deno for that. If the automatic download fails (e.g. an
unsupported platform), the script prints a warning with manual instructions.

This also serves the frontend - visit `http://localhost:5051`. Downloaded
files land in `~/Downloads/Music` unless `MUSIC_DIR` is set.

Playlists work immediately too, but capped at ~50 tracks (Spotify's public
embed page, no credentials needed) unless you also run `playlist-backend`:

```bash
cd playlist-backend
python -m venv venv && source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r requirements.txt
python app.py
```

...and set `PLAYLIST_BACKEND_URL=http://localhost:5058` before starting
`backend/`, or add Spotify credentials in Settings instead.

## Settings (API keys)

Open the **Settings** page in the app to add:

- **ListenBrainz token** - makes the artist "Download top N tracks" button
  reliable (ListenBrainz gates that endpoint against scrapers and can
  intermittently reject unauthenticated requests). Get a free one from your
  account at **listenbrainz.org/settings/**.
- **Spotify Client ID/Secret** - only relevant if you're *not* running
  `playlist-backend` and want to lift the ~50-track cap on the fallback
  embed-page method. Get these free at
  [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
  (Client Credentials flow - read-only, never tied to a user account).

These save to `backend/settings.json` (or the `/config` volume in Docker) via
`POST /api/settings` - nothing needs to be hardcoded or edited in source
files.

## How it works

- **Search**: the page queries MusicBrainz's public search API directly from
  the browser (rate-limited client-side to ~1 request/second, per
  MusicBrainz's usage policy) and layers ListenBrainz play counts on top.
- **Download**: the page never talks to YouTube directly. It sends the
  backend a search string like `"<artist> <title> lyrics"`; the backend hands
  that to yt-dlp's `ytsearch1:` pseudo-URL, which resolves and downloads the
  top match without needing any API key or quota.
- **Artist top tracks**: sourced from ListenBrainz's
  `top-recordings-for-artist` endpoint, which returns an artist's recordings
  already ranked by real play count - far more reliable than trying to infer
  popularity by sampling MusicBrainz's catalog browse endpoint (which returns
  results in roughly alphabetical order, not by popularity).
- **Playlists**: without credentials, the backend fetches Spotify's public
  embed page for the playlist and parses the track list out of its embedded
  JSON (~50-track cap, no pagination available that way). With Spotify
  credentials saved in Settings, it instead exchanges them for a short-lived
  app access token (cached until it expires) and paginates through the
  official Web API. If `playlist-backend` is configured (the default in
  Docker), that's tried first instead, since it needs no credentials at all
  and isn't capped. Either way, each track goes through the exact same
  download pipeline as everything else - same query-building, tagging,
  duplicate detection, and retry logic.
- **Activity**: the backend keeps an in-memory log of every download attempt
  (title, artist, status, timing) exposed via `GET /api/activity`. It's
  intentionally not persisted to disk - a restart just starts a fresh log.
- **Library**: `GET /api/library` reads every `.mp3` in the save directory
  and its actual ID3 tags back out, so what you see always matches what's
  really on disk. Deleting (`DELETE /api/library/:filename`) only accepts a
  bare filename - `path.basename()` strips any directory components, so it
  can't be tricked into deleting outside the save directory.

## Known limitations

- YouTube downloads occasionally fail transiently (a bad format pick, a
  momentary throttle). Both download paths retry once automatically; a
  failure that survives the retry is logged and skipped rather than blocking
  the rest of a batch.
- Downloading audio from YouTube sits in a legal gray area under YouTube's
  Terms of Service, even though the mechanism (yt-dlp) is a legitimate
  open-source tool. This is intended for personal use.
- The Activity log is in-memory only and resets on restart.
- The app has no auth of its own - it's meant for your own local network, not
  to be exposed to the public internet.

## Project layout

```
.
├── README.md
├── LICENSE
├── docker-compose.yml
├── .env.example
├── frontend/
│   └── index.html              # Search / Activity / Library / Settings UI
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js                # all API routes (see below)
│   ├── scripts/
│   │   └── setup-deno.js        # postinstall: fetches the Deno binary
│   └── bin/                     # created by setup-deno.js (gitignored)
└── playlist-backend/
    ├── Dockerfile
    ├── requirements.txt
    └── app.py                   # GET /api/playlist (SpotipyFree)
```

### `backend/server.js` routes

| Method | Path                    | Purpose                                  |
| ------ | ----------------------- | ----------------------------------------- |
| GET    | `/api/settings`         | Read saved API keys                       |
| POST   | `/api/settings`         | Save API keys                             |
| GET    | `/api/playlist`         | Resolve a Spotify playlist to a track list |
| POST   | `/api/download`         | Download + tag + save one track           |
| GET    | `/api/activity`         | Current queue + history                   |
| DELETE | `/api/activity`         | Clear finished entries from history        |
| GET    | `/api/library`          | List everything saved to disk             |
| DELETE | `/api/library/:filename`| Delete one saved file                     |

## License

[MIT](LICENSE) - do what you like with it.
