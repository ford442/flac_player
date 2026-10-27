import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { makeEngine, track } from './helpers/fakeEngine';
import type { PlaylistTrack } from '../src/types/library';

// #258 React-side acceptance: Player does not re-render on clock ticks, library
// filters drive the query key, share links hold library ids only, and failures
// surface as toasts or the error boundary.

const keyboardShortcuts = vi.hoisted(() => vi.fn());
vi.mock('../src/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: keyboardShortcuts }));
vi.mock('../src/components/VisualizerShell', () => ({ VisualizerShell: () => null }));
vi.mock('../src/audio/AudioContextManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/audio/AudioContextManager')>();
  return {
    ...actual,
    isAudioContextSinkSupported: () => false,
    sharedAudioContextManager: {
      setLatencyMode: async () => {},
      setRenderSizeMode: async () => {},
      setSinkId: async () => true,
      hasContext: () => false,
      subscribeGraphRecreated: () => () => {},
      getOutputInfo: () => null,
    },
  };
});

const songApi = vi.hoisted(() => ({
  fetchSongs: vi.fn(),
  createShare: vi.fn(),
}));
vi.mock('../src/api/songApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/songApi')>()),
  fetchSongs: songApi.fetchSongs,
  fetchTags: async () => [],
  fetchStats: async () => ({
    total_tracks: 0, rated_4plus: 0, total_duration_hours: 0, total_play_count: 0,
    untagged_count: 0, trash_count: 0, unique_tags: 0, top_tags: [],
  }),
  createShare: songApi.createShare,
}));

const { Player } = await import('../src/components/Player');
const { PlayerProvider } = await import('../src/player/PlayerContext');
const { PlayerToasts } = await import('../src/components/Toast');
const { ErrorBoundary } = await import('../src/components/ErrorBoundary');
const { reportError } = await import('../src/player/playerStore');
const { useLibraryCatalog, DEFAULT_LIBRARY_FILTERS, LIBRARY_PAGE_SIZE } = await import('../src/api/library');
const { useQueueActions } = await import('../src/hooks/useQueueActions');
const { trackFromUrl } = await import('../src/utils/remoteTracks');

const page = (prefix: string, n: number): PlaylistTrack[] =>
  Array.from({ length: n }, (_, i) => track(`${prefix}${i}`));

function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return Wrapper;
}

beforeEach(() => {
  keyboardShortcuts.mockClear();
  songApi.fetchSongs.mockReset();
  songApi.fetchSongs.mockResolvedValue({ tracks: [], total: 0 });
  songApi.createShare.mockReset();
});
afterEach(() => cleanup());

describe('Player render isolation', () => {
  it('does not re-render while the clock ticks', async () => {
    const env = makeEngine();
    const Wrapper = queryWrapper();
    render(
      <Wrapper>
        <PlayerProvider player={{ engine: env.engine, store: env.store }}>
          <Player />
        </PlayerProvider>
      </Wrapper>,
    );
    await act(async () => {
      env.engine.playQueue([track('a'), track('b')], 0);
      await env.flush();
    });
    const rendersBefore = keyboardShortcuts.mock.calls.length;

    // One commit per tick, like timeupdate events arriving ~4×/s.
    for (let i = 1; i <= 20; i++) {
      act(() => {
        env.advance(300);
        env.backend().report({ currentTime: i * 0.3, duration: 100, isPlaying: true });
      });
    }

    // The clock moved (scrubbers saw it) but Player itself rendered no more.
    expect(env.store.getState().clock.position).toBeGreaterThan(5);
    expect(keyboardShortcuts.mock.calls.length).toBe(rendersBefore);
    env.detach();
  });
});

