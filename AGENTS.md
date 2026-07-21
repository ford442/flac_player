# FLAC Player - Agent Documentation

This document provides essential information for AI coding agents working on the FLAC Player project.

## Project Overview

FLAC Player is a high-fidelity audio player web application with a **React/TypeScript frontend** and a **FastAPI Python backend**. It plays FLAC and WAV audio files directly in the browser and features a **five-backend audio engine** (streaming, Web Audio API, AudioWorklet, SDL3 WASM, SDL2 WASM) with real-time WebGPU shader visualization. It also includes advanced library management: track rating, tagging, smart playlist mixing, and playlist sharing.

**Key Capabilities:**
- Play FLAC/WAV audio from URLs (HTTP/HTTPS, Google Cloud Storage)
- Five audio output backends: **Streaming** (default), Web Audio API, AudioWorklet, SDL3 (WASM), SDL2 (WASM)
- Real-time audio visualization using WebGPU shaders (flat waveform + 3D cube + hardware GUI modes)
- Music library management with ratings, tags, search, and filtering
- Smart Mix: auto-generate queues based on shared tags
- MusicBrainz API integration for auto-populating metadata
- AI-generated track support (parses `generation_model`, `version`, `prompt`)
- Playlist sharing with URL shortening (TinyURL)
- Cross-origin isolation for AudioWorklet/SharedArrayBuffer support

## Technology Stack

| Category | Technology |
|----------|------------|
| Frontend | React 18, TypeScript, CSS3 (Tailwind-like utility classes in `Player.css` and `ShaderGUI.css`) |
| Build System | Webpack 5, Babel, ESLint |
| Audio (Native) | Web Audio API (`AudioContext`, `AnalyserNode`, `BufferSourceNode`) |
| Audio (Worklet) | `AudioWorkletNode` with inline processor blob, ScriptProcessor fallback |
| Audio (WASM) | SDL3/SDL2 compiled via Emscripten |
| Visualization | WebGPU API with WGSL shaders |
| Backend | FastAPI, Pydantic v2, aiocache, httpx, uvicorn |
| Storage | JSON file persistence (`data/songs/index.json`) |
| Deployment | Static hosting, Netlify, Vercel, Python SFTP script (`deploy.py`) |

**Configuration Files:**
- Frontend: `package.json` (npm scripts & dependencies), `tsconfig.json`, `webpack.config.js`, `.eslintrc.json`
- Backend: `requirements.txt` (Python dependencies), `app.py` (single-file FastAPI app), `.env` / `.env.example`
- Deployment: `netlify.toml`, `vercel.json`, `deploy.py`
- There is **no** `pyproject.toml`, `setup.py`, `Cargo.toml`, or similar.

## Project Structure

