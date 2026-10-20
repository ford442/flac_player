import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AudioContextManager } from '../src/audio/AudioContextManager';

// #258 bugs 1–2: the streaming facade runs FLAC through the worklet and everything
// else through <audio>. Switching paths must silence the old one, and an element
// that was replaced (graph rebuild) must not advance the queue with its 'ended'.

class FakeWorklet {
  static instances: FakeWorklet[] = [];
  playing = false;
  stop = vi.fn(() => { this.playing = false; });
  play = vi.fn(() => { this.playing = true; });
  pause = vi.fn(() => { this.playing = false; });
  loadFromArrayBuffer = vi.fn(async () => { this.playing = false; });
  loadFromURLStreaming = vi.fn(async () => { this.playing = false; });
  constructor() { FakeWorklet.instances.push(this); }
  setPlaybackRate(): void {}
  setStateChangeCallback(): void {}
  setOnEndedCallback(): void {}
  setPCMCallback(): void {}
  setGaplessSettings(): void {}
  clearPreload(): void {}
  getState() { return { isPlaying: this.playing, currentTime: 0, duration: 0, isLoading: false }; }
  destroy(): void {}
}

vi.mock('../src/audio/backends/worklet/WorkletAudioPlayer', () => ({ WorkletAudioPlayer: FakeWorklet }));
vi.mock('../src/audio/ensureContextForSource', () => ({ ensureContextForUrl: async () => {} }));
vi.mock('../src/utils/rangeFetch', () => ({
  probeRemoteAudio: async (url: string) => ({ url, contentLength: 1000, acceptsRanges: true, contentType: null }),
}));
vi.mock('../src/utils/audioHeader', () => ({ probeRemoteAudioDuration: async () => null }));
vi.mock('../src/storage/trackCache', () => ({
  isTrackCached: async () => false,
  getOrFetchTrack: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
}));

/** Enough of HTMLAudioElement for the native path; `canplay` follows `load()` with a src. */
class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  paused = true;
  ended = false;
  currentTime = 0;
  duration = NaN;
  playbackRate = 1;
  seeking = false;
  readyState = 4;
  crossOrigin: string | null = null;
  preload = '';
  private attrs = new Map<string, string>();
  constructor() { super(); FakeAudio.instances.push(this); }
  get src(): string { return this.attrs.get('src') ?? ''; }
  set src(value: string) { this.attrs.set('src', value); }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  load(): void {
    if (this.src) setTimeout(() => this.dispatchEvent(new Event('canplay')), 0);
  }
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  pause(): void { this.paused = true; }
}

function fakeContextManager() {
  const listeners = new Set<() => void>();
  const param = { value: 1, setValueAtTime() {}, cancelScheduledValues() {}, linearRampToValueAtTime() {} };
  const ctx = {
    state: 'running',
    currentTime: 0,
    createGain: () => ({ gain: { ...param }, connect() {}, disconnect() {} }),
    createMediaElementSource: () => ({ connect() {}, disconnect() {} }),
  };
  const manager = {
    subscribeGraphRecreated: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    getContext: () => ctx,
    connectInput: () => {},
    resume: async () => {},
    setVolume: () => {},
  };
  return { manager: manager as unknown as AudioContextManager, recreateGraph: () => listeners.forEach((fn) => fn()) };
}

const { StreamingAudioPlayer } = await import('../src/audio/backends/StreamingAudioPlayer');

describe('StreamingAudioPlayer keeps one path audible (#258)', () => {
  beforeEach(() => {
    FakeWorklet.instances.length = 0;
    FakeAudio.instances.length = 0;
    vi.stubGlobal('Audio', FakeAudio);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function setup() {
    const { manager, recreateGraph } = fakeContextManager();
    const player = new StreamingAudioPlayer(manager);
    await player.initialize();
    const worklet = FakeWorklet.instances[0]!;
    const element = () => FakeAudio.instances.at(-1)!;
    const audible = () => [worklet.playing, FakeAudio.instances.some((el) => !el.paused)].filter(Boolean).length;
    return { player, worklet, element, audible, recreateGraph };
  }

  it('FLAC → MP3 → FLAC never has both paths playing', async () => {
    const { player, worklet, element, audible } = await setup();

    await player.loadFromURL('https://music.test/a.flac');
    await player.play();
    expect(worklet.playing).toBe(true);
    expect(audible()).toBe(1);

    await player.loadFromURL('https://music.test/b.mp3');
    expect(worklet.stop).toHaveBeenCalled();
    await player.play();
    expect(element().paused).toBe(false);
    expect(audible()).toBe(1);

    await player.loadFromURL('https://music.test/c.flac');
    expect(element().paused).toBe(true);
    expect(element().hasAttribute('src')).toBe(false);
    await player.play();
    expect(worklet.playing).toBe(true);
    expect(audible()).toBe(1);
    player.destroy();
  });

  it('a superseded native load rejects with AbortError instead of resolving for the new track', async () => {
    const { player } = await setup();
    const first = player.loadFromURL('https://music.test/a.mp3');
    const firstOutcome = first.then(() => 'resolved', (err: unknown) => (err as DOMException).name);
    // The FLAC load switches to the worklet path before a.mp3 reaches canplay.
    await player.loadFromURL('https://music.test/b.flac');
    expect(await firstOutcome).toBe('AbortError');
    player.destroy();
  });

  it('stop() cancels a native load that is waiting for canplay', async () => {
    const { player, element } = await setup();
    const load = player.loadFromURL('https://music.test/a.mp3');
    const outcome = load.then(() => 'resolved', (err: unknown) => (err as DOMException).name);
    // Microtasks only: the element has its src, its canplay timer has not fired yet.
    for (let i = 0; i < 20 && !element().src; i++) await Promise.resolve();
    expect(element().src).toBe('https://music.test/a.mp3');
    player.stop();
    expect(element().hasAttribute('src')).toBe(false);
    expect(await outcome).toBe('AbortError');
    player.destroy();
  });

  it("a replaced element's 'ended' does not advance the queue after a graph rebuild", async () => {
    const { player, element, recreateGraph } = await setup();
    const onEnded = vi.fn();
    player.setOnEndedCallback(onEnded);

    await player.loadFromURL('https://music.test/a.mp3');
    await player.play();
    const old = element();
    recreateGraph();

    expect(old.paused).toBe(true);
    expect(old.hasAttribute('src')).toBe(false);
    expect(element()).not.toBe(old);
    old.dispatchEvent(new Event('ended'));
    expect(onEnded).not.toHaveBeenCalled();

    // The live element still reports its own end.
    await player.loadFromURL('https://music.test/b.mp3');
    element().dispatchEvent(new Event('ended'));
    expect(onEnded).toHaveBeenCalledTimes(1);
    player.destroy();
  });
});