describe('library queries (#258 bug 10)', () => {
  it('a filter change refetches page 0 and loadMore continues the same filter', async () => {
    songApi.fetchSongs.mockImplementation(async (query: { offset?: number; search?: string }) => ({
      tracks: page(`${query.search ?? 'all'}-${query.offset ?? 0}-`, LIBRARY_PAGE_SIZE),
      total: LIBRARY_PAGE_SIZE,
    }));
    const { result, rerender } = renderHook(
      ({ search }) => useLibraryCatalog({ ...DEFAULT_LIBRARY_FILTERS, search }),
      { wrapper: queryWrapper(), initialProps: { search: '' } },
    );
    await vi.waitFor(() => expect(result.current.tracks).toHaveLength(LIBRARY_PAGE_SIZE));
    expect(result.current.hasMore).toBe(true);

    rerender({ search: 'bass' });
    await vi.waitFor(() => expect(result.current.tracks[0]?.id).toBe('bass-0-0'));
    act(() => result.current.loadMore());
    await vi.waitFor(() => expect(result.current.tracks).toHaveLength(2 * LIBRARY_PAGE_SIZE));

    const calls = songApi.fetchSongs.mock.calls.map(([q]) => ({ search: q.search, offset: q.offset }));
    expect(calls).toEqual([
      { search: undefined, offset: 0 },
      { search: 'bass', offset: 0 },
      { search: 'bass', offset: LIBRARY_PAGE_SIZE },
    ]);
  });
});

describe('library cache (#258 bug 12)', () => {
  it('caches real tags and stats, never empty placeholders', async () => {
    const { setCachedLibrary, getCachedLibrary } = await import('../src/storage/libraryCache');
    const earlierStats = { ...(await import('../src/api/library')).EMPTY_STATS, total_tracks: 7 };
    setCachedLibrary([], [{ name: 'ambient', count: 3 }], earlierStats);
    songApi.fetchSongs.mockResolvedValue({ tracks: page('s', 2), total: 2 });

    // Tags and stats are still loading when the songs arrive (fetchTags/fetchStats never settle here).
    const tags = await import('../src/api/songApi');
    vi.spyOn(tags, 'fetchTags').mockReturnValue(new Promise(() => {}));
    vi.spyOn(tags, 'fetchStats').mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useLibraryCatalog(DEFAULT_LIBRARY_FILTERS), { wrapper: queryWrapper() });
    await vi.waitFor(() => expect(result.current.tracks).toHaveLength(2));

    const cached = getCachedLibrary();
    expect(cached?.tracks.map((t) => t.id)).toEqual(['s0', 's1']);
    expect(cached?.tags).toEqual([{ name: 'ambient', count: 3 }]);
    expect(cached?.stats.total_tracks).toBe(7);
    vi.restoreAllMocks();
  });
});

describe('share links (#258 bug 11)', () => {
  it('hold library ids only', async () => {
    const env = makeEngine();
    songApi.createShare.mockResolvedValue({ share_id: 's', short_url: 'https://s.test/s', full_url: 'https://s.test/full' });
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    env.engine.setQueue([track('a'), trackFromUrl('https://example.test/x.mp3')!, track('b')], { currentIndex: 0 });

    const { result } = renderHook(() => useQueueActions(env.engine, env.store));
    await act(() => result.current.shareQueue());

    expect(songApi.createShare).toHaveBeenCalledWith(['a', 'b'], 'Shared Playlist', 30);
    expect(writeText).toHaveBeenCalledWith('https://s.test/s');
    expect(env.store.getState().errors.toasts.map((t) => t.message)).toContain(
      'Left out 1 non-library track (links or local files)',
    );
    vi.unstubAllGlobals();
    env.detach();
  });
});

describe('errors are visible (#258 bug 8)', () => {
  it('an engine error shows as an alert toast', () => {
    const env = makeEngine();
    render(
      <PlayerProvider player={{ engine: env.engine, store: env.store }}>
        <PlayerToasts />
      </PlayerProvider>,
    );
    act(() => reportError(env.store, 'Playback failed: decode error'));
    expect(screen.getByRole('alert').textContent).toBe('Playback failed: decode error');
    env.detach();
  });

  it('a render error shows the error boundary instead of a blank page', () => {
    const Broken: React.FC = () => { throw new Error('boom'); };
    // React rethrows render errors through window 'error' in development; keep the log quiet.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const swallow = (e: ErrorEvent) => e.preventDefault();
    window.addEventListener('error', swallow);
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(screen.getByRole('alert').textContent).toContain('boom');
    window.removeEventListener('error', swallow);
    consoleError.mockRestore();
  });
});
