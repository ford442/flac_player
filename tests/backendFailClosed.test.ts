// #268: buffered playback that cannot start a worklet fails closed with
// `playable: false` instead of running a ScriptProcessor on the main thread.
// jsdom has neither AudioWorklet nor cross-origin isolation.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioContextManager } from '../src/audio/AudioContextManager';
import { Sdl3AudioPlayer, isSdlEngineSupported } from '../src/audio/backends/Sdl3AudioPlayer';
import { WorkletAudioPlayer } from '../src/audio/backends/worklet/WorkletAudioPlayer';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fail closed without AudioWorklet', () => {
  it('sdl: not playable, initialize and loads reject, and the engine module is never fetched', async () => {
    const append = vi.spyOn(document.head, 'appendChild');
    expect(isSdlEngineSupported()).toBe(false);
    const manager = new AudioContextManager();
    const player = new Sdl3AudioPlayer(manager);
    expect(player.getCapabilities().playable).toBe(false);
    await expect(player.initialize()).rejects.toThrow(/AudioWorklet and a cross-origin isolated page/);
    await expect(player.loadFromArrayBuffer(new ArrayBuffer(8))).rejects.toThrow(/cross-origin isolated/);
    expect(append).not.toHaveBeenCalled();
    expect(manager.hasContext()).toBe(false);
    player.destroy();
  });

  it('sdl: AudioWorklet alone is not enough without cross-origin isolation', () => {
    vi.stubGlobal('AudioWorkletNode', class {});
    vi.stubGlobal('crossOriginIsolated', false);
    expect(isSdlEngineSupported()).toBe(false);
    vi.stubGlobal('crossOriginIsolated', true);
    expect(isSdlEngineSupported()).toBe(true);
  });

  it('worklet: not playable and loads reject before a context opens', async () => {
    const manager = new AudioContextManager();
    const player = new WorkletAudioPlayer(manager);
    expect(player.getCapabilities().playable).toBe(false);
    await expect(player.loadFromArrayBuffer(new ArrayBuffer(8))).rejects.toThrow(/needs AudioWorklet/);
    await expect(player.loadFromURLStreaming('https://example.test/a.flac')).rejects.toThrow(/needs AudioWorklet/);
    expect(manager.hasContext()).toBe(false);
    player.destroy();
  });
});
