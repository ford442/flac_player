import { describe, it, expect, afterEach, vi } from 'vitest';
import { AudioContextManager } from '../src/audio/AudioContextManager';
import {
  RecordingAudioContext,
  installRecordingAudioContext,
} from './helpers/recordingAudioContext';

/** The pre-#259 policy: open and rebuild the context at each file's rate (now opt-in). */
function nativeRateManager(): AudioContextManager {
  const manager = new AudioContextManager();
  manager.setPolicy({ recreateOnSampleRateMismatch: true });
  return manager;
}

function allowAllSampleRates(): void {
  (globalThis.AudioContext as typeof AudioContext & {
    isSampleRateSupported?: (rate: number) => boolean;
  }).isSampleRateSupported = () => true;
}

describe('AudioContextManager native-rate policy (opt-in)', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('does not pass sampleRate: 44100 when initializing without a track rate', () => {
    restore = installRecordingAudioContext();
    const manager = nativeRateManager();
    manager.initialize();
    const ctx = RecordingAudioContext.instances[0];
    expect(ctx).toBeDefined();
    expect(ctx.constructorOptions.sampleRate).toBeUndefined();
    expect(ctx.latencyHint).toBe('playback');
  });

  it('creates the context at the track native rate', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = nativeRateManager();
    await manager.ensureForTrack({ sampleRate: 48000, channels: 2 });
    expect(RecordingAudioContext.instances[0].sampleRate).toBe(48000);
    expect(manager.getContext().sampleRate).toBe(48000);
  });

  it('recreates on rate mismatch and restores volume, EQ, ReplayGain, and mute', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = nativeRateManager();
    await manager.ensureForTrack({ sampleRate: 44100 });

    manager.setVolume(0.42);
    manager.setEQGains([1, 2, 3, 4, 5]);
    manager.setReplayGainLinear(0.5);
    manager.setReplayGainLimiter(true);
    manager.setExternalPlaybackActive(true);

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
    // ReplayGain in / out, master, speaker.
    expect(ctx.gainNodes[0].gain.value).toBeCloseTo(0.5, 6);
    expect(ctx.gainNodes[2].gain.value).toBeCloseTo(0.42, 6);
    expect(ctx.gainNodes[3].gain.value).toBe(0);
    expect(ctx.compressorNodes[0].threshold.value).toBe(-1);
    expect(manager.getEQGains()).toEqual([1, 2, 3, 4, 5]);
    expect(manager.isExternalPlaybackActive()).toBe(true);
  });

  it('keeps the same context for a same-rate follow-up track', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = nativeRateManager();
    await manager.ensureForTrack({ sampleRate: 48000 });
    await manager.ensureForTrack({ sampleRate: 48000 });
    expect(RecordingAudioContext.instances).toHaveLength(1);
  });

  it('does not open a graph from setters or getAnalyser before the first track', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = nativeRateManager();
    manager.setEQGains([1, 0, 0, 0, 0]);
    manager.setReplayGainLinear(0.8);
    manager.setReplayGainLimiter(true);
    manager.setVolume(0.5);
    await manager.setSinkId('speaker-2');
    await manager.resume();
    expect(manager.getAnalyser()).toBeNull();
    expect(manager.getOutputInfo()).toBeNull();
    expect(RecordingAudioContext.instances).toHaveLength(0);

    await manager.ensureForTrack({ sampleRate: 96000, channels: 2 });
    expect(RecordingAudioContext.instances).toHaveLength(1);
    const ctx = RecordingAudioContext.instances[0];
    expect(ctx.sampleRate).toBe(96000);
    expect(ctx.constructorOptions).toMatchObject({ sinkId: 'speaker-2' });
    expect(ctx.gainNodes[2].gain.value).toBeCloseTo(0.5, 6);
    expect(manager.getAnalyser()).not.toBeNull();
  });

  it('retries without sampleRate when the native-rate constructor throws', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    RecordingAudioContext.rejectOptions = (o) => o.sampleRate === 384000;
    const manager = nativeRateManager();
    await manager.ensureForTrack({ sampleRate: 384000 });
    expect(RecordingAudioContext.instances).toHaveLength(1);
    expect(manager.getContext().sampleRate).toBe(44100);

    // Same rejected rate on the next track: no recreate loop.
    await manager.ensureForTrack({ sampleRate: 384000 });
    expect(RecordingAudioContext.instances).toHaveLength(1);
  });

  describe('renderSizeHint', () => {
    const proto = RecordingAudioContext.prototype as unknown as { renderQuantumSize?: number };
    afterEach(() => {
      delete proto.renderQuantumSize;
    });

    it('is omitted where the browser has no renderQuantumSize', async () => {
      restore = installRecordingAudioContext();
      allowAllSampleRates();
      const manager = nativeRateManager();
      await manager.setRenderSizeMode('512');
      await manager.ensureForTrack({ sampleRate: 48000 });
      expect(RecordingAudioContext.instances[0].constructorOptions).not.toHaveProperty('renderSizeHint');
      expect(manager.getOutputInfo()?.renderSizeHint).toBeUndefined();
    });

    it('is passed when supported and recreates the graph on change', async () => {
      restore = installRecordingAudioContext();
      allowAllSampleRates();
      proto.renderQuantumSize = 128;
      const manager = nativeRateManager();
      await manager.setRenderSizeMode('hardware');
      await manager.ensureForTrack({ sampleRate: 48000 });
      expect(RecordingAudioContext.instances[0].constructorOptions).toMatchObject({
        renderSizeHint: 'hardware',
        sampleRate: 48000,
      });
      await manager.setRenderSizeMode('256');
      expect(RecordingAudioContext.instances).toHaveLength(2);
      expect(manager.getOutputInfo()).toMatchObject({ renderSizeHint: 256, sampleRate: 48000 });
    });

    it('a rejected hint does not prevent graph create and keeps the native rate', async () => {
      restore = installRecordingAudioContext();
      allowAllSampleRates();
      proto.renderQuantumSize = 128;
      RecordingAudioContext.rejectOptions = (o) =>
        (o as { renderSizeHint?: unknown }).renderSizeHint !== undefined;
      const manager = nativeRateManager();
      await manager.setRenderSizeMode('512');
      await manager.ensureForTrack({ sampleRate: 96000 });
      expect(RecordingAudioContext.instances).toHaveLength(1);
      expect(manager.getContext().sampleRate).toBe(96000);
      expect(manager.getOutputInfo()?.renderSizeHint).toBeUndefined();

      // Not retried on the next same-rate track.
      await manager.ensureForTrack({ sampleRate: 96000 });
      expect(RecordingAudioContext.instances).toHaveLength(1);
    });
  });

  it('falls back from a numeric latencyHint without recreating on every track', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    RecordingAudioContext.rejectOptions = (o) => typeof o.latencyHint === 'number';
    const manager = nativeRateManager();
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
    const manager = nativeRateManager();
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
    const manager = nativeRateManager();
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

describe('AudioContextManager device-rate default (#259 A2 / A8)', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('keeps one context at the device rate across a mixed-rate session', async () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    const rates = [44100, 48000, 96000, 192000, 88200, 44100, 176400, 48000, 32000, 96000];
    for (const sampleRate of rates) {
      await manager.ensureForTrack({ sampleRate, channels: 2 });
    }
    expect(RecordingAudioContext.instances).toHaveLength(1);
    expect(RecordingAudioContext.instances[0].constructorOptions.sampleRate).toBeUndefined();
    expect(manager.getGraphGeneration()).toBe(0);
  });
});

