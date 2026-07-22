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

## Gapless / crossfade matrix

Queue transition mode is configured in **Settings → Queue transitions** (`flac_player_gapless_mode`, `flac_player_crossfade_ms`).

| Mode | Streaming (native `<audio>`) | Streaming (hi-fi worklet path) | Web Audio | Worklet | SDL3/2 |
|------|-------------------------------|-------------------------------|-----------|---------|--------|
| **Gapless** | ✓ Header-parsed duration, dual `<audio>` handoff | ✓ Worklet buffer queue | ✓ Scheduled `BufferSourceNode` | ✓ Worklet buffer queue | — |
| **Crossfade** | ✓ Dual `<audio>` + gain ramps | Gapless handoff (no overlap) | Gapless handoff when overlap minimal | Gapless handoff | — |
| **Off** | — | — | — | — | — |

**Notes**

- **Sample-accurate duration:** `src/utils/audioHeader.ts` probes FLAC `STREAMINFO` / WAV `fmt`+`data` via HTTP Range on the first 64 KiB.
- **Pre-buffering:** The player calls `preloadNext()` ~8 s before track end (or immediately when the queue changes). The queue panel shows **pre-buffering next** while decode/fetch is in progress.
- **Internal transitions:** When a backend has already started the next track, `onEnded` receives `{ alreadyPlayingNext: true }` so the UI advances the queue index without reloading audio.
- **SDL backends:** Gapless is not implemented; tracks still stop at EOF and advance via `onEnded` → `playTrack` (audible gap). Use `worklet` or `streaming` for gapless queues.
- **Different sample rates:** Adjacent tracks with mismatched sample rates may click; dynamic resampling is tracked in [#179](https://github.com/ford442/flac_player/issues/179).
- **ReplayGain / loudness matching:** Not implemented in this change ([#184](https://github.com/ford442/flac_player/issues/184)).

## Backend reference

### 1. Streaming (`streaming`) — **default**

**File:** `src/streamingAudioPlayer.ts`

**How it works:** Selects one of three paths per URL:

1. **Native** — `HTMLAudioElement` + HTTP range (WAV/MP3 or when WASM unavailable)
2. **Hi-fi stream** — Range → WASM decoder → worklet ring buffer
3. **Buffered** — Full fetch → worklet decode

**Use when:**
- Playing from `storage.noahcohn.com` or any CORS-enabled CDN with `Accept-Ranges`
- You want **gapless or crossfade** between queue tracks on the native path
- Memory should stay low on long FLAC files

**Avoid when:**
- Loading from a URL that blocks range requests or CORS
- You need the worklet PCM tap for projectM (use `worklet` instead)
- You need offline ArrayBuffer-only sources without a URL

**Gapless API:** `setGaplessSettings()`, `preloadNext({ url, duration? })`, `clearPreload()`.

**Requirements:** Audio host must send `Access-Control-Allow-Origin` and expose `Accept-Ranges` / `Content-Length`.

---

### 2. Web Audio buffered (`web-audio`)

**File:** `src/audioPlayer.ts`

**How it works:** `fetch(url)` → decode to `AudioBuffer` → `BufferSourceNode` playback. Gapless mode schedules the next `BufferSourceNode` at the exact end time of the current buffer.

**Use when:**
- Debugging decode issues
- Small files or local blobs
- You want the simplest Web Audio graph with full `AnalyserNode` fidelity

**Avoid when:**
- Files are large (full file held in RAM)
- You need streaming start time

**Gapless:** Pre-decodes the next queue track; target handoff gap &lt; 50 ms on local FLACs when the next track is pre-buffered before the current track ends.

---

### 3. AudioWorklet (`worklet`)

**File:** `src/audioWorkletPlayer.ts`

**How it works:** Decodes via `flacDecoder` / worker, feeds an inline `FlacProcessor` AudioWorklet (ScriptProcessor shim fallback). Supports buffered and chunked streaming into a ring buffer.

**Use when:**
- **projectM integration** — `setPCMCallback()` provides audio-clock-synchronized PCM
- Lower-latency playback than ScriptProcessor
- EQ + analyser on the shared `AudioContextManager` graph
- **Gapless queue playback** on buffered (fully decoded) tracks

**Avoid when:**
- Cross-origin isolation headers are unavailable (worklet may fail; shim degrades quality)
- You only need URL streaming with zero decode — prefer `streaming`

**Gapless:** Posts `queueBuffer` to the worklet processor; at the sample boundary the processor emits `segmentEnded` and continues into the next buffer without stopping the audio graph.

**COOP/COEP:** Required for best results. Dev server sets headers automatically.

---

### 4. SDL3 WASM (`sdl`)

**Files:** `src/sdlAudioPlayer.ts`, `src/sdl/audio_engine.cpp`, `public/sdl-audio.*`

**How it works:** Full file fetch → interleaved float → WASM heap → SDL3 audio callback. PCM copied to a lock-free ring; `SdlPcmBridge` AudioWorklet feeds the shared analyser.

**Gapless:** Not supported — each track is loaded with `stop()` between files.

**Build:** `npm run build:wasm:sdl3` or `bash src/sdl/build.sh`.

---

### 5. SDL2 WASM (`sdl2`)

**Files:** `src/sdl2AudioPlayer.ts`, `src/sdl/audio_engine_sdl2.cpp`, `public/sdl2-audio.*`

Same as SDL3 but uses SDL2 + AudioWorklet glue. **Gapless:** not supported.

Build: `npm run build:wasm:sdl2` or `bash src/sdl/build_sdl2.sh`.

---

## Shared features (all backends)

| Feature | Streaming | Web Audio | Worklet | SDL3/2 |
|---------|-----------|-----------|---------|--------|
| EQ (10-band) | ✓ | ✓ | ✓ | ✓ |
| Analyser → visualizer | ✓ | ✓ | ✓ | ✓ (PCM bridge) |
| projectM PCM tap | Analyser fallback | Analyser fallback | ✓ native | Analyser fallback |
| Gapless queue | ✓ (native + worklet paths) | ✓ | ✓ | — |
| Crossfade | ✓ (native path) | partial | partial | — |
| Offline cache (`trackCache`) | URL fetch | ArrayBuffer | ArrayBuffer | ArrayBuffer |
| Playback rate | ✓ | ✓ | ✓ | ✓ |

## Switching backends

`Player.tsx` destroys the current backend and calls `createAudioBackend(mode)` on change. Expect playback to reset; queue position is preserved in UI state. Pre-buffer state is cleared on backend switch — the player re-schedules `preloadNext` for the new backend.

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
- `src/types/gapless.ts` — gapless mode types
