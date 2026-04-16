# FLAC Player - Agent Documentation

This document provides essential information for AI coding agents working on the FLAC Player project.

## Project Overview

FLAC Player is a high-fidelity audio player web application with a **React/TypeScript frontend** and a **FastAPI Python backend**. It plays FLAC and WAV audio files directly in the browser and features a multi-backend audio engine (native Web Audio API, AudioWorklet, and C++ SDL-based WASM modules) with real-time WebGPU shader visualization. It also includes advanced library management: track rating, tagging, smart playlist mixing, a "pile mode" for sorting untagged or low-rated tracks, and playlist sharing.

**Key Capabilities:**
- Play FLAC/WAV audio from URLs (HTTP/HTTPS, Google Cloud Storage)
- Four audio output backends: Web Audio API, AudioWorklet, SDL3 (WASM), SDL2 (WASM)
- Real-time audio visualization using WebGPU shaders (flat waveform + 3D cube modes)
- Music library management with ratings, tags, search, and filtering
- "Pile Mode" for rapid tagging/rating of untagged or low-rated tracks
- Smart Mix: auto-generate queues based on shared tags
- MusicBrainz API integration for auto-populating metadata
- AI-generated track support (parses `generation_model`, `version`, `prompt`)
- Playlist sharing with URL shortening (TinyURL)
- Cross-origin isolation for AudioWorklet/SharedArrayBuffer support

## Technology Stack

| Category | Technology |
|----------|------------|
| Frontend | React 18, TypeScript, CSS3 (Tailwind-like utility classes in `Player.css`) |
| Build System | Webpack 5, Babel, ESLint |
| Audio (Native) | Web Audio API (`AudioContext`, `AnalyserNode`, `BufferSourceNode`) |
| Audio (Worklet) | `AudioWorkletNode` with inline processor blob, ScriptProcessor fallback |
| Audio (WASM) | SDL3/SDL2 compiled via Emscripten |
| Visualization | WebGPU API with WGSL shaders |
| Backend | FastAPI, Pydantic, aiocache, httpx, uvicorn |
| Storage | JSON file persistence (`data/songs/index.json`) |
| Deployment | Static hosting, Netlify, Vercel, Python SFTP script |

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
│   │   ├── Player.css          # Player styles (utility-first)
│   │   ├── LibraryView.tsx     # Grid/list library display
│   │   ├── QueuePanel.tsx      # Queue sidebar/panel
│   │   ├── PileMode.tsx        # "Sort My Pile" rapid-rating mode
│   │   ├── StarRating.tsx      # Reusable star rating widget
│   │   └── TagInput.tsx        # Autocomplete tag input
│   ├── hooks/
│   │   └── useKeyboardShortcuts.ts # Global keyboard shortcuts hook
│   ├── sdl/
│   │   ├── audio_engine.cpp    # SDL3 C++ audio engine
│   │   ├── audio_engine_sdl2.cpp # SDL2 C++ audio engine
│   │   ├── build.sh            # SDL3 build script (outputs to public/)
│   │   └── build_sdl2.sh       # SDL2 build script (outputs to public/)
│   ├── App.tsx                 # Root React component
│   ├── App.css                 # App styles
│   ├── index.tsx               # React entry point
│   ├── audioPlayer.ts          # Native Web Audio API player
│   ├── audioWorkletPlayer.ts   # AudioWorklet player
│   ├── sdlAudioPlayer.ts       # SDL3 WASM wrapper
│   ├── sdl2AudioPlayer.ts      # SDL2 WASM wrapper
│   ├── audioLoader.ts          # Audio fetching + backend API client
│   ├── flacDecoder.ts          # FLAC/WAV decoder (Web Audio API)
│   ├── webgpuVisualizer.ts     # WebGPU visualization engine
│   └── math.ts                 # 3D math utilities (Vec3, Mat4)
├── app.py                      # FastAPI backend
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
# - Proxies /api to http://localhost:7860
# - Automatic COOP/COEP headers for cross-origin isolation
npm start

