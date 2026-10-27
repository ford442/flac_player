import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackEngine } from '../src/audio/PlaybackEngine';
import { AudioContextManager } from '../src/audio/AudioContextManager';
import {
  POSITION_SAVE_INTERVAL_MS,
  POSITION_STORAGE_KEY,
  positionKeyForTrack,
  readSavedPosition,
} from '../src/audio/playbackPosition';
import type { AudioPlaybackState, ConfigurableAudioBackend } from '../src/types/audio';
import type { TrackTransitionEvent } from '../src/types/gapless';

interface FakeBackend extends ConfigurableAudioBackend {
  emit(state: Partial<AudioPlaybackState>): void;
  end(event?: TrackTransitionEvent): void;
  loadCalls: string[];
  /** Resolvers for loadFromURL calls, in call order. */
  pendingLoads: (() => void)[];
}

function fakeBackend({ manualLoads = false } = {}): FakeBackend {
  let onState: ((state: AudioPlaybackState) => void) | undefined;
  let onEnded: ((event?: TrackTransitionEvent) => void) | undefined;
  let state: AudioPlaybackState = { isPlaying: false, currentTime: 0, duration: 0, isLoading: false };
  const backend: FakeBackend = {
    loadCalls: [],
    pendingLoads: [],
    emit(patch) {
      state = { ...state, ...patch };
      onState?.(state);
    },
    end(event) { onEnded?.(event); },
    initialize: async () => {},
    destroy: vi.fn(),
    loadFromArrayBuffer: async () => {},
    loadFromURL: (url: string) => {
      backend.loadCalls.push(url);
      if (!manualLoads) return Promise.resolve();
      return new Promise<void>((resolve) => backend.pendingLoads.push(resolve));
    },
    play: vi.fn(() => { backend.emit({ isPlaying: true }); }),
    pause: vi.fn(() => { backend.emit({ isPlaying: false }); }),
    stop: vi.fn(() => { backend.emit({ isPlaying: false, currentTime: 0 }); }),
    seek: vi.fn((t: number) => { backend.emit({ currentTime: t }); }),
    setVolume: () => {},
    setPlaybackRate: () => {},
    setEQGains: () => {},
    getAnalyser: () => null,
    setOnEndedCallback: (cb) => { onEnded = cb; },
    setStateChangeCallback: (cb) => { onState = cb; },
    getState: () => state,
    getCapabilities: () => ({ playable: true, seek: true, playbackRate: true, gapless: true, crossfade: true, sinkId: false }),
  };
  return backend;
}

const loader = {
  probeAudioUrl: async () => ({ url: '', contentLength: null, acceptsRanges: false, contentType: null }),
  loadFromURL: async () => new ArrayBuffer(0),
};

function makeEngine(backends: FakeBackend[]): PlaybackEngine {
  let next = 0;
  return new PlaybackEngine({
    loader,
    contextManager: new AudioContextManager(),
    createBackend: async () => backends[next++],
    attachBackend: () => () => {},
  });
}

const TRACK = { url: 'https://example.test/a.flac', duration: 200, positionKey: 'id:a' };

describe('playbackPosition keys', () => {
  it('keys catalog tracks by id and URL loads by URL; local files are not saved', () => {
    expect(positionKeyForTrack({ id: 'abc', url: 'https://x.test/a.flac' })).toBe('id:abc');
    expect(positionKeyForTrack({ url: 'https://x.test/a.flac' })).toBe('url:https://x.test/a.flac');
    expect(positionKeyForTrack({ id: 'local-1-xyz', url: 'blob:https://app/123' })).toBeNull();
    expect(positionKeyForTrack({ url: 'blob:https://app/123' })).toBeNull();
  });

  it('reads the pre-engine {trackId, time} format', () => {
    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify({ trackId: 'abc', time: 42 }));
    expect(readSavedPosition('id:abc')).toBe(42);
    expect(readSavedPosition('id:other')).toBeNull();
  });
});

