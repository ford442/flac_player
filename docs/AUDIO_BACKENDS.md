# Audio Backends Guide

Choose the output mode in the player footer `<select>` (session-only in the player store, `src/player/playerStore.ts`; not persisted). Switching resumes the loaded track on the new backend. Default: **`streaming`**.

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
- **Sample-rate policy (#259 A8, was #194):** `AudioContextManager` opens **one** shared graph at the **output device's rate** and keeps it for the page's lifetime; tracks at other rates are converted into it (see [One context at the device rate](#decision-record-one-context-at-the-device-rate)). Only a latency-hint or render-quantum change rebuilds the graph (ReplayGain, master volume, EQ, analyser, `externalPlaybackActive` restored), with a brief gap. `?ctxrate=native` (or `setPolicy({ recreateOnSampleRateMismatch: true })`) restores the old open-at-file-rate behavior for A/B. Latency hint is Settings → **Output latency** (`flac_player_latency_mode`, default `playback`).
  - **streaming (native `<audio>`):** media-element clock; the browser's media pipeline converts to the context rate.
  - **web-audio:** a file-rate decode goes through the SpeexDSP resampler into an `AudioBuffer` at the context rate (Chromium's `AudioBufferSourceNode` would otherwise resample by linear interpolation). `decodeAudioData` results are already at the context rate.
  - **worklet:** PCM is consumed 1:1 with the context callback rate at 1× (see [Worklet transport and playback rate](#worklet-transport-and-playback-rate) for other speeds). The processor is given the file (or context) rate via `processorOptions`; when the file rate differs from the context's, the SpeexDSP WASM resampler (`resampler.ts`, stateful across stream chunks) converts PCM, with linear interpolation as the load-failure fallback — see [Sample-rate conversion](#sample-rate-conversion). No resampler is created when the context already runs at the file rate. Seek uses the processor's own `this.sampleRate`.
  - **sdl:** WASM device opens at file rate. Large FLACs use the C++ play ring (`play_ring.h`); the analyser tap is still `SdlPcmBridge` at `context.sampleRate`. `_set_audio_data` / `_set_stream_format` return `1` on success; TypeScript rejects the load on `!== 1`. WASM heap is capped at 512 MiB (`MAXIMUM_MEMORY`).
- **ReplayGain / loudness matching:** Settings → **Loudness (ReplayGain)** (`flac_player_replaygain_mode`, `flac_player_replaygain_limiter`). Applies a dedicated gain stage **before** the master volume fader on streaming, web-audio, and worklet backends. Every backend runs the same `dsp_chain.h` stage (plus the limiter) in WASM — see [Speaker-path DSP](#speaker-path-dsp-eq--replaygain). Client-side tag fetch uses a 64 KiB range request when API metadata is missing. Crossfade overlap may briefly mismatch levels when adjacent tracks have very different tags ([#184](https://github.com/ford442/flac_player/issues/184)).

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

**Listening rooms:** `setNativeOnly(true)` skips path selection and loads every URL (FLAC included) on the native path; `getSyncClock()` exposes that element's `currentTime` / paused / seeking / rate (null on the hi-fi and buffered paths). Rooms are streaming-only for now — see [LISTENING_ROOMS.md](./LISTENING_ROOMS.md).

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

**Files:** `src/audio/backends/worklet/` — `WorkletAudioPlayer.ts` (graph + orchestration), `hifiStreamFeeder.ts` (hi-fi ring writer + backpressure), `pcmTapReader.ts` (projectM tap). Processor: `src/audio/worklets/flacProcessor.ts`, bundled as its own worklet entry; it imports `flacProcessorMessages.ts` (protocol) and `playRingSAB.ts` (ring layout) like the main thread does.

**How it works:** Decodes via `flacDecoder` / worker, feeds the `flac-processor` AudioWorklet. Buffered tracks are handed over whole; hi-fi streams go through a ring — shared memory under COOP/COEP, `chunk` messages otherwise (see [Worklet transport and playback rate](#worklet-transport-and-playback-rate)). Pause on the hi-fi path is a `pause` / `resume` port message — the shared `AudioContext` is never suspended — and the decoder is held while paused or while the ring is above 75 % full.

**AudioWorklet is required.** There is no ScriptProcessor fallback: without `AudioWorklet` (insecure context, very old browser) every load rejects with an error the player shows, and `getCapabilities()` reports `playbackRate: false` / `gapless: false`.

**Use when:**
- **projectM integration** — `setPCMCallback()` provides audio-clock-synchronized PCM
- EQ / ReplayGain (the `dsp-chain` WASM worklet) + analyser on the shared `AudioContextManager` graph
- **Gapless queue playback** on buffered (fully decoded) tracks
- Playback rate on the hi-fi decode path (varispeed in the processor)

**Avoid when:**
- The browser has no AudioWorklet — use `streaming` or `web-audio`
- You only need URL streaming with zero decode — prefer `streaming`

**Gapless:** Buffered: posts `queueBuffer` to the worklet processor; at the sample boundary the processor emits `segmentEnded` and continues into the next buffer without stopping the audio graph. Hi-fi stream: the next track is decoded into the same ring after a `markSegment` message — see [Hi-fi stream seek and gapless](#hi-fi-stream-seek-and-gapless).

**COOP/COEP:** Needed for the shared-memory transport (without it hi-fi PCM falls back to `chunk` messages). Dev server sets headers automatically.

---

### 4. SDL3 WASM (`sdl`)

**Files:** `src/audio/backends/Sdl3AudioPlayer.ts`, `src/sdl/audio_engine.cpp`, `src/sdl/play_ring.h`, `public/sdl-audio.*`

**How it works:**

- **Small files (buffered):** full fetch → decode → `_create_audio_buffer` / `_set_audio_data` (compat path).
- **Large files (≥ 32 MB) or `forceStream`:** `HifiStreamSession` (`hifiStreamPipeline.ts`) → `_set_stream_format` → `_push_pcm` into a **play ring** (`PLAY_RING_CAPACITY` = 384000 floats, ~2 s stereo f32 @ 96 kHz). JS pauses decode when fill &gt; 75% (`get_play_ring_fill`). The SDL callback drains the play ring into a pre-sized scratch, runs speaker DSP (`dsp_chain.h`) in place, then writes the **viz** ring (`pcm_ring.h`, 65536 floats) for `SdlPcmBridge` and the **analysis** ring (`analysis_ring.h`, see [Analysis ring](#analysis-ring-shared-pcm-tap)).

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
| Playback rate | ✓ (native + worklet paths) | ✓ | ✓ (varispeed in the processor) | ✓ (SDL frequency ratio) |
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

- **Worklet:** `seekStream { position, epoch, readFrom }` drops the ring up to `readFrom` — the writer's position at the moment of the seek, so PCM the restarted decoder writes before the message lands survives — and restarts the clock at `position`. `position`, `segmentEnded` and `ended` messages carry the epoch, so late messages from before the seek are ignored by the UI and by `HifiStreamFeeder` backpressure. Positions are posted every ~100 ms of media time.
- **SDL3:** `_seek_stream(t)` (see above). JS tracks samples pushed on the C++ `playHead` scale so splice points line up with `get_current_time`.

**Gapless** (`HifiStreamSession`): `preloadNext()` on a hi-fi stream queues the successor and probes its header right away. When the current decode ends, a successor with the **same channels and sample rate** is decoded straight into the same ring; otherwise the stream ends normally and the queue reloads through `ensureForTrack`. When playback crosses the splice, the backend fires `onEnded({ alreadyPlayingNext: true })` and restarts its clock at 0 with the successor's `STREAMINFO` duration. Only one decoder runs at a time and nothing holds a whole decoded track; memory is bounded by the ring (worklet 30 s, SDL `PLAY_RING_CAPACITY`). A successor shorter than the ring may end before the app queues the one after it — that transition then reloads normally.

| Bound | Target | Measured (`tests/browser/hifiSeek.test.ts`, headless Chromium) |
|-------|--------|------------------------------------------------------------------|
| First sample after seek | = target sample | exact, worklet (index-coded fixture) |
| UI clock vs audible output after settle | ± 100 ms | within bound, worklet + SDL3, seeks to 30 s / 39.5 s / 0 / 12.345 s |
| Gapless handoff gap (same rate/channels) | ≤ 20 ms (≤ one render quantum of extra silence) | 0 samples, worklet + SDL3 |
| Seek while the push loop is parked on a full ring | no deadlock | SDL3: pause → fill > 70 % → seek × 2 → play · worklet (`hifiWorkletRing.test.ts`, both transports): fill > 65 % → pause → seek × 2 → play, fill reads 0 right after the seek |

With a resampler active (worklet at a non-native context rate) the splice marker lands within the filter latency (< 3 ms) of the true boundary; the audio itself stays continuous because the resampler keeps its state across the join.

Fixtures come from `scripts/make-seek-fixtures.mjs`: every frame encodes its own sample index, so positions and gaps are asserted exactly. Unit coverage: `tests/flacSeek.test.ts` (both estimate and `SEEKTABLE` paths, real WASM decode).

## Worklet transport and playback rate

Mirrors the SDL play ring (`src/sdl/play_ring.h`) in TypeScript: `src/audio/worklets/playRingSAB.ts` is an SPSC float ring with an Int32 header `[writePos, readPos, capacity, ended]` followed by interleaved PCM. Positions wrap at a multiple of `capacity` (< 2³¹), so `pos % capacity` stays continuous. The main thread owns `writePos`/`ended`; the processor owns `readPos`.

```
Shared transport (crossOriginIsolated):
decode worker ─► HifiStreamFeeder.push ─► SharedArrayBuffer play ring ─► flac-processor process()
                                                                           ├─► outputs (varispeed at rate ≠ 1)
                                          SharedArrayBuffer tap ring ◄─────┘ (512-frame `pcmTap` notify)
                                                  └─► PcmTapReader ─► setPCMCallback (projectM)
Chunk fallback (no SAB):
decode worker ─► `chunk` postMessage ─► processor-local ring (same layout) ─► …
                                        `projectm-pcm` transferred blocks ─► setPCMCallback
```

- **Shared (COOP/COEP):** hi-fi PCM and the projectM tap never travel in `postMessage` — the port carries control only (`startStreaming` hands over the ring's `SharedArrayBuffer`; `markSegment { at }` and `seekStream { readFrom }` name ring positions; end-of-stream is the header's `ended` flag). The main thread cannot `Atomics.wait`, so the feeder re-checks the ring counters on each ~100 ms `position` message; the 30 s ring is far deeper than that tick.
- **Chunk fallback** (`SharedArrayBuffer` unavailable, or `new WorkletAudioPlayer(manager, { sharedRing: false })`): the processor builds the same ring in its own memory and fills it from `chunk` messages; the tap posts transferred 512-frame blocks. Seek, gapless splice and playback rate behave the same.
- **Processor build:** `flacProcessor.ts` is loaded with `context.audioWorklet.addModule(new URL('…/flacProcessor.ts', import.meta.url))`. Webpack turns that call into a bundled worklet entry (`module.parser.javascript.worker` in `webpack.config.js`; `output.publicPath: '/'` because a worklet cannot auto-detect it); Vite serves the module directly in tests. No blob URLs.

**Playback rate** (`setPlaybackRate`, clamped 0.25–4 like `useAudioSettings.ts` and SDL): the processor consumes its source at `rate ×` the callback rate through a 4-point Hermite interpolator — varispeed, so pitch follows tempo exactly like SDL's `SDL_SetAudioStreamFrequencyRatio` and `<audio>` with `preservesPitch = false`. At 1× the interpolator is bypassed and output is bit-exact; returning to 1× snaps to the next whole frame. Applies to hi-fi streams and buffered tracks. `position` stays in **media seconds** at any rate (it counts source frames, minus the few carried in the interpolator), and position messages tick every 100 ms of media time. Rate changes are independent of the feeder: while paused nothing is consumed and the decoder stays parked. SpeexDSP remains the fixed-ratio *sample-rate* converter (below); it is not used for tempo.

| Bound | Target | Measured (`tests/browser/hifiWorkletRing.test.ts`, headless Chromium) |
|-------|--------|------------------------------------------------------------------|
| Hi-fi PCM in `postMessage` (shared transport) | none | none — no `chunk`, no sample payloads, tap via `pcmTap` only |
| Audible tempo at 1.5× / 0.5× / 1× | = rate | tap source-index slope within 0.005; UI clock advances rate × ± 0.12 s/s |
| UI clock vs audible output at any rate | ± 100 ms | within bound (median of 9 samples) |
| Seek / gapless / tap on the chunk fallback | as shared | exact first sample, 0-sample splice, 512-frame blocks |

## Sample-rate conversion

Used whenever a file's rate differs from the context's (the device rate, see the decision record below) on the **worklet** path (buffered PCM and hi-fi stream chunks) and the **web-audio** path (whole decoded buffers). SDL3 opens its stream at the file rate and lets SDL convert on bind.

| Converter | Source | When |
|-----------|--------|------|
| **SpeexDSP resampler**, quality 10 | `public/speex-resampler.{js,wasm}` (~26 KiB wasm, `-msimd128`, 16 MiB heap cap) — SpeexDSP 1.2.1 `resample.c`, BSD-3-Clause, pinned tarball SHA-256; ABI `src/resampler/speex_resampler_wasm.c` | Default |
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

Build: `npm run build:wasm:resampler` (downloads + verifies the SpeexDSP tarball into `.build/`, writes `public/resampler-source.sha256`); `npm run verify:wasm` checks the SDL, resampler, DSP chain and projectM hashes. The module is capped at 16 MiB (`MAXIMUM_MEMORY`): `resampler.ts` stages at most ~1 MiB of in+out per `rs_process` slice, so the one-shot whole-file path never copies the file into the heap. `rs_create` returns 0 for > 8 channels or out-of-range rates, which selects the linear fallback. Release uses `-msimd128` (bit-identical to scalar, 1.25–1.85× faster at q10); `--debug` is scalar `-O0 -g`. Rubber Band (pitch-preserving tempo) is separate (#209).

## Speaker-path DSP (EQ / ReplayGain)

EQ and ReplayGain must affect what the speakers play on every backend (prerequisite for #209 studio DSP). Every backend runs **the same C++** — `src/sdl/dsp_chain.h` (ReplayGain → limiter → volume → 5 RBJ biquads, wasm SIMD stereo) — compiled twice: into `sdl-audio.wasm` for the SDL callback and into a tiny standalone `dsp-chain.wasm` for an AudioWorklet in the shared Web Audio graph.

| Backend | Where DSP runs | Speaker path |
|---------|----------------|--------------|
| streaming / web-audio / worklet | `dsp-chain` AudioWorklet (`dspChainProcessor.js` + `public/dsp-chain.wasm`) on the shared graph (`AudioContextManager`) | `input → dsp-chain (RG → limiter → volume → EQ) → analyser → speakerGain → destination` |
| streaming / web-audio / worklet — **fallback** | Web Audio nodes, when the module or AudioWorklet is unavailable, or `?dsp=webaudio` | `input → ReplayGainNode → master Gain → EQChain → analyser → speakerGain → destination` |
| sdl | `dsp_chain.h` in-process, inside the SDL stream callback (never the extra module — no cross-thread calls from the pthread) | `play ring / buffer → scratch → ReplayGain → limiter → volume → 5 biquads → SDL + viz ring` |

Settings → **Output latency** shows which engine is live (**EQ / limiter**: `Worklet WASM`, `Web Audio nodes`, or `SDL WASM`).

- **One band layout:** `DEFAULT_EQ_BANDS` (type / frequency / Q) is the single JS source of truth. `Sdl3AudioPlayer` pushes it via `_set_eq_band(index, type, freq, q, gainDb)`; `DspChainNode` pushes the same values (`DSP_EQ_TYPE_CODES`) to the worklet's `set_eq_band` export. Coefficients follow the Web Audio `BiquadFilterNode` formulas (shelves use S = 1 and ignore Q), recomputed at the context / stream rate. `set_replaygain(linear, limiter)`: threshold −1 dBFS, ratio 20, 3 ms / 100 ms, no makeup gain. Volume is the fader only and sits after the limiter (as the master `GainNode` does in the fallback).
- **No double-apply:** while SDL plays, `setExternalPlaybackActive(true)` zeroes `speakerGain`; the `SdlPcmBridge` tap enters **after** the speaker DSP (`visualizerFeedGain → analyser`), so the analyser sees exactly the processed PCM SDL played. The shared graph still stores EQ/RG values; switching to streaming destroys the SDL backend, unmutes the graph, and applies them once.
- **Older prebuilt SDL WASM** without the DSP exports: EQ is visualizer-only and ReplayGain folds into `_set_volume` (clamped at unity) — rebuild with `npm run build:wasm:sdl3`.

### DSP worklet (`dsp-chain`)

- **Module:** `scripts/build-dsp-wasm.sh` (`npm run build:wasm:dsp`) compiles `src/dsp/dsp_wasm_entry.cpp` (thin C exports: `scratch_ptr`, `scratch_floats`, `set_eq_band`, `set_replaygain`, `request_reset`, `process`, plus `fft_spectrum` / `fft_out_ptr` / `fft_lines_ptr` over `dsp_fft.h`) over the headers-only `dsp_chain.h` — no SDL, no pthread — with the SDL release flags (`-O3 -DNDEBUG -msimd128`, no fast-math, so the float ops are the same as SDL's). `STANDALONE_WASM`, fixed 1 MiB memory, ~22 KiB `.wasm`, **no imports**. `MODULARIZE` / `createDspChainModule` glue (`dsp-chain.js`) ships for tooling; the worklet does not use it.
- **Loading:** `DspChainNode.create()` fetches and compiles `/dsp-chain.wasm` once per page, `addModule`s the processor once per context, and passes the compiled `WebAssembly.Module` (raw bytes if the module is not cloneable) plus the current EQ / ReplayGain / volume in `processorOptions`. The processor instantiates synchronously (empty import object) and applies those settings **before the first render quantum**; later changes are port messages. The node is fixed-width (`channelCount` = destination channels, 2…8, `'explicit'` / `'speakers'`) and is rebuilt when a track changes the destination width.
- **Wiring:** `AudioContextManager` builds the fallback chain synchronously, then swaps `inputGain` onto the worklet once it reports `ready`. `ensureForTrack` waits up to 1.5 s for that swap so playback starts on the final path. Any failure (no AudioWorklet, 404, compile error, 3 s ready timeout) logs one warning and keeps the fallback — the same pattern as SpeexDSP → linear resampling.

### Analysis ring (shared PCM tap)

One shared-memory tap of the post-DSP PCM the user hears, for every analysis consumer (gpu-chores `fft_spectrum`, the `dsp_fft.h` WASM spectrum; projectM and the ShaderGUI spectrum next — #233). The audio thread only `memcpy`s its block in; analysis runs on the readers' threads at UI rate.

| Backend | Writer | Ring memory |
|---------|--------|-------------|
| SDL3 | `fill_audio_callback` → `analysis_ring_write` (`src/sdl/analysis_ring.h`), after `dsp_process` | SDL module's `wasmMemory` (SharedArrayBuffer, `-pthread`); `_get_analysis_ring_state` / `_get_analysis_ring_data` |
| Streaming / Web Audio / Worklet | `dspChainProcessor.js` copies each processed quantum | `SharedArrayBuffer` from `createAnalysisRingBuffer()` (only when `crossOriginIsolated`) |

- **Layout** (8 × u32 header, shared by `analysis_ring.h`, `src/audio/analysisRing.ts` and the inline writer in `dspChainProcessor.js`): `writePos` (floats since reset), `generation` (bumped on reset / format change), `capacity` (2^17 floats, 512 KiB), `channels`, `sampleRate`. Offsets are checked by `tests/native/analysis_golden.cpp`.
- **Broadcast, not SPSC:** unlike `pcm_ring.h` nothing is consumed. `AnalysisRingReader.readLatest(frames)` copies the newest whole frames and re-checks `generation` / `writePos` after the copy; a copy the writer reset or lapped is retried, then dropped — never returned torn. Writers copy data before publishing `writePos`, at most `ANALYSIS_RING_MAX_BLOCK` (8192) floats at a time, so readers stay that far behind it (a window is at most 15360 frames at 8 channels, 61440 stereo).
- **Reset:** SDL `stop` / `seek` / `seek_stream` / format change; worklet `reset` message (seek, new stream).
- **Active tap:** `getAnalysisTap()` returns SDL's ring while `SdlPcmBridge` is connected (the dsp-chain worklet then only processes silence), else the dsp-chain worklet's; null without SharedArrayBuffer or before the worklet loads, and consumers fall back to the `AnalyserNode`. While SDL is paused its callback stops, so its ring keeps the last window (the worklet keeps writing silence); a consumer that must decay on pause should watch `writePos` advance.

### A/B tolerance (SDL vs worklet vs fallback)

| Comparison | Result | Test |
|-----------|--------|------|
| SDL `dsp_chain.h` vs worklet `dsp-chain.wasm` | **Bit-identical.** `npm run test:dsp-golden` prints an FNV-1a hash of its SIMD output (8 bands, 1 kHz / 440 Hz stereo, ReplayGain 2.5 + limiter, odd chunk sizes); the test replays those vectors through `dsp-chain.wasm` and expects the same hash | `tests/dspChainWasm.test.ts`, `tests/native/dsp_simd_golden.cpp` |
| `dsp-chain.wasm` vs analytic `BiquadFilterNode` response, 60 Hz–12 kHz tones, all 5 bands non-zero | **< 0.01 dB** | `tests/dspChainWasm.test.ts` |
| `dsp-chain` worklet vs Chromium `EQChain` (`BiquadFilterNode` × 5), same tones | **< 0.01 dB** (measured ~1e-4 dB) | `tests/browser/dspChain.test.ts` |
| Analysis ring vs worklet output (Chromium `OfflineAudioContext`) | **Bit-exact** frames | `tests/browser/analysisTap.test.ts` |
| Limiter: worklet vs fallback `DynamicsCompressorNode` | **Not matched.** The compressor has look-ahead and its own detector. The WASM limiter is the reference; it is what SDL runs. | — |

Flat EQ, unity ReplayGain and volume are a bit-exact pass-through in the worklet.

### Crossfade and multichannel (later phases)

- Worklet / SDL "crossfade" is still a **gapless splice**: the hi-fi rings hold one timeline. An overlap fade in the processor waits on the SharedArrayBuffer play ring (crossfading `postMessage` chunks is fragile). Native `<audio>` streaming remains the only overlap fade.
- `DSP_MAX_CHANNELS = 8`. The worklet follows the destination width, so a 5.1 file on a stereo device is folded down by Web Audio's `'speakers'` mix before the DSP; there is no surround / HRTF Settings UI yet. On a surround device the fallback chain keeps full width too: its limiter is out of the chain while off, and while on it runs one `DynamicsCompressorNode` per channel pair (the node is clamped to 2 channels), split and merged around them (`ReplayGainNode.ts`). `tests/browser/multichannel.test.ts` checks 5.1 / 7.1 on both engines.

## AudioContext lifecycle and output (`AudioContextManager`)

- **One context, created in the gesture.** The engine calls `unlock()` synchronously from user play commands (play, track click, next / previous), before any network await, so the context is created and resumed inside the gesture (WebKit otherwise starts it `suspended`). `ensureForTrack({ sampleRate, channels })` then reuses it. Volume / EQ / ReplayGain / sink setters, `getAnalyser()` (returns `null` before a graph) and `resume()` never open a graph. No throwaway context is ever opened to test a rate: `isSampleRateAccepted()` asks `AudioContext.isSampleRateSupported` where it exists, and the constructor relaxation below catches the rest.
- **State machine.** `getState()` / `subscribeState()` report `none | running | suspended | interrupted | closed` from the context's `statechange`. `resume()` handles both `suspended` and WebKit's `interrupted` (a call or Siri took the session) and never rejects. The engine reports `setPlaybackActive(status is playing or loading)`. While playback is wanted, a suspended or interrupted context is resumed on `statechange`, on the next `pointerdown` / `pointerup` / `keydown` / `touchend` (installed once, capture + passive), and when the page becomes visible. `navigator.audioSession.type = 'playback'` is set where Safari's Audio Session API exists.
- **Idle suspend.** Paused, stopped or ended for `IDLE_SUSPEND_MS` (10 s), the context is `suspend()`ed: the speaker DSP worklet / biquads, the analyser and the output stop rendering and the iOS audio session is released. The next play resumes it before the backend starts. A gesture alone does not wake an idled context.
- **Constructor fallbacks.** If `new AudioContext(options)` throws, options are relaxed in order: numeric `latencyHint → 'interactive'`, drop `sinkId` (re-applied live via `setSinkId`), drop `renderSizeHint`, drop `sampleRate`. A rejected rate is remembered so later tracks at that rate do not retry. A rejected `renderSizeHint` is not retried either, until the setting changes.
- **Render quantum.** Settings → **Output latency → Render quantum** persists `flac_player_render_size` (`default` = option omitted / 128 frames, `hardware`, `256`, `512`). It is sent as `AudioContextOptions.renderSizeHint` only when `AudioContext.prototype.renderQuantumSize` exists (Chromium). Elsewhere the buttons are disabled. Changing it recreates the graph. Larger quanta mean fewer worklet wakeups per second; `FlacProcessor` resizes its varispeed scratch for quanta above 128. The readout shows the live `renderQuantumSize`.
- **Channels.** `destination.channelCount` follows the track (`max(2, channels)`, capped at `maxChannelCount`), `channelCountMode = 'explicit'`, `'speakers'` interpretation.
- **Output device.** Settings → **Output device** persists `flac_player_output_device` (`{ id, label }`, `''` = default). Uses `navigator.mediaDevices.selectAudioOutput` where present, otherwise an `enumerateDevices()` list, applied with `AudioContext.setSinkId` (Chromium 110+) and passed as `sinkId` to future constructors. Chromium may blank output ids until the page holds a media permission; the list then offers **Show devices…**, which takes a microphone permission, stops the stream at once and lists again. Browsers without `setSinkId` keep the default sink. A rejected device falls back to default with a toast; a context `error` event (device unplugged) falls back to default too, and `sinkchange` refreshes the readout.
- **SDL3.** It opens its own option-less context and ScriptProcessor in the emsdk SDL port (#260 replaces it), so the sink, latency hint and render quantum apply only to the shared graph that feeds its analyser. While SDL owns the speakers that graph moves to a `{ type: 'none' }` sink (Chromium), so it renders for the visualizer without holding a second device open. SDL3 is a `-pthread` build: without cross-origin isolation the engine pickers show it disabled ("needs cross-origin isolation") instead of failing on load.
- **Latency readout.** Settings → **Output latency** shows context rate, `baseLatency`, `outputLatency`, destination channels, and the speaker DSP engine (`useAudioOutputInfo`, polled each second, refreshed on graph recreate).

### Decision record: one context at the device rate

**Status:** adopted in #259 (A8). Supersedes the per-rate rebuild from #194.

**Context.** Until #259 the shared graph was opened at each file's sample rate and rebuilt when the next track's rate differed. Each rebuild closed the context and recreated every node, which replaced the analyser (and so tore down the visualizer's `GPUDevice`, #259 W1), forced the engine to reload the track at `clock.now()`, left an audible gap between mixed-rate tracks, and, with `probeSampleRateSupported`, opened a throwaway context per track (#259 A2).

**What a native-rate context buys.** Less than it seems. A context's `sampleRate` is not the device's: Chromium, Firefox and WebKit resample a context to the output device's rate (none of them switches the hardware rate for a page). So a 44.1 kHz context on a 48 kHz device is converted by the browser's output stage, and the result is bit-exact only when the device already runs at the file's rate. In that case a context opened at the device rate is bit-exact too. A native-rate context therefore only changes *which* resampler runs (the browser's output stage instead of ours), and it runs EQ and analysis at the file rate.

**Options.**

| | Rebuild per file rate (old) | One context at the device rate (chosen) |
|---|---|---|
| Bit-exact when device rate = file rate | yes | yes |
| Resampler when they differ | browser output stage | SpeexDSP q10 (worklet, web-audio), media pipeline (streaming) |
| Mixed-rate queue | gap + graph rebuild + engine reload per change | no rebuild; web-audio and native streaming stay gapless across rates (the hi-fi rings still splice only same-format successors) |
| Visualizer / analyser | replaced per rate change | stable for the session |
| Contexts per session | one per rate change (+ probes) | one |
| Analyser bin width | varies with the file rate | fixed by the device rate |

**Decision.** One context at the device rate. The stability gains are concrete, and the bit-exact path is unchanged where it ever existed. `?ctxrate=native` keeps the old behavior for listening tests. Revisit if a browser ever lets a page switch the device rate; until then, native rate belongs to SDL3 (#260), which opens its device stream at the file rate.

**Consequences.** `tests/audioContextManager.test.ts` asserts a 10-track mixed-rate session constructs exactly one context, and the e2e smoke counts every constructed context (closed ones included). Hz-aware analyser bands (#259 A6) still matter: the device rate decides the bin width.

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

Logs appear as `[FLAC:label]` from `src/utils/debug.ts` (used by `api/http.ts` and `api/songApi.ts`). Off by default in production builds.

## Further reading

- [ARCHITECTURE.md](./ARCHITECTURE.md) — full system diagram
- [API.md](./API.md#projectm-visualizer-integration) — projectM embed contract
- `src/types/audio.ts` — `AudioBackend` interface
- `src/types/gapless.ts` — gapless mode types

## Media Session (OS media controls)

`src/hooks/useMediaSession.ts` (wired in `Player.tsx`) adapts the playback controller to
`navigator.mediaSession`: lock-screen metadata/artwork (`cover_url`, else `/icons/icon-*.png`),
hardware/Bluetooth play-pause/next/previous, and OS scrubber seek (only when the backend reports
`capabilities.seek`). Position state is pushed from backend state updates, throttled to ~1 Hz — no
extra rAF loop. Muted playback still reports `playing`. Handlers and metadata are cleared on unmount.

Support: Chromium and Safari are full; Firefox is partial (metadata + play/pause, seek varies).
`setPositionState` is only as accurate as the backend clock (see #205 for worklet sample-rate honesty).
