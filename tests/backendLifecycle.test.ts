import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from './helpers/renderHook';
import { DEFAULT_AUDIO_BACKEND_CAPABILITIES } from '../src/types/audio';
import type { PlaylistTrack } from '../src/api/audioLoader';

// #236: the backend lifecycle effect must depend only on outputMode. Queue edits,
// index changes and shuffle used to destroy and recreate the player mid-track.

const created: Array<{ mode: string; destroy: ReturnType<typeof vi.fn> }> = [];

function fakeBackend(mode: string) {
  const destroy = vi.fn();
  created.push({ mode, destroy });
  const known: Record<string, unknown> = {
    destroy,
    initialize: () => Promise.resolve(),
    getCapabilities: () => DEFAULT_AUDIO_BACKEND_CAPABILITIES,
    getState: () => ({ isPlaying: false, currentTime: 0, duration: 0, volume: 1 }),
  };
  // Every other backend method is a no-op stub.
  return new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : (prop === 'then' ? undefined : vi.fn())),
  });
}

vi.mock('../src/audio/createAudioBackend', () => ({
  createAudioBackend: vi.fn(async (mode: string) => fakeBackend(mode)),
}));
vi.mock('../src/utils/projectMBridge', () => ({
  createProjectMPCMFeed: () => () => {},
  notifyInAppProjectMTrackChange: () => {},
}));

const { usePlaybackController } = await import('../src/hooks/usePlaybackController');
type Options = Parameters<typeof usePlaybackController>[0];

const track = (id: string): PlaylistTrack => ({ id, name: id, title: id, url: `https://example.test/${id}.flac` });

function options(overrides: Partial<Options> = {}): Options {
  return {
    loader: {} as Options['loader'],
    outputMode: 'streaming',
    setOutputMode: () => {},
    playerState: { isPlaying: false, currentTime: 0, duration: 0, volume: 1 },
    setPlayerState: () => {},
    setError: () => {},
    currentTrack: null,
    setCurrentTrack: () => {},
    setLoadingTrackId: () => {},
    queue: [track('a'), track('b')],
    queueCurrentIndex: 0,
    setQueueCurrentIndex: () => {},
    shuffle: false,
    repeatMode: 'off',
    volume: 1,
    muted: false,
    setVolume: () => {},
    setMuted: () => {},
    prevVolumeRef: { current: 1 },
    eqGains: [],
    playbackRate: 1,
    gaplessSettings: { mode: 'off', crossfadeMs: 0 },
    crossfadeEnabled: false,
    replayGainSettings: { mode: 'off', limiterEnabled: false },
    addToast: () => {},
    loadStats: () => {},
    isSharedPlaylist: false,
    ...overrides,
  };
}

describe('usePlaybackController backend lifecycle (#236)', () => {
  beforeEach(() => { created.length = 0; });

  it('constructs the backend once across a queue append, an index change and a shuffle toggle', async () => {
    const base = options();
    const hook = await renderHook(usePlaybackController, base);
    expect(created).toHaveLength(1);

    await hook.rerender({ ...base, queue: [...base.queue, track('c')] });
    await hook.rerender({ ...base, queue: [...base.queue, track('c')], queueCurrentIndex: 1 });
    await hook.rerender({ ...base, queue: [...base.queue, track('c')], queueCurrentIndex: 1, shuffle: true });

    expect(created).toHaveLength(1);
    expect(created[0]!.destroy).not.toHaveBeenCalled();
    await hook.unmount();
    expect(created[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it('recreates the backend when outputMode changes', async () => {
    const base = options();
    const hook = await renderHook(usePlaybackController, base);
    await hook.rerender({ ...base, outputMode: 'worklet' });

    expect(created.map(c => c.mode)).toEqual(['streaming', 'worklet']);
    expect(created[0]!.destroy).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });
});
