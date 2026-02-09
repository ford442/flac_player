# FLAC Player - Agent Documentation

This document provides essential information for AI coding agents working on the FLAC Player project.

## Project Overview

FLAC Player is a high-fidelity audio player web application that plays FLAC and WAV audio files directly in the browser. It features a dual-backend audio engine (native Web Audio API and C++ SDL-based WASM modules) with real-time WebGPU shader visualization.

**Key Capabilities:**
- Play FLAC/WAV audio from URLs (HTTP/HTTPS, Google Cloud Storage, FTP proxies)
- Three audio output backends: Web Audio API, SDL3 (WASM), SDL2 (WASM)
- Real-time audio visualization using WebGPU shaders (flat waveform + 3D cube modes)
- Playlist support fetched from external API
- Cross-origin isolation for AudioWorklet/SharedArrayBuffer support

## Technology Stack

| Category | Technology |
|----------|------------|
| Frontend | React 18, TypeScript, CSS3 |
| Build System | Webpack 5, Babel, ESLint |
| Audio (Native) | Web Audio API (AudioContext, AnalyserNode, BufferSourceNode) |
| Audio (WASM) | SDL3/SDL2 compiled via Emscripten |
| Visualization | WebGPU API with WGSL shaders |
| Deployment | Static hosting (Python SFTP script included) |

## Project Structure

```
flac_player/
├── public/                      # Static assets
│   ├── index.html              # HTML template
│   ├── sdl-audio.js            # SDL3 WASM module (generated)
│   ├── sdl-audio.wasm          # SDL3 WASM binary (generated)
│   ├── sdl2-audio.js           # SDL2 WASM module (generated)
│   ├── sdl2-audio.wasm         # SDL2 WASM binary (generated)
│   ├── script-processor-shim.js     # AudioWorklet fallback shim
│   └── script-processor-processor.js # AudioWorklet processor
├── src/
│   ├── components/
│   │   ├── Player.tsx          # Main player UI component
│   │   └── Player.css          # Player styles
│   ├── sdl/
│   │   ├── audio_engine.cpp    # SDL3 C++ audio engine
│   │   ├── audio_engine_sdl2.cpp # SDL2 C++ audio engine
│   │   ├── build.sh            # SDL3 build script (outputs to public/)
│   │   └── build_sdl2.sh       # SDL2 build script (outputs to dist/)
│   ├── App.tsx                 # Root React component
│   ├── App.css                 # App styles
│   ├── index.tsx               # React entry point
│   ├── audioPlayer.ts          # Native Web Audio API player
│   ├── sdlAudioPlayer.ts       # SDL3 WASM wrapper
│   ├── sdl2AudioPlayer.ts      # SDL2 WASM wrapper
│   ├── audioLoader.ts          # Audio fetching (HTTP, GCS, FTP)
│   ├── flacDecoder.ts          # FLAC/WAV decoder
│   ├── webgpuVisualizer.ts     # WebGPU visualization engine
│   └── math.ts                 # 3D math utilities (Vec3, Mat4)
├── deploy.py                   # Python SFTP deployment script
├── package.json                # NPM dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── webpack.config.js           # Webpack build configuration
├── .eslintrc.json              # ESLint rules
├── netlify.toml                # Netlify deployment config
└── vercel.json                 # Vercel deployment config
```

## Build Commands

```bash
# Install dependencies
npm install

# Development server (http://localhost:3000)
# - Webpack dev server with hot reload
# - Automatic COOP/COEP headers for cross-origin isolation
npm start

# Build WASM modules (requires Emscripten/emsdk)
npm run build:wasm

# Production build
# - Runs prebuild (build:wasm)
# - Webpack production build
# - Outputs to dist/
npm run build

# Code linting
npm run lint
```

## Code Style Guidelines

### TypeScript/JavaScript
- **ESLint**: Configured with `eslint:recommended`, `plugin:react/recommended`, `@typescript-eslint/recommended`
- **React**: Functional components with hooks
- **Strict Mode**: React StrictMode enabled in development
- **Types**: TypeScript strict mode is OFF (`"strict": false` in tsconfig.json)

### Naming Conventions
- Components: PascalCase (e.g., `Player.tsx`, `AudioPlayer.ts`)
- Utilities: camelCase (e.g., `audioLoader.ts`, `flacDecoder.ts`)
- CSS: kebab-case classes (e.g., `.player-controls`, `.visualizer-canvas`)
- Interfaces: PascalCase with descriptive names (e.g., `PlayerState`, `FlacDecoderResult`)

### Code Patterns
- **Observer Pattern**: Players use `setStateChangeCallback` to notify UI of state changes
- **Strategy Pattern**: Three audio player implementations share similar interfaces
- **Manual Resource Management**: WebGPU resources must be explicitly destroyed

## Critical Architecture Details

