# FreeListen

[FreeListen](https://github.com/Alextheguy1/FreeListen) searches the
[MusicBrainz](https://musicbrainz.org) database - or a public Spotify playlist -
and saves tagged audio files to a directory you choose.

Downloads are tagged with title, artist, album, year, genre and track number,
with cover art embedded where the format supports it, and are filed as
`Artist/Album/NN - Title` so music servers such as Navidrome or Jellyfin pick
them up without any extra work. Point FreeListen's music storage at the same
directory your music server reads and new downloads simply appear there.

Output format is configurable (MP3, FLAC, Opus or AAC) along with encode
quality, and downloads run through a queue you can watch while it works.

## Configuration

Everything else - Spotify credentials, a ListenBrainz token, audio format and
quality - is set from the app's own Settings page once it's running, and stored
in the config storage you configure here. None of it is required to search and
download.

## Storage

- **Music storage** - where downloaded audio is saved.
- **Config storage** - the app's `settings.json`. Small, but keep it on
  persistent storage so your settings survive updates.

## Note

FreeListen downloads audio from YouTube. That sits in a grey area under
YouTube's Terms of Service, and this app is intended for personal use.
