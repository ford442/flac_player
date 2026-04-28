# flac_player — Agent Guide

## Backend: storage.noahcohn.com

The API backend is **storage.noahcohn.com** (not a local server).
`REACT_APP_API_URL=https://storage.noahcohn.com` in `.env` and `.env.production`.

Songs come from `GET /api/songs` on that host. Audio files are served as static files
from `https://storage.noahcohn.com/files/audio/music/{filename}`.

## How songs load (audioLoader.ts)

```
fetchLibrary()
  → GET https://storage.noahcohn.com/api/songs
  → each item.url is already an absolute https:// URL (set by the backend)
  → if somehow not absolute, prepend API_BASE_URL

playTrack(track)
  → loader.loadFromURL(track.url)
  → fetch(url) → arrayBuffer()  ← this is where 404s surface
```

`track.url` is always set by the backend. If you see a 404:
1. Open Network tab — note the exact URL that 404s
2. `GET https://storage.noahcohn.com/api/songs/debug` — shows each song's resolved URL
   and whether the file exists on disk

## API_BASE_URL usage

`API_BASE_URL` is used for:
- `GET /api/songs` (library fetch)
- `GET /api/songs/tags`
- `POST /api/songs/{id}/play`
- Fallback audio proxy: `/api/music/{id}` (only when song has no filename)

Do **not** change `API_BASE_URL` without also updating the backend CORS origins list
in `contabo_storage_manager/packages/python-bridge/app/config.py`.

## Audio pipeline

```
fetch(url) → ArrayBuffer → flacDecoder.ts (libflac WASM) → AudioBuffer
           → AudioWorklet or Web Audio API → speakers
```

No `<audio>` element is used. The full file is loaded into memory before playback starts.
Range requests (byte-range fetches) are NOT used during load — but nginx must still
serve `Accept-Ranges` so browser preflight checks pass.

## Key invariants to maintain

- `audioLoader.ts` line ~203: fallback URL is `${API_BASE_URL}/api/music/${item.id}`
  — this only fires when the backend sends a song with no URL (shouldn't happen normally)
- `loadFromURL()` only handles `http`, `https`, `gs://` schemes — don't pass relative paths
- The backend must always return absolute `https://` URLs in the `url` field
