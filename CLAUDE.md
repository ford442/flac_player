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
  → createAudioBackend(outputMode)  // default: streaming
  → streaming: loadFromURL(track.url) → HTMLAudioElement.src (range requests)
  → buffered backends: fetch(url) → arrayBuffer() → decode  ← 404s surface here
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

Five backends via `src/audio/createAudioBackend.ts`. See `docs/AUDIO_BACKENDS.md`.

**Streaming (default):**
```
track.url → HTMLAudioElement → MediaElementSource → AudioContextManager → speakers
(crossfade uses a second <audio> element; no full-file download)
```

**Buffered (web-audio, worklet, SDL):**
```
fetch(url) → ArrayBuffer → flacDecoder / audioDecoder → AudioBuffer or worklet ring
           → backend-specific nodes → AudioContextManager → speakers
```

No `<audio>` element for buffered modes. Streaming uses `<audio>` exclusively.

Worklet backend exposes `setPCMCallback()` for projectM PCM (`createProjectMPCMFeed` in `projectMBridge.ts`).

## Visualizer pipeline

```
AnalyserNode → VisualizerShell
  → ShaderGUI: WebGPU → WebGL2 → Canvas2D (rendererSelection.ts)
  → projectM: optional WASM host (?aesthetic=projectm|split)
```

## Debug logging

Off by default. Enable with `REACT_APP_DEBUG=true` in `.env` (webpack DefinePlugin).
Helper: `src/utils/debug.ts` — used by `audioLoader.ts` and `api/songApi.ts`.

## Key invariants to maintain

- `audioLoader.ts` line ~203: fallback URL is `${API_BASE_URL}/api/music/${item.id}`
  — this only fires when the backend sends a song with no URL (shouldn't happen normally)
- `loadFromURL()` only handles `http`, `https`, `gs://` schemes — don't pass relative paths
- The backend must always return absolute `https://` URLs in the `url` field
- Default output mode is `streaming` (`usePlayerState.ts`)

## WASM builds

```bash
npm run build:wasm:sdl3    # or bash src/sdl/build.sh
npm run build:wasm:sdl2    # or bash src/sdl/build_sdl2.sh
npm run build:projectm     # optional Milkdrop host
npm run verify:wasm        # CI artifact check
```

Production webpack (`npm run build`) copies prebuilt artifacts from `public/` — no emsdk required.

## Related docs

- `docs/ARCHITECTURE.md` — system diagram
- `docs/AUDIO_BACKENDS.md` — backend selection
- `docs/API.md` — REST + projectM embed
- `AGENTS.md` — full agent reference
