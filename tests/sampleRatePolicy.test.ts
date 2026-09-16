import { describe, it, expect, afterEach } from 'vitest';
import {
  BALANCED_LATENCY_SECONDS,
  chooseContextSampleRate,
  latencyHintsEqual,
  latencyModeToHint,
  destinationChannelCount,
  probeSampleRateSupported,
  relaxContextOptions,
  shouldRecreateContext,
} from '../src/audio/sampleRatePolicy';
import { resampleInterleavedLinear } from '../src/audio/linearResampler';
import {
  RecordingAudioContext,
  installRecordingAudioContext,
} from './helpers/recordingAudioContext';

describe('sampleRatePolicy', () => {
  it('chooses the file rate when the device reports support', () => {
    expect(chooseContextSampleRate(48000, () => true)).toBe(48000);
    expect(chooseContextSampleRate(96000, (rate) => rate <= 48000)).toBeUndefined();
  });

  it('omits the constructor rate when the file rate is missing or invalid', () => {
    expect(chooseContextSampleRate(undefined, () => true)).toBeUndefined();
    expect(chooseContextSampleRate(0, () => true)).toBeUndefined();
    expect(chooseContextSampleRate(-1, () => true)).toBeUndefined();
  });

  it('recreates on sample-rate mismatch only when the policy allows it', () => {
    expect(shouldRecreateContext({
      liveRate: 44100,
      targetRate: 48000,
      liveHint: 'playback',
      nextHint: 'playback',
      recreateOnMismatch: true,
    })).toBe(true);

    expect(shouldRecreateContext({
      liveRate: 44100,
      targetRate: 48000,
      liveHint: 'playback',
      nextHint: 'playback',
      recreateOnMismatch: false,
    })).toBe(false);
  });

  it('does not recreate when the target rate is omitted or already matches', () => {
    expect(shouldRecreateContext({
      liveRate: 48000,
      targetRate: undefined,
      liveHint: 'playback',
      nextHint: 'playback',
      recreateOnMismatch: true,
    })).toBe(false);

    expect(shouldRecreateContext({
      liveRate: 48000,
      targetRate: 48000,
      liveHint: 'playback',
      nextHint: 'playback',
      recreateOnMismatch: true,
    })).toBe(false);
  });

  it('recreates when the latency hint changes', () => {
    expect(shouldRecreateContext({
      liveRate: 48000,
      targetRate: 48000,
      liveHint: 'playback',
      nextHint: 'interactive',
      recreateOnMismatch: false,
    })).toBe(true);

    expect(latencyModeToHint('balanced')).toBe(BALANCED_LATENCY_SECONDS);
    expect(latencyHintsEqual('playback', 'playback')).toBe(true);
    expect(latencyHintsEqual(0.03, 0.03)).toBe(true);
  });
});

describe('probeSampleRateSupported', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('uses AudioContext.isSampleRateSupported when present', () => {
    restore = installRecordingAudioContext();
    const Ctor = globalThis.AudioContext as typeof AudioContext & {
      isSampleRateSupported?: (rate: number) => boolean;
    };
    Ctor.isSampleRateSupported = (rate) => rate === 48000;
    expect(probeSampleRateSupported(48000)).toBe(true);
    expect(probeSampleRateSupported(192000)).toBe(false);
    expect(RecordingAudioContext.instances).toHaveLength(0);
    delete Ctor.isSampleRateSupported;
  });

  it('falls back to a construct/close probe', () => {
    restore = installRecordingAudioContext();
    expect(probeSampleRateSupported(96000)).toBe(true);
    expect(RecordingAudioContext.instances[0]?.state).toBe('closed');
  });
});

describe('resampleInterleavedLinear', () => {
  it('is a no-op when rates match', () => {
    const pcm = new Float32Array([0, 1, 0, 1]);
    expect(resampleInterleavedLinear(pcm, 2, 48000, 48000)).toBe(pcm);
  });

  it('changes frame count proportionally', () => {
    const pcm = new Float32Array([0, 0, 1, 1, 0, 0]);
    const out = resampleInterleavedLinear(pcm, 2, 48000, 24000);
    expect(out.length).toBe(4);
  });
});

describe('context option fallbacks', () => {
  it('relaxes numeric hint, then sinkId, then sampleRate', () => {
    let o = relaxContextOptions({ latencyHint: 0.03, sinkId: 'dac', sampleRate: 96000 });
    expect(o).toEqual({ latencyHint: 'interactive', sinkId: 'dac', sampleRate: 96000 });
    o = relaxContextOptions(o!);
    expect(o).toEqual({ latencyHint: 'interactive', sampleRate: 96000 });
    o = relaxContextOptions(o!);
    expect(o).toEqual({ latencyHint: 'interactive' });
    expect(relaxContextOptions(o!)).toBeNull();
  });

  it('clamps destination channels to stereo..device max', () => {
    expect(destinationChannelCount(undefined, 8)).toBeUndefined();
    expect(destinationChannelCount(1, 2)).toBe(2);
    expect(destinationChannelCount(6, 2)).toBe(2);
    expect(destinationChannelCount(6, 8)).toBe(6);
    expect(destinationChannelCount(6, 0)).toBe(6);
  });
});
