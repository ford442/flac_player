import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const BACKEND_MODULES = [
  'StreamingAudioPlayer.ts',
  'WebAudioPlayer.ts',
  'WorkletAudioPlayer.ts',
  'Sdl3AudioPlayer.ts',
  'Sdl2AudioPlayer.ts',
] as const;

const BACKENDS_DIR = resolve(__dirname, '../src/audio/backends');

describe('audio backend package layout', () => {
  it('keeps all five backends under src/audio/backends/', () => {
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
    expect(factorySource).toMatch(/\.\/backends\/Sdl2AudioPlayer/);
  });
});