describe('PlaybackEngine', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('throttles position saves instead of writing on every tick', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const backend = fakeBackend();
    const engine = makeEngine([backend]);
    await engine.setOutputMode('streaming');
    expect(await engine.load(TRACK)).toBe('loaded');
    backend.emit({ duration: 200 });

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const positionWrites = () => setItem.mock.calls.filter(([key]) => key === POSITION_STORAGE_KEY).length;

    // 20 s of 4 Hz timeupdate.
    for (let tick = 1; tick <= 80; tick++) {
      vi.setSystemTime(Date.now() + 250);
      backend.emit({ currentTime: tick * 0.25 });
    }
    expect(positionWrites()).toBeLessThanOrEqual(Math.ceil(20_000 / POSITION_SAVE_INTERVAL_MS));
    expect(positionWrites()).toBeGreaterThan(0);

    // Pause writes immediately, under the stable track key.
    setItem.mockClear();
    engine.pause();
    expect(positionWrites()).toBe(1);
    expect(readSavedPosition('id:a')).toBe(20);
    engine.destroy();
  });

  it('does not save positions for tracks without a stable key', async () => {
    const backend = fakeBackend();
    const engine = makeEngine([backend]);
    await engine.setOutputMode('streaming');
    await engine.load({ url: 'blob:https://app/1', positionKey: null });
    backend.emit({ duration: 100, currentTime: 30 });
    engine.pause();
    expect(localStorage.getItem(POSITION_STORAGE_KEY)).toBeNull();
    engine.destroy();
  });

  it('a newer load supersedes an in-flight one; only the newer track plays', async () => {
    const backend = fakeBackend({ manualLoads: true });
    const engine = makeEngine([backend]);
    await engine.setOutputMode('streaming');

    const first = engine.load({ url: 'https://example.test/first.flac' });
    await vi.waitFor(() => expect(backend.loadCalls).toHaveLength(1));
    const second = engine.load({ url: 'https://example.test/second.flac' });
    await vi.waitFor(() => expect(backend.loadCalls).toHaveLength(2));

    backend.pendingLoads[1]();
    expect(await second).toBe('loaded');
    backend.pendingLoads[0]();
    expect(await first).toBe('superseded');

    expect(backend.play).toHaveBeenCalledTimes(1);
    expect(engine.getStatus().isLoading).toBe(false);
    engine.destroy();
  });

  it('ignores `ended` and state from a replaced backend', async () => {
    const oldBackend = fakeBackend();
    const newBackend = fakeBackend();
    const engine = makeEngine([oldBackend, newBackend]);
    const onEnded = vi.fn();
    engine.setOnEnded(onEnded);

    await engine.setOutputMode('streaming');
    await engine.load(TRACK);
    await engine.setOutputMode('worklet');
    expect(oldBackend.destroy).toHaveBeenCalled();

    oldBackend.end();
    oldBackend.emit({ isPlaying: true, currentTime: 99 });
    expect(onEnded).not.toHaveBeenCalled();
    expect(engine.getTime()).toBe(0);
    expect(engine.getStatus().isPlaying).toBe(false);

    newBackend.end();
    expect(onEnded).toHaveBeenCalledTimes(1);
    engine.destroy();
  });

  it('keeps the status snapshot stable across time-only ticks', async () => {
    const backend = fakeBackend();
    const engine = makeEngine([backend]);
    await engine.setOutputMode('streaming');
    await engine.load(TRACK);
    backend.emit({ duration: 200, isPlaying: true });

    const status = engine.getStatus();
    backend.emit({ currentTime: 1 });
    backend.emit({ currentTime: 2 });
    expect(engine.getStatus()).toBe(status);
    expect(engine.getTime()).toBe(2);
    engine.destroy();
  });

  it('fails closed for a backend that cannot play in this browser: nothing is fetched or loaded', async () => {
    const backend = fakeBackend();
    const capabilities = backend.getCapabilities();
    backend.getCapabilities = () => ({ ...capabilities, playable: false });
    const probe = vi.spyOn(loader, 'probeAudioUrl');
    const fetchBytes = vi.spyOn(loader, 'loadFromURL');
    const engine = makeEngine([backend]);
    await engine.setOutputMode('worklet');
    expect(engine.getCapabilities().playable).toBe(false);

    await expect(engine.load(TRACK)).rejects.toThrow(/worklet output cannot play in this browser/);
    expect(probe).not.toHaveBeenCalled();
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(backend.loadCalls).toEqual([]);
    expect(engine.getStatus().isLoading).toBe(false);
    engine.destroy();
  });
});