```
flac_player/
├── public/                      # Static assets
│   ├── index.html              # HTML template
│   ├── sdl-audio.js            # SDL3 WASM module (generated via Emscripten)
│   ├── sdl-audio.wasm          # SDL3 WASM binary (generated)
│   ├── sdl2-audio.js           # SDL2 WASM module (generated via Emscripten)
│   ├── sdl2-audio.wasm         # SDL2 WASM binary (generated)
│   ├── script-processor-shim.js     # AudioWorklet fallback shim
│   └── script-processor-processor.js # AudioWorklet processor
├── src/
│   ├── components/
│   │   ├── Player.tsx          # Main player UI component (~1196 lines)
│   │   ├── Player.css          # Player styles (utility-first)
│   │   ├── LibraryView.tsx     # Grid/list library display with inline editing (~488 lines)
│   │   ├── QueuePanel.tsx      # Queue sidebar/panel with drag-to-reorder (~236 lines)
│   │   ├── StarRating.tsx      # Reusable star rating widget (with trash option)
│   │   ├── TagInput.tsx        # Autocomplete tag input
│   │   └── ShaderGUI/          # Hardware-inspired control panel
│   │       ├── ShaderGUI.tsx   # Main GUI orchestrator (~264 lines)
│   │       ├── TopScreen.tsx   # WebGPU canvas + track info marquee
│   │       ├── BottomScreen.tsx# Scrollable track queue
│   │       ├── Knob.tsx        # Rotary knob control
│   │       ├── Button.tsx      # Hardware-style buttons
│   │       ├── VolumeSlider.tsx# Vertical fader
│   │       ├── Chassis.tsx     # Outer chassis shell
│   │       └── ShaderGUI.css   # GUI-specific styles
│   ├── hooks/
│   │   ├── useKeyboardShortcuts.ts # Global keyboard shortcuts (Space/Arrows/N/P/R/Q/S/Ctrl+K)
│   │   ├── useBeatDetection.ts     # 5-band spectrum analysis + simple beat detection
│   │   ├── useKnob.ts              # Drag interaction hook for rotary knobs
│   │   └── useShaderUniforms.ts    # Shader uniform state management
│   ├── sdl/
│   │   ├── audio_engine.cpp    # SDL3 C++ audio engine (~209 lines)
│   │   ├── audio_engine_sdl2.cpp # SDL2 C++ audio engine
│   │   ├── build.sh            # wrapper -> scripts/build-wasm.sh --sdl3
│   │   └── build_sdl2.sh       # wrapper -> scripts/build-wasm.sh --sdl2
│   ├── shaders/
│   │   ├── waveform.ts         # WGSL shader for ShaderGUI
│   │   └── waveform.wgsl       # Standalone WGSL file (reference)
│   ├── App.tsx                 # Root React component (handles shared playlist routes)
│   ├── App.css                 # App styles
│   ├── index.tsx               # React entry point (StrictMode)
│   ├── audioPlayer.ts          # Native Web Audio API player (~200 lines)
│   ├── audioWorkletPlayer.ts   # AudioWorklet player with ScriptProcessor fallback (~393 lines)
│   ├── sdlAudioPlayer.ts       # SDL3 WASM wrapper (~297 lines)
│   ├── sdl2AudioPlayer.ts      # SDL2 WASM wrapper (~233 lines)
│   ├── audioLoader.ts          # Audio fetching + backend API client (~765 lines)
│   ├── flacDecoder.ts          # FLAC/WAV decoder (Web Audio API)
│   ├── webgpuVisualizer.ts     # WebGPU visualization engine (~687 lines)
│   └── math.ts                 # 3D math utilities (Vec3, Mat4)
├── data/                        # Runtime data directories (must be writable)
│   ├── music/                  # Audio file storage
│   └── songs/                  # JSON index and metadata
│       └── index.json          # Library persistence file
├── app.py                      # FastAPI backend (~1261 lines)
├── deploy.py                   # Python SFTP deployment script
├── package.json                # NPM dependencies and scripts
├── tsconfig.json               # TypeScript configuration (strict mode enabled)
├── webpack.config.js           # Webpack build configuration
├── .eslintrc.json              # ESLint rules
├── netlify.toml                # Netlify deployment config
├── vercel.json                 # Vercel deployment config
├── .env.example                # Environment variable documentation
└── requirements.txt            # Python dependencies
```

## Build Commands

```bash
# Install frontend dependencies
npm install

# Install backend dependencies
pip install -r requirements.txt

# Development server (http://localhost:3000)
# - Webpack dev server with hot reload
# - Proxies /api to http://localhost:7860
# - Automatic COOP/COEP headers for cross-origin isolation
npm start

# Build WASM modules (requires Emscripten/emsdk)
npm run build:wasm              # scripts/build-wasm.sh --all (SDL3 + SDL2)
npm run build:wasm:sdl3         # SDL3 only — equivalent to bash src/sdl/build.sh
npm run build:wasm:sdl2         # SDL2 only — equivalent to bash src/sdl/build_sdl2.sh
npm run build:projectm          # optional projectM Milkdrop host
npm run verify:wasm             # CI: check committed artifacts match sources

# Production build (webpack copies prebuilt public/sdl-*.wasm; no emsdk)
npm run build

# Full rebuild: WASM + webpack
npm run build:all

# Code linting
npm run lint

# Strict TypeScript validation (required before committing)
npm run typecheck

# Run the FastAPI backend (default port 7860)
python app.py
# or
uvicorn app:app --host 0.0.0.0 --port 7860
```

