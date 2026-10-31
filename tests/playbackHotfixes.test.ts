import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeEngine, track } from './helpers/fakeEngine';
import {
  POSITION_STORAGE_KEY, persistPlayerState, readSavedPosition,
} from '../src/player/persistence';
import type { QueueState } from '../src/storage/queueStorage';

// #258 bug 4: the resume position was never saved (the save interval was torn
// down by every timeupdate render). It is now written from the engine clock.

const savedPosition = () => JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY) ?? 'null');
let savedQueue: QueueState | null = null;
const loadSavedQueue = () => savedQueue;

describe('resume position (#258 bug 4)', () => {
  const cleanups: Array<() => void> = [];
  beforeEach(() => {
    localStorage.clear();
    savedQueue = null;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    cleanups.splice(0).forEach((fn) => fn());
    vi.useRealTimers();
  });

  async function playing(options = { position: true, queue: true }, readSaved = readSavedPosition) {
    const env = makeEngine({ readSavedPosition: (id) => readSaved(id) });
    cleanups.push(env.detach, persistPlayerState(env.engine.clock, env.store, {
      ...options, saveQueue: (queue) => { savedQueue = queue; },
    }));
    await env.flush();
    env.engine.playQueue([track('song-1'), track('song-2')], 0);
    await env.flush();
    return env;
  }

  it('saves every 5 s from the engine clock', async () => {
    const { backend, advance } = await playing();
    backend().report({ currentTime: 4, duration: 200, isPlaying: true });
    advance(1000);
    vi.advanceTimersByTime(4999);
    expect(savedPosition()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(savedPosition().trackId).toBe('song-1');
    expect(savedPosition().time).toBeCloseTo(5, 5);
  });

  it('flushes on pagehide so a reload resumes where playback stopped', async () => {
    const { backend } = await playing();
    backend().report({ currentTime: 42.5, duration: 200, isPlaying: false });
    window.dispatchEvent(new Event('pagehide'));
    expect(savedPosition()).toEqual({ trackId: 'song-1', time: 42.5 });
  });

  it('a reloaded page resumes the restored queue at the saved position', async () => {
    const first = await playing();
    first.backend().report({ currentTime: 42.5, duration: 200, isPlaying: false });
    window.dispatchEvent(new Event('pagehide'));
    first.detach();

    const saved = loadSavedQueue();
    expect(saved?.tracks.map((t) => t.id)).toEqual(['song-1', 'song-2']);
    const reloaded = makeEngine({ readSavedPosition: (id) => readSavedPosition(id) });
    cleanups.push(reloaded.detach);
    await reloaded.flush();
    reloaded.engine.setQueue(saved!.tracks, { currentIndex: saved!.currentIndex });
    await reloaded.engine.play();
    await reloaded.flush();
    expect(reloaded.backend().seek).toHaveBeenCalledWith(42.5);
  });

  it('does not save for shared playlists or room guests', async () => {
    const { backend } = await playing({ position: false, queue: false });
    backend().report({ currentTime: 30, duration: 200, isPlaying: true });
    vi.advanceTimersByTime(6000);
    window.dispatchEvent(new Event('pagehide'));
    expect(savedPosition()).toBeNull();
    expect(loadSavedQueue()).toBeNull();
  });

  it('never persists local files', async () => {
    const env = await playing();
    const file = new File(['x'], 'local.flac');
    env.engine.enqueue({ id: 'local-1', source: 'local', file, name: 'local.flac', url: 'blob:x' });
    const saved = loadSavedQueue();
    expect(saved?.tracks.map((t) => t.id)).toEqual(['song-1', 'song-2']);
    expect(JSON.stringify(saved)).not.toContain('blob:');
  });
});
