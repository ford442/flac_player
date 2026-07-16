# FLAC Player - Implementation Summary

Last updated: July 2026

## Project Overview

A React/TypeScript high-fidelity audio player with **five interchangeable audio backends**, **WebGPU/WebGL2/Canvas2D visualization**, optional **projectM Milkdrop host**, and **library management** backed by `storage.noahcohn.com`.

## Key Features

### Audio
- **Five backends:** Streaming (default), Web Audio, AudioWorklet, SDL3 WASM, SDL2 WASM
- **FLAC/WAV/MP3** via browser decode, libflac WASM, or CDN streaming
- **10-band EQ**, playback rate, volume
- **Crossfade / gapless** (streaming mode, 3 s fade)
- **Offline track cache** via Cache API (`trackCache.ts`)

### Library & playback
- Full library from `GET /api/songs` with filter, sort, pagination
- Ratings, tags, inline editing, smart mix by shared tags
- Queue with drag-reorder, repeat/shuffle, shareable playlists (TinyURL)
- MusicBrainz metadata lookup, AI-generated track fields
- Upload workflow via storage admin + rescan

### Visualization
- **ShaderGUI** — hardware-panel WebGPU shader (waveform, knobs, queue screen)
- **Fallback chain:** WebGPU → WebGL2 → Canvas2D
- **projectM** — optional in-app Milkdrop WASM (`?aesthetic=projectm|split`)
- Beat-sync preset switching, `.milk` import

### Build & quality
- TypeScript strict mode, ESLint, `npm run typecheck`
- Playwright smoke tests (`npm run test:e2e`)
- WASM artifacts (SDL, optional projectM) committed to `public/`
- CI: lint, typecheck, verify:wasm, production build

## Project Structure (abbreviated)

```
flac_player/
├── src/
│   ├── components/       Player, LibraryView, QueuePanel, ShaderGUI, VisualizerShell, ProjectMHost
│   ├── audio/            createAudioBackend, AudioContextManager, EQChain, SdlPcmBridge
│   ├── api/              songApi.ts
│   ├── storage/          libraryCache, trackCache, queueStorage
│   ├── visuals/          rendererSelection, WebGL2 fallback
│   ├── projectm/         ProjectMEngine, projectm_host.cpp
│   ├── streamingAudioPlayer.ts   # default backend
│   ├── audioPlayer.ts
│   ├── audioWorkletPlayer.ts
│   ├── sdlAudioPlayer.ts / sdl2AudioPlayer.ts
│   └── audioLoader.ts
├── public/               SDL + projectM WASM artifacts
├── scripts/              build-wasm.sh, build-projectm-wasm.sh, verify-wasm-artifacts.sh
├── docs/                 ARCHITECTURE.md, AUDIO_BACKENDS.md, API.md
└── tests/                smoke.spec.ts (Playwright)
```

## Build Commands

```bash
npm install
npm start                    # dev server, COOP/COEP headers
npm run build                # production (prebuilt WASM in public/)
npm run build:all            # rebuild SDL WASM + webpack
npm run build:wasm           # SDL3 + SDL2
npm run build:wasm:sdl3      # SDL3 only (also: bash src/sdl/build.sh)
npm run build:projectm       # optional Milkdrop WASM
npm run verify:wasm          # CI artifact freshness check
npm run typecheck && npm run lint
npm test                     # decoder unit + Playwright e2e
```

## Current Working State (July 2026)

Live against **`https://storage.noahcohn.com`**:

- **Library** — full catalog, CORS, tags, ratings, search, smart mix
- **Streaming playback** — default backend; range requests against Contabo/static files
- **Uploads** — storage admin → FLAC conversion → `songs.json` index
- **Shareable playlists** — `?share=<id>` loads from `/api/share/<id>`
- **Five audio backends** — user-selectable; lazy-loaded WASM chunks
- **Visualizer** — ShaderGUI + WebGL2 fallback + optional projectM split mode
- **Offline cache** — per-track download via Cache API
- **Tests** — Playwright smoke suite + decoder unit test

## Browser Requirements

- Modern browser (Chrome 90+, Firefox 88+, Safari 14+)
- Web Audio API (required)
- WebGPU (optional — WebGL2/Canvas2D fallback)
- HTTPS + COOP/COEP for AudioWorklet / SDL WASM / projectM

## Documentation Map

| Doc | Purpose |
|-----|---------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System diagram, data flows, WASM build |
| [AUDIO_BACKENDS.md](./AUDIO_BACKENDS.md) | When to use each backend |
| [API.md](./API.md) | REST endpoints + projectM embed |
| [DEVELOPER_CONTEXT.md](./DEVELOPER_CONTEXT.md) | Agent-oriented complexity notes |
| [ROADMAP.md](./ROADMAP.md) | Open issues #166–#174 |

## Deployment

Static hosting after `npm run build` → `dist/`. Configure COOP/COEP in production. Set `REACT_APP_API_URL=https://storage.noahcohn.com` for production API.

See root `README.md` and `DEPLOYMENT.md` for platform-specific steps.
