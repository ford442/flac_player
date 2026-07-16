# Audio Backends Guide

Choose the output mode in the player UI or via persisted `localStorage` (`flac_player_output_mode`). Default: **`streaming`**.

Factory entry point: `src/audio/createAudioBackend.ts`.

## Quick decision tree

```
Need instant playback on large remote FLAC files?
  └─ YES → streaming (default)

Need projectM PCM tap at audio-clock rate (~86 blocks/s)?
  └─ YES → worklet

Need full in-memory buffer + simplest Web Audio graph?
  └─ YES → web-audio

Experimenting with C++ SDL WASM output?
  └─ YES → sdl (SDL3) or sdl2 (SDL2)
```

## Backend reference

### 1. Streaming (`streaming`) — **default**

**File:** `src/streamingAudioPlayer.ts`

**How it works:** Sets `HTMLAudioElement.src` to the track URL. The browser performs HTTP range requests; playback can start before the full file downloads.

**Use when:**
- Playing from `storage.noahcohn.com` or any CORS-enabled CDN with `Accept-Ranges`
- You want **crossfade / gapless** between queue tracks (3 s fade, preload 8 s ahead)
- Memory should stay low on long FLAC files

**Avoid when:**
- Loading from a URL that blocks range requests or CORS
- You need the worklet PCM tap for projectM (use `worklet` instead)
- You need offline ArrayBuffer-only sources without a URL

**Features:** `setCrossfadeEnabled()`, `preloadNextTrack(url)`, standard seek/volume via `AudioContextManager`.

**Requirements:** Audio host must send `Access-Control-Allow-Origin` and expose `Accept-Ranges` / `Content-Length`.

---

### 2. Web Audio buffered (`web-audio`)

**File:** `src/audioPlayer.ts`

**How it works:** `fetch(url)` → decode to `AudioBuffer` → `BufferSourceNode` playback.

**Use when:**
- Debugging decode issues
- Small files or local blobs
- You want the simplest Web Audio graph with full `AnalyserNode` fidelity

**Avoid when:**
- Files are large (full file held in RAM)
- You need streaming start time

---

### 3. AudioWorklet (`worklet`)

**File:** `src/audioWorkletPlayer.ts`

**How it works:** Decodes via `flacDecoder` / worker, feeds an inline `FlacProcessor` AudioWorklet (ScriptProcessor shim fallback). Supports buffered and chunked streaming into a ring buffer.

**Use when:**
- **projectM integration** — `setPCMCallback()` provides audio-clock-synchronized PCM
- Lower-latency playback than ScriptProcessor
- EQ + analyser on the shared `AudioContextManager` graph

**Avoid when:**
- Cross-origin isolation headers are unavailable (worklet may fail; shim degrades quality)
- You only need URL streaming with zero decode — prefer `streaming`

**COOP/COEP:** Required for best results. Dev server sets headers automatically.

---

### 4. SDL3 WASM (`sdl`)

**Files:** `src/sdlAudioPlayer.ts`, `src/sdl/audio_engine.cpp`, `public/sdl-audio.*`

**How it works:** Full file fetch → interleaved float → WASM heap → SDL3 audio callback. PCM copied to a lock-free ring; `SdlPcmBridge` AudioWorklet feeds the shared analyser.

**Use when:**
- Testing the Emscripten/SDL experimental path
- Comparing WASM vs native Web Audio output

**Build:** `npm run build:wasm:sdl3` or `bash src/sdl/build.sh` (wrapper to `scripts/build-wasm.sh --sdl3`).

**Notes:** WASM glue loads lazily (~800 KB). Volume is applied in the C++ path. Web Audio destination is muted while SDL owns speakers.

---

### 5. SDL2 WASM (`sdl2`)

**Files:** `src/sdl2AudioPlayer.ts`, `src/sdl/audio_engine_sdl2.cpp`, `public/sdl2-audio.*`

Same as SDL3 but uses SDL2 + AudioWorklet glue. Build: `npm run build:wasm:sdl2` or `bash src/sdl/build_sdl2.sh`.

---

## Shared features (all backends)

| Feature | Streaming | Web Audio | Worklet | SDL3/2 |
|---------|-----------|-----------|---------|--------|
| EQ (10-band) | ✓ | ✓ | ✓ | ✓ |
| Analyser → visualizer | ✓ | ✓ | ✓ | ✓ (PCM bridge) |
| projectM PCM tap | Analyser fallback | Analyser fallback | ✓ native | Analyser fallback |
| Crossfade | ✓ | — | — | — |
| Offline cache (`trackCache`) | URL fetch | ArrayBuffer | ArrayBuffer | ArrayBuffer |
| Playback rate | ✓ | ✓ | ✓ | ✓ |

## Switching backends

`Player.tsx` destroys the current backend and calls `createAudioBackend(mode)` on change. Expect playback to reset; queue position is preserved in UI state.

## Visualizer interaction

| Backend | ShaderGUI | projectM in-app |
|---------|-----------|-----------------|
| streaming | Analyser (~60 fps) | Analyser PCM |
| web-audio | Analyser | Analyser PCM |
| worklet | Analyser + optional PCM | Worklet PCM tap (best) |
| sdl / sdl2 | Analyser via PCM bridge | Analyser PCM |

In **split** aesthetic mode, ShaderGUI uses `forceLiteGpu` (WebGL2) to reduce GPU contention with projectM.

## Debugging

Enable verbose loader/API logs:

```bash
# .env
REACT_APP_DEBUG=true
```

Logs appear as `[FLAC:label]` from `src/utils/debug.ts` (used by `audioLoader.ts` and `api/songApi.ts`). Off by default in production builds.

## Further reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) — full system diagram
- [API.md](./API.md#projectm-visualizer-integration) — projectM embed contract
- `src/types/audio.ts` — `AudioBackend` interface
