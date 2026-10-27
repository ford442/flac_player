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

Experimenting with the C++ WASM engine (play ring + transport in C++)?
  └─ YES → sdl (labelled "WASM engine"; needs AudioWorklet + cross-origin isolation)
```

## Gapless / crossfade matrix

Queue transition mode is configured in **Settings → Queue transitions** (`flac_player_gapless_mode`, `flac_player_crossfade_ms`).

| Mode | Streaming (native `<audio>`) | Streaming (hi-fi worklet path) | Web Audio | Worklet | SDL engine |
|------|-------------------------------|-------------------------------|-----------|---------|--------|
| **Gapless** | ✓ Header-parsed duration, dual `<audio>` handoff | ✓ Decode-ahead splice into the worklet ring (same rate/channels) | ✓ Scheduled `BufferSourceNode` | ✓ Worklet buffer queue (buffered) / ring splice (hi-fi) | ✓ Hi-fi stream: splice into the play ring (same rate/channels) · buffered: — |
| **Crossfade** | ✓ Dual `<audio>` + gain ramps | Gapless handoff (no overlap) | Gapless handoff when overlap minimal | Gapless handoff | Gapless handoff on hi-fi stream (no overlap) |
| **Off** | — | — | — | — | — |

**Notes**

- **Sample-accurate duration:** `src/utils/audioHeader.ts` probes FLAC `STREAMINFO` / WAV `fmt`+`data` via HTTP Range on the first 64 KiB.
- **Pre-buffering:** The player calls `preloadNext()` ~8 s before track end (or immediately when the queue changes). The queue panel shows **pre-buffering next** while decode/fetch is in progress.
- **Internal transitions:** When a backend has already started the next track, `onEnded` receives `{ alreadyPlayingNext: true }` so the UI advances the queue index without reloading audio.
- **Hi-fi paths (worklet ring / SDL play ring):** see [Hi-fi stream seek and gapless](#hi-fi-stream-seek-and-gapless). **Crossfade overlap stays native-streaming + web-audio only**: the hi-fi rings hold one timeline, so crossfade mode is treated as gapless there. Buffered SDL (small files) has no queue; tracks stop at EOF and advance via `onEnded` → `playTrack`.
- **Sample-rate policy (#194):** `AudioContextManager` opens the shared graph at the **file native rate** when `AudioContext.isSampleRateSupported` (or a construct/close probe) allows it. Otherwise `sampleRate` is omitted and the OS device default is used. Probe answers are kept per rate for the page lifetime (`sampleRatePolicy.ts`); a first build is not probed (its constructor attempt is the probe), nor is a rate the live context already runs at, so a track at the live rate opens no context. A later track at a different rate **recreates** the graph (ReplayGain, master volume, EQ, analyser restored). Same-rate album queues stay gapless; a rate or latency change may produce a brief audible gap. Latency hint is Settings → **Output latency** (`flac_player_latency_mode`, default `playback`).
  - **streaming (native `<audio>`):** media-element clock; analyser lives on the shared native-rate context.
  - **web-audio:** `AudioBuffer` stays at file rate; `BufferSourceNode` lets the browser resample if the context could not match.
  - **worklet:** PCM is consumed 1:1 with the context callback rate. The processor is given the file (or context) rate via `processorOptions`; if the device cannot open native rate, the SpeexDSP WASM resampler (`resampler.ts`, stateful across stream chunks) converts PCM, with linear interpolation as the load-failure fallback — see [Sample-rate conversion](#sample-rate-conversion). No resampler is created when the context already runs at the file rate. Seek uses the processor's own `this.sampleRate`.
  - **sdl:** same as worklet: PCM is Speex-resampled to the context rate before it reaches the engine (whole buffer, or per chunk with a stateful stream resampler), so the `sdl-engine` processor copies frames 1:1. If the context is later replaced at another rate mid-track, the processor scales its step by PCM rate / context rate (linear interpolation) so pitch and clock stay right. `_set_audio_data` / `_set_stream_format` return `1` on success; TypeScript rejects the load on `!== 1`. WASM heap is capped at 512 MiB (`MAXIMUM_MEMORY`).
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

**Files:** `src/audio/backends/worklet/` — `WorkletAudioPlayer.ts` (graph + orchestration), `hifiStreamFeeder.ts` (hi-fi ring backpressure). Processor: `src/audio/worklets/flacProcessor.js` (static same-origin module; message union in `flacProcessorMessages.ts`).

**How it works:** Decodes via `flacDecoder` / worker, feeds the `flac-processor` AudioWorklet. Without AudioWorklet the backend reports `playable: false` and loads reject (#268; there is no ScriptProcessor fallback). Supports buffered and chunked streaming into a ring buffer. Pause on the hi-fi path is a `pause` / `resume` port message — the shared `AudioContext` is never suspended — and the decoder is held while paused or while the ring is above 75 % full.

**Use when:**
- **projectM integration** — `setPCMCallback()` provides audio-clock-synchronized PCM
- EQ / ReplayGain (the `dsp-chain` WASM worklet) + analyser on the shared `AudioContextManager` graph
- **Gapless queue playback** on buffered (fully decoded) tracks

**Avoid when:**
- The browser has no AudioWorklet (the backend is unplayable there)
- You only need URL streaming with zero decode — prefer `streaming`

**Gapless:** Buffered: posts `queueBuffer` to the worklet processor; at the sample boundary the processor emits `segmentEnded` and continues into the next buffer without stopping the audio graph. Hi-fi stream: the next track is decoded into the same ring after a `markSegment` message — see [Hi-fi stream seek and gapless](#hi-fi-stream-seek-and-gapless).

**COOP/COEP:** Required for best results. Dev server sets headers automatically.

---

### 4. SDL engine (`sdl`, labelled "WASM engine")

**Files:** `src/audio/backends/Sdl3AudioPlayer.ts`, `src/sdl/audio_engine.cpp`, `src/sdl/engine_state.h`, `src/sdl/play_ring.h`, `src/sdl/pcm_scrub.h`, processor `src/audio/worklets/sdlEngineProcessor.js` (contract and word indices in `sdlEngineMessages.ts`), `public/sdl-audio.*`

The mode keeps its name and stored value, but since #268 it links no SDL. SDL3's Emscripten backend pumped the engine from a `ScriptProcessorNode` on the main thread, in a second `AudioContext`, so React renders and visualizer frames could starve the mixer, and the output device setting did not apply.

**How it works:**

```
C++ engine (audio_engine.cpp, main-thread exports)        sdl-engine AudioWorkletProcessor (audio thread)
  buffered track (malloc) / play ring (play_ring.h)  ──►  reads whole frames out of the module's
  transport block (engine_state.h)                        shared memory each render quantum
                                                           │
                                                           ▼
                        AudioContextManager.connectInput → dsp-chain worklet (dsp_chain.h) → analyser → speakers
                                                           └─ analysis ring (same as every other backend)
