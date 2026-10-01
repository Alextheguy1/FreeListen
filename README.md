# FreeListen

A self-hosted web app that searches the [MusicBrainz](https://musicbrainz.org)
database for songs, albums, and artists, or loads a public Spotify playlist,
then downloads tagged audio files to a directory you choose. Play counts come
from [ListenBrainz](https://listenbrainz.org) and cover art from the
[Cover Art Archive](https://coverartarchive.org). Search, the download queue,
and the library view are all one web UI.

![license](https://img.shields.io/badge/license-MIT-green)

## Pages

Four pages, reachable from the sidebar: **Search**, **Activity** (live download
queue and history), **Library** (everything saved to disk, with delete), and
**Settings**.

## Features

- Search **Songs**, **Albums**, or **Artists**, sorted by popularity or
  relevance. Narrow a search with `artist:name` syntax.
- A **Playlists** tab: paste a public Spotify playlist link to list its tracks,
  with per-track or "download all" buttons.
- Per-song **Download**: finds a lyrics-video version of the track, which
  avoids the sound effects, crowd noise, and intros that come with official
  music videos, downloads it, and tags it with title, artist, album, year,
  genre, track number, and embedded cover art where available.
- Configurable **download quality**: pick the output format (MP3, FLAC, Opus,
  or AAC/M4A) and, for the lossy formats, the encode quality. It is a global
  setting applied to every download rather than decided for you. Every format
  gets full metadata tags. Only Opus cannot carry embedded cover art, which is
  a limitation of the format itself and not of this app.
- Per-album **Download album**: grabs the album's whole track listing in order,
  numbered and tagged. Albums exist in MusicBrainz as dozens of editions that
  disagree, since reissues add bonus tracks and box sets bundle discs, so it
  uses the track listing the most official editions agree on rather than
  whichever edition came back first.
- Per-artist **Download top N tracks**: downloads an artist's N most popular
  tracks by ListenBrainz play count, skipping remaster, live, and concert
  versions along with near-duplicate titles. N is adjustable in the UI, with no
  upper limit.
- Playlist **Download all**: downloads every track in a loaded playlist the
  same way, tagged with the metadata Spotify has for each track.
- Singles vs album tracks: downloading one track saves it as a standalone
  single (`Artist/Title.<ext>`, no album tag) by default, so music servers list
  it as a song you can find by name instead of nesting it inside a one-track
  album. Downloading a whole album always uses album folders. Switchable in
  Settings if you would rather everything were filed by album.
- Library layout: saves into `Artist/Album/NN - Title.<ext>`, or
  `Artist/Title.<ext>` when no album is known, rather than one flat folder.
  Point Navidrome, Jellyfin, or any other Subsonic-style app at the same
  directory and it will organize correctly.
- **Activity page**: the live download queue, showing what is downloading now
  and everything waiting behind it in the order it will be worked through.
  Pressing download queues a track and returns immediately instead of making
  you wait, so queuing a 50-track album takes seconds.
- **Toast notifications**: each download reports back in the bottom-left corner
  when it finishes, including *why* it failed, since downloads run in the
  background and you may well be on another page by then.
- **Library page**: a cover-art grid of what is saved, grouped into albums,
  with the artwork pulled back out of the files themselves. Click an album to
  see its tracks and delete them individually. Deleting also prunes any album
  or artist folder left empty behind it.
- Duplicate detection: re-downloading a track you already have is a no-op,
  matched by sanitized title within that track's artist/album folder, so batch
  downloads are safe to re-run.
- Automatic retry with backoff on the transient failures YouTube downloads
  occasionally hit.
- Settings page for API keys and download quality. Nothing is hardcoded in
  source.

## Architecture

Two pieces of code, packaged as one Docker image:

- **`frontend/`**: a static page, no build step, no framework. Served by
  `backend/`, so running the app means visiting one URL. It can also be opened
  directly as a local file for manual, non-Docker use.
- **`backend/`**: a Node/Express server. Resolves a search query to a YouTube
  video with [yt-dlp](https://github.com/yt-dlp/yt-dlp), downloads and converts
  the audio, tags it, and saves it to disk. It also serves the frontend, tracks
  download activity, lists and deletes library files, and holds saved settings.
- **`playlist-backend/`**: a small Python service using
  [SpotipyFree](https://github.com/TzurSoffer/spotipyFree) to read full Spotify
  playlists without a Spotify account or API credentials. `backend/` proxies
  playlist requests to it when available, falling back to its own
  credential-optional logic, capped near 50 tracks, otherwise.

In Docker, both run inside the same container as two processes managed by
`supervisord` (see `Dockerfile` and `supervisord.conf`), talking to each other
over `localhost`. Apps like Lidarr use the same single-image approach for their
own internal services, so this deploys as one app instead of two. For local
development they are still two separate things you can run independently; see
Option B below.

## Option A: Docker

A prebuilt image is published to GitHub Container Registry on every change (see
`.github/workflows/docker-publish.yml`), the same way Sonarr and Radarr ship.
No source code, no local build, and no git needed to run it.

```bash
mkdir freelisten && cd freelisten
curl -O https://raw.githubusercontent.com/alextheguy1/FreeListen/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/alextheguy1/FreeListen/main/.env.example
cp .env.example .env
# edit .env: at minimum set MUSIC_DIR_HOST to where you want downloads to land
docker compose pull
docker compose up -d
```

Then visit `http://<the-host's-address>:5051`. That is the whole app: one
image, one container, with playlists working on a fresh install at no cap and
with no credentials. On TrueNAS, `MUSIC_DIR_HOST` in `.env` should point at a
dataset path such as `/mnt/tank/Music`, the same way Sonarr and Radarr let you
map a media directory instead of hardcoding one. Nothing about the save
location is baked into the image.

**Updating** is the same as any other Docker app from here on, with no git
clone needed:

```bash
docker compose pull && docker compose up -d
```

### Deploying to TrueNAS SCALE specifically

Since it is a published image, it fits TrueNAS's "Custom App" wizard like any
other app in the Apps catalog. No SSH, no build:

1. **Apps → Discover Apps → Custom App**.
2. Image repository: `ghcr.io/alextheguy1/freelisten`, tag: `latest`.
3. Storage: map a host path to container path `/music`, and another to
   `/config`.
4. Networking: publish container port `5051` to whatever host port you want.
5. Deploy. Updating later uses whatever "check for updates" action TrueNAS's
   Apps UI gives that image, the same as your other apps.

If you would rather use `docker compose` over SSH than the UI, that works too,
with the same commands as Option A above.

### Building it yourself instead

If you would rather not depend on the published image, or want to test a change
before it is merged, clone the repo and build locally. `docker compose build`
uses the same `Dockerfile` the GitHub Action does:

```bash
git clone https://github.com/alextheguy1/FreeListen.git
cd FreeListen
cp .env.example .env
docker compose build
docker compose up -d
```

## Option B: Run it without Docker

```bash
cd backend
npm install
npm start
```

`npm install` also runs a `postinstall` script
(`backend/scripts/setup-deno.js`) that downloads a portable copy of
[Deno](https://deno.com) into `backend/bin/`. This is required: YouTube now
requires running a bit of JS to decrypt some video formats' URLs, and yt-dlp
only supports Deno for that. If the automatic download fails, on an unsupported
platform for instance, the script prints a warning with manual instructions.

This also serves the frontend, so visit `http://localhost:5051`. Downloaded
files land in `~/Downloads/Music` unless `MUSIC_DIR` is set.

Playlists work immediately too, but are capped near 50 tracks, the limit of
Spotify's public embed page, unless you also run `playlist-backend`:

```bash
cd playlist-backend
python -m venv venv && source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r requirements.txt
python app.py
```

Then set `PLAYLIST_BACKEND_URL=http://localhost:5058` before starting
`backend/`, or add Spotify credentials in Settings instead.

## Settings

Open the **Settings** page in the app to configure:

- **Download quality**: output format (MP3, FLAC, Opus, or AAC/M4A) and, for
  the lossy ones, encode quality. It applies to every download from then on;
  existing files are not touched.
- **Single track downloads**: whether a one-off track is saved as a standalone
  single or filed into an album folder. Album downloads ignore this and always
  use album folders.
- **ListenBrainz token**: makes the artist "Download top N tracks" button
  reliable. ListenBrainz gates that endpoint against scrapers and can
  intermittently reject unauthenticated requests. Get a free one from your
  account at **listenbrainz.org/settings/**.
- **Spotify Client ID and Secret**: only relevant if you are *not* running
  `playlist-backend` and want to lift the 50-track cap on the fallback
  embed-page method. Get these free at
  [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).
  The Client Credentials flow is read-only and never tied to a user account.

These save to `backend/settings.json`, or the `/config` volume in Docker, via
`POST /api/settings`. Nothing needs to be hardcoded or edited in source files.

## How it works

- **Search**: the page queries MusicBrainz's public search API directly from
  the browser, rate-limited client-side to one request per second per
  MusicBrainz's usage policy, and layers ListenBrainz play counts on top.
- **Download**: the page never talks to YouTube directly. It sends the backend
  a search string like `"<artist> <title> lyrics"`; the backend hands that to
  yt-dlp's `ytsearch1:` pseudo-URL, which resolves and downloads the top match
  in whatever format and quality is set in Settings, without needing an API key
  or quota. Tags, and cover art where the format supports it, are embedded
  afterward with a direct `ffmpeg -metadata` pass rather than a format-specific
  tagging library, so MP3, FLAC, Opus, and M4A are all tagged the same way.
- **Artist top tracks**: sourced from ListenBrainz's `top-recordings-for-artist`
  endpoint, which returns an artist's recordings already ranked by play count.
  The alternative is sampling MusicBrainz's catalog browse endpoint, which
  returns results in roughly alphabetical order rather than by popularity.
- **Playlists**: without credentials, the backend fetches Spotify's public
  embed page for the playlist and parses the track list out of its embedded
  JSON, which caps at about 50 tracks because that route offers no pagination.
  With Spotify credentials saved in Settings, it instead exchanges them for a
  short-lived app access token, cached until it expires, and paginates through
  the official Web API. If `playlist-backend` is configured, the default in
  Docker, that is tried first, since it needs no credentials and is not capped.
  Its playlist listing does not include real album or year data, a SpotipyFree
  limitation, so the frontend looks that up per track
  (`GET /api/playlist/track/:id`) right before downloading rather than for the
  whole playlist upfront. Each lookup takes 2 to 5 seconds, which is fine for
  one track at download time and would be several minutes for a large playlist
  just to display it. Cover art for those tracks then comes from the same
  MusicBrainz and Cover Art Archive lookup that song search uses, once a real
  album name is known. Either way, each track goes through the same download
  pipeline as everything else: same query-building, tagging, duplicate
  detection, and retry logic.
- **The queue**: `POST /api/download` downloads nothing itself. It validates,
  adds the track to an in-memory queue, and returns. A worker drains that queue
  one track at a time, since yt-dlp plus ffmpeg is heavy and firing a burst at
  YouTube is the quickest way to get throttled, retrying each track once before
  marking it failed. Progress is exposed through `GET /api/activity`, which the
  page polls for both the queue table and the toasts. None of it is persisted;
  a restart drops the queue and starts a fresh log.
- **Library**: `GET /api/library` walks the save directory and reads each
  file's tags back out via `ffmpeg -i`, cached by path and modification time so
  a re-scan only re-reads changed files. What you see matches what is on disk.
  Deleting (`DELETE /api/library/:relpath`, with the relative path URL-encoded
  by the frontend) resolves the path and checks it is still inside the save
  directory before touching anything, so it cannot be tricked into deleting
  outside it, then prunes any album or artist folder left empty.

## Known limitations

- YouTube downloads occasionally fail transiently, from a bad format pick or a
  momentary throttle. Both download paths retry once automatically; a failure
  that survives the retry is logged and skipped rather than blocking the rest
  of a batch.
- Downloading audio from YouTube sits in a legal grey area under YouTube's
  Terms of Service, even though yt-dlp itself is a legitimate open-source tool.
  This is intended for personal use.
- The Activity log is in-memory only and resets on restart.
- The app has no auth of its own. It is meant for your own local network, not
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
├── .github/
│   └── workflows/
│       └── docker-publish.yml   # builds + pushes to ghcr.io on every push
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
| POST   | `/api/download`         | Queue one track for download              |
| GET    | `/api/activity`         | Queue state + recent outcomes             |
| DELETE | `/api/activity`         | Clear finished entries (keeps the queue)   |
| GET    | `/api/library`          | List everything saved to disk             |
| GET    | `/api/library/art/:relpath` | Cover art embedded in one saved file |
| DELETE | `/api/library/:relpath` | Delete one saved file                     |

## License

[MIT](LICENSE). Do what you like with it.
