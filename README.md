# FreeListen

A self-hosted app for searching songs, albums, and artists in the
[MusicBrainz](https://musicbrainz.org) database (with play-count data from
[ListenBrainz](https://listenbrainz.org) and cover art from
[Cover Art Archive](https://coverartarchive.org)), or loading a Spotify
playlist - with one-click downloads of tagged audio files, a download queue,
and a library view, all through a single web UI.

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
  videos), downloads it, and tags it with title, artist, album, year, genre,
  track number, and embedded cover art where available.
- Configurable **download quality**: pick the output format (MP3, FLAC,
  Opus, or AAC/M4A) and, for the lossy formats, the encode quality - a
  global setting applied to every download, not decided for you. Every
  format gets full metadata tags; only Opus can't carry embedded cover art
  (a limitation of the format itself, not this app).
- Per-artist **Download top N tracks**: downloads an artist's N most popular
  tracks (by real ListenBrainz play count), skipping remaster/live/concert
  versions and near-duplicate titles. N is adjustable in the UI, with no
  upper limit.
- Playlist **Download all**: downloads every track in a loaded playlist the
  same way, tagged with the metadata Spotify has for each track.
- Library layout: saves into `Artist/Album/NN - Title.<ext>` (or
  `Artist/Title.<ext>` when no album is known) rather than one flat folder -
  point Navidrome, Jellyfin, or any other Subsonic/media-server-style app at
  the same directory and it'll organize correctly.
- **Activity page**: a live queue of downloads currently in progress.
- **Library page**: everything currently saved to disk, read back from each
  file's actual tags, with a delete button per track (which also prunes any
  album/artist folder left empty behind it).
- Duplicate detection: re-downloading a track you already have is a no-op
  (matched by sanitized title within that track's artist/album folder), so
  batch downloads are safe to re-run.
- Automatic retry with backoff on the transient failures YouTube downloads
  occasionally hit.
- Settings page for API keys and download quality - nothing is hardcoded in
  source.

## Architecture

Two pieces of code, packaged as one Docker image/container:

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

In Docker, both run inside the same container as two processes managed by
`supervisord` (see `Dockerfile`/`supervisord.conf`), talking to each other
over `localhost` - the same single-image approach apps like Lidarr use for
their own internal services, so this deploys as one app instead of two. For
local (non-Docker) development they're still just two separate things you
can run independently - see Option B below.

## Option A: Docker (recommended - e.g. for TrueNAS)

```bash
cp .env.example .env
# edit .env - at minimum set MUSIC_DIR_HOST to where you want downloads to land
docker compose up -d --build
```

Then visit `http://<the-host's-address>:5051` - that's the whole app. One
image, one container; playlists work fully (no cap, no credentials) out of
the box. On TrueNAS, `MUSIC_DIR_HOST` in `.env` should point at a dataset
path (e.g. `/mnt/tank/Music`), the same way apps like Sonarr/Radarr let you
map a media directory instead of hardcoding one - nothing about the save
location is baked into the image.

### Deploying to TrueNAS SCALE specifically

Since this is one image now, it fits TrueNAS's "Custom App" wizard directly
(no more needing two separate apps for the two backends):

1. Copy this folder onto the NAS (SMB share, or `scp -O -r`).
2. SSH/Shell in, `cd` into the folder, `sudo docker build -t freelisten .`
3. In the TrueNAS UI: **Apps → Discover Apps → Custom App**. Point the image
   at `freelisten:latest`, map a host path to container path `/music` and
   another to `/config`, publish container port `5051` to whatever host port
   you want, and deploy.

Or skip the UI and just run `docker compose up -d --build` over SSH the same
way as any other Docker host - the compose file works either way, it's just
one service now.

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

Open the **Settings** page in the app to configure:

- **Download quality** - output format (MP3/FLAC/Opus/AAC) and, for the
  lossy ones, encode quality. Applies to every download from then on;
  existing files aren't touched.
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
  top match in whatever format/quality is set in Settings, without needing
  any API key or quota. Tags (and cover art, where the format supports it)
  are embedded afterward with a direct `ffmpeg -metadata` pass rather than a
  format-specific tagging library, so MP3/FLAC/Opus/M4A are all tagged the
  same way.
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
  and isn't capped - though its playlist listing doesn't include real
  album/year data (SpotipyFree limitation), so the frontend looks that up
  per track (`GET /api/playlist/track/:id`) right before actually
  downloading it, rather than for the whole playlist upfront (each lookup
  takes ~2-5s - fine for one track at download time, would be several
  minutes for a large playlist just to display it). Cover art for those
  tracks then comes from the same MusicBrainz/Cover Art Archive lookup song
  search uses, once a real album name is known. Either way, each track goes
  through the exact same download pipeline as everything else - same
  query-building, tagging, duplicate detection, and retry logic.
- **Activity**: the backend keeps an in-memory log of every download attempt
  (title, artist, status, timing) exposed via `GET /api/activity`. It's
  intentionally not persisted to disk - a restart just starts a fresh log.
- **Library**: `GET /api/library` walks the save directory (now
  `Artist/Album/Track.<ext>`, not a flat folder) and reads each file's actual
  tags back out via `ffmpeg -i` (cached by path+modification time, so a
  re-scan only re-reads files that actually changed), so what you see always
  matches what's really on disk. Deleting (`DELETE /api/library/:relpath`,
  with the relative path URL-encoded by the frontend) resolves the path and
  checks it's still inside the save directory before touching anything, so
  it can't be tricked into deleting outside it - then prunes any
  album/artist folder left empty.

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
├── Dockerfile                   # builds the single freelisten image
├── supervisord.conf              # runs backend/ + playlist-backend/ as one container
├── docker-compose.yml
├── .env.example
├── frontend/
│   └── index.html              # Search / Activity / Library / Settings UI
├── backend/
│   ├── package.json
│   ├── server.js                # all API routes (see below)
│   ├── scripts/
│   │   └── setup-deno.js        # postinstall: fetches the Deno binary
│   └── bin/                     # created by setup-deno.js (gitignored)
└── playlist-backend/
    ├── requirements.txt
    └── app.py                   # GET /api/playlist (SpotipyFree)
```

### `backend/server.js` routes

| Method | Path                    | Purpose                                  |
| ------ | ----------------------- | ----------------------------------------- |
| GET    | `/api/settings`         | Read saved API keys                       |
| POST   | `/api/settings`         | Save API keys                             |
| GET    | `/api/playlist`         | Resolve a Spotify playlist to a track list |
| GET    | `/api/playlist/track/:id` | Real album/year for one playlist track  |
| POST   | `/api/download`         | Download + tag + save one track           |
| GET    | `/api/activity`         | Current queue + history                   |
| DELETE | `/api/activity`         | Clear finished entries from history        |
| GET    | `/api/library`          | List everything saved to disk             |
| DELETE | `/api/library/:relpath` | Delete one saved file                     |

## License

[MIT](LICENSE) - do what you like with it.