## Environment Variables

Copy `.env.example` to `.env` for local development.

**Backend (`app.py`):**
- `DATA_DIR` — Data storage directory (default: `./data`; use `/data` on Hugging Face Spaces)
- `HOST` / `PORT` — Server bind address (default: `0.0.0.0:7860`)
- `APP_BASE_URL` — Used for generating share links (e.g., `https://your-username-flac-player.hf.space`)
- `CACHE_TTL` — Cache TTL in seconds (default: `300`)
- `MUSICBRAINZ_USER_AGENT` — Required for MusicBrainz API access
- `TINYURL_API_KEY` — Optional TinyURL API key for playlist URL shortening
- `CORS_ALLOWED_ORIGINS` — Comma-separated list (default: `*`)

**Frontend (webpack `DefinePlugin`):**
- `REACT_APP_API_URL` — Override API base URL (default: same-origin / `window.location.origin`)
- `REACT_APP_GA_ID` — Optional Google Analytics 4 Measurement ID
- `REACT_APP_MIXPANEL_TOKEN` — Optional Mixpanel project token
- `REACT_APP_DEBUG` — Set to `true` for verbose `[FLAC:*]` console logging (off by default)

## Code Style Guidelines

### TypeScript/JavaScript
- **ESLint**: `eslint:recommended`, `plugin:react/recommended`, `@typescript-eslint/recommended`
- **React**: Functional components with hooks
- **Strict Mode**: React `StrictMode` enabled in development (`src/index.tsx`)
- **Types**: TypeScript strict mode is ON (`"strict": true` in `tsconfig.json`)
- **Target**: ES2020; libraries include DOM, DOM.Iterable, WebWorker
- **JSX**: `react-jsx` transform (no need to import React for JSX)

### Naming Conventions
- Components: PascalCase (e.g., `Player.tsx`, `LibraryView.tsx`)
- Utilities: camelCase (e.g., `audioLoader.ts`, `flacDecoder.ts`)
- CSS classes: Tailwind-like utility classes are used inside `Player.css` and `ShaderGUI.css` (e.g., `bg-white/10`, `flex`, `gap-2`)
- Interfaces: PascalCase with descriptive names (e.g., `PlayerUIState`, `AudioPlaybackState`, `FlacDecoderResult`)

### Strict TypeScript Policy
- `npm run typecheck` must pass alongside lint; CI runs both on every pull request.
- Shared domain contracts belong in `src/types/`. Keep backend playback state (`AudioPlaybackState`) distinct from React UI state (`PlayerUIState`).
- Do not introduce explicit `any` in application code. Use `unknown` at API, worker, and storage boundaries, then narrow it with type guards.
- Generated Emscripten glue under `public/sdl*.js` is excluded from TypeScript migration and must not be hand-edited.

### Code Patterns
- **Observer Pattern**: Players use `setStateChangeCallback` to notify UI of state changes
- **Strategy Pattern**: Five audio player implementations share the `AudioBackend` / `ConfigurableAudioBackend` interface via `createAudioBackend()`
- **Manual Resource Management**: WebGPU resources and audio nodes must be explicitly destroyed

## Critical Architecture Details

### Audio Backend Selection
The `Player.tsx` component selects one of five backends via `createAudioBackend()` (lazy dynamic imports):
1. **Streaming** (`streamingAudioPlayer.ts`) - Default. HTMLAudioElement + HTTP range requests; crossfade support
2. **Web Audio** (`audioPlayer.ts`) - Full fetch + decode; buffered `BufferSourceNode`
3. **AudioWorklet** (`audioWorkletPlayer.ts`) - Low-latency worklet; `setPCMCallback` for projectM PCM tap
4. **SDL3** (`sdlAudioPlayer.ts`) - C++ SDL3 compiled to WASM; PCM ring → `SdlPcmBridge` → analyser
5. **SDL2** (`sdl2AudioPlayer.ts`) - C++ SDL2 compiled to WASM with AudioWorklet glue

