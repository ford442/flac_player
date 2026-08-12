import { describe, it, expect } from 'vitest';
import {
  chooseSampleRate,
  resolveLatencyHint,
  shouldRecreateContext,
  isSupportedSampleRate,
  SUPPORTED_SAMPLE_RATES,
} from '../src/audio/audioContextPolicy';

describe('resolveLatencyHint', () => {
  it('passes through user latency modes', () => {
    expect(resolveLatencyHint('playback')).toBe('playback');
    expect(resolveLatencyHint('interactive')).toBe('interactive');
    expect(resolveLatencyHint('balanced')).toBe('balanced');
  });
});

describe('chooseSampleRate', () => {
  it('returns supported track rates', () => {
    expect(chooseSampleRate(48000)).toBe(48000);
    expect(chooseSampleRate(96000)).toBe(96000);
  });

  it('returns undefined for missing or exotic rates', () => {
    expect(chooseSampleRate(undefined)).toBeUndefined();
    expect(chooseSampleRate(0)).toBeUndefined();
    expect(chooseSampleRate(37800)).toBeUndefined();
  });

  it('respects a custom supported list', () => {
    expect(chooseSampleRate(48000, undefined, [44100])).toBeUndefined();
  });
});

describe('isSupportedSampleRate', () => {
  it('matches the supported whitelist', () => {
    for (const rate of SUPPORTED_SAMPLE_RATES) {
      expect(isSupportedSampleRate(rate)).toBe(true);
    }
    expect(isSupportedSampleRate(22050)).toBe(false);
  });
});

describe('shouldRecreateContext', () => {
  const policy = { recreateOnSampleRateMismatch: true };

  it('rebuilds when the live context rate differs from the track', () => {
    expect(shouldRecreateContext(44100, 48000, policy)).toBe(true);
  });

  it('does not rebuild when rates already match', () => {
    expect(shouldRecreateContext(48000, 48000, policy)).toBe(false);
  });

  it('does not rebuild for exotic track rates', () => {
    expect(shouldRecreateContext(48000, 37800, policy)).toBe(false);
  });

  it('honours recreateOnSampleRateMismatch=false', () => {
    expect(shouldRecreateContext(44100, 48000, { recreateOnSampleRateMismatch: false })).toBe(false);
  });
});