# Build WASM modules (requires Emscripten/emsdk)
# NOTE: This ONLY builds SDL2. To build SDL3, run bash src/sdl/build.sh
npm run build:wasm

# Build SDL3 manually
bash src/sdl/build.sh

# Production build
# - Runs prebuild (build:wasm -> SDL2 only)
# - Webpack production build
# - Outputs to dist/
npm run build

# Code linting
npm run lint

# Run the FastAPI backend (default port 7860)
python app.py
# or
uvicorn app:app --host 0.0.0.0 --port 7860
```

## Code Style Guidelines

### TypeScript/JavaScript
- **ESLint**: `eslint:recommended`, `plugin:react/recommended`, `@typescript-eslint/recommended`
- **React**: Functional components with hooks
- **Strict Mode**: React `StrictMode` enabled in development
- **Types**: TypeScript strict mode is OFF (`"strict": false` in `tsconfig.json`)

### Naming Conventions
- Components: PascalCase (e.g., `Player.tsx`, `LibraryView.tsx`)
- Utilities: camelCase (e.g., `audioLoader.ts`, `flacDecoder.ts`)
- CSS classes: Tailwind-like utility classes are used inside `Player.css` (e.g., `bg-white/10`, `flex`, `gap-2`)
- Interfaces: PascalCase with descriptive names (e.g., `PlayerState`, `FlacDecoderResult`)

### Code Patterns
- **Observer Pattern**: Players use `setStateChangeCallback` to notify UI of state changes
- **Strategy Pattern**: Four audio player implementations share similar interfaces
- **Manual Resource Management**: WebGPU resources and audio nodes must be explicitly destroyed

## Critical Architecture Details

### Audio Backend Selection
The `Player.tsx` component maintains four possible audio backends:
1. **Web Audio** (`audioPlayer.ts`) - Native browser API, full `AnalyserNode` support
2. **AudioWorklet** (`audioWorkletPlayer.ts`) - Low-latency worklet processor with ScriptProcessor fallback
3. **SDL3** (`sdlAudioPlayer.ts`) - C++ SDL3 compiled to WASM
4. **SDL2** (`sdl2AudioPlayer.ts`) - C++ SDL2 compiled to WASM with AudioWorklet

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
- **Production**: Must be configured on hosting server (see `netlify.toml`/`vercel.json`)

Without these headers:
- AudioWorklet will fail to load
- SharedArrayBuffer will be undefined
- SDL WASM backends may fall back to ScriptProcessor or fail

### WebGPU Visualizer
- Two modes: `'flat'` (waveform) and `'3D'` (rotating cube with screen)
- Requires manual resource cleanup in `destroy()` method
- Runs at 60fps via `requestAnimationFrame`
- Falls back gracefully if WebGPU not supported (Chrome 113+, Edge 113+)

### Backend API (`app.py`)
The FastAPI backend provides:

- **Health**: `GET /`, `GET /api/health`
- **Library**: `GET /api/songs` (filtering, sorting, pagination), `GET /api/library/songs`
- **Tags**: `GET /api/songs/tags`
- **Stats**: `GET /api/songs/stats`
- **CRUD**: `GET /api/songs/{id}`, `POST /api/upload/songs`, `PUT /api/songs/{id}`, `PATCH /api/songs/{id}`, `DELETE /api/songs/{id}`
- **Plays**: `POST /api/songs/{id}/play` (increments `play_count`)
- **Trash**: `POST /api/songs/{id}/trash` (sets `rating=0`, adds `trash` tag)
- **Tag Suggestions**: `GET /api/songs/{id}/suggest-tags`
- **Share**: `POST /api/share`, `GET /api/share/{share_id}`, `GET /playlist/{share_id}`
- **MusicBrainz**: `GET /api/musicbrainz/search`

**Storage**: Uses `StorageManager` class with an in-memory cache backed by `data/songs/index.json`.

### Audio Data Flow
```
User selects track
    ↓
