import type { WebGL2DebugConfig, WebGL2DebugMode } from '../types';
import { DEFAULT_WEBGL2_DEBUG } from '../types';

const MODE_TO_INT: Record<WebGL2DebugMode, number> = {
  normal: 0,
  uv: 1,
  'waveform-only': 2,
  'audio-bins': 3,
  spectrum: 4,
};

export function debugModeToUniform(mode: WebGL2DebugMode): number {
  return MODE_TO_INT[mode] ?? 0;
}

export function cycleDebugMode(current: WebGL2DebugMode): WebGL2DebugMode {
  const order: WebGL2DebugMode[] = [
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
