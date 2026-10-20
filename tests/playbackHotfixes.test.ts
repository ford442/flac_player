import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from './helpers/renderHook';
import { DEFAULT_AUDIO_BACKEND_CAPABILITIES } from '../src/types/audio';
import type { PlaylistTrack } from '../src/api/audioLoader';
import { trackFromUrl } from '../src/utils/remoteTracks';

// #258 phase 1 regressions in usePlaybackController: the resume position was never
// saved (bug 4), and URL tracks POSTed to library-only endpoints (bug 11).

function fakeBackend() {
  const known: Record<string, unknown> = {
    destroy: vi.fn(),
    initialize: () => Promise.resolve(),
    getCapabilities: () => DEFAULT_AUDIO_BACKEND_CAPABILITIES,
    getState: () => ({ isPlaying: false, currentTime: 0, duration: 0, isLoading: false }),
    getPlaybackPath: () => null,
    loadFromURL: async () => {},
    play: async () => {},
  };
  return new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : (prop === 'then' ? undefined : vi.fn())),
  });
}

vi.mock('../src/audio/createAudioBackend', () => ({ createAudioBackend: vi.fn(async () => fakeBackend()) }));
vi.mock('../src/utils/projectMBridge', () => ({
  createProjectMPCMFeed: () => () => {},
  notifyInAppProjectMTrackChange: () => {},
}));

const { usePlaybackController, POSITION_STORAGE_KEY } = await import('../src/hooks/usePlaybackController');
type Options = Parameters<typeof usePlaybackController>[0];

const libraryTrack: PlaylistTrack = { id: 'song-1', source: 'library', name: 'a', url: 'https://storage.test/a.mp3' };

function options(overrides: Partial<Options> = {}): Options {
  return {
    loader: { recordPlay: vi.fn(async () => {}) } as unknown as Options['loader'],
    outputMode: 'streaming',
    setOutputMode: () => {},
    playerState: { isPlaying: false, currentTime: 0, duration: 0, isLoading: false },
    setPlayerState: () => {},
    setError: () => {},
    currentTrack: null,
    setCurrentTrack: () => {},
    setLoadingTrackId: () => {},
    queue: [],
    queueCurrentIndex: -1,
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

const savedPosition = () => JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY) ?? 'null');

describe('resume position (#258 bug 4)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('saves every 5 s while timeupdate re-renders about 4×/s', async () => {
    const base = options({ currentTrack: libraryTrack });
    const hook = await renderHook(usePlaybackController, base);
    for (let i = 1; i <= 24; i++) {
      await hook.rerender({ ...base, playerState: { isPlaying: true, currentTime: i * 0.25, duration: 200, isLoading: false } });
      await vi.advanceTimersByTimeAsync(250);
    }
    // The 5 s tick saw the position of that moment, not a stale render's.
    expect(savedPosition()).toEqual({ trackId: 'song-1', time: 5 });
    await hook.unmount();
  });

  it('flushes on pagehide so a reload resumes where playback stopped', async () => {
    const base = options({ currentTrack: libraryTrack });
    const hook = await renderHook(usePlaybackController, base);
    await hook.rerender({ ...base, playerState: { isPlaying: true, currentTime: 42.5, duration: 200, isLoading: false } });
    window.dispatchEvent(new Event('pagehide'));
    expect(savedPosition()).toEqual({ trackId: 'song-1', time: 42.5 });
    await hook.unmount();
  });

  it('does not save for shared playlists', async () => {
    const base = options({ currentTrack: libraryTrack, isSharedPlaylist: true });
    const hook = await renderHook(usePlaybackController, base);
    await hook.rerender({ ...base, playerState: { isPlaying: true, currentTime: 30, duration: 200, isLoading: false } });
    await vi.advanceTimersByTimeAsync(6000);
    window.dispatchEvent(new Event('pagehide'));
    expect(savedPosition()).toBeNull();
    await hook.unmount();
  });
});

describe('library-only endpoints (#258 bug 11)', () => {
  it('records a play for library tracks only', async () => {
    const base = options();
    const hook = await renderHook(usePlaybackController, base);
    const recordPlay = (base.loader as unknown as { recordPlay: ReturnType<typeof vi.fn> }).recordPlay;

    const urlTrack = trackFromUrl('https://example.test/song.mp3')!;
    expect(await hook.result.current.playTrack(urlTrack)).toBe(true);
    expect(recordPlay).not.toHaveBeenCalled();

    expect(await hook.result.current.playTrack(libraryTrack)).toBe(true);
    expect(recordPlay).toHaveBeenCalledWith('song-1');
    await hook.unmount();
  });
});
