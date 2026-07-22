# DEVELOPER CONTEXT

Last updated: July 2026

## 1. High-Level Architecture & Intent

*   **Core Purpose:** High-performance in-browser audio player for FLAC/WAV and library-backed streaming. Features a **five-backend audio engine** (streaming, Web Audio, AudioWorklet, SDL3 WASM, SDL2 WASM) and multi-tier visualization (WebGPU ShaderGUI, WebGL2/Canvas2D fallbacks, optional projectM Milkdrop host).
*   **Tech Stack:**
    *   **Frontend:** React 18, TypeScript, CSS3.
    *   **Build:** Webpack 5, Babel, lazy dynamic imports for WASM backends.
    *   **Audio Engines:** See [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md). Default is `StreamingAudioPlayer` (HTMLAudio + range requests).
    *   **Visualization:** WebGPU primary; WebGL2 + Canvas2D via `src/visuals/rendererSelection.ts`; projectM WASM optional.
    *   **Backend API:** FastAPI (`app.py`); production at `storage.noahcohn.com`.
*   **Design Patterns:**
    *   **Strategy Pattern:** `createAudioBackend(mode)` returns a `ConfigurableAudioBackend` implementation.
    *   **Observer Pattern:** Players call `setStateChangeCallback` for UI updates.
    *   **Shared context:** `AudioContextManager` owns one `AudioContext`, EQ chain, and analyser routing.

## 2. Feature Map

| Feature | Entry point |
|---------|-------------|
| Player orchestration | `src/components/Player.tsx` |
| Backend factory | `src/audio/createAudioBackend.ts` |
| Streaming (default) | `src/streamingAudioPlayer.ts` |
| Buffered Web Audio | `src/audioPlayer.ts` |
| AudioWorklet + PCM tap | `src/audioWorkletPlayer.ts` |
| SDL3 / SDL2 WASM | `src/sdlAudioPlayer.ts`, `src/sdl2AudioPlayer.ts` |
| SDL → analyser bridge | `src/audio/SdlPcmBridge.ts`, `src/sdl/pcm_ring.h` |
| Library / API client | `src/api/songApi.ts`, `src/audioLoader.ts` |
| Offline cache | `src/storage/trackCache.ts`, `src/components/OfflineCache.tsx` |
| EQ / crossfade settings | `src/audio/EQChain.ts`, `src/hooks/useAudioSettings.ts` |
| Visualizer shell | `src/components/VisualizerShell.tsx` |
| ShaderGUI | `src/components/ShaderGUI/ShaderGUI.tsx` |
| projectM host | `src/components/ProjectMHost.tsx`, `src/projectm/ProjectMEngine.ts` |
| Renderer selection | `src/visuals/rendererSelection.ts` |

## 3. Complexity Hotspots

*   **WASM memory interop (`sdlAudioPlayer.ts`, `sdl2AudioPlayer.ts`):**
    *   Manual `malloc`, HEAP views, channel interleaving. PTHREADS builds expose memory differently (`wasmMemory.buffer` vs `HEAPU8.buffer`).
*   **SDL PCM ring → AudioWorklet (`SdlPcmBridge.ts`):**
    *   C++ ring buffer written in the SDL audio callback; JS worklet reads and feeds `AnalyserNode`. Required for visualization when SDL owns speaker output.
*   **Cross-origin isolation (`webpack.config.js`, hosting headers):**
    *   COOP/COEP required for AudioWorklet, SharedArrayBuffer, SDL pthreads, projectM WASM.
*   **WebGPU lifecycle (`webgpuVisualizer.ts`):**
    *   Manual resource cleanup in `destroy()`; 60 fps rAF loop.
*   **ShaderGUI layout contract (`src/visuals/waveformContract.ts`):**
    *   Knob/LED glow UVs, palette colors, and intensity scales live in `WAVEFORM_LAYOUT`.
    *   Both WGSL (`src/shaders/waveform.ts`) and GLSL (`src/visuals/webgl2/shaders/waveform.ts`) inject these constants — change positions in **one** place.
    *   `Alt+D` debug modes (`uv`, `waveform-only`, `audio-bins`, `spectrum`) are implemented in both shaders; cycle via ShaderGUI on WebGPU or WebGL2.
    *   Guard: `npm run test:visualizer` asserts layout injection parity + debug mode helpers.

## 4. Inherent Limitations & "Here be Dragons"

*   **Streaming vs buffered:** Streaming cannot load raw ArrayBuffers; buffered backends cannot crossfade. Mode switch resets playback.
*   **Test coverage:** Playwright smoke tests exist; no full audio pipeline integration suite yet ([#172](https://github.com/ford442/flac_player/issues/172)).
*   **Deploy credentials:** `deploy.py` contains environment-specific SFTP config.
*   **HTTPS + isolation:** App requires secure context with COOP/COEP for worklet/SDL/projectM paths.

## 5. Key Flows

**Load and play (streaming — default)**

1. User selects track → `Player.tsx` → `audioLoader` resolves URL from API.
2. `createAudioBackend('streaming')` → `StreamingAudioPlayer.loadFromURL(url)`.
3. `<audio src>` + `MediaElementAudioSourceNode` → `AudioContextManager` → EQ → analyser → visualizer.
4. Optional: `preloadNextTrack` + crossfade 3 s before track end.

**Load and play (worklet — projectM PCM)**

1. `fetch` → decode → `AudioWorkletPlayer` ring buffer.
2. `createProjectMPCMFeed(player)` wires `setPCMCallback` → `projectMBridge` → in-app `ProjectMHost` or external embed.

**Library fetch**

1. `songApi.fetchSongs()` → `GET /api/songs` on `REACT_APP_API_URL` (default `storage.noahcohn.com`).
2. Response cached in `libraryCache.ts` (TTL). Each item includes absolute `https://` `url`.

## 6. Debug logging

Set `REACT_APP_DEBUG=true` in `.env`. Central helper: `src/utils/debug.ts` (used by `audioLoader.ts`, `api/songApi.ts`). **Off by default** in production builds.

## 7. Related docs

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md)
- [ROADMAP.md](./ROADMAP.md)
