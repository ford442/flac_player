import { describe, it, expect, afterEach, vi } from 'vitest';
import { AudioContextManager } from '../src/audio/AudioContextManager';
import {
  RecordingAudioContext,
  channelsAt,
  installRecordingAudioContext,
  reachableNodes,
  type RecordingAudioNode,
} from './helpers/recordingAudioContext';

function allowAllSampleRates(): void {
  (globalThis.AudioContext as typeof AudioContext & {
    isSampleRateSupported?: (rate: number) => boolean;
  }).isSampleRateSupported = () => true;
}

describe('AudioContextManager native-rate recreate', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('does not pass sampleRate: 44100 when initializing without a track rate', () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    manager.initialize();
    const ctx = RecordingAudioContext.instances[0];
    expect(ctx).toBeDefined();
    expect(ctx.constructorOptions.sampleRate).toBeUndefined();
    expect(ctx.latencyHint).toBe('playback');
  });

  it('creates the context at the track native rate', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 48000, channels: 2 });
    expect(RecordingAudioContext.instances[0].sampleRate).toBe(48000);
    expect(manager.getContext().sampleRate).toBe(48000);
  });

  it('recreates on rate mismatch and restores volume, EQ, and ReplayGain', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 44100 });

    manager.setVolume(0.42);
    manager.setEQGains([1, 2, 3, 4, 5]);
    manager.setReplayGainLinear(0.5);
    manager.setReplayGainLimiter(true);

    let notified = 0;
    manager.subscribeGraphRecreated(() => {
      notified += 1;
    });

    await manager.ensureForTrack({ sampleRate: 96000 });

    expect(RecordingAudioContext.instances).toHaveLength(2);
    expect(RecordingAudioContext.instances[0].state).toBe('closed');
    expect(RecordingAudioContext.instances[1].sampleRate).toBe(96000);
    expect(notified).toBe(1);
    expect(manager.getGraphGeneration()).toBe(1);

    const ctx = RecordingAudioContext.instances[1];
    expect(ctx.gainNodes[0].gain.value).toBeCloseTo(0.5, 6);
    expect(ctx.gainNodes[1].gain.value).toBeCloseTo(0.42, 6);
    // Speaker gain: no backend mutes it any more (#268: SDL plays through this graph).
    expect(ctx.gainNodes[2].gain.value).toBe(1);
    expect(ctx.compressorNodes[0].threshold.value).toBe(-1);
    expect(manager.getEQGains()).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the same context for a same-rate follow-up track', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 48000 });
    await manager.ensureForTrack({ sampleRate: 48000 });
    expect(RecordingAudioContext.instances).toHaveLength(1);
  });

  it('does not open a graph from setters or getAnalyser before the first track', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = new AudioContextManager();
    manager.setEQGains([1, 0, 0, 0, 0]);
    manager.setReplayGainLinear(0.8);
    manager.setReplayGainLimiter(true);
    manager.setVolume(0.5);
    await manager.setSinkId('speaker-2');
    expect(await manager.whenRunning()).toBe(false);
    expect(manager.getAnalyser()).toBeNull();
    expect(manager.getOutputInfo()).toBeNull();
    expect(RecordingAudioContext.instances).toHaveLength(0);

    await manager.ensureForTrack({ sampleRate: 96000, channels: 2 });
    expect(RecordingAudioContext.instances).toHaveLength(1);
    const ctx = RecordingAudioContext.instances[0];
    expect(ctx.sampleRate).toBe(96000);
    expect(ctx.constructorOptions).toMatchObject({ sinkId: 'speaker-2' });
    expect(ctx.gainNodes[1].gain.value).toBeCloseTo(0.5, 6);
    expect(manager.getAnalyser()).not.toBeNull();
  });

  it('retries without sampleRate when the native-rate constructor throws', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    RecordingAudioContext.rejectOptions = (o) => o.sampleRate === 384000;
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 384000 });
    expect(RecordingAudioContext.instances).toHaveLength(1);
    expect(manager.getContext().sampleRate).toBe(44100);

    // Same rejected rate on the next track: no recreate loop.
    await manager.ensureForTrack({ sampleRate: 384000 });
    expect(RecordingAudioContext.instances).toHaveLength(1);
  });

  it('falls back from a numeric latencyHint without recreating on every track', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    RecordingAudioContext.rejectOptions = (o) => typeof o.latencyHint === 'number';
    const manager = new AudioContextManager();
    await manager.setLatencyMode('balanced');
    await manager.ensureForTrack({ sampleRate: 48000 });
    expect(RecordingAudioContext.instances[0].latencyHint).toBe('interactive');
    await manager.ensureForTrack({ sampleRate: 48000 });
    expect(RecordingAudioContext.instances).toHaveLength(1);
  });

  it('applies track channels to the destination within device limits', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    RecordingAudioContext.maxChannelCount = 6;
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 48000, channels: 6 });
    expect(manager.getOutputInfo()?.channelCount).toBe(6);
    await manager.ensureForTrack({ sampleRate: 48000, channels: 1 });
    expect(manager.getOutputInfo()?.channelCount).toBe(2);
    await manager.ensureForTrack({ sampleRate: 48000, channels: 8 });
    expect(manager.getOutputInfo()?.channelCount).toBe(6);
  });

  it('switches sink live and reports latency after the graph exists', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 48000 });
    expect(await manager.setSinkId('usb-dac')).toBe(true);
    const info = manager.getOutputInfo();
    expect(info).toMatchObject({
      sampleRate: 48000,
      baseLatency: 0.01,
      outputLatency: 0.02,
      sinkId: 'usb-dac',
      latencyHint: 'playback',
    });

    expect(await manager.setSinkId('missing-device')).toBe(false);
    expect(manager.getSinkId()).toBe('');
    expect(manager.getOutputInfo()?.sinkId).toBe('');
  });
});

