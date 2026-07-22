import type { WebGL2DebugConfig, VisualizerDebugMode } from '../types';
import { DEFAULT_WEBGL2_DEBUG } from '../types';

const MODE_TO_INT: Record<VisualizerDebugMode, number> = {
  normal: 0,
  uv: 1,
  'waveform-only': 2,
  'audio-bins': 3,
  spectrum: 4,
};

export function debugModeToUniform(mode: VisualizerDebugMode): number {
  return MODE_TO_INT[mode] ?? 0;
}

export function cycleDebugMode(current: VisualizerDebugMode): VisualizerDebugMode {
  const order: VisualizerDebugMode[] = [
    'normal', 'uv', 'waveform-only', 'audio-bins', 'spectrum',
  ];
  const idx = order.indexOf(current);
  return order[(idx + 1) % order.length] ?? 'normal';
}

export function createDebugConfig(
  partial?: Partial<WebGL2DebugConfig>,
): WebGL2DebugConfig {
  return { ...DEFAULT_WEBGL2_DEBUG, ...partial };
}

/** Ordered list of debug modes — useful for tests and UI labels. */
export const VISUALIZER_DEBUG_MODES: readonly VisualizerDebugMode[] = [
  'normal',
  'uv',
  'waveform-only',
  'audio-bins',
  'spectrum',
] as const;
