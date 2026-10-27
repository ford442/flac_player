// Transport ticks must not re-render the tree: Player reads PlaybackStatus
// (no position) and only time-showing leaves subscribe to the engine clock.

import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioPlaybackState, ConfigurableAudioBackend } from '../src/types/audio';
import type { PlaylistTrack } from '../src/types/library';

const counters = vi.hoisted(() => ({ libraryRenders: 0 }));
const backendHandle = vi.hoisted(() => ({
  emit: null as ((state: AudioPlaybackState) => void) | null,
}));

const TRACKS: PlaylistTrack[] = [
  { id: 'a', name: 'a.flac', title: 'Alpha', author: 'Test', url: 'https://example.test/a.flac', duration: 120 },
  { id: 'b', name: 'b.flac', title: 'Beta', author: 'Test', url: 'https://example.test/b.flac', duration: 90 },
];

vi.mock('../src/components/LibraryView', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/components/LibraryView')>();
  const Inner = original.LibraryView as ComponentType<object>;
  return {
    ...original,
    LibraryView: (props: object) => {
      counters.libraryRenders += 1;
      return createElement(Inner, props);
    },
  };
});

// The WebGPU shell is out of scope; a button switches to the fallback (library) view.
vi.mock('../src/components/VisualizerShell', () => ({
  VisualizerShell: (props: { onToggleFallback?: () => void }) =>
    createElement('button', { 'data-testid': 'show-fallback', onClick: props.onToggleFallback }, 'fallback'),
}));

vi.mock('../src/utils/healthCheck', () => ({ checkBackendHealth: async () => true }));

vi.mock('../src/audioLoader', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/audioLoader')>();
  class StubLoader {
    fetchLibrary = async () => ({ tracks: TRACKS, total: TRACKS.length });
    fetchTags = async () => [];
    fetchStats = async () => ({ total_tracks: TRACKS.length });
    fetchPlaylists = async () => [];
    fetchSong = async (id: string) => TRACKS.find((t) => t.id === id)!;
    recordPlay = async () => {};
    probeAudioUrl = async () => ({ contentLength: null });
    loadFromURL = async () => new ArrayBuffer(0);
  }
  return { ...original, AudioLoader: StubLoader };
});

vi.mock('../src/audio/createAudioBackend', () => ({
  createAudioBackend: async (): Promise<ConfigurableAudioBackend> => ({
    initialize: async () => {},
    destroy: () => {},
    loadFromArrayBuffer: async () => {},
    loadFromURL: async () => {},
    play: () => {},
    pause: () => {},
    stop: () => {},
    seek: () => {},
    setVolume: () => {},
    setPlaybackRate: () => {},
    setEQGains: () => {},
    getAnalyser: () => null,
    setOnEndedCallback: () => {},
    setStateChangeCallback: (callback) => { backendHandle.emit = callback; },
    getState: () => ({ isPlaying: false, currentTime: 0, duration: 0, isLoading: false }),
    getCapabilities: () => ({ seek: true, playbackRate: true, gapless: true, crossfade: true, sinkId: false }),
  }),
}));

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('Player render isolation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    counters.libraryRenders = 0;
    backendHandle.emit = null;
    // jsdom has no canvas; the waveform strip just skips painting.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('LibraryView render count stays flat across 2 s of timeupdate', async () => {
    const { Player } = await import('../src/components/Player');
    await act(async () => { root.render(createElement(Player)); });
    for (let i = 0; i < 5 && !backendHandle.emit; i++) await flush();
    expect(backendHandle.emit).toBeTypeOf('function');

    act(() => { (container.querySelector('[data-testid="show-fallback"]') as HTMLButtonElement).click(); });
    await flush();
    expect(container.textContent).toContain('Alpha');

    // Start of playback is a real status change (isPlaying, duration) and may render.
    act(() => backendHandle.emit!({ isPlaying: true, currentTime: 0, duration: 120, isLoading: false }));
    await flush();
    const rendersBeforeTicks = counters.libraryRenders;
    expect(rendersBeforeTicks).toBeGreaterThan(0);

    // 2 s of timeupdate at the native ~4 Hz cadence.
    for (let tick = 1; tick <= 8; tick++) {
      act(() => backendHandle.emit!({ isPlaying: true, currentTime: tick * 0.25, duration: 120, isLoading: false }));
    }
    await flush();

    expect(counters.libraryRenders).toBe(rendersBeforeTicks);
    // The ticks did reach the clock subscribers (the transport bar's time label).
    const timeLabels = [...container.querySelectorAll('.waveform-overview-time')].map((el) => el.textContent);
    expect(timeLabels).toContain('0:02');
  });
});