/** A stand-in backend source wired through the public input, as backends do. */
function connectSource(manager: AudioContextManager): RecordingAudioNode {
  const source = manager.getContext().createBufferSource() as unknown as RecordingAudioNode;
  manager.connectInput(source as unknown as AudioNode);
  return source;
}

function destinationOf(manager: AudioContextManager): RecordingAudioNode {
  return manager.getContext().destination as unknown as RecordingAudioNode;
}

function kindsAfter(source: RecordingAudioNode): string[] {
  return reachableNodes(source).map((node) => node.kind);
}

describe('AudioContextManager fallback chain channels', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  async function openSurround(channels: number) {
    restore ??= installRecordingAudioContext();
    allowAllSampleRates();
    RecordingAudioContext.maxChannelCount = 8;
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 48000, channels });
    return manager;
  }

  it('keeps no DynamicsCompressorNode in the connected chain while the limiter is off', async () => {
    const manager = await openSurround(6);
    const source = connectSource(manager);

    expect(kindsAfter(source)).not.toContain('compressor');
    expect(manager.getOutputInfo()?.channelCount).toBe(6);
    expect(channelsAt(source, 6, destinationOf(manager))).toBe(6);
  });

  it('carries 5.1 and 7.1 to the destination with the limiter on, one compressor per channel', async () => {
    const manager = await openSurround(6);
    manager.setReplayGainLimiter(true);
    const source = connectSource(manager);

    const compressors = reachableNodes(source).filter((node) => node.kind === 'compressor');
    expect(compressors).toHaveLength(6);
    expect(channelsAt(source, 6, destinationOf(manager))).toBe(6);
    // No compressor is ever asked to carry more than the one channel it is fed.
    for (const compressor of compressors) {
      expect(channelsAt(source, 6, compressor)).toBe(1);
    }

    await manager.ensureForTrack({ sampleRate: 48000, channels: 8 });
    const wide = reachableNodes(source).filter((node) => node.kind === 'compressor');
    expect(wide).toHaveLength(8);
    expect(channelsAt(source, 8, destinationOf(manager))).toBe(8);
  });

  it('uses a single linked compressor up to stereo and none once the limiter goes off', async () => {
    const manager = await openSurround(2);
    manager.setReplayGainLimiter(true);
    const source = connectSource(manager);
    expect(kindsAfter(source).filter((kind) => kind === 'compressor')).toHaveLength(1);
    expect(kindsAfter(source)).not.toContain('channel-splitter');
    expect(channelsAt(source, 2, destinationOf(manager))).toBe(2);

    manager.setReplayGainLimiter(false);
    expect(kindsAfter(source)).not.toContain('compressor');
    expect(channelsAt(source, 2, destinationOf(manager))).toBe(2);
  });

  it('rebuilds the limiter when the next track changes the channel count', async () => {
    const manager = await openSurround(6);
    manager.setReplayGainLimiter(true);
    const source = connectSource(manager);
    expect(kindsAfter(source).filter((kind) => kind === 'compressor')).toHaveLength(6);

    await manager.ensureForTrack({ sampleRate: 48000, channels: 2 });
    expect(kindsAfter(source).filter((kind) => kind === 'compressor')).toHaveLength(1);
    expect(channelsAt(source, 2, destinationOf(manager))).toBe(2);

    await manager.ensureForTrack({ sampleRate: 48000, channels: 6 });
    expect(kindsAfter(source).filter((kind) => kind === 'compressor')).toHaveLength(6);
  });

  it('leaves no disposed limiter node wired into the graph after toggling', async () => {
    const manager = await openSurround(6);
    const source = connectSource(manager);
    manager.setReplayGainLimiter(true);
    const ctx = RecordingAudioContext.instances[0];
    const built = [...ctx.compressorNodes];
    manager.setReplayGainLimiter(false);
    for (const compressor of built) {
      expect((compressor as unknown as RecordingAudioNode).edges).toHaveLength(0);
    }
    expect(kindsAfter(source)).not.toContain('compressor');
  });
});

