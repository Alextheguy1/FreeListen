"""
Separate playlist backend using SpotipyFree (github.com/TzurSoffer/spotipyFree),
the same no-official-API approach spotDL itself defaults to. This exists
alongside the Node backend's /api/playlist (embed-page scraping, capped at
~50 tracks, or the official Web API if Spotify credentials are configured
there) as a third option: full playlists, no Spotify account or credentials
needed at all.

Response shape matches the Node backend's /api/playlist exactly, so the
frontend only needs to change which URL it calls - nothing else:
    { "name": str, "tracks": [{"title", "artist", "album", "year"}], "truncated": bool }

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
    to the flat {title, artist, album, year} shape the frontend expects."""
    track = item.get("track") if isinstance(item, dict) else None
    if not track or not track.get("name"):
        return None

    artists = track.get("artists") or []
    artist = ", ".join(a.get("name", "") for a in artists if a.get("name")) or "Unknown artist"

    album = track.get("album") or {}
    release_date = album.get("release_date") or ""

    return {
        "title": track["name"],
        "artist": artist,
        "album": album.get("name"),
        "year": release_date[:4] if release_date else None,
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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5058))
    # 0.0.0.0 (not 127.0.0.1) so the Node container can reach this one over
    # the Docker network; for local (non-Docker) use it's still only reachable
    # from this machine unless you've explicitly opened the port up.
    app.run(host="0.0.0.0", port=port)