describe('ReplayGain limiter channel width (#259 A1)', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('keeps the (stereo-clamped) compressor out of the chain while the limiter is off', async () => {
    restore = installRecordingAudioContext();
    RecordingAudioContext.maxChannelCount = 8;
    const manager = new AudioContextManager();
    await manager.ensureForTrack({ channels: 6 });
    const ctx = RecordingAudioContext.instances[0];
    expect(ctx.compressorNodes).toHaveLength(0);
    // ReplayGain input feeds its output directly.
    expect(ctx.gainNodes[0].connections).toEqual([ctx.gainNodes[1]]);
  });

  it('limits a 5.1 track per channel pair and merges back to six channels', async () => {
    restore = installRecordingAudioContext();
    RecordingAudioContext.maxChannelCount = 8;
    const manager = new AudioContextManager();
    manager.setReplayGainLimiter(true);
    await manager.ensureForTrack({ channels: 6 });
    const ctx = RecordingAudioContext.instances[0];
    // The graph opens stereo, then widens to the track: only the rewired limiters stay connected.
    const live = ctx.compressorNodes.filter((c) => c.connections.length > 0);
    expect(live).toHaveLength(3);
    const [splitter, merger] = ctx.channelNodes.filter((n) => n.channels === 6);
    expect(splitter).toMatchObject({ kind: 'splitter', channels: 6 });
    expect(merger).toMatchObject({ kind: 'merger', channels: 6 });
    expect(ctx.gainNodes[0].connections).toEqual([splitter]);
    expect(merger.connections).toEqual([ctx.gainNodes[1]]);
    // Every splitter output reaches a pair and every merger input is fed.
    expect(splitter.ports.map((p) => p.output).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    const mergerInputs = ctx.channelNodes
      .filter((node) => node.connections.length > 0)
      .flatMap((node) => node.ports)
      .filter((p) => p.destination === (merger as unknown as AudioNode))
      .map((p) => p.input)
      .sort();
    expect(mergerInputs).toEqual([0, 1, 2, 3, 4, 5]);
    expect(live.every((c) => c.threshold.value === -1 && c.ratio.value === 20)).toBe(true);
  });

  it('uses a single compressor for stereo and drops it when the limiter is turned off', async () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    manager.setReplayGainLimiter(true);
    await manager.ensureForTrack({ channels: 2 });
    const ctx = RecordingAudioContext.instances[0];
    expect(ctx.compressorNodes).toHaveLength(1);
    expect(ctx.gainNodes[0].connections).toEqual([ctx.compressorNodes[0]]);
    manager.setReplayGainLimiter(false);
    expect(ctx.gainNodes[0].connections).toEqual([ctx.gainNodes[1]]);
  });
});