```

- **Small files (buffered):** full fetch → decode → Speex to the context rate → `_create_audio_buffer` / `_set_audio_data` (NaN / Inf scrubbed to 0).
- **Large files (≥ 32 MB) or `forceStream`:** `HifiStreamSession` (`hifiStreamPipeline.ts`) → `_set_stream_format` → stream resampler → `_push_pcm` (scrubbed) into the **play ring** (`PLAY_RING_CAPACITY` = 2^19 floats, ~2.7 s stereo f32 @ 96 kHz; a power of two so the u32 positions wrap seamlessly). JS pauses decode when fill &gt; 75% (`get_play_ring_fill`).
- **Processor:** one `sdl-engine` node per load (`outputChannelCount` = track channels), created after `_set_output_owner(id)`; a node whose id is no longer the owner outputs silence and retires. Each quantum it applies a new transport epoch if there is one, then copies whole frames (a partial frame at the ring's tail waits for the producer), advances the ring's `readPos` and publishes `framesPlayed`. It never allocates, locks or waits.
- **Transport protocol (`engine_state.h`):** the exports write the fields of a change (load, seek, stop, rebase) and bump `epoch`; the processor re-reads them until `epoch` is stable, moves to `startFrame` (buffered) or skips the ring forward to `ringStart` (stream), resets `framesPlayed` and publishes `ackEpoch`. `get_current_time` is `startFrame` until the change is acknowledged, then `startFrame + framesPlayed`, in media frames at the PCM rate. The ring stays SPSC: JS only advances `writePos`, the processor only `readPos`.
- **Speaker DSP and analysis:** the shared graph's `dsp-chain` worklet, exactly as for web-audio / worklet / streaming. The engine has no DSP exports; EQ, ReplayGain, limiter and volume go to `AudioContextManager`.

**Stream-mode seek:** `seek(t)` calls `_seek_stream(t)`: the clock reads `t` at once, the ring's ended flag clears, and `ringStart` is set to the current write position, so the processor skips everything already queued when it applies the epoch. The session restarts the decoder at the frame containing `t` (HTTP Range). A push loop parked on a full ring belongs to the aborted run and exits on its next check, so a seek never deadlocks `playRingBackpressure`.

**Playback rate:** `_set_playback_rate(r)` (clamped 0.25–4) is read by the processor every quantum: `r = 1` copies frames, anything else interpolates linearly between neighbouring frames (pitch follows speed). The clock stays in media seconds because `framesPlayed` counts PCM frames consumed.

**End of track:** `_is_drained()` is 1 once the processor read the last buffered frame, or the stream's producer set `ended` and the ring is empty. The 100 ms poll turns it into `onEnded`; `play()` after the end seeks to 0.

**Graph recreate:** the old node dies with its context. `_rebase()` turns the position it reached and the ring position it read to into a fresh epoch, and a new node in the new context carries on (`tests/browser/sdlEngine.test.ts`).

**Fails closed:** without AudioWorklet or cross-origin isolation (SharedArrayBuffer) the backend reports `playable: false`, `initialize()` rejects and `PlaybackEngine` refuses loads before fetching anything.

Buffered `_create_audio_buffer` rejects lengths above 384 MiB of f32 PCM and returns `nullptr` on allocation failure (the buffer is `malloc`-backed, so OOM never aborts); the JS player throws instead of hanging.

**Gapless:** Hi-fi stream only — the successor is pushed into the play ring right behind the current track; a rate/channel change is not spliced (`ensureForTrack` reload). Buffered loads each track with `stop()` between files.

**Output device:** the shared graph's, so Settings → **Output device** (`AudioContext.setSinkId`) applies.

**Build:** `npm run build:wasm` / `npm run build:wasm:sdl3` or `bash src/sdl/build.sh`. Debug: `scripts/build-wasm.sh --debug --sdl3`. Release: `-O3 -DNDEBUG -msimd128 -pthread` (`-pthread` only for the shared memory; no thread is started), `INITIAL_MEMORY=64 MiB`, `MAXIMUM_MEMORY=512 MiB`; 26 KB of WASM. projectM still uses a separate `USE_SDL=2` **video** host (`npm run build:projectm`).

**Tests:** `tests/sdlEngineProcessor.test.ts` (processor against a shared `WebAssembly.Memory` laid out like the engine: 6- and 8-channel seams at the u32 wrap, partial frames, epochs, rate, ownership, growth), `tests/native/engine_state_test.cpp` + `play_ring_test.cpp` (`npm run test:native`, host clang), `tests/browser/sdlEngine.test.ts` and the SDL cases of `tests/browser/hifiSeek.test.ts` (the real module in Chromium).

---

## Shared features (all backends)

| Feature | Streaming | Web Audio | Worklet | SDL engine |
|---------|-----------|-----------|---------|--------|
| EQ (5-band) | ✓ | ✓ | ✓ | ✓ |
| Analyser → visualizer | ✓ | ✓ | ✓ | ✓ |
| projectM PCM tap | Analyser fallback | Analyser fallback | ✓ native | Analyser fallback |
| Gapless queue | ✓ (native + worklet paths) | ✓ | ✓ | ✓ hi-fi stream / — buffered |
| Crossfade | ✓ (native path) | ✓ | — | — |
| Offline cache (`trackCache`) | URL fetch | ArrayBuffer | ArrayBuffer | ArrayBuffer |
| Playback rate | ✓ (native path) | ✓ | — | ✓ (processor interpolation) |
| Seek | ✓ (native, buffered, hi-fi) | ✓ | ✓ buffered + hi-fi | ✓ buffered + hi-fi (`_seek_stream`) |

The UI reads these from `AudioBackend.getCapabilities()` (`AudioBackendCapabilities`) and disables controls the live backend cannot honor. `playable: false` means the backend cannot make sound in this browser (worklet: no AudioWorklet; sdl: no AudioWorklet or no cross-origin isolation): `PlaybackEngine` rejects loads before fetching, and nothing falls back to a main-thread ScriptProcessor.

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
- **SDL engine:** `_seek_stream(t)` (see above). JS counts samples pushed on the engine clock's scale (`floor(t × rate) × channels` after a seek) so splice points line up with `get_current_time`.

**Gapless** (`HifiStreamSession`): `preloadNext()` on a hi-fi stream queues the successor and probes its header right away. When the current decode ends, a successor with the **same channels and sample rate** is decoded straight into the same ring; otherwise the stream ends normally and the queue reloads through `ensureForTrack`. When playback crosses the splice, the backend fires `onEnded({ alreadyPlayingNext: true })` and restarts its clock at 0 with the successor's `STREAMINFO` duration. Only one decoder runs at a time and nothing holds a whole decoded track; memory is bounded by the ring (worklet 30 s, SDL `PLAY_RING_CAPACITY`). A successor shorter than the ring may end before the app queues the one after it — that transition then reloads normally.

| Bound | Target | Measured (`tests/browser/hifiSeek.test.ts`, headless Chromium) |
|-------|--------|------------------------------------------------------------------|
| First sample after seek | = target sample | exact, worklet (index-coded fixture) |
| UI clock vs audible output after settle | ± 100 ms | within bound, worklet + SDL engine, seeks to 30 s / 39.5 s / 0 / 12.345 s |
| Gapless handoff gap (same rate/channels) | ≤ 20 ms (≤ one render quantum of extra silence) | 0 samples, worklet + SDL engine |
| Seek while the push loop is parked on a full ring | no deadlock | SDL engine: pause → fill > 70 % → seek × 2 → play |

With a resampler active (worklet at a non-native context rate) the splice marker lands within the filter latency (< 3 ms) of the true boundary; the audio itself stays continuous because the resampler keeps its state across the join.

Fixtures come from `scripts/make-seek-fixtures.mjs`: every frame encodes its own sample index, so positions and gaps are asserted exactly. Unit coverage: `tests/flacSeek.test.ts` (both estimate and `SEEKTABLE` paths, real WASM decode).

## Sample-rate conversion

Used only when the `AudioContext` cannot open the file's rate (`chooseContextSampleRate` / `ensureForTrack` fell back to the device rate) on the **worklet** and **sdl** paths, for buffered PCM and for hi-fi stream chunks.

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

Build: `npm run build:wasm:resampler` (downloads + verifies the SpeexDSP tarball into `.build/`, writes `public/resampler-source.sha256`); `npm run verify:wasm` checks the SDL, resampler and DSP chain hashes. Rubber Band (pitch-preserving tempo) is separate (#209).

## Speaker-path DSP (EQ / ReplayGain)

EQ and ReplayGain must affect what the speakers play on every backend (prerequisite for #209 studio DSP). Every backend runs **the same C++** — `src/sdl/dsp_chain.h` (ReplayGain → limiter → volume → 5 RBJ biquads, wasm SIMD stereo) — compiled into a tiny standalone `dsp-chain.wasm` for an AudioWorklet in the shared Web Audio graph. Since #268 the `sdl` engine plays into that graph too, so there is one DSP instance per context (`sdl-audio.wasm` no longer contains `dsp_chain.h`).

| Backend | Where DSP runs | Speaker path |
|---------|----------------|--------------|
| streaming / web-audio / worklet / sdl | `dsp-chain` AudioWorklet (`dspChainProcessor.js` + `public/dsp-chain.wasm`) on the shared graph (`AudioContextManager`) | `input → dsp-chain (RG → limiter → volume → EQ) → analyser → speakerGain → destination` |
| any — **fallback** | Web Audio nodes, when the module or AudioWorklet is unavailable, or `?dsp=webaudio` | `input → ReplayGainNode → master Gain → EQChain → analyser → speakerGain → destination` |

Settings → **Output latency** shows which engine is live (**EQ / limiter**: `Worklet WASM` or `Web Audio nodes`).

- **One band layout:** `DEFAULT_EQ_BANDS` (type / frequency / Q) is the single JS source of truth. `DspChainNode` pushes it (`DSP_EQ_TYPE_CODES`) to the worklet's `set_eq_band` export. Coefficients follow the Web Audio `BiquadFilterNode` formulas (shelves use S = 1 and ignore Q), recomputed at the context / stream rate. `set_replaygain(linear, limiter)`: threshold −1 dBFS, ratio 20, 3 ms / 100 ms, no makeup gain. Volume is the fader only and sits after the limiter (as the master `GainNode` does in the fallback).
- **Fallback limiter and channel count:** `ReplayGainNode` is a gain node straight through to the master gain while the limiter is off. A `DynamicsCompressorNode` is clamped to two channels by the spec, so one left in the chain "off" would downmix 5.1 / 7.1 to stereo; the limiter stage exists only while enabled. On, it is one compressor up to stereo and one per channel (mix → splitter → compressors → merger) above it, rebuilt when the track's channel count changes. Unlike `dsp_chain.h`, which keeps a single gain-reduction envelope, those channels are not linked.

### DSP worklet (`dsp-chain`)

- **Module:** `scripts/build-dsp-wasm.sh` (`npm run build:wasm:dsp`) compiles `src/dsp/dsp_wasm_entry.cpp` (thin C exports: `scratch_ptr`, `scratch_floats`, `set_eq_band`, `set_replaygain`, `request_reset`, `process`, plus `fft_spectrum` / `fft_out_ptr` / `fft_lines_ptr` over `dsp_fft.h`) over the headers-only `dsp_chain.h` — no SDL, no pthread — with the SDL release flags (`-O3 -DNDEBUG -msimd128`, no fast-math, so the float ops are the same as SDL's). `STANDALONE_WASM`, fixed 1 MiB memory, ~22 KiB `.wasm`, **no imports**. `MODULARIZE` / `createDspChainModule` glue (`dsp-chain.js`) ships for tooling; the worklet does not use it.
- **Loading:** `DspChainNode.create()` fetches and compiles `/dsp-chain.wasm` once per page, `addModule`s the processor once per context, and passes the compiled `WebAssembly.Module` (raw bytes if the module is not cloneable) plus the current EQ / ReplayGain / volume in `processorOptions`. The processor instantiates synchronously (empty import object) and applies those settings **before the first render quantum**; later changes are port messages. The node is fixed-width (`channelCount` = destination channels, 2…8, `'explicit'` / `'speakers'`) and is rebuilt when a track changes the destination width.
- **Wiring:** `AudioContextManager` builds the fallback chain synchronously, then swaps `inputGain` onto the worklet once it reports `ready`. `ensureForTrack` waits up to 1.5 s for that swap so playback starts on the final path. Any failure (no AudioWorklet, 404, compile error, 3 s ready timeout) logs one warning and keeps the fallback — the same pattern as SpeexDSP → linear resampling.

### Analysis ring (shared PCM tap)

One shared-memory tap of the post-DSP PCM the user hears, for every analysis consumer (gpu-chores `fft_spectrum`, the `dsp_fft.h` WASM spectrum; projectM and the ShaderGUI spectrum next — #233). The audio thread only `memcpy`s its block in; analysis runs on the readers' threads at UI rate.

| Backend | Writer | Ring memory |
|---------|--------|-------------|
| every backend (the `sdl` engine included, #268) | `dspChainProcessor.js` copies each processed quantum | `SharedArrayBuffer` from `createAnalysisRingBuffer()` (only when `crossOriginIsolated`) |

- **Layout** (8 × u32 header, shared by `src/audio/analysisRing.ts` and the inline writer in `dspChainProcessor.js`; must not change): `writePos` (floats since reset), `generation` (bumped on reset / format change), `capacity` (2^17 floats, 512 KiB), `channels`, `sampleRate`. Checked end to end by `tests/analysisRing.test.ts`.
- **Broadcast, not SPSC:** unlike the play ring nothing is consumed. `AnalysisRingReader.readLatest(frames)` copies the newest whole frames and re-checks `generation` / `writePos` after the copy; a copy the writer reset or lapped is retried, then dropped — never returned torn. Writers copy data before publishing `writePos`, at most `ANALYSIS_RING_MAX_BLOCK` (8192) floats at a time, so readers stay that far behind it (a window is at most 15360 frames at 8 channels, 61440 stereo).
- **Reset:** the worklet's `reset` message.
- **Active tap:** `getAnalysisTap()` returns the dsp-chain worklet's ring; null without SharedArrayBuffer or before the worklet loads, and consumers fall back to the `AnalyserNode`. The worklet keeps writing (silence while paused), so `writePos` always advances.

### A/B tolerance (scalar vs SIMD vs fallback)

| Comparison | Result | Test |
|-----------|--------|------|
| `dsp_chain.h` scalar vs SIMD, native vs `dsp-chain.wasm` | **Bit-identical.** `npm run test:dsp-golden` prints an FNV-1a hash of its SIMD output (8 bands, 1 kHz / 440 Hz stereo, ReplayGain 2.5 + limiter, odd chunk sizes); the test replays those vectors through `dsp-chain.wasm` and expects the same hash | `tests/dspChainWasm.test.ts`, `tests/native/dsp_simd_golden.cpp` |
| `dsp-chain.wasm` vs analytic `BiquadFilterNode` response, 60 Hz–12 kHz tones, all 5 bands non-zero | **< 0.01 dB** | `tests/dspChainWasm.test.ts` |
| `dsp-chain` worklet vs Chromium `EQChain` (`BiquadFilterNode` × 5), same tones | **< 0.01 dB** (measured ~1e-4 dB) | `tests/browser/dspChain.test.ts` |
| Analysis ring vs worklet output (Chromium `OfflineAudioContext`) | **Bit-exact** frames | `tests/browser/analysisTap.test.ts` |
| Limiter: worklet vs fallback `DynamicsCompressorNode` | **Not matched.** The compressor has look-ahead and its own detector. The WASM limiter is the reference. | — |

Flat EQ, unity ReplayGain and volume are a bit-exact pass-through in the worklet.

### Crossfade and multichannel (later phases)

- Worklet / SDL engine "crossfade" is still a **gapless splice**: the hi-fi rings hold one timeline. An overlap fade would be a second reader in the `sdl-engine` processor over the SharedArrayBuffer play ring (crossfading `postMessage` chunks is fragile). Native `<audio>` streaming remains the only overlap fade.
- `DSP_MAX_CHANNELS = 8`. The worklet follows the destination width, so a 5.1 file on a stereo device is folded down by Web Audio's `'speakers'` mix before the DSP; there is no surround / HRTF Settings UI yet.

## AudioContext lifecycle and output (`AudioContextManager`)

- **Lazy, native-rate creation.** `ensureForTrack({ sampleRate, channels })` creates the context at the file rate. Volume / EQ / ReplayGain / sink setters, `getAnalyser()` (returns `null` before a graph) and `whenRunning()` never open a graph. `getContext()` is the only lazy creator; calling it before `ensureForTrack` opens the device default rate and the first track may recreate.
- **Run state.** `whenRunning(timeoutMs = 500)` is the one way to get a running context: it resumes `suspended` and iOS Safari's `interrupted` without rebuilding the graph, issues `resume()` before its first await (call it inside the unlocking click), and arms a one-shot gesture listener so the next click or key press resumes a gesture-gated context that missed its deadline. Resolves `false` when the deadline passes or there is no graph. The context is shared by every backend and the visualizer tap, so `context.suspend()` is refused (warned and ignored); nothing in the manager suspends it.
- **Recreate.** Rate / latency changes are serialized. The old graph is cut from its destination first so two contexts never sound at once; the old context is closed only after the new one is running; `graphGeneration` and the `subscribeGraphRecreated` listeners then fire together, once the new input is routed (DSP worklet attached or its wait expired), so `getOutputInfo()` already reports the new rate and latencies.
- **Constructor fallbacks.** If `new AudioContext(options)` throws, options are relaxed in order: numeric `latencyHint → 'interactive'`, drop `sinkId` (re-applied live via `setSinkId`), drop `sampleRate`. A rejected rate is remembered so later tracks at that rate do not retry.
- **Channels.** `destination.channelCount` follows the track (`max(2, channels)`, capped at `maxChannelCount`), `channelCountMode = 'explicit'`, `'speakers'` interpretation.
- **Output device.** Settings → **Output device** persists `flac_player_output_device` (`{ id, label }`, `''` = default). Uses `navigator.mediaDevices.selectAudioOutput` where present, otherwise an `enumerateDevices()` list, applied with `AudioContext.setSinkId` (Chromium 110+) and passed as `sinkId` to future constructors. Browsers without `setSinkId` keep the default sink. A rejected device falls back to default with a toast.
- **Latency readout.** Settings → **Output latency** shows context rate, `baseLatency`, `outputLatency`, destination channels, and the speaker DSP engine (`useAudioOutputInfo`, polled each second, refreshed on graph recreate).

## Switching backends

`Player.tsx` destroys the current backend and calls `createAudioBackend(mode)` on change. Expect playback to reset; queue position is preserved in UI state. Pre-buffer state is cleared on backend switch — the player re-schedules `preloadNext` for the new backend.

## Visualizer interaction

| Backend | ShaderGUI | projectM in-app |
|---------|-----------|-----------------|
| streaming | Analyser (~60 fps) | Analyser PCM |
| web-audio | Analyser | Analyser PCM |
| worklet | Analyser + optional PCM | Worklet PCM tap (best) |
| sdl | Analyser | Analyser PCM |

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

## Media Session (OS media controls)

`src/hooks/useMediaSession.ts` (wired in `Player.tsx`) adapts the playback controller to
`navigator.mediaSession`: lock-screen metadata/artwork (`cover_url`, else `/icons/icon-*.png`),
hardware/Bluetooth play-pause/next/previous, and OS scrubber seek (only when the backend reports
`capabilities.seek`). Position state is pushed from backend state updates, throttled to ~1 Hz — no
extra rAF loop. Muted playback still reports `playing`. Handlers and metadata are cleared on unmount.

Support: Chromium and Safari are full; Firefox is partial (metadata + play/pause, seek varies).
`setPositionState` is only as accurate as the backend clock (see #205 for worklet sample-rate honesty).
