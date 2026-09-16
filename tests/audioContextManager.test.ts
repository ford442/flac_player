import { describe, it, expect, afterEach } from 'vitest';
import { AudioContextManager } from '../src/audio/AudioContextManager';
import {
  RecordingAudioContext,
  installRecordingAudioContext,
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

  it('recreates on rate mismatch and restores volume, EQ, ReplayGain, and mute', async () => {
    restore = installRecordingAudioContext();
    allowAllSampleRates();
    const manager = new AudioContextManager();
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
    expect(ctx.gainNodes[0].gain.value).toBeCloseTo(0.5, 6);
    expect(ctx.gainNodes[1].gain.value).toBeCloseTo(0.42, 6);
    expect(ctx.gainNodes[2].gain.value).toBe(0);
    expect(ctx.compressorNodes[0].threshold.value).toBe(-1);
    expect(manager.getEQGains()).toEqual([1, 2, 3, 4, 5]);
    expect(manager.isExternalPlaybackActive()).toBe(true);
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
    await manager.resume();
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