See `docs/AUDIO_BACKENDS.md` for selection guidance.

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

- **Development**: Webpack dev server adds these automatically (`webpack.config.js` devServer.headers)
- **Production**: Must be configured on hosting server (see `netlify.toml`/`vercel.json`)

Without these headers:
- AudioWorklet will fail to load
- SharedArrayBuffer will be undefined
- SDL WASM backends may fall back to ScriptProcessor or fail

### WebGPU Visualizer
- Three modes: `'flat'` (waveform), `'3D'` (rotating cube with screen), `'gui'` (ShaderGUI hardware panel)
- Requires manual resource cleanup in `destroy()` method
- Runs at 60fps via `requestAnimationFrame`
- Falls back gracefully if WebGPU not supported (Chrome 113+, Edge 113+)

### WebGL2 Fallback (`src/visuals/`)
- **Renderer selection**: `src/visuals/rendererSelection.ts` — `webgpu → webgl2 → canvas2d` with `?visualizer=` URL param, `localStorage`, and `window.DEBUG_VISUALIZER`
- **WebGL2 reference renderer**: `src/visuals/webgl2/WebGL2Visualizer.ts` — GLSL port of `src/shaders/waveform.ts` with shared uniform/audio data via `src/visuals/visualSync.ts`
- **Canvas2D last resort**: `src/visuals/webglFallback.ts` — basic frequency bars when both GPU backends fail
- **Debug helpers**: `window.currentVisualizer`, Alt+D debug mode cycling (uv, waveform-only, audio-bins, spectrum), debug panel in ShaderGUI (🎛 button)
- **3D mode on WebGL2**: Renders GUI shader (3D cube is WebGPU-only)

### ShaderGUI Component
The `ShaderGUI` component (`src/components/ShaderGUI/ShaderGUI.tsx`) is a hardware-inspired control panel rendered in the "now-playing" tab. It features:
- **Top Screen**: WebGPU canvas with real-time WGSL shader (waveform, scanlines, chromatic aberration, pulse bloom, knob/LED glows)
- **Bottom Screen**: Scrollable track queue with active-track highlighting
- **Knobs**: RSYCRB (chromatic aberration), FRACTAL (waveform detail), PULSE (bloom intensity)
- **Buttons**: NONE, IR (visual modes), STOP, PLAY, PREV, NEXT
- **Volume Slider**: Vertical fader with tick marks
- **Hidden 3D Mode**: Double-click the top screen to toggle between the GUI shader and the 3D rotating cube visualizer

**Critical Note — Shader-to-CSS Alignment:**
The WGSL shader in `src/shaders/waveform.ts` hardcodes UV coordinates for knob glows and LED glows to match the CSS grid layout. If you modify `.shader-gui-layout`, `.shader-gui-top-right`, knob positions, or button positions in `ShaderGUI.css`, you **must** recalibrate the UV coordinates in the WGSL shader's `drawKnobGlow` and `drawLedGlow` calls. The alignment map is documented in comments inside `waveform.ts`.

### Backend API (`app.py`)
The FastAPI backend provides the following endpoints (verified from `app.py`):

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

**Storage**: Uses an in-memory cache backed by `data/songs/index.json`. The `data/` directory must be writable at runtime.

### Audio Data Flow
```
User selects track
    ↓
audioLoader / songApi → absolute https:// URL from storage.noahcohn.com
    ↓
createAudioBackend(mode) — streaming (default) | web-audio | worklet | sdl | sdl2
    ↓
AudioContextManager (EQ, analyser, volume)
    ↓
AnalyserNode → VisualizerShell (WebGPU / WebGL2 / Canvas2D / projectM)
    ↓
AudioDestination → Speakers
```

Buffered backends: `fetch(url) → decode → AudioBuffer`. Streaming: `<audio src>` + range requests (no full download).

