# grok.md — Grok AI Assistant Guide for flac_player

> Read this first.

## Project Overview
**flac_player** is a high-quality audio player for FLAC, WAV, and AIFF files using flac.js and SDL3 (via Emscripten/WASM).

- **Focus**: Accurate, high-fidelity playback of lossless audio formats in the browser.
- **Technical Strength**: Uses native-like audio engine via SDL3 + WASM.

## Technology Stack
- TypeScript + Vite
- flac.js + SDL3 (Emscripten)
- WASM for audio processing

## Grok Guidelines
- **Audio Quality**: Prioritize bit-perfect or near-perfect playback and low latency.
- **Format Support**: Make sure FLAC, WAV, and AIFF handling is robust.
- **UI/UX**: Clean player interface with good metadata display, seeking, and playlist support.
- **Performance**: Keep CPU usage reasonable while decoding high-resolution audio.

## Common Tasks
- Improve playback stability and seeking
- Add playlist management and metadata parsing
- Enhance UI and visualizations
- Optimize WASM audio pipeline
- Add format conversion or export features

A great tool for audiophiles and developers. Let’s make lossless audio feel native in the browser. 🎵✨