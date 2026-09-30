import { describe, it, expect, vi, afterEach } from 'vitest';
import { AudioContextManager } from '../src/audio/AudioContextManager';
import { Sdl3AudioPlayer } from '../src/audio/backends/Sdl3AudioPlayer';

const RING_CAPACITY = 256;

function fakeModule() {
  const heap = new Float32Array(4096);
  const pushed: number[][] = [];
  const mod = {
    HEAPF32: heap,
    _init_audio: vi.fn(() => 0), // initializeModule bails early; the test drives the module directly
    _malloc: vi.fn(() => 1024), // byte offset → float index 256
    _free: vi.fn(),
    _cleanup: vi.fn(),
    _stop: vi.fn(),
    _get_play_ring_capacity: vi.fn(() => RING_CAPACITY),
    _get_play_ring_fill: vi.fn(() => 0),
    _push_pcm: vi.fn((ptr: number, n: number) => {
      pushed.push(Array.from(heap.subarray(ptr / 4, ptr / 4 + n)));
      return n;
    }),
    _get_pcm_ring_state: vi.fn(() => 0),
    _get_pcm_ring_data: vi.fn(() => 0),
  };
  return { mod, pushed };
}

describe('Sdl3AudioPlayer push staging', () => {
  const win = window as unknown as Record<string, unknown>;
  afterEach(() => {
    delete win.createSdlAudioModule;
    delete win.__sdl_script_processor_shim_loaded;
    vi.restoreAllMocks();
  });

  it('reuses one heap block across push_pcm chunks and frees it on destroy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { mod, pushed } = fakeModule();
    win.__sdl_script_processor_shim_loaded = true;
    win.createSdlAudioModule = async () => mod;

    const player = new Sdl3AudioPlayer(new AudioContextManager());
    await expect(player.initialize()).rejects.toThrow(/failed to initialize/);

    const pcm = Float32Array.from({ length: RING_CAPACITY * 3 + 17 }, (_, i) => i);
    const push = (player as unknown as {
      pushPcmWithBackpressure(pcm: Float32Array, signal: AbortSignal): Promise<void>;
    }).pushPcmWithBackpressure.bind(player);
    await push(pcm, new AbortController().signal);
    await push(pcm.subarray(0, 10), new AbortController().signal);

    expect(mod._malloc).toHaveBeenCalledTimes(1);
    expect(mod._malloc).toHaveBeenCalledWith(RING_CAPACITY * 4);
    expect(mod._push_pcm).toHaveBeenCalledTimes(5);
    expect(pushed.flat()).toEqual([...Array.from(pcm), ...Array.from(pcm.subarray(0, 10))]);
    expect(mod._free).not.toHaveBeenCalled();

    player.destroy();
    expect(mod._free).toHaveBeenCalledWith(1024);
    expect(mod._cleanup).toHaveBeenCalled();
  });
});
