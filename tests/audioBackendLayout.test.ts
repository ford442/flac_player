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

  it('does not offer SDL2 in the footer output-mode select', () => {
    const src = readFileSync(
      resolve(__dirname, '../src/components/PlayerFallbackView.tsx'),
      'utf8'
    );
    expect(src).toMatch(/<option value="sdl">SDL3<\/option>/);
    expect(src).not.toMatch(/value="sdl2"/);
  });
});
