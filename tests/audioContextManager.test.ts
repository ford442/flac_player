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
});
