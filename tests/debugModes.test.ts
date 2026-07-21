import { describe, it, expect } from 'vitest';
import {
  cycleDebugMode,
  debugModeToUniform,
  createDebugConfig,
  VISUALIZER_DEBUG_MODES,
} from '../src/visuals/webgl2/debugModes';
import type { VisualizerDebugMode } from '../src/visuals/types';

describe('debugModeToUniform', () => {
  it('maps each mode to a stable integer for both GPU backends', () => {
    expect(debugModeToUniform('normal')).toBe(0);
    expect(debugModeToUniform('uv')).toBe(1);
    expect(debugModeToUniform('waveform-only')).toBe(2);
    expect(debugModeToUniform('audio-bins')).toBe(3);
    expect(debugModeToUniform('spectrum')).toBe(4);
  });
});

describe('cycleDebugMode', () => {
  it('cycles through all modes and wraps to normal', () => {
    let mode: VisualizerDebugMode = 'normal';
    const seen: VisualizerDebugMode[] = [mode];
    for (let i = 0; i < VISUALIZER_DEBUG_MODES.length; i++) {
      mode = cycleDebugMode(mode);
      seen.push(mode);
    }
    expect(seen.slice(0, -1)).toEqual([...VISUALIZER_DEBUG_MODES]);
    expect(seen[seen.length - 1]).toBe('normal');
  });
});

describe('createDebugConfig', () => {
  it('defaults to normal mode', () => {
    expect(createDebugConfig()).toEqual({ mode: 'normal', showLabel: false });
  });

  it('merges partial overrides', () => {
    expect(createDebugConfig({ mode: 'uv', showLabel: true })).toEqual({
      mode: 'uv',
      showLabel: true,
    });
  });
});
