import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BACKEND_MODULES = [
  'StreamingAudioPlayer.ts',
  'WebAudioPlayer.ts',
  'WorkletAudioPlayer.ts',
  'Sdl3AudioPlayer.ts',
] as const;

const BACKENDS_DIR = resolve(__dirname, '../src/audio/backends');

describe('audio backend package layout', () => {
  it('keeps playback backends under src/audio/backends/', () => {
    for (const file of BACKEND_MODULES) {
      expect(existsSync(resolve(BACKENDS_DIR, file))).toBe(true);
    }
  });

  it('does not leave legacy root-level backend files', () => {
    const legacy = [
      'streamingAudioPlayer.ts',
      'audioPlayer.ts',
      'audioWorkletPlayer.ts',
      'sdlAudioPlayer.ts',
      'sdl2AudioPlayer.ts',
    ];
    for (const file of legacy) {
      expect(existsSync(resolve(__dirname, '../src', file))).toBe(false);
    }
  });

  it('routes createAudioBackend through backends/ dynamic imports', () => {
    const factorySource = readFileSync(
      resolve(__dirname, '../src/audio/createAudioBackend.ts'),
      'utf8'
    );
    expect(factorySource).toMatch(/\.\/backends\/StreamingAudioPlayer/);
    expect(factorySource).toMatch(/\.\/backends\/WebAudioPlayer/);
    expect(factorySource).toMatch(/\.\/backends\/WorkletAudioPlayer/);
    expect(factorySource).toMatch(/\.\/backends\/Sdl3AudioPlayer/);
    expect(factorySource).not.toMatch(/Sdl2AudioPlayer/);
  });

  it('rejects SDL engine configure failures in Sdl3AudioPlayer', () => {
    const src = readFileSync(
      resolve(__dirname, '../src/audio/backends/Sdl3AudioPlayer.ts'),
      'utf8'
    );
    expect(src).toMatch(/_set_audio_data\(length: number, channels: number, sampleRate: number\): number/);
    expect(src).toMatch(/_set_stream_format\(channels: number, sampleRate: number\): number/);
    expect(src).toMatch(/_set_audio_data\(pcm\.length, channels, rate\) !== 1/);
    expect(src).toMatch(/_set_stream_format\(channels, rate\) !== 1/);
    expect(src).toMatch(/SDL engine configure failed \(set_audio_data\)/);
    expect(src).toMatch(/SDL engine configure failed \(set_stream_format\)/);
  });

  it('does not offer SDL2 in the footer output-mode select', () => {
    // The footer select moved from PlayerFallbackView.tsx into the transport bar.
    const src = readFileSync(
      resolve(__dirname, '../src/components/player-fallback/PlayerFallbackTransportBar.tsx'),
      'utf8'
    );
    const options = readFileSync(
      resolve(__dirname, '../src/components/player-fallback/OutputModeOptions.tsx'),
      'utf8'
    );
    const types = readFileSync(resolve(__dirname, '../src/components/player-fallback/types.ts'), 'utf8');
    expect(src).toMatch(/<OutputModeOptions \/>/);
    expect(options).toMatch(/Object\.entries\(OUTPUT_MODE_LABELS\)/);
    expect(types).toMatch(/\bsdl:\s*'WASM engine'/);
    expect(options).not.toMatch(/sdl2/);
    const settings = readFileSync(
      resolve(__dirname, '../src/components/player-fallback/PlayerFallbackSettingsTab.tsx'),
      'utf8'
    );
    expect(settings).toMatch(/<OutputModeOptions \/>/);
  });

  it('exports the engine transport ABI without linking SDL', () => {
    const build = readFileSync(resolve(__dirname, '../scripts/build-wasm.sh'), 'utf8');
    for (const sym of [
      '_seek', '_seek_stream', '_rebase', '_set_playback_rate', '_is_drained',
      '_set_output_owner', '_get_engine_state', '_get_play_ring_state', '_get_play_ring_data',
    ]) {
      expect(build).toContain(`"${sym}"`);
    }
    // #268: no SDL audio device (and so no ScriptProcessor, no second AudioContext).
    expect(build).not.toMatch(/^\s*-s ?USE_SDL/m);
    const engine = readFileSync(resolve(__dirname, '../src/sdl/audio_engine.cpp'), 'utf8');
    expect(engine).not.toMatch(/#include <SDL|SDL_[A-Z]/);
    expect(engine).toMatch(/int seek_stream\(double seconds\)/);
    // Buffered seek moves the processor's start frame.
    expect(engine).toMatch(/void seek\(float time\)[\s\S]*?engine_frame_at\(time/);

    const player = readFileSync(resolve(BACKENDS_DIR, 'Sdl3AudioPlayer.ts'), 'utf8');
    expect(player).toMatch(/_seek_stream\(target\)/);
    expect(player).toMatch(/module\._seek\(/);
    expect(player).not.toMatch(/createScriptProcessor|ScriptProcessorNode/);
  });

  it('hashes every SDL source the engine includes into wasm-source.sha256', () => {
    const hash = readFileSync(resolve(__dirname, '../scripts/wasm-source-hash.sh'), 'utf8');
    const engine = readFileSync(resolve(__dirname, '../src/sdl/audio_engine.cpp'), 'utf8');
    const included = [...engine.matchAll(/#include "([^"]+)"/g)].map((m) => m[1]);
    expect(included.length).toBeGreaterThan(0);
    for (const f of ['audio_engine.cpp', ...included]) {
      expect(hash).toContain(`src/sdl/${f}`);
    }
  });
});