## Testing Instructions

```bash
npm run test:decoder   # libflac decode unit test
npm run test:e2e       # Playwright smoke tests
npm run typecheck && npm run lint
npm audit --audit-level=high   # CI also runs this (warn-only); see Dependency audit
```

Manual testing checklist:
1. Load a track from the library (streaming default — instant start)
2. Test play/pause/seek controls
3. Verify WebGPU visualization responds to audio
4. Switch between all five audio backends
5. Test EQ panel and crossfade toggle (streaming mode)
6. Test offline track download / evict
7. Test playlist loading from `/api/songs`
8. Verify 3D mode interaction (drag to rotate, click to play/pause)
9. Test library features: rating a track, adding tags, smart mix
10. Verify backend health endpoint returns 200
11. **ShaderGUI**: Verify knobs affect the waveform (RSYCRB = chromatic aberration, FRACTAL = detail, PULSE = bloom)
12. **ShaderGUI**: Double-click top screen to toggle 3D cube mode
13. **ShaderGUI**: Verify volume slider is vertical with tick marks
14. **ShaderGUI**: Confirm active track in bottom screen has highlight + play overlay
15. Test queue drag-to-reorder functionality
16. Test keyboard shortcuts: Space (play/pause), Arrows (seek/volume), N/P (next/prev), Q (queue), S (pile), Ctrl+K (search)
17. **projectM** (if WASM built): toggle Milkdrop / Split aesthetic; verify fallback when WASM missing
18. **Local drag-drop**: Drop a FLAC/WAV onto the player (buffered mode) and confirm MetadataPanel shows title/artist/format

## Dependency audit

CI (`lint-and-build` job) runs `npm audit --audit-level=high` with **`continue-on-error: true`** (warn-only). Flip to enforcing once remaining moderate findings are cleared or explicitly waived.

**Do not** run `npm audit fix --force` without verifying compatibility — force upgrades can jump `webpack-dev-server` 4→5 and `copy-webpack-plugin` 11→14.

Local metadata parsing uses **`music-metadata` only** (`parseBlob` / `parseBuffer`). The deprecated `music-metadata-browser` package must not be reintroduced.

### Accepted risks (moderate / tooling-only)

| Area | Why accepted |
|------|----------------|
| `lighthouse` → `@sentry/node` → OpenTelemetry | Optional profiling dep (`optionalDependencies`); not shipped in the production bundle |
| `webpack-dev-server@4` → `sockjs` → `uuid` | Dev-server only; fixing requires webpack-dev-server 5 (major). Stay on 4.x until a dedicated upgrade |
| `npm overrides` for `serialize-javascript` / `minimatch` | Patches high CVEs in webpack/eslint transitive trees without major parent bumps |

Re-check after tooling major upgrades: `npm audit --audit-level=high`.

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
- No external analytics or data collection (optional GA/Mixpanel via env vars)
- Client-side application with optional backend

### HTTPS Requirement
Due to SharedArrayBuffer usage, the app must be served over HTTPS (except localhost).

### Deployment Credentials
`deploy.py` contains hardcoded server credentials. This is a known issue — do not commit sensitive credentials in production.

## Known Issues & Limitations

