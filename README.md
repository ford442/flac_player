# flac_player

A high-quality React application for playing FLAC and WAV audio files with WebGPU shader-based visualization.

## Features

- **FLAC and WAV Support**: Decodes and plays FLAC and WAV audio files using the Web Audio API
- **WebGPU Visualization**: Real-time audio visualization using WebGPU shaders
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
- WebGPU API
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

If you are developing with the SDL-based audio engine (Emscripten build), build the WASM bundle first:

```bash
# make sure emsdk is installed and activated in your shell
npm run build:wasm
npm start
```

This will open the app at `http://localhost:3000`

## Production Build

Build for production:

```bash
npm run build
```

The compiled files will be in the `dist/` directory, ready for static hosting.

## Usage

1. Enter the URL of a FLAC or WAV file in the input field
2. Click "Load" or press Enter
3. Once loaded, use the Play/Pause button to control playback
4. Use the seek slider to navigate through the audio
5. Watch the WebGPU visualization respond to the audio

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

- Modern browser with WebGPU support (Chrome 113+, Edge 113+)
- Web Audio API support (all modern browsers)
- CORS-enabled audio sources

If WebGPU is not supported, the player will still work but without visualization.

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

The player can feed raw PCM audio data to a [projectM](https://github.com/projectM-visualizer/projectm) (or compatible) visualizer running in a popup window or an iframe on the same page.

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
