# Audio Backends Guide

Choose the output mode in the player footer `<select>` (session-only in `usePlayerState`; not persisted). Default: **`streaming`**.

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
  └─ YES → sdl (SDL3)
```

## Gapless / crossfade matrix

Queue transition mode is configured in **Settings → Queue transitions** (`flac_player_gapless_mode`, `flac_player_crossfade_ms`).

| Mode | Streaming (native `<audio>`) | Streaming (hi-fi worklet path) | Web Audio | Worklet | SDL3 |
|------|-------------------------------|-------------------------------|-----------|---------|--------|
| **Gapless** | ✓ Header-parsed duration, dual `<audio>` handoff | ✓ Worklet buffer queue | ✓ Scheduled `BufferSourceNode` | ✓ Worklet buffer queue | — |
| **Crossfade** | ✓ Dual `<audio>` + gain ramps | Gapless handoff (no overlap) | Gapless handoff when overlap minimal | Gapless handoff | — |
| **Off** | — | — | — | — | — |

**Notes**

- **Sample-accurate duration:** `src/utils/audioHeader.ts` probes FLAC `STREAMINFO` / WAV `fmt`+`data` via HTTP Range on the first 64 KiB.
- **Pre-buffering:** The player calls `preloadNext()` ~8 s before track end (or immediately when the queue changes). The queue panel shows **pre-buffering next** while decode/fetch is in progress.
- **Internal transitions:** When a backend has already started the next track, `onEnded` receives `{ alreadyPlayingNext: true }` so the UI advances the queue index without reloading audio.
- **SDL backends:** Gapless is not implemented; tracks still stop at EOF and advance via `onEnded` → `playTrack` (audible gap). Use `worklet` or `streaming` for gapless queues.
- **Sample-rate policy (#194):** `AudioContextManager` opens the shared graph at the **file native rate** when `AudioContext.isSampleRateSupported` (or a construct/close probe) allows it. Otherwise `sampleRate` is omitted and the OS device default is used. A later track at a different rate **recreates** the graph (ReplayGain, master volume, EQ, analyser, `externalPlaybackActive` restored). Same-rate album queues stay gapless; a rate or latency change may produce a brief audible gap. Latency hint is Settings → **Output latency** (`flac_player_latency_mode`, default `playback`).
  - **streaming (native `<audio>`):** media-element clock; analyser lives on the shared native-rate context.
  - **web-audio:** `AudioBuffer` stays at file rate; `BufferSourceNode` lets the browser resample if the context could not match.
  - **worklet:** PCM is consumed 1:1 with the context callback rate. The processor is given the file (or context) rate via `processorOptions`; if the device cannot open native rate, a documented linear interpolator (`linearResampler.ts`) converts chunks. Seek uses the processor's own `this.sampleRate`.
  - **sdl:** WASM device opens at file rate. Large FLACs use the C++ play ring (`play_ring.h`); the analyser tap is still `SdlPcmBridge` at `context.sampleRate`. `_set_audio_data` / `_set_stream_format` return `1` on success; TypeScript rejects the load on `!== 1`. WASM heap is capped at 512 MiB (`MAXIMUM_MEMORY`).
- **ReplayGain / loudness matching:** Settings → **Loudness (ReplayGain)** (`flac_player_replaygain_mode`, `flac_player_replaygain_limiter`). Applies a dedicated gain stage **before** the master volume fader on streaming, web-audio, and worklet backends. SDL runs the same stage (plus the limiter) in WASM on the speaker path — see [Speaker-path DSP](#speaker-path-dsp-eq--replaygain). Client-side tag fetch uses a 64 KiB range request when API metadata is missing. Crossfade overlap may briefly mismatch levels when adjacent tracks have very different tags ([#184](https://github.com/ford442/flac_player/issues/184)).

## Backend reference

### 1. Streaming (`streaming`) — **default**

**File:** `src/audio/backends/StreamingAudioPlayer.ts`

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

**File:** `src/audio/backends/WebAudioPlayer.ts`

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

**Files:** `src/audio/backends/worklet/` — `WorkletAudioPlayer.ts` (graph + orchestration), `hifiStreamFeeder.ts` (hi-fi ring backpressure), `scriptProcessorFallback.ts`. Processor: `src/audio/worklets/flacProcessor.js` (static same-origin module; message union in `flacProcessorMessages.ts`).

**How it works:** Decodes via `flacDecoder` / worker, feeds the `flac-processor` AudioWorklet (ScriptProcessor fallback for buffered playback only). Supports buffered and chunked streaming into a ring buffer. Pause on the hi-fi path is a `pause` / `resume` port message — the shared `AudioContext` is never suspended — and the decoder is held while paused or while the ring is above 75 % full.

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

**Files:** `src/audio/backends/Sdl3AudioPlayer.ts`, `src/sdl/audio_engine.cpp`, `src/sdl/play_ring.h`, `public/sdl-audio.*`

**How it works:**

- **Small files (buffered):** full fetch → decode → `_create_audio_buffer` / `_set_audio_data` (compat path).
- **Large files (≥ 32 MB) or `forceStream`:** `runHifiStreamPipeline` → `_set_stream_format` → `_push_pcm` into a **play ring** (`PLAY_RING_CAPACITY` = 384000 floats, ~2 s stereo f32 @ 96 kHz). JS pauses decode when fill &gt; 75% (`get_play_ring_fill`). The SDL callback drains the play ring into a pre-sized scratch, runs speaker DSP (`dsp_chain.h`) in place, then writes the **viz** ring (`pcm_ring.h`, 65536 floats) for `SdlPcmBridge`.

Seek is **disabled** in hi-fi stream mode (same as worklet).

Buffered `_create_audio_buffer` rejects lengths above 384 MiB of f32 PCM (`nullptr`); `_set_audio_data` / `_set_stream_format` return `0` if `SDL_CreateAudioStream` / `SDL_BindAudioStream` fail, and the JS player throws instead of hanging.

**Gapless:** Not supported — each track is loaded with `stop()` between files.

**Output device:** SDL opens its own Emscripten audio context, so Settings → **Output device** (`AudioContext.setSinkId`) does not apply; it uses the system default.

**Build:** `npm run build:wasm` / `npm run build:wasm:sdl3` or `bash src/sdl/build.sh`. Debug: `scripts/build-wasm.sh --debug --sdl3`. Release: `-O3 -DNDEBUG`, `INITIAL_MEMORY=64 MiB`, `MAXIMUM_MEMORY=512 MiB`. SDL2 **playback** was retired (#212); projectM still uses a separate `USE_SDL=2` **video** host (`npm run build:projectm`).

---

## Shared features (all backends)

| Feature | Streaming | Web Audio | Worklet | SDL3 |
|---------|-----------|-----------|---------|--------|
| EQ (5-band) | ✓ | ✓ | ✓ | ✓ |
| Analyser → visualizer | ✓ | ✓ | ✓ | ✓ (PCM bridge) |
| projectM PCM tap | Analyser fallback | Analyser fallback | ✓ native | Analyser fallback |
| Gapless queue | ✓ (native + worklet paths) | ✓ | ✓ | — |
| Crossfade | ✓ (native path) | ✓ | — | — |
| Offline cache (`trackCache`) | URL fetch | ArrayBuffer | ArrayBuffer | ArrayBuffer |
| Playback rate | ✓ (native path) | ✓ | — | — |
| Seek | ✓ (not on hi-fi stream) | ✓ | ✓ buffered / — hi-fi | ✓ |

The UI reads these from `AudioBackend.getCapabilities()` (`AudioBackendCapabilities`) and disables controls the live backend cannot honor.

## Speaker-path DSP (EQ / ReplayGain)

EQ and ReplayGain must affect what the speakers play on every backend (prerequisite for #209 studio DSP).

| Backend | Where DSP runs | Speaker path |
|---------|----------------|--------------|
| streaming / web-audio / worklet | Shared Web Audio graph (`AudioContextManager`) | `input → ReplayGainNode → master Gain → EQChain → analyser → speakerGain → destination` |
| sdl | C++ `src/sdl/dsp_chain.h`, inside the SDL stream callback | `play ring / buffer → scratch → ReplayGain → limiter → volume → 5 biquads → SDL + viz ring` |

- **Why C++ and not the Web Audio graph for SDL:** keeps SDL exclusive (no second clock, no graph→WASM copy). The duplicated DSP is ~200 lines.
- **One band layout:** `Sdl3AudioPlayer` pushes `DEFAULT_EQ_BANDS` (type / frequency / Q) and gains via `_set_eq_band(index, type, freq, q, gainDb)`; coefficients follow the Web Audio `BiquadFilterNode` formulas (shelves use S = 1 and ignore Q), recomputed at the stream rate. `_set_replaygain(linear, limiter)` mirrors `ReplayGainNode` (threshold −1 dBFS, ratio 20, 3 ms / 100 ms, no makeup gain). `_set_volume` is the fader only.
- **No double-apply:** while SDL plays, `setExternalPlaybackActive(true)` zeroes `speakerGain`, and the `SdlPcmBridge` tap enters **after** the Web Audio EQ (`visualizerFeedGain → analyser`), so the analyser sees exactly the processed PCM SDL played. The shared graph still stores EQ/RG values; switching to streaming destroys the SDL backend, unmutes the graph, and applies them once.
- **Older prebuilt WASM** without the DSP exports: EQ is visualizer-only and ReplayGain folds into `_set_volume` (clamped at unity) — rebuild with `npm run build:wasm:sdl3`.

## AudioContext lifecycle and output (`AudioContextManager`)

- **Lazy, native-rate creation.** `ensureForTrack({ sampleRate, channels })` creates the context at the file rate. Volume / EQ / ReplayGain / sink setters, `getAnalyser()` (returns `null` before a graph) and `resume()` never open a graph. `getContext()` is the only lazy creator; calling it before `ensureForTrack` opens the device default rate and the first track may recreate.
- **Constructor fallbacks.** If `new AudioContext(options)` throws, options are relaxed in order: numeric `latencyHint → 'interactive'`, drop `sinkId` (re-applied live via `setSinkId`), drop `sampleRate`. A rejected rate is remembered so later tracks at that rate do not retry.
- **Channels.** `destination.channelCount` follows the track (`max(2, channels)`, capped at `maxChannelCount`), `channelCountMode = 'explicit'`, `'speakers'` interpretation.
- **Output device.** Settings → **Output device** persists `flac_player_output_device` (`{ id, label }`, `''` = default). Uses `navigator.mediaDevices.selectAudioOutput` where present, otherwise an `enumerateDevices()` list, applied with `AudioContext.setSinkId` (Chromium 110+) and passed as `sinkId` to future constructors. Browsers without `setSinkId` keep the default sink. A rejected device falls back to default with a toast.
- **Latency readout.** Settings → **Output latency** shows context rate, `baseLatency`, `outputLatency`, and destination channels (`useAudioOutputInfo`, polled each second, refreshed on graph recreate).

## Switching backends

`Player.tsx` destroys the current backend and calls `createAudioBackend(mode)` on change. Expect playback to reset; queue position is preserved in UI state. Pre-buffer state is cleared on backend switch — the player re-schedules `preloadNext` for the new backend.

## Visualizer interaction

| Backend | ShaderGUI | projectM in-app |
|---------|-----------|-----------------|
| streaming | Analyser (~60 fps) | Analyser PCM |
| web-audio | Analyser | Analyser PCM |
| worklet | Analyser + optional PCM | Worklet PCM tap (best) |
| sdl | Analyser via PCM bridge | Analyser PCM |

In **split** aesthetic mode, ShaderGUI keeps the required WebGPU renderer with a reduced visual layout alongside projectM. If the WebGPU boot probe fails, only the ShaderGUI surface hard-fails; audio and projectM remain independent.

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