describe('AudioContextManager sample-rate probing', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  /** Throwaway probe contexts carry no latencyHint; the manager's always do. */
  const probeContexts = () =>
    RecordingAudioContext.instances.filter((ctx) => ctx.constructorOptions.latencyHint === undefined);
  const graphContexts = () =>
    RecordingAudioContext.instances.filter((ctx) => ctx.constructorOptions.latencyHint !== undefined);

  it('constructs one AudioContext for the same rate twice, with no throwaway probe', async () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 48000 });
    await manager.ensureForTrack({ sampleRate: 48000 });
    expect(RecordingAudioContext.instances).toHaveLength(1);
  });

  it('does not probe a first build: the constructor attempt is the probe', async () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 96000 });
    expect(probeContexts()).toHaveLength(0);
    expect(graphContexts()).toHaveLength(1);
    expect(manager.getContext().sampleRate).toBe(96000);
  });

  it('probes each new rate once for the page, then answers from memory', async () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    for (const rate of [48000, 96000, 48000, 96000, 48000]) {
      await manager.ensureForTrack({ sampleRate: rate });
    }
    // 96000 and 48000 were each probed once (the first build probes nothing).
    expect(probeContexts()).toHaveLength(2);
    expect(graphContexts()).toHaveLength(5);
  });

  it('remembers an unsupported rate instead of probing and recreating again', async () => {
    restore = installRecordingAudioContext();
    RecordingAudioContext.rejectOptions = (o) => o.sampleRate === 384000;
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 48000 });
    await manager.ensureForTrack({ sampleRate: 384000 });
    await manager.ensureForTrack({ sampleRate: 384000 });
    expect(probeContexts()).toHaveLength(0); // the throwing probe never produces an instance
    expect(graphContexts()).toHaveLength(1);
    expect(manager.getGraphGeneration()).toBe(0);
  });
});

describe('AudioContextManager.whenRunning', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
    vi.restoreAllMocks();
  });

  it('resumes a suspended context without rebuilding the graph', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    RecordingAudioContext.initialState = 'suspended';
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 48000 });
    expect(RecordingAudioContext.instances[0].state).toBe('suspended');

    expect(await manager.whenRunning()).toBe(true);
    expect(RecordingAudioContext.instances).toHaveLength(1);
    expect(manager.getGraphGeneration()).toBe(0);
    expect(manager.getOutputInfo()?.state).toBe('running');
  });

  it('treats iOS interrupted like suspended: resume, never rebuild', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 48000 });
    const ctx = RecordingAudioContext.instances[0];
    ctx.setState('interrupted');

    await manager.ensureForTrack({ sampleRate: 48000 });
    expect(RecordingAudioContext.instances).toHaveLength(1);

    expect(await manager.whenRunning()).toBe(true);
    expect(ctx.resumeCalls).toBe(1);
    expect(RecordingAudioContext.instances).toHaveLength(1);
  });

  it('is already true for a running context and false with no graph (creating none)', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = new AudioContextManager();
    expect(await manager.whenRunning()).toBe(false);
    expect(RecordingAudioContext.instances).toHaveLength(0);

    await manager.ensureForTrack({ sampleRate: 48000 });
    expect(await manager.whenRunning()).toBe(true);
    expect(RecordingAudioContext.instances[0].resumeCalls).toBe(0);
  });

  it('issues resume() before its first await so it stays inside the unlocking click', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    RecordingAudioContext.initialState = 'suspended';
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 48000 });
    const pending = manager.whenRunning();
    expect(RecordingAudioContext.instances[0].resumeCalls).toBe(1);
    await pending;
  });

  it('gives up after the deadline, then resumes on the next user gesture', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    RecordingAudioContext.initialState = 'suspended';
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 48000 });
    const ctx = RecordingAudioContext.instances[0];
    // Autoplay-gated: the promise stays pending until the platform allows the start.
    let allowed = false;
    vi.spyOn(ctx, 'resume').mockImplementation(async () => {
      if (!allowed) return new Promise<void>(() => undefined);
      ctx.setState('running');
    });

    expect(await manager.whenRunning(10)).toBe(false);
    expect(ctx.state).toBe('suspended');

    allowed = true;
    document.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(ctx.state).toBe('running'));

    // Disarmed once running: a later gesture does not touch the context again.
    const calls = vi.mocked(ctx.resume).mock.calls.length;
    document.dispatchEvent(new Event('pointerdown'));
    expect(vi.mocked(ctx.resume).mock.calls.length).toBe(calls);
  });

  it('refuses context.suspend() from a backend', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = new AudioContextManager();
    const ctx = await manager.ensureForTrack({ sampleRate: 48000 });

    await ctx.suspend();

    expect(RecordingAudioContext.instances[0].suspendCalls).toBe(0);
    expect(ctx.state).toBe('running');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('suspend() ignored'));
  });
});

