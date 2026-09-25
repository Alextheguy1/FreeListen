"""
Separate playlist backend using SpotipyFree (github.com/TzurSoffer/spotipyFree),
the same no-official-API approach spotDL itself defaults to. This exists
alongside the Node backend's /api/playlist (embed-page scraping, capped at
~50 tracks, or the official Web API if Spotify credentials are configured
there) as a third option: full playlists, no Spotify account or credentials
needed at all.

GET /api/playlist response shape matches the Node backend's /api/playlist,
so the frontend only needs to change which URL it calls - nothing else:
    { "name": str, "tracks": [{"id", "title", "artist", "album", "year", "trackNumber"}], "truncated": bool }
album/year are always null here (SpotipyFree's playlist listing doesn't
carry them) - GET /api/track/<id> below fills them in for one track at a
time, on demand.

Run:
    pip install -r requirements.txt
    python app.py
Listens on http://localhost:5058 by default (set PORT to change it).
"""

import os
import re
import traceback

from flask import Flask, jsonify, request
from flask_cors import CORS
from SpotipyFree import Spotify

app = Flask(__name__)
CORS(app)

PLAYLIST_ID_RE = re.compile(r"playlist[/:]([a-zA-Z0-9]+)")

_sp = None


def get_client():
    """Lazily created and reused across requests."""
    global _sp
    if _sp is None:
        _sp = Spotify()
    return _sp


def extract_track(item):
    """Adapts SpotipyFree's per-item shape (spotipy-compatible: {"track": {...}})
    to the flat {id, title, artist, album, year, trackNumber} shape the
    frontend expects. playlist_items() doesn't return real album data (its
    "album" is always {}) - the frontend fills album/year in later via
    GET /api/track/<id> below, only for tracks it actually downloads, since
    that lookup is too slow (~2-5s each) to do for a whole playlist upfront.
    Cover art isn't sourced from Spotify at all - the frontend looks it up
    on MusicBrainz/Cover Art Archive once it has a real album name."""
    track = item.get("track") if isinstance(item, dict) else None
    if not track or not track.get("name"):
        return None

    artists = track.get("artists") or []
    artist = ", ".join(a.get("name", "") for a in artists if a.get("name")) or "Unknown artist"
    track_number = track.get("track_number")

    return {
        "id": track.get("id"),
        "title": track["name"],
        "artist": artist,
        "album": None,
        "year": None,
        "trackNumber": track_number if isinstance(track_number, int) else None,
    }


def extract_full_track(t):
    """Shape returned by sp.track() (a single-track lookup) is different
    from playlist_items()'s per-item shape, but *does* have real album data."""
    if not t or not t.get("name"):
        return None
    album = t.get("album") or {}
    date = album.get("date") or {}
    year = None
    if isinstance(date, dict):
        year = date.get("year")
    elif isinstance(date, str):
        year = date[:4] or None
    return {
        "album": album.get("name"),
        "year": str(year) if year else None,
    }


@app.route("/api/playlist")
def get_playlist():
    url = request.args.get("url", "")
    match = PLAYLIST_ID_RE.search(url)
    if not match:
        return jsonify({"error": "That doesn't look like a Spotify playlist link"}), 400
    playlist_id = match.group(1)

    try:
        sp = get_client()
        raw = sp.playlist_items(playlist_id)

        # SpotipyFree mirrors spotipy's response shape: a paging object with
        # "items", plus "next" when there's another page to follow.
        items = list(raw.get("items", []))
        next_page = raw.get("next")
        while next_page:
            page = sp.next(raw) if hasattr(sp, "next") else None
            if not page:
                break
            items.extend(page.get("items", []))
            next_page = page.get("next")
            raw = page

        tracks = [t for t in (extract_track(item) for item in items) if t]

        playlist_meta = sp.playlist(playlist_id) if hasattr(sp, "playlist") else {}
        name = (playlist_meta or {}).get("name", "Playlist")

        return jsonify({"name": name, "tracks": tracks, "truncated": False})
    except Exception as exc:  # noqa: BLE001 - surface whatever SpotipyFree raises
        traceback.print_exc()
        return jsonify({"error": str(exc) or "Playlist fetch failed"}), 500


@app.route("/api/track/<track_id>")
def get_track(track_id):
    """Real album/year for one track, on demand - only called for tracks
    that are actually being downloaded, since this lookup takes ~2-5s."""
    try:
        sp = get_client()
        full = extract_full_track(sp.track(track_id))
        if not full:
            return jsonify({"error": "Track not found"}), 404
        return jsonify(full)
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        return jsonify({"error": str(exc) or "Track lookup failed"}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5058))
    # 0.0.0.0 (not 127.0.0.1) so the Node container can reach this one over
    # the Docker network; for local (non-Docker) use it's still only reachable
    # from this machine unless you've explicitly opened the port up.
    # threaded=True: without it, Flask's dev server handles one request at a
    # time, so a second person loading a playlist would just hang until the
    # first one's multi-page Spotify fetch finished.
    app.run(host="0.0.0.0", port=port, threaded=True)
