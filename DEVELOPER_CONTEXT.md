# DEVELOPER CONTEXT

## 1. High-Level Architecture & Intent

*   **Core Purpose:** This application is a high-performance audio player designed to play high-fidelity formats (FLAC, WAV) directly in the browser. It features a dual-backend audio engine (switching between native Web Audio API and a C++ SDL3-based WASM module) and a real-time, hardware-accelerated audio visualizer using WebGPU.
*   **Tech Stack:**
    *   **Frontend:** React 18, TypeScript, CSS3.
    *   **Build System:** Webpack 5 (custom config), Babel.
    *   **Audio Engines:**
        *   *Native:* Web Audio API (`AudioContext`, `AudioBufferSourceNode`, `AnalyserNode`).
        *   *WASM:* SDL3 (Simple DirectMedia Layer) compiled via Emscripten to WebAssembly, utilizing AudioWorklets and Pthreads.
    *   **Visualization:** WebGPU (WGSL shaders) for high-performance graphics.
    *   **Deployment:** Python script (`deploy.py`) using Paramiko for SFTP.
*   **Design Patterns:**
    *   **Strategy Pattern (Audio Backend):** The `Player` component switches between `AudioPlayer` (native) and `SdlAudioPlayer` (WASM) implementations based on user selection. Both adhere to a similar implicit interface (load, play, pause, seek).
    *   **Observer Pattern:** The players accept a `setStateChangeCallback` to notify the UI of playback progress and status updates.
    *   **Singleton/Global Factory:** The SDL WASM module is loaded once globally (`window.createSdlAudioModule`).

## 2. Feature Map

*   **Audio Playback Orchestration:**
    *   **Entry Point:** `src/components/Player.tsx`
    *   **Description:** Manages UI state, handles user input (URL, play/pause, seek), and instantiates the selected audio backend.
*   **Native Audio Engine:**
    *   **Entry Point:** `src/audioPlayer.ts`
    *   **Description:** Standard Web Audio API implementation. Handles decoding (`flacDecoder.ts`) and playback nodes.
*   **SDL3 WASM Audio Engine:**
    *   **Entry Point:** `src/sdlAudioPlayer.ts` (TypeScript wrapper) & `src/sdl/audio_engine.cpp` (C++ source).
    *   **Description:** A more complex engine providing an alternative playback path. Compiles C++ SDL3 code to WASM. Requires specific memory management interactions between JS and WASM.
*   **WebGPU Visualizer:**
    *   **Entry Point:** `src/webgpuVisualizer.ts`
    *   **Description:** Renders audio-reactive graphics (flat waveform or 3D cube) using raw WebGPU commands and WGSL shaders. Connects to the audio `AnalyserNode`.
*   **Audio Loading & Playlist:**
    *   **Entry Point:** `src/audioLoader.ts`
    *   **Description:** Handles fetching files from HTTP, Google Cloud Storage (`gs://` protocol conversion), and FTP proxies. Fetches playlist metadata from `ford442-storage-manager.hf.space`.

## 3. Complexity Hotspots

*   **WASM Memory Management & Interop (`src/sdlAudioPlayer.ts`):**
    *   **Why it's complex:** Passing audio data from JavaScript (Float32Array) to the C++ WASM heap is dangerous. The code must manually allocate memory (`_malloc`), locate the correct buffer view (`wasmMemory.buffer`, `HEAPU8`, etc.), and copy data.
    *   **Agent Note:** **CRITICAL WARNING.** Emscripten builds with `PTHREADS` and `AUDIO_WORKLET` change how the WASM memory buffer is exposed (`wasmMemory.buffer` vs `HEAPU8.buffer`). The current implementation attempts multiple fallbacks. *Always* verify that `malloc` succeeds and that you are writing to a valid view of the WASM memory. Incorrect access here causes silent failures or browser crashes.
*   **SharedArrayBuffer & Security Headers (`webpack.config.js`):**
    *   **Why it's complex:** The SDL3 WASM build uses `SharedArrayBuffer` for threading. Browsers require specific security headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`) to enable this.
    *   **Agent Note:** If the WASM player fails to load or `SharedArrayBuffer` is undefined, check these headers first. This requirement complicates loading resources from cross-origin domains (CDNs, storage buckets) unless they also serve CORP headers.
*   **WebGPU Resource Lifecycle (`src/webgpuVisualizer.ts`):**
    *   **Why it's complex:** WebGPU requires manual management of buffers, pipelines, and textures. The `render` loop runs at 60fps.
    *   **Agent Note:** Ensure that `destroy()` is called and correctly releases all GPU resources when the component unmounts to prevent memory leaks. Watch out for race conditions where the visualizer might try to render after the device has been destroyed.

## 4. Inherent Limitations & "Here be Dragons"

*   **Known Issues:**
    *   **Test Suite:** There is no configured test runner (`npm test` fails). Tests must be run manually or added.
    *   **SDL Analyser:** The SDL audio player does not currently expose a real Web Audio `AnalyserNode` to the visualizer. It returns a dummy/empty analyser, meaning the visualizer may flatline or show static data when using the SDL backend.
*   **Technical Debt:**
    *   **Hardcoded Deploy Credentials:** `deploy.py` contains logic for specific servers (`1ink.us`). Credentials or paths might need configuration for other environments.
    *   **Build Artifacts in Source Control:** The `dist` folder logic relies on `copy-webpack-plugin` to move pre-built or public artifacts. `src/sdl/build.sh` manually places outputs in `public/`.
*   **Hard Constraints:**
    *   **HTTPS Requirement:** Due to `SharedArrayBuffer`, the app *must* be served over HTTPS (or `localhost`) with the correct isolation headers. It will not work on standard HTTP or insecure contexts.

## 5. Dependency Graph & Key Flows

**Critical Flow: Load and Play Audio**

1.  **User Action:** Enters URL or selects Playlist item -> `Player.tsx`.
2.  **Fetch:** `AudioLoader.loadFromURL(url)` performs `fetch()`.
    *   *Normalization:* Converts `gs://` -> `https://storage.googleapis.com`.
3.  **Decode:**
    *   Returns `ArrayBuffer`.
    *   `FlacDecoder.decode()` uses `AudioContext.decodeAudioData()`.
4.  **Backend Dispatch:**
    *   *If Web Audio:* `AudioPlayer` creates `AudioBuffer` -> `BufferSource` -> `Destination`.
    *   *If SDL:* `SdlAudioPlayer` interleaves channels -> `malloc` WASM memory -> `_set_audio_data` -> C++ Engine Playback.
5.  **Visualization:**
    *   `requestAnimationFrame` -> `WebGPUVisualizer.render()` -> Reads `AnalyserNode` data -> Updates GPU Uniforms -> Draws.