describe('AudioContextManager lifecycle (#259 A3 / A4 / A5 / A7)', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
    vi.useRealTimers();
  });

  it('publishes running / suspended / interrupted / closed from statechange', async () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    const seen: string[] = [];
    manager.subscribeState((state) => seen.push(state));
    expect(manager.getState()).toBe('none');
    await manager.ensureForTrack({});
    const ctx = RecordingAudioContext.instances[0];
    ctx.setState('interrupted');
    ctx.setState('suspended');
    expect(seen).toEqual(['running', 'interrupted', 'suspended']);
  });

  it('suspends after the idle timeout while paused and resumes on play', async () => {
    vi.useFakeTimers();
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager(1000);
    await manager.ensureForTrack({});
    const ctx = RecordingAudioContext.instances[0];
    manager.setPlaybackActive(true);
    manager.setPlaybackActive(false);
    vi.advanceTimersByTime(999);
    expect(ctx.suspendCalls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(ctx.suspendCalls).toBe(1);
    expect(ctx.state).toBe('suspended');

    manager.setPlaybackActive(true);
    await vi.runAllTimersAsync();
    expect(ctx.state).toBe('running');
  });

  it('does not suspend when playback restarts within the idle window', async () => {
    vi.useFakeTimers();
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager(1000);
    await manager.ensureForTrack({});
    manager.setPlaybackActive(false);
    vi.advanceTimersByTime(500);
    manager.setPlaybackActive(true);
    vi.advanceTimersByTime(5000);
    expect(RecordingAudioContext.instances[0].suspendCalls).toBe(0);
  });

  it('resumes an interrupted context (iOS), not only a suspended one', async () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({});
    const ctx = RecordingAudioContext.instances[0];
    ctx.setState('interrupted');
    await manager.resume();
    expect(ctx.state).toBe('running');
  });

  it('retries a refused resume on the next user gesture while playback is wanted', async () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    manager.installLifecycle();
    await manager.ensureForTrack({});
    const ctx = RecordingAudioContext.instances[0];
    ctx.refuseResume = true;
    ctx.setState('suspended');
    manager.setPlaybackActive(true);
    await Promise.resolve();
    expect(ctx.state).toBe('suspended');

    ctx.refuseResume = false;
    window.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    expect(ctx.state).toBe('running');
  });

  it('a gesture does not wake a context that idled out while paused', async () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    manager.installLifecycle();
    await manager.ensureForTrack({});
    const ctx = RecordingAudioContext.instances[0];
    await ctx.suspend();
    const before = ctx.resumeCalls;
    window.dispatchEvent(new Event('keydown'));
    await Promise.resolve();
    expect(ctx.resumeCalls).toBe(before);
    expect(ctx.state).toBe('suspended');
  });

  it('unlock() creates the graph synchronously (inside the gesture)', () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    manager.unlock();
    expect(RecordingAudioContext.instances).toHaveLength(1);
    expect(manager.getState()).toBe('running');
  });

  it('moves to a silent sink while SDL owns the speakers and restores the device after', async () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({});
    const ctx = RecordingAudioContext.instances[0];
    await manager.setSinkId('usb-dac');
    manager.setExternalPlaybackActive(true);
    expect(ctx.setSinkIdCalls.at(-1)).toEqual({ type: 'none' });
    manager.setExternalPlaybackActive(false);
    expect(ctx.setSinkIdCalls.at(-1)).toBe('usb-dac');
  });

  it('falls back to the default output when the sink errors (device unplugged)', async () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({});
    const ctx = RecordingAudioContext.instances[0];
    await manager.setSinkId('usb-dac');
    ctx.dispatch('error');
    await Promise.resolve();
    expect(manager.getSinkId()).toBe('');
    expect(ctx.setSinkIdCalls.at(-1)).toBe('');
  });

  it('notifies graph listeners on sinkchange so readouts refresh', async () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    await manager.ensureForTrack({});
    let notified = 0;
    manager.subscribeGraphRecreated(() => { notified += 1; });
    RecordingAudioContext.instances[0].dispatch('sinkchange');
    expect(notified).toBe(1);
  });
});