audioLoader.loadFromURL() → fetch() with CORS
    ↓
flacDecoder.decode() → AudioContext.decodeAudioData()
    ↓
Player backend (Web Audio / Worklet / SDL3 / SDL2)
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
4. Switch between audio backends (Web Audio → Worklet → SDL3 → SDL2)
5. Test playlist loading from `/api/songs`
6. Verify 3D mode interaction (drag to rotate, click to play/pause)
7. Test library features: rating a track, adding tags, smart mix, pile mode
8. Verify backend health endpoint returns 200

## Security Considerations

### CORS Requirements
All audio sources and API calls must have proper CORS headers:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET
```
The FastAPI backend already adds `CORSMiddleware` with `allow_origins=["*"]`.

### Content Security
- No `eval()` or inline scripts
- TypeScript provides type safety
- No external analytics or data collection
- Client-side application with optional backend

### HTTPS Requirement
Due to SharedArrayBuffer usage, the app must be served over HTTPS (except localhost).

## Known Issues & Limitations

1. **SDL Analyser**: SDL backends return a dummy `AnalyserNode` — visualization may flatline when using SDL audio
2. **Test Suite**: No automated tests configured
3. **WASM Build Scope**: `npm run build:wasm` only compiles SDL2. SDL3 must be built manually via `bash src/sdl/build.sh`
4. **Hardcoded Deploy Credentials**: `deploy.py` contains server-specific configuration
5. **Memory Constraints**: Large audio files may require WASM memory growth (`ALLOW_MEMORY_GROWTH=1` is enabled)

## Development Workflow

1. **Setup**: `npm install`
2. **Backend**: `python app.py` (ensure `data/` directory is writable)
3. **WASM Build** (if modifying C++): Ensure emsdk is installed and run the appropriate `build.sh` or `build_sdl2.sh`
4. **Development**: `npm start` - opens at http://localhost:3000
5. **Lint**: `npm run lint` - must pass before committing
6. **Build**: `npm run build` - outputs production bundle to `dist/`
7. **Deploy**: Use `deploy.py` for SFTP, or configure Netlify/Vercel as needed

## File Dependencies

Key module dependencies:
- `Player.tsx` → `audioPlayer.ts`, `audioWorkletPlayer.ts`, `sdlAudioPlayer.ts`, `sdl2AudioPlayer.ts`, `audioLoader.ts`, `webgpuVisualizer.ts`, `useKeyboardShortcuts.ts`, `LibraryView.tsx`, `QueuePanel.tsx`, `PileMode.tsx`, `StarRating.tsx`
- `audioPlayer.ts` → `flacDecoder.ts`
- `audioWorkletPlayer.ts` → `flacDecoder.ts`
- `sdlAudioPlayer.ts` → `flacDecoder.ts`
- `sdl2AudioPlayer.ts` → `flacDecoder.ts`
- `webgpuVisualizer.ts` → `math.ts`
- `app.py` → `data/songs/index.json` (runtime)

## External APIs

- **Backend API**: Default base URL is `https://storage.noahcohn.com` (override with `REACT_APP_API_URL`)
- **MusicBrainz**: `https://musicbrainz.org/ws/2`
- **TinyURL**: Optional URL shortening for playlist shares (`TINYURL_API_KEY` env var)
- **Audio Sources**: Any CORS-enabled HTTP/HTTPS URL, Google Cloud Storage (`gs://`)

## Browser Compatibility

- **Required**: Chrome 90+, Firefox 88+, Safari 14+, Edge 90+
- **WebGPU**: Chrome 113+, Edge 113+ (optional - visualization falls back gracefully)
- **Web Audio API**: All modern browsers
- **SharedArrayBuffer**: Requires cross-origin isolation headers
