import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeBackend, makeEngine, track } from './helpers/fakeEngine';
import { trackFromUrl } from '../src/utils/remoteTracks';
import { canTransition } from '../src/player/transport';
import { localTrackId, localTrackUrl } from '../src/types/track';
import type { ConfigurableAudioBackend } from '../src/types/audio';
import type { PlaylistTrack } from '../src/types/library';

// #258: the PlaybackEngine owns the backend, load tokens, the queue cursor and the clock.

describe('PlaybackEngine', () => {
  let detach: (() => void) | null = null;
  afterEach(() => { detach?.(); detach = null; });

  function setup(...args: Parameters<typeof makeEngine>) {
    const env = makeEngine(...args);
    detach = env.detach;
    return env;
  }

  it('constructs the backend once across queue edits and shuffle toggles (#236)', async () => {
    const { engine, deps, flush } = setup();
    await flush();
    expect(deps.createBackend).toHaveBeenCalledTimes(1);

    engine.setQueue([track('a'), track('b')], { currentIndex: 0 });
    engine.enqueue(track('c'));
    engine.insertNext(track('d'));
    engine.reorderQueue(0, 2);
    engine.removeFromQueue(1);
    engine.setShuffle(true);
    engine.setRepeatMode('all');
    engine.setShuffle(false);
    await engine.load(track('a'), { index: 0 });
    engine.next();
    await flush();

    expect(deps.createBackend).toHaveBeenCalledTimes(1);
    expect(FakeBackend.created[0]!.destroy).not.toHaveBeenCalled();

    engine.setOutputMode('worklet');
    await flush();
    expect(deps.createBackend).toHaveBeenCalledTimes(2);
    expect(FakeBackend.created[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it('unlocks audio synchronously on user play commands and reports audible transport (#259 A3/A4)', async () => {
    const { engine, deps, flush } = setup();
    await flush();
    const unlock = deps.unlockAudio as ReturnType<typeof vi.fn>;
    const active = deps.setPlaybackActive as ReturnType<typeof vi.fn>;

    const loading = engine.load(track('a'));
    // Before the first await: still inside the click handler's task.
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(active).toHaveBeenLastCalledWith(true); // loading
    await loading;
    await flush();
    expect(active).toHaveBeenLastCalledWith(true); // playing

    engine.pause();
    expect(active).toHaveBeenLastCalledWith(false);
    const playing = engine.play();
    expect(unlock).toHaveBeenCalledTimes(2);
    await playing;
    expect(active).toHaveBeenLastCalledWith(true);

    // A guest's paused load (autoplay off) is not a gesture.
    await engine.load(track('b'), { autoplay: false });
    expect(unlock).toHaveBeenCalledTimes(2);
    engine.stop();
    expect(active).toHaveBeenLastCalledWith(false);
  });

  it('drops a stale load result: a slow track A cannot replace track B', async () => {
    const { engine, store, backend, flush } = setup();
    await flush();
    const b = backend();
    b.holdLoads = true;

    const loadA = engine.load(track('a'));
    await flush();
    const loadB = engine.load(track('b'));
    await flush();
    // Backend loads never overlap: B waits for A's call to settle.
    expect(b.loadFromURL.mock.calls.map((c) => c[0])).toEqual(['https://storage.test/a.flac']);

    b.releaseLoad('https://storage.test/a.flac');
    await flush();
    b.releaseLoad('https://storage.test/b.flac');

    expect(await loadA).toBe(false);
    expect(await loadB).toBe(true);
    expect(b.loadedUrl).toBe('https://storage.test/b.flac');
    expect(store.getState().transport.currentTrack?.id).toBe('b');
    expect(store.getState().transport.status).toBe('playing');
    expect(b.play).toHaveBeenCalledTimes(1);
  });

  it('a load superseded while waiting never reaches the backend', async () => {
    const { engine, backend, flush } = setup();
    await flush();
    const b = backend();
    b.holdLoads = true;
    void engine.load(track('a'));
    await flush();
    const loadB = engine.load(track('b'));
    const loadC = engine.load(track('c'));
    b.releaseLoad('https://storage.test/a.flac');
    await flush();
    b.releaseLoad('https://storage.test/c.flac');
    expect(await loadB).toBe(false);
    expect(await loadC).toBe(true);
    expect(b.loadFromURL.mock.calls.map((c) => c[0])).not.toContain('https://storage.test/b.flac');
  });

  it('stops the current track before the next one loads (one audible path)', async () => {
    const { engine, backend, flush } = setup();
    await flush();
    await engine.load(track('a'));
    const b = backend();
    b.holdLoads = true;
    void engine.load(track('b'));
    expect(b.stop).toHaveBeenCalled();
    expect(b.state.isPlaying).toBe(false);
  });

  it('a graph rebuild mid-play reloads at the clock position within 100 ms', async () => {
    const { engine, store, backend, advance, recreateGraph, flush } = setup();
    await flush();
    await engine.load(track('a'));
    const b = backend();
    b.report({ currentTime: 30, isPlaying: true });
    advance(400); // no report for 400 ms: the clock extrapolates
    expect(engine.clock.now()).toBeCloseTo(30.4, 5);

    b.seek.mockClear();
    b.play.mockClear();
    recreateGraph();
    await flush();
    await flush();

    expect(b.seek).toHaveBeenCalledTimes(1);
    expect(Math.abs(b.seek.mock.calls[0]![0] - 30.4)).toBeLessThan(0.1);
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(store.getState().transport.status).toBe('playing');
  });

  it('a graph rebuild while paused reloads paused', async () => {
    const { engine, store, backend, recreateGraph, flush } = setup();
    await flush();
    await engine.load(track('a'));
    const b = backend();
    b.report({ currentTime: 12 });
    engine.pause();
    b.play.mockClear();
    recreateGraph();
    await flush();
    await flush();
    expect(b.seek).toHaveBeenLastCalledWith(12);
    expect(b.play).not.toHaveBeenCalled();
    expect(store.getState().transport.status).toBe('ready');
  });

  it("ignores 'ended' while a newer load is in flight and from a replaced backend", async () => {
    const { engine, store, backend, flush } = setup();
    await flush();
    engine.setQueue([track('a'), track('b'), track('c'), track('d')], { currentIndex: 0 });
    await engine.load(track('a'), { index: 0 });
    const b = backend();
    b.holdLoads = true;
    const loadC = engine.load(track('c'), { index: 2 });
    // a's end arrives after the cursor moved to c: it must not skip ahead to d.
    b.end();
    await flush();
    expect(b.loadFromURL.mock.calls.map((c) => c[0])).not.toContain('https://storage.test/d.flac');
    expect(store.getState().queue.currentIndex).toBe(2);

    b.releaseLoad('https://storage.test/c.flac');
    expect(await loadC).toBe(true);
    engine.setOutputMode('worklet');
    await flush();
    b.end();
    await flush();
    expect(store.getState().queue.currentIndex).toBe(2);
  });

  it("advances to the next track on 'ended'", async () => {
    const { engine, store, backend, flush } = setup();
    await flush();
    engine.setQueue([track('a'), track('b')], { currentIndex: 0 });
    await engine.load(track('a'), { index: 0 });
    backend().end();
    await flush();
    await flush();
    expect(store.getState().queue.currentIndex).toBe(1);
    expect(store.getState().transport.currentTrack?.id).toBe('b');
    expect(backend().loadedUrl).toBe('https://storage.test/b.flac');
  });

  it('a gapless handoff moves the cursor to the preloaded track, even with shuffle', async () => {
    const { engine, store, backend, deps, flush } = setup();
    await flush();
    engine.setQueue([track('a'), track('b'), track('c'), track('d')], { currentIndex: 0, shuffle: true });
    await engine.load(track('a'), { index: 0 });
    const b = backend();
    const preloadedUrl = b.preloadNext.mock.calls.at(-1)![0].url as string;
    b.end({ alreadyPlayingNext: true });
    const current = store.getState().transport.currentTrack!;
    expect(current.url).toBe(preloadedUrl);
    expect(store.getState().queue.tracks[store.getState().queue.currentIndex]!.url).toBe(preloadedUrl);
    expect(deps.recordPlay).toHaveBeenLastCalledWith(current.id);
  });

  it('never records a play for URL or local tracks', async () => {
    const { engine, deps, flush } = setup();
    await flush();
    await engine.load(trackFromUrl('https://example.test/song.mp3')!);
    expect(deps.recordPlay).not.toHaveBeenCalled();
    await engine.load(track('lib'));
    expect(deps.recordPlay).toHaveBeenCalledWith('lib');
  });

  it('play() with nothing loaded starts the restored queue cursor at its saved position', async () => {
    const { engine, store, backend, flush } = setup({ readSavedPosition: (id) => (id === 'b' ? 42 : null) });
    await flush();
    engine.setQueue([track('a'), track('b')], { currentIndex: 1 });
    await engine.play();
    expect(store.getState().transport.currentTrack?.id).toBe('b');
    expect(backend().seek).toHaveBeenCalledWith(42);
    expect(store.getState().transport.status).toBe('playing');
  });

  it('switching engines resumes the loaded track where it was', async () => {
    const { engine, store, backend, flush } = setup();
    await flush();
    engine.setQueue([track('a')], { currentIndex: 0 });
    await engine.load(track('a'), { index: 0 });
    backend().report({ currentTime: 55, isPlaying: true });
    engine.setOutputMode('web-audio');
    await flush();
    await flush();
    const next = backend();
    expect(next.mode).toBe('web-audio');
    expect(next.seek).toHaveBeenCalledWith(55);
    expect(next.play).toHaveBeenCalled();
    expect(store.getState().settings.outputMode).toBe('web-audio');
  });

  it('local files switch streaming to a buffered engine, then queue and play', async () => {
    const { engine, store, backend, flush } = setup();
    await flush();
    const file = new File([new Uint8Array(4)], 'x.flac');
    await engine.addLocalFiles([file]);
    await flush();
    await flush();
    expect(store.getState().settings.outputMode).toBe('worklet');
    expect(store.getState().queue.tracks.map((t) => t.id)).toEqual(['local-x.flac']);
    expect(backend().loadFromArrayBuffer).toHaveBeenCalled();
    expect(store.getState().transport.status).toBe('playing');
  });

  describe('local folder tracks (#284)', () => {
    const folderTrack = (path: string) => track(localTrackId('fab12', path), {
      source: 'local', url: localTrackUrl('fab12', path), local: { folderId: 'fab12', path, size: 4, mtime: 1 },
    });
    /** A backend that, like the real four, takes Blobs. */
    const blobBackend = async (mode: string) => Object.assign(new FakeBackend(mode), {
      loadFromBlob: vi.fn(async function (this: FakeBackend) {
        this.state = { isPlaying: false, currentTime: 0, duration: 100, isLoading: false };
      }),
    }) as unknown as ConfigurableAudioBackend;

    it('play through loadFromBlob on the current (streaming) backend; nothing is fetched', async () => {
      const file = new File([new Uint8Array([0x66, 0x4c, 0x61, 0x43])], '01.flac');
      const resolveLocalFile = vi.fn(async () => file);
      const fetchTrackBytes = vi.fn(async () => new ArrayBuffer(8));
      const { engine, store, backend, flush } = setup({ createBackend: vi.fn(blobBackend), resolveLocalFile, fetchTrackBytes });
      await flush();
      const t = folderTrack('Album/01.flac');
      expect(await engine.load(t)).toBe(true);

      const b = backend() as FakeBackend & { loadFromBlob: ReturnType<typeof vi.fn> };
      expect(resolveLocalFile).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));
      expect(b.loadFromBlob).toHaveBeenCalledWith(file, { key: t.url, name: '01.flac', expectedDuration: 100 });
      expect(b.loadFromURL).not.toHaveBeenCalled();
      expect(b.loadFromArrayBuffer).not.toHaveBeenCalled();
      expect(fetchTrackBytes).not.toHaveBeenCalled();
      expect(store.getState().settings.outputMode).toBe('streaming');
      expect(store.getState().transport.status).toBe('playing');
    });

    it('a folder that lost access is an error toast with the recover hint, not a throw', async () => {
      const resolveLocalFile = vi.fn(async () => {
        throw new Error('Access to the folder "Music" needs to be granted again: use Reconnect under Local Folders.');
      });
      const { engine, store, flush } = setup({ createBackend: vi.fn(blobBackend), resolveLocalFile });
      await flush();
      expect(await engine.load(folderTrack('a.flac'))).toBe(false);
      expect(store.getState().transport.status).toBe('error');
      expect(store.getState().errors.toasts.at(-1)?.message).toMatch(/Reconnect under Local Folders/);
    });

    it('hand a local successor to the backend with its file for gapless', async () => {
      const files = new Map<string, File>();
      const resolveLocalFile = vi.fn(async (t: PlaylistTrack) => {
        const f = files.get(t.id) ?? new File([new Uint8Array(4)], t.name);
        files.set(t.id, f);
        return f;
      });
      const { engine, backend, flush } = setup({ createBackend: vi.fn(blobBackend), resolveLocalFile });
      await flush();
      engine.setAudioSettings({ gapless: { mode: 'gapless', crossfadeMs: 0 } });
      const a = folderTrack('a.flac');
      const b2 = folderTrack('b.flac');
      engine.setQueue([a, b2], { currentIndex: 0 });
      await engine.load(a, { index: 0 });
      await flush();
      const preload = backend().preloadNext.mock.calls.at(-1)?.[0];
      expect(preload).toMatchObject({ url: b2.url, blob: files.get(b2.id) });
    });

    it('dropped files stay on a streaming backend that takes Blobs', async () => {
      const { engine, store, backend, flush } = setup({ createBackend: vi.fn(blobBackend) });
      await flush();
      await engine.addLocalFiles([new File([new Uint8Array(4)], 'x.flac')]);
      await flush();
      expect(store.getState().settings.outputMode).toBe('streaming');
      expect((backend() as unknown as { loadFromBlob: ReturnType<typeof vi.fn> }).loadFromBlob).toHaveBeenCalled();
    });
  });

  it('reports a failed load as an error toast and the error state', async () => {
    const { engine, store, backend, flush } = setup();
    await flush();
    backend().loadFromURL.mockRejectedValueOnce(new Error('decode failed'));
    expect(await engine.load(track('a'))).toBe(false);
    const { transport, errors } = store.getState();
    expect(transport.status).toBe('error');
    expect(errors.toasts.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('decode failed') });
  });

  it('publishes the store clock at most 4×/s while the engine clock stays exact', async () => {
    const { engine, store, backend, advance, flush } = setup();
    await flush();
    await engine.load(track('a'));
    const b = backend();
    const seen: number[] = [];
    const unsubscribe = store.subscribe((s, prev) => { if (s.clock !== prev.clock) seen.push(s.clock.position); });
    for (let i = 1; i <= 40; i++) {
      advance(25);
      b.report({ currentTime: i * 0.025, isPlaying: true });
    }
    unsubscribe();
    expect(seen.length).toBeLessThanOrEqual(5);
    expect(engine.clock.now()).toBeCloseTo(1, 5);
  });

  it('mute and unmute restore the previous volume', async () => {
    const { engine, store, backend, flush } = setup();
    await flush();
    engine.setVolume(0.6);
    engine.toggleMute();
    expect(backend().setVolume).toHaveBeenLastCalledWith(0);
    expect(store.getState().settings).toMatchObject({ muted: true, volume: 0.6 });
    engine.toggleMute();
    expect(backend().setVolume).toHaveBeenLastCalledWith(0.6);
    expect(store.getState().settings.muted).toBe(false);
  });

  it('passes gapless mode to the backend without the deprecated crossfade toggle', async () => {
    const { engine, backend, flush } = setup();
    await flush();
    engine.setAudioSettings({ gapless: { mode: 'gapless', crossfadeMs: 3000 } });
    const b = backend() as FakeBackend & { setCrossfadeEnabled?: unknown };
    expect(b.setGaplessSettings).toHaveBeenLastCalledWith({ mode: 'gapless', crossfadeMs: 3000 });
    expect(b.setCrossfadeEnabled).toBeUndefined();
  });

  it('passes preserve-pitch with the rate, and room nudges keep the user setting (#283)', async () => {
    const { engine, backend, flush } = setup();
    await flush();
    const b = backend();
    expect(b.setPlaybackRate).toHaveBeenLastCalledWith(1, true);
    engine.setAudioSettings({ playbackRate: 1.25 });
    expect(b.setPlaybackRate).toHaveBeenLastCalledWith(1.25, true);
    engine.setAudioSettings({ preservePitch: false });
    expect(b.setPlaybackRate).toHaveBeenLastCalledWith(1.25, false);
    engine.nudgeRate(1.25 * 1.04);
    expect(b.setPlaybackRate).toHaveBeenLastCalledWith(1.25 * 1.04, false);
  });

  it('keeps the backend across a StrictMode detach/attach', async () => {
    const { engine, deps, flush } = setup();
    await flush();
    const reattach = (() => { detach!(); return engine.attach(); })();
    detach = reattach;
    await flush();
    expect(deps.createBackend).toHaveBeenCalledTimes(1);
    expect(FakeBackend.created[0]!.destroy).not.toHaveBeenCalled();

    // The last detach (unmount) tears the backend down.
    detach!();
    detach = null;
    await flush();
    expect(FakeBackend.created[0]!.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('transport state machine', () => {
  it('allows the documented edges only', () => {
    expect(canTransition('idle', 'loading')).toBe(true);
    expect(canTransition('idle', 'playing')).toBe(false);
    expect(canTransition('loading', 'ready')).toBe(true);
    expect(canTransition('playing', 'paused')).toBe(true);
    expect(canTransition('paused', 'playing')).toBe(true);
    expect(canTransition('playing', 'ended')).toBe(true);
    expect(canTransition('error', 'playing')).toBe(false);
    expect(canTransition('error', 'loading')).toBe(true);
  });
});

vi.setConfig({ testTimeout: 5000 });