describe('AudioContextManager graph recreate', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
    vi.restoreAllMocks();
  });

  it('cuts the old destination first and closes the old context only once the new one runs', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 44100 });
    const [oldCtx] = RecordingAudioContext.instances;
    const oldSpeaker = oldCtx.gainNodes[2] as unknown as RecordingAudioNode;
    expect(oldSpeaker.edges).toHaveLength(1); // speaker -> destination

    RecordingAudioContext.initialState = 'suspended';
    const seenAtResume: Array<{ speakerEdges: number; oldState: string; generation: number }> = [];
    const resume = RecordingAudioContext.prototype.resume;
    vi.spyOn(RecordingAudioContext.prototype, 'resume').mockImplementation(async function (this: RecordingAudioContext) {
      seenAtResume.push({
        speakerEdges: oldSpeaker.edges.length,
        oldState: oldCtx.state,
        generation: manager.getGraphGeneration(),
      });
      return resume.call(this);
    });

    await manager.ensureForTrack({ sampleRate: 96000 });

    expect(seenAtResume).toEqual([{ speakerEdges: 0, oldState: 'running', generation: 0 }]);
    expect(RecordingAudioContext.events).toEqual(['resume:1', 'close:0']);
    expect(manager.getGraphGeneration()).toBe(1);
  });

  it('publishes the generation and the new output info together, after the context runs', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 44100 });
    const [oldCtx] = RecordingAudioContext.instances;

    RecordingAudioContext.initialState = 'suspended';
    const resume = RecordingAudioContext.prototype.resume;
    vi.spyOn(RecordingAudioContext.prototype, 'resume').mockImplementation(async function (this: RecordingAudioContext) {
      this.outputLatency = 0.05; // the device only reports a real figure once the context runs
      return resume.call(this);
    });

    const seen: Array<ReturnType<AudioContextManager['getOutputInfo']>> = [];
    let oldStateAtNotify = '';
    manager.subscribeGraphRecreated(() => {
      seen.push(manager.getOutputInfo());
      oldStateAtNotify = oldCtx.state;
    });
    await manager.ensureForTrack({ sampleRate: 96000 });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sampleRate: 96000,
      baseLatency: 0.01,
      outputLatency: 0.05,
      state: 'running',
      graphGeneration: 1,
    });
    expect(oldStateAtNotify).toBe('closed');
  });

  it('serializes overlapping recreates: one live context, a generation per rebuild', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ sampleRate: 44100 });
    // Each rebuild is published whole, before the next one starts swapping contexts.
    const publishedRates: Array<number | undefined> = [];
    manager.subscribeGraphRecreated(() => {
      publishedRates.push(manager.getOutputInfo()?.sampleRate);
    });

    const [a, b] = await Promise.all([
      manager.ensureForTrack({ sampleRate: 96000 }),
      manager.ensureForTrack({ sampleRate: 192000 }),
    ]);

    expect(a.sampleRate).toBe(96000);
    expect(b.sampleRate).toBe(192000);
    expect(manager.getContext()).toBe(b);
    expect(publishedRates).toEqual([96000, 192000]);
    expect(manager.getGraphGeneration()).toBe(2);
    expect(RecordingAudioContext.instances.map((ctx) => ctx.state)).toEqual(['closed', 'closed', 'running']);
  });
});