### Audio Backend Selection
The `Player.tsx` component maintains three possible audio backends:
1. **Web Audio** (`audioPlayer.ts`) - Native browser API, supports AnalyserNode
2. **SDL3** (`sdlAudioPlayer.ts`) - C++ SDL3 compiled to WASM
3. **SDL2** (`sdl2AudioPlayer.ts`) - C++ SDL2 compiled to WASM with AudioWorklet

Switching backends recreates the player instance and resets audio state.

### WASM Memory Management (CRITICAL)
The SDL audio players require careful memory handling:

```typescript
// SDL3: Uses _create_audio_buffer() to allocate, then write to HEAPF32
const ptr = module._create_audio_buffer(length);
const floatIndex = ptr / 4;
module.HEAPF32.set(interleaved, floatIndex);

// SDL2: Uses _malloc(), writes to wasmMemory.buffer or HEAPU8.buffer
const ptr = module._malloc(byteLength);
const destination = new Float32Array(module.wasmMemory.buffer, ptr, length);
destination.set(interleaved);
```

**WARNING**: Emscripten builds with `PTHREADS` and `AUDIO_WORKLET` expose memory differently (`wasmMemory.buffer` vs `HEAPU8.buffer`). The current implementation has multiple fallbacks. Always verify memory access works.

### Cross-Origin Isolation Requirements
The application requires specific headers for AudioWorklet and SharedArrayBuffer:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- **Development**: Webpack dev server adds these automatically
- **Production**: Must be configured on hosting server (see DEPLOYMENT.md)

Without these headers:
- AudioWorklet will fail to load
- SharedArrayBuffer will be undefined
- SDL WASM backends may fall back to ScriptProcessor or fail

### WebGPU Visualizer
- Two modes: `'flat'` (waveform) and `'3D'` (rotating cube with screen)
- Requires manual resource cleanup in `destroy()` method
- Runs at 60fps via `requestAnimationFrame`
- Falls back gracefully if WebGPU not supported (Chrome 113+, Edge 113+)

### Audio Data Flow
```
User enters URL
    ↓
audioLoader.loadFromURL() → fetch() with CORS
    ↓
flacDecoder.decode() → AudioContext.decodeAudioData()
    ↓
Player backend (Web Audio/SDL/SDL2)
    ↓
AnalyserNode → webgpuVisualizer (frequency data)
    ↓
AudioDestination → Speakers
```

## Testing Instructions

**IMPORTANT**: No test runner is currently configured. `npm test` will fail.

Manual testing checklist:
1. Load a FLAC/WAV file from a URL
2. Test play/pause/seek controls
3. Verify WebGPU visualization responds to audio
4. Switch between audio backends (Web Audio → SDL3 → SDL2)
5. Test playlist loading
6. Verify 3D mode interaction (drag to rotate, click to play/pause)

## Security Considerations

### CORS Requirements
All audio sources must have proper CORS headers:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET
```

### Content Security
- No `eval()` or inline scripts
- TypeScript provides type safety
- No external analytics or data collection
- Purely client-side application

### HTTPS Requirement
Due to SharedArrayBuffer usage, the app must be served over HTTPS (except localhost).

## Known Issues & Limitations

1. **SDL Analyser**: SDL backends return a dummy AnalyserNode - visualization may flatline when using SDL audio
2. **Test Suite**: No automated tests configured
3. **Hardcoded Deploy Credentials**: `deploy.py` contains server-specific configuration
4. **Memory Constraints**: Large audio files may require WASM memory growth

## Development Workflow

1. **Setup**: `npm install`
2. **WASM Build** (if modifying C++): Ensure emsdk is installed and run `npm run build:wasm`
3. **Development**: `npm start` - opens at http://localhost:3000
4. **Lint**: `npm run lint` - must pass before committing
5. **Build**: `npm run build` - outputs production bundle to `dist/`
6. **Deploy**: Use `deploy.py` for SFTP, or configure Netlify/Vercel as needed

## File Dependencies

Key module dependencies:
- `Player.tsx` → `audioPlayer.ts`, `sdlAudioPlayer.ts`, `sdl2AudioPlayer.ts`, `audioLoader.ts`, `webgpuVisualizer.ts`
- `audioPlayer.ts` → `flacDecoder.ts`
- `sdlAudioPlayer.ts` → `flacDecoder.ts`
- `sdl2AudioPlayer.ts` → `flacDecoder.ts`
- `webgpuVisualizer.ts` → `math.ts`

## External APIs

- **Playlist API**: `https://ford442-storage-manager.hf.space/api/storage/files?folder={folder}`
- **Audio Sources**: Any CORS-enabled HTTP/HTTPS URL, Google Cloud Storage (gs://), FTP proxies

## Browser Compatibility

- **Required**: Chrome 90+, Firefox 88+, Safari 14+, Edge 90+
- **WebGPU**: Chrome 113+, Edge 113+ (optional - visualization falls back gracefully)
- **Web Audio API**: All modern browsers
- **SharedArrayBuffer**: Requires cross-origin isolation headers
