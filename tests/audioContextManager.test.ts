import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioContextManager } from '../src/audio/AudioContextManager';

/** Records every constructed context so tests can assert rebuild behaviour. */
const constructed: FakeAudioContext[] = [];

class FakeAudioNode {
  connections: FakeAudioNode[] = [];
  gain = { value: 1 };
  connect(target: FakeAudioNode) { this.connections.push(target); return target; }
  disconnect() { this.connections = []; }
}

class FakeAnalyser extends FakeAudioNode {
  fftSize = 0;
}

class FakeAudioContext {
  sampleRate: number;
  latencyHint: unknown;
  state = 'running';
  destination = new FakeAudioNode();
  closed = false;

  /** Rates this fake "hardware" refuses, to exercise the fallback path. */
  static unsupportedRates: number[] = [];
  static deviceRate = 48000;

  constructor(options?: { sampleRate?: number; latencyHint?: unknown }) {
    if (options?.sampleRate && FakeAudioContext.unsupportedRates.includes(options.sampleRate)) {
      throw new DOMException('unsupported sample rate', 'NotSupportedError');
    }
    this.sampleRate = options?.sampleRate ?? FakeAudioContext.deviceRate;
    this.latencyHint = options?.latencyHint;
    constructed.push(this);
  }

  createGain() { return new FakeAudioNode(); }
  createAnalyser() { return new FakeAnalyser(); }
  createBiquadFilter() {
    return { type: '', frequency: { value: 0 }, Q: { value: 0 }, gain: { value: 0 }, connect: () => {}, disconnect: () => {} };
  }
  async close() { this.closed = true; }
  async resume() { this.state = 'running'; }
}

describe('AudioContextManager sample rate', () => {
  beforeEach(() => {
    constructed.length = 0;
    FakeAudioContext.unsupportedRates = [];
    FakeAudioContext.deviceRate = 48000;
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the device native rate instead of a hardcoded 44100', () => {
    const manager = new AudioContextManager();
    expect(manager.getSampleRate()).toBe(48000);
    expect(constructed[0].sampleRate).toBe(48000);
  });

  it('creates the context lazily, not on construction', () => {
    const manager = new AudioContextManager();
    expect(constructed).toHaveLength(0);
    manager.getContext();
    expect(constructed).toHaveLength(1);
  });

  it('a 48000 track propagates to the context before creation', () => {
    FakeAudioContext.deviceRate = 44100;
    const manager = new AudioContextManager();
    // Configure before first use: picked up at lazy creation, no rebuild.
    expect(manager.configure({ sampleRate: 48000 })).toBe(false);
    expect(manager.getSampleRate()).toBe(48000);
    expect(constructed).toHaveLength(1);
  });

  it('rebuilds the context when a track needs a different rate', () => {
    const manager = new AudioContextManager();
    manager.getContext();
    expect(manager.getSampleRate()).toBe(48000);

    const rebuilt = manager.configure({ sampleRate: 96000 });

    expect(rebuilt).toBe(true);
    expect(constructed).toHaveLength(2);
    expect(constructed[0].closed).toBe(true);
    expect(manager.getSampleRate()).toBe(96000);
  });

  it('does not rebuild when the rate already matches', () => {
    const manager = new AudioContextManager();
    manager.getContext();
    expect(manager.configure({ sampleRate: 48000 })).toBe(false);
    expect(constructed).toHaveLength(1);
  });

  it('notifies subscribers so backends can rebuild their nodes', () => {
    const manager = new AudioContextManager();
    manager.getContext();
    const listener = vi.fn();
    const unsubscribe = manager.onContextChange(listener);

    manager.configure({ sampleRate: 96000 });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    manager.configure({ sampleRate: 44100 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('falls back to device native when the hardware rejects a rate', () => {
    FakeAudioContext.unsupportedRates = [192000];
    const manager = new AudioContextManager();
    manager.configure({ sampleRate: 192000 });
    expect(manager.getSampleRate()).toBe(48000);
  });

  it('ignores exotic rates outside the supported set', () => {
    const manager = new AudioContextManager();
    manager.getContext();
    expect(manager.configure({ sampleRate: 37800 })).toBe(false);
    expect(constructed).toHaveLength(1);
  });

  it('carries volume and EQ across a rebuild', () => {
    const manager = new AudioContextManager();
    manager.getContext();
    manager.setVolume(0.35);
    const gains = manager.getEQGains().map(() => 6);
    manager.setEQGains(gains);

    manager.configure({ sampleRate: 96000 });

    expect(manager.getEQGains()).toEqual(gains);
  });
});

describe('AudioContextManager latency hint', () => {
  beforeEach(() => {
    constructed.length = 0;
    FakeAudioContext.unsupportedRates = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('defaults to playback', () => {
    const manager = new AudioContextManager();
    manager.getContext();
    expect(constructed[0].latencyHint).toBe('playback');
  });

  it('rebuilds when a backend needs a different hint', () => {
    const manager = new AudioContextManager();
    manager.getContext();

    expect(manager.configure({ latencyHint: 'interactive' })).toBe(true);
    expect(constructed).toHaveLength(2);
    expect(constructed[1].latencyHint).toBe('interactive');
  });

  it('does not rebuild when the hint is unchanged', () => {
    const manager = new AudioContextManager();
    manager.getContext();
    expect(manager.configure({ latencyHint: 'playback' })).toBe(false);
    expect(constructed).toHaveLength(1);
  });
});
