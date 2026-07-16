# flac_player

A high-quality React application for playing FLAC and WAV audio files with WebGPU shader-based visualization.

## Features

- **Five audio backends**: Streaming (default), Web Audio, AudioWorklet, SDL3 WASM, SDL2 WASM — see [docs/AUDIO_BACKENDS.md](docs/AUDIO_BACKENDS.md)
- **FLAC and WAV Support**: Decode and play via Web Audio, libflac WASM, or CDN streaming (HTTP range requests)
- **Streaming playback (default)**: Instant start on remote files without full download; optional **crossfade / gapless** between queue tracks
- **10-band EQ** and playback-rate control (`EQPanel`)
- **Offline track cache**: Download tracks for offline playback via Cache API (`OfflineCache` UI)
- **WebGPU Visualization**: Real-time ShaderGUI hardware panel with audio-reactive WGSL shaders
- **WebGL2 / Canvas2D fallback**: Automatic fallback when WebGPU is unavailable
- **projectM Milkdrop** (optional): In-app visualizer — `?aesthetic=projectm|split`; build with `npm run build:projectm`
- **Library management**: Ratings, tags, smart mix, queue, shareable playlists
- **Multiple Audio Sources**: Load audio from:
  - Google Cloud Storage buckets
  - FTP servers (via HTTP/HTTPS proxy)
  - Direct HTTP/HTTPS URLs
- **Full Playback Controls**:
  - Load audio from URL
  - Play/Pause
  - Seek to any position
  - Real-time progress tracking
- **Modern UI**: Beautiful gradient interface with responsive design
- **Static Hosting Ready**: Compiled to static files for easy deployment

## Technology Stack

- React 18
- TypeScript
- WebGPU API (primary visualization)
- WebGL2 API (reference fallback, shader-debug friendly)
- Web Audio API
- Webpack 5
- CSS3 with modern gradients

## Installation

```bash
npm install
```

## Development

Start the development server:

```bash
npm start
```

Optional verbose logging (`[FLAC:*]` tags in the console):

```bash
# .env
REACT_APP_DEBUG=true
```

### Tests

```bash
npm run test:decoder   # libflac decode unit test
npm run test:e2e       # Playwright smoke tests (tests/smoke.spec.ts)
npm test               # both
```

If you are developing with the SDL-based audio engine (Emscripten build), build the WASM bundles first:

```bash
# One-time: install and activate Emscripten (from repo root)
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk && ./emsdk install latest && ./emsdk activate latest
source ./emsdk_env.sh

# Build both SDL3 and SDL2 WASM artifacts into public/
cd ..   # back to repo root
npm run build:wasm              # scripts/build-wasm.sh --all
npm run build:wasm:sdl3         # SDL3 only (same as bash src/sdl/build.sh)
npm run build:wasm:sdl2         # SDL2 only (same as bash src/sdl/build_sdl2.sh)

npm start
```

**WASM policy:** C++ sources live in `src/sdl/`; compiled `public/sdl-audio.*` and `public/sdl2-audio.*` are committed to the repo. CI runs `npm run verify:wasm` to ensure the source hash in `public/wasm-source.sha256` matches. PRs that touch SDL sources also run an optional emsdk build job.

**Production webpack build** does not compile WASM (no emsdk required). It copies prebuilt artifacts from `public/`:

```bash
npm run build                   # webpack only (--env skipWasm=true in CI)
npm run build:all               # build:wasm + webpack
```

SDL WASM glue (~1.3 MiB) is **not** in the main JS bundle — backend modules and Emscripten scripts load only when the user selects SDL3/SDL2.

This will open the app at `http://localhost:3000`

## Production Build

Build for production (uses pre-committed WASM in `public/`; no emsdk needed):

```bash
npm run build
```

Full rebuild including WASM:

```bash
npm run build:all
```

The compiled files will be in the `dist/` directory, ready for static hosting.

## Usage

1. Open the app — **streaming** backend starts tracks quickly from the library (`storage.noahcohn.com` by default)
2. Switch audio backend in settings if needed (Worklet for projectM PCM tap; Web Audio for debugging)
3. Use Play/Pause, seek, queue, EQ panel, and crossfade toggle (streaming mode)
4. Toggle visualizer aesthetic: ShaderGUI, projectM Milkdrop, or split view
5. Download tracks for offline playback from the library row actions

For manual URL loading: enter a FLAC/WAV URL, click Load, then play.

### Documentation

| Doc | Contents |
|-----|----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System diagram, data flows |
| [docs/AUDIO_BACKENDS.md](docs/AUDIO_BACKENDS.md) | When to use each backend |
| [docs/API.md](docs/API.md) | REST + projectM embed |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Open issues #166–#175 |

### Visualization Backends

The ShaderGUI visualizer resolves backends automatically: **WebGPU → WebGL2 → Canvas2D**.

| Backend | When used | Debug |
|---------|-----------|-------|
| `webgpu` | Default when adapter available | — |
| `webgl2` | Manual override or WebGPU failure | Alt+D cycles debug modes |
| `canvas2d` | Last resort when GPU shaders unavailable | Basic bars + waveform |

**Force a backend:**

```
?visualizer=webgl2
?renderer=webgl2          # alias (sibling-project compat)
```

**From devtools:**

```js
window.DEBUG_VISUALIZER = 'webgl2';
window.currentVisualizer.setDebugMode('uv');
window.currentVisualizer.readPixels();
```