1. **Streaming vs buffered**: Streaming requires URL + CORS + Accept-Ranges; cannot load raw ArrayBuffers. Crossfade is streaming-only.
2. **Test coverage**: Vitest unit tests (`queueUtils`, `audioDecoder`, `rendererSelection`) + Playwright smoke suite; expand audio pipeline integration ([#172](https://github.com/ford442/flac_player/issues/172))
3. **WASM Build**: `scripts/build-wasm.sh` builds both SDL3 and SDL2; SDL3 also via `bash src/sdl/build.sh`; `npm run verify:wasm` checks artifact freshness in CI
4. **Hardcoded Deploy Credentials**: `deploy.py` contains server-specific configuration
5. **Memory Constraints**: Large audio files may require WASM memory growth (`ALLOW_MEMORY_GROWTH=1` is enabled in build scripts)
6. **Shader-to-CSS Fragility**: WGSL knob/LED glow positions are hardcoded to match CSS layout. Changing the layout requires updating `waveform.ts`

## Development Workflow

1. **Setup**: `npm install` and `pip install -r requirements.txt`
2. **Data directories**: Ensure `data/music/` and `data/songs/` exist and are writable
3. **Backend**: `python app.py` (runs on port 7860 by default)
4. **WASM Build** (if modifying C++): `npm run build:wasm`, commit `public/sdl-audio.*`, `public/sdl2-audio.*`, and `public/wasm-source.sha256`
5. **Development**: `npm start` — opens at http://localhost:3000 with hot reload
6. **Lint**: `npm run lint` — must pass before committing
7. **Build**: `npm run build` — outputs production bundle to `dist/`
8. **Deploy**: Use `deploy.py` for SFTP, or configure Netlify/Vercel as needed

## File Dependencies

Key module dependencies:
- `Player.tsx` → `audioPlayer.ts`, `audioWorkletPlayer.ts`, `sdlAudioPlayer.ts`, `sdl2AudioPlayer.ts`, `audioLoader.ts`, `webgpuVisualizer.ts`, `useKeyboardShortcuts.ts`, `LibraryView.tsx`, `QueuePanel.tsx`, `StarRating.tsx`, `ShaderGUI.tsx`
- `ShaderGUI.tsx` → `WebGPUVisualizer`, `useBeatDetection`, `TopScreen`, `BottomScreen`, `Knob`, `Button`, `VolumeSlider`, `Chassis`
- `audioPlayer.ts` → `flacDecoder.ts`
- `audioWorkletPlayer.ts` → `flacDecoder.ts`
- `sdlAudioPlayer.ts` → `flacDecoder.ts`
- `sdl2AudioPlayer.ts` → `flacDecoder.ts`
- `webgpuVisualizer.ts` → `math.ts`, `waveform.ts`
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

## Cursor Cloud specific instructions

Dependencies (npm + pip) are installed automatically by the startup update script. Standard commands live in the **Build Commands** / **Testing Instructions** sections above; the notes below are the non-obvious cloud caveats only.

- **The frontend talks to the REMOTE backend by default.** The committed `.env` / `.env.production` set `REACT_APP_API_URL=https://storage.noahcohn.com`, so `npm start` alone yields a fully working library (~351 tracks) and streaming playback with no local backend. This requires network egress to `storage.noahcohn.com`.
- **The local backend serves an EMPTY library.** `python3 app.py` (port 7860) starts healthy but `data/` is empty, so `/api/health` reports `songs_count: 0`. Running it is optional — only needed for offline/self-hosted testing, and then you must set `REACT_APP_API_URL=http://localhost:7860` and seed `data/music/` + `data/songs/index.json`.
- **The webpack `/api → localhost:7860` proxy is bypassed** whenever `REACT_APP_API_URL` is non-empty (the committed default), so the local backend is not reached even if running.
- **Python console scripts install to `~/.local/bin`** (not on PATH). Run the backend with `python3 app.py` or `python3 -m uvicorn app:app --host 0.0.0.0 --port 7860`.
- **Playwright browsers are not part of `npm install`.** For `npm run test:e2e`, first run `npx playwright install chromium` (add `--with-deps` for system libs).
- **WebGPU is unavailable in headless Chrome**, so the visualizer falls back to Canvas2D ("Using Canvas2D fallback — limited shader parity"). This is expected and not an error; audio playback and visualization still work.
- **WASM builds need Emscripten/emsdk, which is NOT installed.** Prebuilt `public/sdl-audio.*` / `sdl2-audio.*` are committed, so `npm start`, `npm run build`, and all default (streaming) playback work without emsdk. Only `npm run build:wasm*` requires the toolchain.
- `npm start` uses `--open`; there is no desktop browser auto-launch in the VM, but the dev server still serves on `http://localhost:3000`.
