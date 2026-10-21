# flac_player — Agent Guide

## Backend: storage.noahcohn.com

The API backend is **storage.noahcohn.com** (not a local server).
`REACT_APP_API_URL=https://storage.noahcohn.com` in `.env` and `.env.production`.
webpack loads `.env.<mode>` then `.env` (shell variables win). The dev server's
`/api → localhost:7860` proxy only matters with `REACT_APP_API_URL=` empty, i.e. when
running the optional local backend in `server/` (see `server/README.md`).

Songs come from `GET /api/songs` on that host. Audio files are served as static files
from `https://storage.noahcohn.com/files/audio/music/{filename}`.

## How songs load (api/songApi.ts → api/http.ts)

```
useLibraryCatalog(filters)            // api/library.ts, TanStack Query keyed on filters
  → fetchSongs() → apiFetch('/api/songs?…', SongListSchema)   // status check + valibot
  → each item.url is already an absolute https:// URL (set by the backend)
  → resolveTrackUrl(url, id): the only resolver; relative → API_BASE_URL + path

engine.load(track)                    // player/PlaybackEngine.ts
  → backend from createAudioBackend(outputMode), built once per output mode
  → streaming: loadFromURL(track.url) → HTMLAudioElement.src (range requests)
  → buffered backends: fetchTrackBytes(url) → arrayBuffer() → decode  ← 404s surface here
```

`track.url` is always set by the backend. If you see a 404:
1. Open Network tab — note the exact URL that 404s
2. `GET https://storage.noahcohn.com/api/songs/debug` — shows each song's resolved URL
   and whether the file exists on disk

## API_BASE_URL usage

Defined once in `src/api/http.ts`. Catalog requests go through `apiFetch(path, schema, {signal})`.
`API_BASE_URL` is used for:
- `GET /api/songs` (library fetch)
- `GET /api/songs/tags`
- `POST /api/songs/{id}/play`
- Fallback audio proxy: `/api/music/{id}` (only when song has no filename)

Do **not** change `API_BASE_URL` without also updating the backend CORS origins list
in `contabo_storage_manager/packages/python-bridge/app/config.py`.

## Audio pipeline

Four backends via `src/audio/createAudioBackend.ts`. See `docs/AUDIO_BACKENDS.md`.

**Streaming (default):**
```
track.url → HTMLAudioElement → MediaElementSource → AudioContextManager → speakers
(crossfade uses a second <audio> element; no full-file download)
```

Streaming / web-audio / worklet speaker DSP (ReplayGain → limiter → volume → EQ) is the
`dsp-chain` AudioWorklet running `src/sdl/dsp_chain.h` as WASM — the same code SDL runs in
its callback. `EQChain` / `ReplayGainNode` are the fallback when it fails to load
(`?dsp=webaudio` forces the fallback). Keep `DEFAULT_EQ_BANDS` the single band layout.

**Analysis ring (shared post-DSP PCM tap):** SDL's callback (`src/sdl/analysis_ring.h`) and the
dsp-chain worklet (`dspChainProcessor.js`) write the same 8 × u32 header + data layout into a
SharedArrayBuffer; `src/audio/analysisRing.ts` reads it (`getAnalysisTap()`). Keep the three in
sync. Writers only memcpy — FFT / analysis runs on reader threads (`src/sdl/dsp_fft.h` via
`src/audio/wasmFft.ts`, or gpu-chores WebGPU), never in an audio callback.

