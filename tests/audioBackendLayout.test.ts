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
const FALLBACK_DIR = resolve(__dirname, '../src/components/player-fallback');

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

  it('rejects SDL3 stream configure failures in Sdl3AudioPlayer', () => {
    const src = readFileSync(
      resolve(__dirname, '../src/audio/backends/Sdl3AudioPlayer.ts'),
      'utf8'
    );
    expect(src).toMatch(/_set_audio_data\(length: number, channels: number, sampleRate: number\): number/);
    expect(src).toMatch(/_set_stream_format\(channels: number, sampleRate: number\): number/);
    expect(src).toMatch(/configured !== 1/);
    expect(src).toMatch(/SDL stream configure failed \(set_audio_data\)/);
    expect(src).toMatch(/SDL stream configure failed \(set_stream_format\)/);
  });

  it('offers the same audio engines (incl. SDL3, not SDL2) in the transport bar and Settings', () => {
    const types = readFileSync(resolve(FALLBACK_DIR, 'types.ts'), 'utf8');
    expect(types).toMatch(/OUTPUT_MODE_LABELS[^=]*=\s*\{[\s\S]*?\bsdl: 'SDL3'/);
    expect(types).not.toMatch(/sdl2/);
    for (const file of ['PlayerFallbackTransportBar.tsx', 'PlayerFallbackSettingsTab.tsx']) {
      const src = readFileSync(resolve(FALLBACK_DIR, file), 'utf8');
      // Both selects render the shared list; no hand-written engine options.
      expect(src).toMatch(/Object\.entries\(OUTPUT_MODE_LABELS\)/);
      expect(src).not.toMatch(/<option value="(streaming|worklet|web-audio|sdl2?)"/);
    }
  });

  it('exports the SDL3 transport ABI and keeps buffered _seek', () => {
    const build = readFileSync(resolve(__dirname, '../scripts/build-wasm.sh'), 'utf8');
    for (const sym of ['_seek', '_seek_stream', '_set_playback_rate', '_get_device_format']) {
      expect(build).toContain(`"${sym}"`);
    }
    const engine = readFileSync(resolve(__dirname, '../src/sdl/audio_engine.cpp'), 'utf8');
    expect(engine).toMatch(/int seek_stream\(double seconds\)/);
    expect(engine).toMatch(/SDL_SetAudioStreamFrequencyRatio/);
    // Buffered seek still indexes the PCM buffer.
    expect(engine).toMatch(/void seek\(float time\)[\s\S]*?g_state\.playHead = sampleIndex/);

    const player = readFileSync(resolve(BACKENDS_DIR, 'Sdl3AudioPlayer.ts'), 'utf8');
    expect(player).toMatch(/_seek_stream\(target\)/);
    expect(player).toMatch(/this\.module\._seek\(time\)/);
  });

  it('keeps the SDL audio-thread headers allocation-free', () => {
    for (const f of ['pcm_ring.h', 'play_ring.h', 'dsp_chain.h']) {
      const src = readFileSync(resolve(__dirname, '../src/sdl', f), 'utf8');
      expect(src).not.toMatch(/#include <vector>|std::vector|scale_samples/);
    }
    // Limiter works in the linear domain: no per-sample log10.
    const dsp = readFileSync(resolve(__dirname, '../src/sdl/dsp_chain.h'), 'utf8');
    expect(dsp).not.toMatch(/log10/);
  });

  it('hashes every SDL header into wasm-source.sha256', () => {
    const hash = readFileSync(resolve(__dirname, '../scripts/wasm-source-hash.sh'), 'utf8');
    for (const f of ['audio_engine.cpp', 'dsp_chain.h', 'pcm_ring.h', 'play_ring.h']) {
      expect(hash).toContain(`src/sdl/${f}`);
    }
  });
});
