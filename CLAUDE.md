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

Four backends via `src/audio/createAudioBackend.ts`. See `docs/AUDIO_BACKENDS.md`.

**Streaming (default):**
```
track.url → HTMLAudioElement → MediaElementSource → AudioContextManager → speakers
(crossfade uses a second <audio> element; no full-file download)
```

Every backend's speaker DSP (ReplayGain → limiter → volume → EQ) is the `dsp-chain`
AudioWorklet running `src/sdl/dsp_chain.h` as WASM (`public/dsp-chain.wasm`), one instance per
context. `EQChain` / `ReplayGainNode` are the fallback when it fails to load (`?dsp=webaudio`
forces the fallback). Keep `DEFAULT_EQ_BANDS` the single band layout; never reimplement the RBJ
EQ in TS.

**Analysis ring (shared post-DSP PCM tap):** the dsp-chain worklet (`dspChainProcessor.js`) writes
an 8 × u32 header + data into a SharedArrayBuffer; `src/audio/analysisRing.ts` reads it
(`getAnalysisTap()`). Keep the two in sync; the layout must not change. Writers only memcpy —
FFT / analysis runs on reader threads (`src/sdl/dsp_fft.h` via `src/audio/wasmFft.ts`, or
gpu-chores WebGPU), never in an audio callback.

**Buffered (web-audio, worklet, SDL):**
```
fetch(url) → ArrayBuffer → flacDecoder / audioDecoder → AudioBuffer or worklet ring
           → backend-specific nodes → AudioContextManager → speakers
```

No `<audio>` element for buffered modes. Streaming uses `<audio>` exclusively.

**SDL mode (`sdl`, labelled "WASM engine"; links no SDL since #268):**
```
audio_engine.cpp (main-thread exports: PCM + transport words, engine_state.h / play_ring.h)
  → module's shared memory → `sdl-engine` AudioWorkletProcessor (sdlEngineProcessor.js)
  → AudioContextManager.connectInput → dsp-chain → analyser → speakers
```
- The processor reads whole frames on the audio thread; JS only advances `writePos`, the
  processor only `readPos` and its progress words. Changes go through the epoch protocol in
  `engine_state.h`; word indices are mirrored in `sdlEngineMessages.ts` and the processor
  (`tests/sdlEngineProcessor.test.ts` checks them against the static_asserts).
- One node per load, owner id set first (`_set_output_owner`); a graph recreate calls `_rebase()`
  and attaches a new node.
- Worklet `.js` processors stay classic `@ts-check` scripts with a sibling `*Messages.ts`; do not
  bundle them into the React chunk.
- No main-thread audio: no ScriptProcessor anywhere. A backend that cannot start a worklet reports
  `getCapabilities().playable === false` and `PlaybackEngine` rejects loads before fetching.

Worklet backend exposes `setPCMCallback()` for projectM PCM (`createProjectMPCMFeed` in `projectMBridge.ts`).

## Transport (PlaybackEngine)

`src/audio/PlaybackEngine.ts` is the one transport: backend lifecycle, `load()` (generation counter —
stale loads return `'superseded'`), play/pause/seek/stop, the clock, gapless `preloadNext` forwarding,
throttled `flac_position` saves (`src/audio/playbackPosition.ts`). `usePlaybackController` maps the queue onto it.

- Read transport state with `usePlaybackStatus` (no position). Only leaves that show time use
  `usePlaybackTime` / `usePlaybackTimeRef` (`src/hooks/usePlaybackEngine.ts`) — do not put `currentTime` back
  into Player state or props (`tests/playerRenders.test.ts` guards this).
- `StreamingAudioPlayer.loadFromURL` halts every path before starting one; a graph recreate retires the
  `<audio>` element (an element binds to one `MediaElementAudioSourceNode` forever) and reattaches the URL on a new one.

## Visualizer pipeline

```
AnalyserNode → VisualizerShell
  → ShaderGUI: WebGPU → WebGL2 → Canvas2D (rendererSelection.ts)
  → projectM: optional WASM host (?aesthetic=projectm|split)
```

## Listening rooms (#209)

```
Player.tsx → useListeningRoomBridge (next to usePlaybackController) → useListeningRoom
  host:  HostPublisher.observe(SyncClock) → WS → rooms.py → guests
  guest: GuestSync.reconcile → playTrack({autoplay:false}) / play / seek / nudge rate
```

- Join links are `?room={id}` (relative asset paths break deep `/room/{id}` reloads); host token in sessionStorage only
- Rooms lock the backend to `streaming` and force its native `<audio>` path (`setNativeOnly`, `getSyncClock`)
- Server: `rooms.py` router mounted in `app.py` (in-memory → one uvicorn worker); production bridge port pending
- Details: `docs/LISTENING_ROOMS.md`

## Debug logging

Off by default. Enable with `REACT_APP_DEBUG=true` in `.env` (webpack DefinePlugin).
Helper: `src/utils/debug.ts` — used by `audioLoader.ts` and `api/songApi.ts`.

## Key invariants to maintain

- `audioLoader.ts` line ~203: fallback URL is `${API_BASE_URL}/api/music/${item.id}`
  — this only fires when the backend sends a song with no URL (shouldn't happen normally)
- `loadFromURL()` only handles `http`, `https`, `gs://` schemes — don't pass relative paths
- The backend must always return absolute `https://` URLs in the `url` field
- Default output mode is `streaming` (`usePlayerState.ts`)
- The shared `AudioContext`'s run state belongs to `AudioContextManager`: use `whenRunning()`, never `context.suspend()`
  (refused; the context is shared with every backend and the visualizer tap). Never leave a `DynamicsCompressorNode`
  in the speaker chain while the limiter is off (spec clamps it to 2 channels)
- Files copied into the build root (`*.wasm`, glue scripts, icons, `service-worker.js`) are located with `publicUrl()`
  (`src/utils/publicUrl.ts`), not `'/name'` literals, so a sub-path deploy finds them

## WASM builds

```bash
npm run build:wasm:sdl3    # engine → public/sdl-audio.* (or bash src/sdl/build.sh)
npm run build:wasm:resampler  # SpeexDSP HQ resampler (worklet rate mismatch)
npm run build:wasm:dsp     # dsp_chain.h + dsp_fft.h → public/dsp-chain.wasm (EQ/ReplayGain worklet, fft_spectrum)
npm run build:projectm     # optional Milkdrop host
npm run verify:wasm        # CI artifact check
```

Emscripten is pinned in `scripts/emsdk-version` (6.0.11); the build scripts refuse any other `emcc`
and every source hash covers the pin. Per-graph flags and heap caps: `docs/WASM_TOOLCHAIN.md`.

Production webpack (`npm run build`) copies prebuilt artifacts from `public/` — no emsdk required.
Host-clang tests for the engine headers: `npm run test:native` (CMake, `-Wall -Wextra -Werror`;
writes `.build/native/compile_commands.json` for clangd).

## Related docs

- `docs/ARCHITECTURE.md` — system diagram
- `docs/AUDIO_BACKENDS.md` — backend selection
- `docs/API.md` — REST + projectM embed
- `docs/LISTENING_ROOMS.md` — synced listening rooms
- `docs/WASM_TOOLCHAIN.md` — emsdk pin, compile commands, heap caps
- `AGENTS.md` — full agent reference
