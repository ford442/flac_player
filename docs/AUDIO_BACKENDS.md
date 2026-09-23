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
| **Gapless** | ✓ Header-parsed duration, dual `<audio>` handoff | ✓ Decode-ahead splice into the worklet ring (same rate/channels) | ✓ Scheduled `BufferSourceNode` | ✓ Worklet buffer queue (buffered) / ring splice (hi-fi) | ✓ Hi-fi stream: splice into the play ring (same rate/channels) · buffered: — |
| **Crossfade** | ✓ Dual `<audio>` + gain ramps | Gapless handoff (no overlap) | Gapless handoff when overlap minimal | Gapless handoff | Gapless handoff on hi-fi stream (no overlap) |
| **Off** | — | — | — | — | — |

**Notes**

- **Sample-accurate duration:** `src/utils/audioHeader.ts` probes FLAC `STREAMINFO` / WAV `fmt`+`data` via HTTP Range on the first 64 KiB.
- **Pre-buffering:** The player calls `preloadNext()` ~8 s before track end (or immediately when the queue changes). The queue panel shows **pre-buffering next** while decode/fetch is in progress.
- **Internal transitions:** When a backend has already started the next track, `onEnded` receives `{ alreadyPlayingNext: true }` so the UI advances the queue index without reloading audio.
- **Hi-fi paths (worklet ring / SDL play ring):** see [Hi-fi stream seek and gapless](#hi-fi-stream-seek-and-gapless). **Crossfade overlap stays native-streaming + web-audio only**: the hi-fi rings hold one timeline, so crossfade mode is treated as gapless there. Buffered SDL (small files) has no queue; tracks stop at EOF and advance via `onEnded` → `playTrack`.
- **Sample-rate policy (#194):** `AudioContextManager` opens the shared graph at the **file native rate** when `AudioContext.isSampleRateSupported` (or a construct/close probe) allows it. Otherwise `sampleRate` is omitted and the OS device default is used. A later track at a different rate **recreates** the graph (ReplayGain, master volume, EQ, analyser, `externalPlaybackActive` restored). Same-rate album queues stay gapless; a rate or latency change may produce a brief audible gap. Latency hint is Settings → **Output latency** (`flac_player_latency_mode`, default `playback`).
  - **streaming (native `<audio>`):** media-element clock; analyser lives on the shared native-rate context.
  - **web-audio:** `AudioBuffer` stays at file rate; `BufferSourceNode` lets the browser resample if the context could not match.
  - **worklet:** PCM is consumed 1:1 with the context callback rate. The processor is given the file (or context) rate via `processorOptions`; if the device cannot open native rate, the SpeexDSP WASM resampler (`resampler.ts`, stateful across stream chunks) converts PCM, with linear interpolation as the load-failure fallback — see [Sample-rate conversion](#sample-rate-conversion). No resampler is created when the context already runs at the file rate. Seek uses the processor's own `this.sampleRate`.
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

**Requirements:** Audio host must send `Access-Control-Allow-Origin` and expose `Accept-Ranges` / `Content-Length` (hi-fi seek also accepts a `206` + `Content-Range` answer to a 1-byte Range GET).

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

**Gapless:** Buffered: posts `queueBuffer` to the worklet processor; at the sample boundary the processor emits `segmentEnded` and continues into the next buffer without stopping the audio graph. Hi-fi stream: the next track is decoded into the same ring after a `markSegment` message — see [Hi-fi stream seek and gapless](#hi-fi-stream-seek-and-gapless).

**COOP/COEP:** Required for best results. Dev server sets headers automatically.

---

### 4. SDL3 WASM (`sdl`)

**Files:** `src/audio/backends/Sdl3AudioPlayer.ts`, `src/sdl/audio_engine.cpp`, `src/sdl/play_ring.h`, `public/sdl-audio.*`

**How it works:**

- **Small files (buffered):** full fetch → decode → `_create_audio_buffer` / `_set_audio_data` (compat path).
- **Large files (≥ 32 MB) or `forceStream`:** `HifiStreamSession` (`hifiStreamPipeline.ts`) → `_set_stream_format` → `_push_pcm` into a **play ring** (`PLAY_RING_CAPACITY` = 384000 floats, ~2 s stereo f32 @ 96 kHz). JS pauses decode when fill &gt; 75% (`get_play_ring_fill`). The SDL callback drains the play ring into a pre-sized scratch, runs speaker DSP (`dsp_chain.h`) in place, then writes the **viz** ring (`pcm_ring.h`, 65536 floats) for `SdlPcmBridge`.

**Stream-mode seek:** `seek(t)` calls `_seek_stream(t)`, which (under the SDL stream lock) clears the SDL stream, play ring, viz ring, DSP history and the ended flag, and sets the clock to `t`; the session then restarts the decoder at the frame containing `t` (HTTP Range). A push loop parked on a full ring belongs to the aborted run and exits on its next check, so a seek never deadlocks `playRingBackpressure`. See [Hi-fi stream seek and gapless](#hi-fi-stream-seek-and-gapless).

**Playback rate:** `_set_playback_rate(r)` → `SDL_SetAudioStreamFrequencyRatio` (clamped 0.25–4; pitch follows speed). `get_current_time` stays in **media seconds**: `playHead` counts file samples handed to SDL, and queued output bytes are scaled by `r` back to file samples before being subtracted.

**Device format:** `_get_device_format(int* freq, int* ch)` is logged at init (SDL resamples file rate → device on bind).

Buffered `_create_audio_buffer` rejects lengths above 384 MiB of f32 PCM and returns `nullptr` on allocation failure (the buffer is `malloc`-backed, so OOM never aborts); `_set_audio_data` / `_set_stream_format` return `0` if `SDL_CreateAudioStream` / `SDL_BindAudioStream` fail, and the JS player throws instead of hanging.

**Gapless:** Hi-fi stream only — the successor is pushed into the play ring right behind the current track; a rate/channel change is not spliced (`ensureForTrack` reload). Buffered SDL loads each track with `stop()` between files.

**Output device:** SDL opens its own Emscripten audio context, so Settings → **Output device** (`AudioContext.setSinkId`) does not apply; it uses the system default.

**Build:** `npm run build:wasm` / `npm run build:wasm:sdl3` or `bash src/sdl/build.sh`. Debug: `scripts/build-wasm.sh --debug --sdl3`. Release: `-O3 -DNDEBUG -msimd128` (stereo EQ uses f64x2 lanes; scalar fallback otherwise, bit-identical — `npm run test:dsp-golden`), `INITIAL_MEMORY=64 MiB`, `MAXIMUM_MEMORY=512 MiB`. SDL2 **playback** was retired (#212); projectM still uses a separate `USE_SDL=2` **video** host (`npm run build:projectm`).

---

## Shared features (all backends)

| Feature | Streaming | Web Audio | Worklet | SDL3 |
|---------|-----------|-----------|---------|--------|
| EQ (5-band) | ✓ | ✓ | ✓ | ✓ |
| Analyser → visualizer | ✓ | ✓ | ✓ | ✓ (PCM bridge) |
| projectM PCM tap | Analyser fallback | Analyser fallback | ✓ native | Analyser fallback |
| Gapless queue | ✓ (native + worklet paths) | ✓ | ✓ | ✓ hi-fi stream / — buffered |
| Crossfade | ✓ (native path) | ✓ | — | — |
| Offline cache (`trackCache`) | URL fetch | ArrayBuffer | ArrayBuffer | ArrayBuffer |
| Playback rate | ✓ (native path) | ✓ | — | ✓ (SDL frequency ratio) |
| Seek | ✓ (native, buffered, hi-fi) | ✓ | ✓ buffered + hi-fi | ✓ buffered + hi-fi (`_seek_stream`) |

The UI reads these from `AudioBackend.getCapabilities()` (`AudioBackendCapabilities`) and disables controls the live backend cannot honor.

## Hi-fi stream seek and gapless

Applies to the hi-fi paths — `worklet` (and `streaming`'s hi-fi path, which delegates to it) and `sdl` — where a WASM FLAC decoder fills a bounded ring. Default native `<audio>` streaming seeks and crossfades on its own.

```
storage.noahcohn.com ──Range GET──► StreamingDecoder (flac worker) ──► worklet ring / SDL play ring
                                          ▲
seek(t)     = reset ring (seekStream msg / _seek_stream) + restart decoder at the frame holding t
gapless     = after the last PCM of A, decode B into the same ring (markSegment / JS splice list)
```

**Seek** (`flacSeek.ts`, `hifiStreamPipeline.ts`):

1. `openHifiTrack` probes the URL once per track (HEAD; if HEAD omits `Accept-Ranges`, a `bytes=0-0` GET confirms 206) and reads `STREAMINFO` + `SEEKTABLE` with a small Range GET. `STREAMINFO` also gives the exact duration.
2. `locateFrame` picks a byte offset: the last seek point ≤ target, else a constant-bitrate estimate that backs off until the frame found starts at or before the target. A frame is accepted only if the sync code, reserved bits, CRC‑8 and the channel/rate/depth fields match `STREAMINFO`; its coded number gives the frame's first sample.
3. The decoder is fed a synthetic `fLaC` + `STREAMINFO` prefix, then bytes from that frame; the leading `target − frameStart` frames are dropped. The first sample played is the target sample.
4. No Range support (or unreadable header): skip-decode from byte 0 (correct, slower).

Each restart takes a pre-warmed decoder worker, so a seek does not pay worker/WASM startup. The shared `AudioContext` is never suspended.

- **Worklet:** `seekStream { position, epoch }` empties the processor ring and restarts its clock at `position`; `position` messages carry the epoch, so late messages from before the seek are ignored by the UI and by `HifiStreamFeeder` backpressure. Positions are posted every ~100 ms.
- **SDL3:** `_seek_stream(t)` (see above). JS tracks samples pushed on the C++ `playHead` scale so splice points line up with `get_current_time`.

**Gapless** (`HifiStreamSession`): `preloadNext()` on a hi-fi stream queues the successor and probes its header right away. When the current decode ends, a successor with the **same channels and sample rate** is decoded straight into the same ring; otherwise the stream ends normally and the queue reloads through `ensureForTrack`. When playback crosses the splice, the backend fires `onEnded({ alreadyPlayingNext: true })` and restarts its clock at 0 with the successor's `STREAMINFO` duration. Only one decoder runs at a time and nothing holds a whole decoded track; memory is bounded by the ring (worklet 30 s, SDL `PLAY_RING_CAPACITY`). A successor shorter than the ring may end before the app queues the one after it — that transition then reloads normally.

| Bound | Target | Measured (`tests/browser/hifiSeek.test.ts`, headless Chromium) |
|-------|--------|------------------------------------------------------------------|
| First sample after seek | = target sample | exact, worklet (index-coded fixture) |
| UI clock vs audible output after settle | ± 100 ms | within bound, worklet + SDL3, seeks to 30 s / 39.5 s / 0 / 12.345 s |
| Gapless handoff gap (same rate/channels) | ≤ 20 ms (≤ one render quantum of extra silence) | 0 samples, worklet + SDL3 |
| Seek while the push loop is parked on a full ring | no deadlock | SDL3: pause → fill > 70 % → seek × 2 → play |

With a resampler active (worklet at a non-native context rate) the splice marker lands within the filter latency (< 3 ms) of the true boundary; the audio itself stays continuous because the resampler keeps its state across the join.

Fixtures come from `scripts/make-seek-fixtures.mjs`: every frame encodes its own sample index, so positions and gaps are asserted exactly. Unit coverage: `tests/flacSeek.test.ts` (both estimate and `SEEKTABLE` paths, real WASM decode).

## Sample-rate conversion

Used only when the `AudioContext` cannot open the file's rate (`chooseContextSampleRate` / `ensureForTrack` fell back to the device rate) on the **worklet** path, for buffered PCM and for hi-fi stream chunks. SDL3 opens its stream at the file rate and lets SDL convert on bind.

| Converter | Source | When |
|-----------|--------|------|
| **SpeexDSP resampler**, quality 10 | `public/speex-resampler.{js,wasm}` (26 KiB wasm) — SpeexDSP 1.2.1 `resample.c`, BSD-3-Clause, pinned tarball SHA-256; ABI `src/resampler/speex_resampler_wasm.c` | Default |
| Linear interpolation | `linearResampler.ts` | The WASM module fails to load |

SpeexDSP rather than soxr: soxr is LGPL, needs its CMake build and FFT code, and would add a much larger module next to `sdl-audio.wasm`; SpeexDSP's float path is one file and already far past 16/24-bit noise floors for this use.

THD+N of a 0.5 FS sine (least-squares fit of the ideal output, residual = noise + distortion; `tests/resampler.test.ts`):

| Tone | Conversion | SpeexDSP q10 | Linear |
|------|-----------|--------------|--------|
| 1 kHz | 44.1 → 48 kHz | 137 dB | 50 dB |
| 10 kHz | 44.1 → 48 kHz | 136 dB | 20 dB |
| 1 kHz | 96 → 48 kHz | 152 dB | 35 dB |
| 15 kHz | 96 → 48 kHz | 149 dB | 11 dB |

The stream resampler is stateful (chunked output equals one-shot output), is reset on seek, and flushes its filter tail at end of stream so output length is exactly `round(in × to / from)`.

Build: `npm run build:wasm:resampler` (downloads + verifies the SpeexDSP tarball into `.build/`, writes `public/resampler-source.sha256`); `npm run verify:wasm` checks both SDL and resampler hashes. Rubber Band (pitch-preserving tempo) is separate (#209).

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
