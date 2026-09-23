import { describe, it, expect, afterEach } from 'vitest';
import { AudioContextManager } from '../src/audio/AudioContextManager';
import { DEFAULT_ANALYSER_POLICY, applyAnalyserPolicy } from '../src/audio/analyserPolicy';
import { installRecordingAudioContext } from './helpers/recordingAudioContext';

describe('analyser policy', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  it('declares every analyser parameter explicitly', () => {
    expect(DEFAULT_ANALYSER_POLICY).toEqual({
      fftSize: 2048,
      smoothingTimeConstant: 0.8,
      minDecibels: -100,
      maxDecibels: -30,
    });
  });

  it('applies all fields, not just fftSize', () => {
    const node = { fftSize: 0, smoothingTimeConstant: 0, minDecibels: 0, maxDecibels: 0 };
    applyAnalyserPolicy(node as unknown as AnalyserNode, {
      fftSize: 512,
      smoothingTimeConstant: 0.5,
      minDecibels: -90,
      maxDecibels: -10,
    });
    expect(node).toEqual({ fftSize: 512, smoothingTimeConstant: 0.5, minDecibels: -90, maxDecibels: -10 });
  });

  it('is applied by AudioContextManager.buildGraph', () => {
    restore = installRecordingAudioContext();
    const manager = new AudioContextManager();
    manager.initialize();
    const analyser = manager.getAnalyser()!;
    expect({
      fftSize: analyser.fftSize,
      smoothingTimeConstant: analyser.smoothingTimeConstant,
      minDecibels: analyser.minDecibels,
      maxDecibels: analyser.maxDecibels,
    }).toEqual(DEFAULT_ANALYSER_POLICY);
  });
});