**Context lifecycle (#259):** one shared `AudioContext` at the device rate for the session
(decision record in `docs/AUDIO_BACKENDS.md`; `?ctxrate=native` restores per-file-rate rebuilds).
The engine calls `unlock()` synchronously from user play commands and reports
`setPlaybackActive(playing|loading)`; the manager resumes on gesture / visibility / `statechange`
(incl. iOS `interrupted`) and suspends after 10 s idle. Never open throwaway contexts.

**Buffered (web-audio, worklet, SDL):**
```
fetch(url) → ArrayBuffer → audio/flacDecoder / audio/audioDecoder → AudioBuffer or worklet ring
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

- One `GPUDevice` per session from `GpuDeviceService` (`visuals/webgpu/deviceService.ts`), lent to the
  visualizer and gpu-chores; analyser changes go through `setAnalyser()`, never a re-init.
- WebGL2 survives `webglcontextlost`/`restored`. projectM: `ProjectMEngine` owns one canvas + main loop
  (SDL-free `emscripten_webgl_create_context` host); presets come from `public/projectm/presets.json`
  at runtime (`?preset=`).

## Playback engine (#258)

```
React views ─ selectors (useTransport / useQueue / useClock …) ─┐
            └ useActions() → usePlayerActions (room-aware) ──┐   │
                                                            ▼   │
PlaybackEngine (player/PlaybackEngine.ts) ── writes ──► player store (zustand, playerStore.ts)
  owns: backend (one per output mode), queue cursor, load token + AbortController,
        transport state machine (transport.ts), honest clock (clock.now())
```

- One active audio path; every load gets a token and stale results are dropped; backend loads are serialized
- Graph rebuild → engine reloads the current track at `clock.now()` and keeps playing
- `'ended'` counts only from the current backend for the current load
- Only the scrubber / time readouts / MediaSessionBridge subscribe to `useClock()` (≤4 Hz); `Player` never does.
  rAF code (ShaderGUI) reads `engine.clock.now()` directly
- Persistence (`player/persistence.ts`): position every 5 s + `pagehide` from the clock, queue/volume on change
- Errors → store toasts (`PlayerToasts`) + top-level `ErrorBoundary` (`src/index.tsx`)
- Engine unit tests use `tests/helpers/fakeEngine.ts` (fake backend + clock)

## Listening rooms (#209)

```
Player.tsx → useListeningRoomBridge({ engine, store }) → useListeningRoom
  host:  HostPublisher.observe(SyncClock) → WS → server/rooms.py → guests
  guest: GuestSync.reconcile → engine.load({autoplay:false}) / play / seek / nudgeRate
```

- Join links are `?room={id}` (relative asset paths break deep `/room/{id}` reloads); host token in sessionStorage only
- Rooms lock the backend to `streaming` and force its native `<audio>` path (`setNativeOnly`, `getSyncClock`)
- Server: `server/rooms.py` router mounted in `server/app.py` (in-memory → one uvicorn worker); production bridge port pending
- Details: `docs/LISTENING_ROOMS.md`

## Debug logging

Off by default. Enable with `REACT_APP_DEBUG=true` in `.env` (webpack DefinePlugin).
Helper: `src/utils/debug.ts` — used by `api/http.ts` and `api/songApi.ts`.

## Key invariants to maintain

- `resolveTrackUrl()` (`api/http.ts`): fallback URL is `${API_BASE_URL}/api/music/${encodeURIComponent(id)}`
  — this only fires when the backend sends a song with no URL (shouldn't happen normally)
- `loadFromURL()` only handles `http`, `https`, `gs://` schemes — don't pass relative paths
- The backend must always return absolute `https://` URLs in the `url` field
- Default output mode is `streaming` (`player/playerStore.ts`)
- Only `source: 'library'` tracks reach library endpoints, share links, playlists and rooms
  (`isLibraryTrack()`, `types/track.ts`); ids in paths are `encodeURIComponent`-ed

## Deployment base path

Root-hosted by default. For a subpath (e.g. `https://host/flac-player/`) build with
`PUBLIC_PATH=/flac-player/ npm run build`. It feeds webpack `publicPath`, the HTML
template, the SW precache/scope, and runtime asset URLs (`src/utils/publicPath.ts`).
Server rewrites must serve `<base>/service-worker.js` as JS, not the SPA fallback.

## WASM builds

```bash
npm run build:wasm:sdl3    # or bash src/sdl/build.sh
npm run build:wasm:resampler  # SpeexDSP HQ resampler (worklet rate mismatch)
npm run build:wasm:dsp     # dsp_chain.h + dsp_fft.h → public/dsp-chain.wasm (EQ/ReplayGain worklet, fft_spectrum)
npm run build:projectm     # optional Milkdrop host
npm run verify:wasm        # CI artifact check
```

All four are built with the emsdk in `scripts/emsdk-version` (the build refuses any other
emcc; if `$EMSDK` points at another release, `export EMSDK=$PWD/emsdk`). SDL3 and
`dsp-chain` both compile `src/sdl/dsp_chain.h` — rebuild both when it changes. Never merge
`public/*.wasm` or `*.sha256` textually; rebuild them.

Production webpack (`npm run build`) copies prebuilt artifacts from `public/` — no emsdk required.

## Related docs

- `docs/ARCHITECTURE.md` — system diagram
- `docs/AUDIO_BACKENDS.md` — backend selection
- `docs/API.md` — REST + projectM embed
- `docs/LISTENING_ROOMS.md` — synced listening rooms
- `AGENTS.md` — full agent reference
