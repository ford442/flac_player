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

**File:** `src/audio/backends/streamingAudioPlayer.ts`

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

**File:** `src/audio/backends/audioPlayer.ts`

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

**File:** `src/audio/backends/audioWorkletPlayer.ts`

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

**Files:** `src/audio/backends/sdlAudioPlayer.ts`, `src/sdl/audio_engine.cpp`, `public/sdl-audio.*`

**How it works:** Full file fetch → interleaved float → WASM heap → SDL3 audio callback. PCM copied to a lock-free ring; `SdlPcmBridge` AudioWorklet feeds the shared analyser.

**Use when:**
- Testing the Emscripten/SDL experimental path
- Comparing WASM vs native Web Audio output

**Build:** `npm run build:wasm:sdl3` or `bash src/sdl/build.sh` (wrapper to `scripts/build-wasm.sh --sdl3`).

**Notes:** WASM glue loads lazily (~800 KB). Volume is applied in the C++ path. Web Audio destination is muted while SDL owns speakers.

---

### 5. SDL2 WASM (`sdl2`)

**Files:** `src/audio/backends/sdl2AudioPlayer.ts`, `src/sdl/audio_engine_sdl2.cpp`, `public/sdl2-audio.*`

Same as SDL3 but uses SDL2 + AudioWorklet glue. Build: `npm run build:wasm:sdl2` or `bash src/sdl/build_sdl2.sh`.

---

## Sample rate and latency

`AudioContextManager` no longer hardcodes 44100. The context is created lazily,
on first use, with:

- **sampleRate** — probed from the track header (`audioHeader.ts`) before load,
  confirmed after decode/metadata, otherwise the device native rate (option omitted).
- **latencyHint** — user-selected in Settings: `playback` (default), `balanced`,
  or `interactive`. Applies to all backends.

Policy helpers live in `src/audio/audioContextPolicy.ts` (`chooseSampleRate`,
`shouldRecreateContext`, `resolveLatencyHint`).

Backends also report the decoded rate via `contextManager.configure({ sampleRate })`
after decode, or from `onMetadata` on the streaming path.

### Resampling by backend

| Backend | Output rate | Context rate | Resampling |
|---------|-------------|--------------|------------|
| streaming (native) | Source (browser) | Probed from header | `MediaElementSource` → context |
| streaming (hifi) | Track | Probed / metadata | Worklet ring at track rate |
| web-audio | Track | Matched via `configure` | None when rates match |
| worklet | Track | Matched via `configure` | None when rates match |
| SDL3 | Track (WASM) | Matched via `configure` | SDL3 stream at track rate |
| SDL2 | Track (WASM) | Matched via `configure` | SDL2 `AudioStream` source→device if needed |

SDL2 defers `SDL_OpenAudioDevice` until `set_audio_data` / `start_stream` so the
device is not pinned to 44100 at init. The SDL PCM analyser tap renders at
`context.sampleRate`; configure the context to match the track before connecting
`SdlPcmBridge`.

### Why this matters

The browser renders the graph at `context.sampleRate`, then the OS resamples to
the hardware rate. Pinning the context to 44100 meant a 96 kHz file was
resampled **twice** — down to 44.1 kHz, then back up to the device's 48 kHz —
with the intermediate step below the device rate, which is lossy. Matching the
source (or at least the device) removes that second conversion.

Requesting a rate the hardware rejects throws `NotSupportedError`, so
unsupported and exotic rates fall back to device native.

### Cost: context rebuilds

`sampleRate` and `latencyHint` are **construction-time only**. Changing either
means building a new `AudioContext` and rebuilding the graph, because nodes
belonging to a closed context cannot be reconnected. `configure()` therefore:

1. compares against the *live* context and no-ops when nothing changed,
2. closes the old context and rebuilds the master → ReplayGain → EQ → analyser →
   destination chain, carrying volume, EQ, ReplayGain stub, and external-playback
   mute across,
3. notifies `onContextChange` subscribers so backends recreate their nodes.

`useAudioBackendLifecycle` subscribes and recreates the backend. **Playback stops
and the analyser is replaced when this happens**, so the visualiser blanks
briefly. Situations that trigger it:

- changing the user latency mode in Settings
- playing a track whose sample rate differs from the current context

With the default `playback` latency, all five backends share one context until a
sample-rate change forces a rebuild (`tests/smoke.spec.ts`).

### ReplayGain

A stub `GainNode` between master volume and EQ holds a manual dB offset
(`setReplayGainDb`). Full loudness normalization is tracked in #184; the node
and restore-on-rebuild wiring are in place so #184 can drop in tags later.

### Unsupported rates

Requesting a rate the hardware rejects throws `NotSupportedError`, so
unsupported and exotic rates fall back to device native. `recreateOnSampleRateMismatch`
is always on for now.

## SDL streaming mode

Both SDL backends support two playback modes, chosen by `selectDecodeStrategy()`:

| File size | Mode | Memory | Seek |
|---|---|---|---|
| < 32 MB | buffered (`_set_audio_data`) | whole decoded track resident | arbitrary |
| >= 32 MB FLAC | streaming (`_start_stream` + `_feed_pcm_chunk`) | bounded (~8 s of audio) | **not supported** |

Streaming reuses `runHifiStreamPipeline()` — the same Range-fetch + WASM FLAC
decoder the AudioWorklet backend uses — and feeds decoded PCM into a bounded
ring inside the WASM module:

```
HTTP Range → StreamingDecoder → onPcmChunk → _feed_pcm_chunk → feed ring
                                                                   ↓
                                              SDL callback → pcm_ring → analyser
```

`_feed_pcm_chunk` returns the number of samples actually accepted. A short
return means the ring is full, and the backend retries the remainder after
waiting for `_get_buffer_fill_level()` to fall below 75%. That threshold also
gates `waitForCapacity`, which the pipeline awaits between fetched chunks, so
back-pressure reaches all the way up to the network read rather than letting
decoded PCM pile up in JS.

Seek is unsupported while streaming, matching `AudioWorkletPlayer`'s hi-fi
stream path — only a few seconds of audio are resident, so seeking would mean
restarting the decode pipeline at a new byte offset. Files below the threshold
stay buffered and keep arbitrary seek.

New exported symbols (see `scripts/build-wasm.sh`):

| Symbol | Purpose |
|---|---|
| `_start_stream(channels, sampleRate, bufferSeconds)` | Enter streaming mode, size the ring |
| `_feed_pcm_chunk(ptr, samples)` | Push PCM; returns samples accepted |
| `_get_buffer_fill_level()` | Ring fill 0-100, for back-pressure |
| `_set_stream_ended(ended)` | Mark end of decode so underrun ends playback |

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
