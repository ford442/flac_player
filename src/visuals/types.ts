import type { ShaderGUIUniforms } from '../webgpuVisualizer';

/** Active audio visualization backend. */
export type VisualizerBackend = 'webgpu' | 'webgl2' | 'canvas2d';

/** Shared per-frame GUI shader parameters — all backends read the same shape. */
export type VisualizerUniforms = ShaderGUIUniforms;

/**
 * Debug visualization modes shared by WebGPU + WebGL2 ShaderGUI shaders.
 * Cycle with Alt+D while the player is focused.
 */
export type VisualizerDebugMode =
  | 'normal'
  | 'uv'
  | 'waveform-only'
  | 'audio-bins'
  | 'spectrum';

/** @deprecated Use VisualizerDebugMode — alias retained for existing imports. */
export type WebGL2DebugMode = VisualizerDebugMode;

export interface WebGL2DebugConfig {
  mode: VisualizerDebugMode;
  /** When true, overlay backend label on canvas. */
  showLabel: boolean;
}

export const DEFAULT_WEBGL2_DEBUG: WebGL2DebugConfig = {
  mode: 'normal',
  showLabel: false,
};

/** Agent/CI-facing handle exposed on `window.currentVisualizer`. */
export interface CurrentVisualizer {
  backend: VisualizerBackend;
  /** Read back RGBA pixels from the active canvas (bottom-left origin). */
  readPixels(): Uint8Array | null;
  getCanvas(): HTMLCanvasElement | null;
  setDebugMode(mode: WebGL2DebugMode): void;
  getDebugMode(): WebGL2DebugMode;
  resize(): void;
}

declare global {
  interface Window {
    DEBUG_VISUALIZER?: VisualizerBackend;
    currentVisualizer: CurrentVisualizer | null;
  }
}
