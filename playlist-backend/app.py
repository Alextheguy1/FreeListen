"""
Playlist backend built on SpotipyFree (github.com/TzurSoffer/spotipyFree),
which reads full playlists with no Spotify account or credentials. The Node
backend's own /api/playlist is the fallback: embed-page scraping capped near
50 tracks, or the official Web API when credentials are configured there.

GET /api/playlist returns the same shape as the Node backend's, so the
frontend only changes which URL it calls:
    { "name": str, "tracks": [{"id", "title", "artist", "album", "year", "trackNumber"}], "truncated": bool }
album and year are always null, since SpotipyFree's playlist listing does not
carry them. GET /api/track/<id> below fills them in one track at a time.

Run:
    pip install -r requirements.txt
    python app.py
Listens on http://localhost:5058 unless PORT is set.
"""

import os
import re
import traceback

from flask import Flask, jsonify, request
from SpotipyFree import Spotify

app = Flask(__name__)

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
    to the flat {id, title, artist, album, year, trackNumber} the frontend
    expects. playlist_items() returns an empty "album", so the frontend fills
    album and year in later via GET /api/track/<id>, only for tracks it
    downloads; that lookup takes 2 to 5 seconds each, too slow for a whole
    playlist upfront. Cover art comes from MusicBrainz and the Cover Art
    Archive once a real album name is known, never from Spotify."""
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
    """sp.track() returns a different shape from playlist_items(), and this
    one carries real album data."""
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

        # SpotipyFree mirrors spotipy's paging shape.
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
    """Real album and year for one track. Called only for tracks being
    downloaded, since the lookup takes 2 to 5 seconds."""
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
    # Loopback only. The Node backend shares this container's network
    # namespace, so it reaches us over localhost either way, and binding
    # 0.0.0.0 would put this unauthenticated service straight on the host
    # whenever someone enables host networking.
    host = os.environ.get("HOST", "127.0.0.1")
    # threaded=True: Flask's dev server is otherwise serial, so a second
    # playlist load blocks until the first multi-page fetch finishes.
    app.run(host=host, port=port, threaded=True)