### Storage & Library Management

- Use **⬆️ Add Music** in the player UI to open the storage admin in a new tab: `https://storage.noahcohn.com/admin`
- Use **🔄 Rescan Library** in the player UI after uploads to trigger `POST /api/admin/sync-music?type=music` and refresh `songs.json` indexing.
- The player now prefers `storage.1ink.us` for streaming for tracks served from `storage.noahcohn.com`, and safely falls back to the original URL if the fast mirror is unavailable.
- In HTML mode, use the **Storage Source** selector to browse all tracks or only fast-mirror tracks from `storage.1ink.us`.
- For reliable cataloging, upload through the storage admin workflow (not direct mirror/FTP writes), then run a rescan if tracks do not appear immediately.
- Cloud playlist workflows are backed by `https://github.com/ford442/contabo_storage_manager` (linked from the Playlists tab).

### Supported URL Formats

**Google Cloud Storage:**
```
https://storage.googleapis.com/your-bucket-name/path/to/file.flac
```

**Direct URLs:**
```
https://example.com/audio/sample.flac
https://example.com/audio/sample.wav
```

**FTP (via HTTP proxy):**
```
https://your-ftp-proxy.com/path/to/file.flac
```

## Browser Requirements

- Modern browser with WebGPU support (Chrome 113+, Edge 113+) for full GPU visuals
- WebGL2 for reference fallback visualization (most modern browsers)
- Web Audio API support (all modern browsers)
- CORS-enabled audio sources

If WebGPU is not supported, the player falls back to WebGL2 (shader parity) or Canvas2D (basic bars).

## Deployment

The application is designed for static hosting. After building, upload the contents of the `dist/` directory to any static web host:

- Apache/Nginx web servers
- GitHub Pages
- Netlify
- Vercel
- AWS S3 + CloudFront
- Any shared hosting with static file support

### CORS Configuration

Ensure your audio sources have proper CORS headers configured:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET
```

### AudioWorklet / Cross-Origin Isolation

When using the modern AudioWorklet backend (recommended for lower latency and better audio performance), browsers require cross-origin isolation. To enable this during development and in production, the server must send these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- Development: the dev server (`webpack-dev-server`) adds these headers automatically when running `npm start`.
- Production: configure your hosting provider to emit the headers above. For example:
  - Netlify: use `_headers` file or Netlify headers config
  - Vercel: configure headers in `vercel.json` or platform settings
  - S3/CloudFront: configure CloudFront response headers or Lambda@Edge

Without these headers, the browser will block the AudioWorklet/SharedArrayBuffer functionality and the SDL audio backend may fall back to ScriptProcessor or fail to initialize. If you cannot set these headers, the project includes a ScriptProcessor→AudioWorklet shim as a fallback, but enabling COOP/COEP is the recommended path for best audio performance.

## Project-M Visualizer Integration

The player includes an **in-app projectM host** (Milkdrop mode) plus external embed/popup feeding. Toggle aesthetics in the UI or via `?aesthetic=projectm|split|shadergui`. Build WASM with `npm run build:projectm` — see [docs/API.md](docs/API.md#projectm-visualizer-integration).

The player can also feed raw PCM audio data to an external [projectM](https://github.com/projectM-visualizer/projectm) visualizer in a popup window or iframe on the same page.

### How it works

When the **AudioWorklet** backend is active (the default for modern browsers), the `FlacProcessor` worklet accumulates 512 samples per channel from both buffered and streaming playback and posts them to the main thread as audio-clock-synchronized PCM blocks (~86 blocks/s at 44,100 Hz).  The main thread then forwards every block to the visualizer via:

1. `window.opener.postMessage` / `window.parent.postMessage` – cross-origin safe; works for popups opened with `window.open` and for `<iframe>` embeds.
2. `BroadcastChannel('projectm-audio')` – same-origin fallback for multi-tab or worker usage.

For non-worklet modes (streaming, SDL, ScriptProcessor fallback) the existing AnalyserNode + `requestAnimationFrame` path is used instead (~60 fps, mono).

### Receiving PCM in projectM

On the visualizer side listen for `message` events and pass the PCM data to projectM's audio input:

```js
// Popup / iframe approach
window.addEventListener('message', (e) => {
  if (e.data?.type === 'pcm') {
    // e.data.buffer  – Float32Array of interleaved samples
    // e.data.channels – number of channels (1 or 2)
    projectM.addPCMfloat(e.data.buffer, e.data.channels);
  }
});

// BroadcastChannel approach (same origin only)
const bc = new BroadcastChannel('projectm-audio');
bc.onmessage = (e) => {
  if (e.data?.type === 'pcm') {
    projectM.addPCMfloat(e.data.buffer, e.data.channels);
  }
};
```

### Opening as a popup

```js
const player = window.open('https://<your-flac-player-url>', 'flac_player');
// Now listen for 'message' events as shown above.
```

### Embedding as an iframe

```html
<iframe src="https://<your-flac-player-url>" id="flac_player"></iframe>
<script>
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'pcm') {
      projectM.addPCMfloat(e.data.buffer, e.data.channels);
    }
  });
</script>
```

> **Note:** Cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`) is required for the AudioWorklet backend.  See the [AudioWorklet / Cross-Origin Isolation](#audioworklet--cross-origin-isolation) section above.



MIT

## Author

ford442
