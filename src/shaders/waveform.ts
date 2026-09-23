import waveformSource from './waveform.wgsl?raw';
import { injectShaderTokens, waveformLayoutTokens } from '../visuals/waveformContract';

export interface WaveformShaderOptions {
  /** Device has `shader-f16`: glow math runs in f16. f32 otherwise. */
  f16?: boolean;
}

/**
 * ShaderGUI waveform WGSL. Source of truth is `waveform.wgsl`; this wrapper only
 * injects WAVEFORM_LAYOUT constants (src/visuals/waveformContract.ts) and the
 * f16/f32 glow type. Edit the contract for knob/LED UVs — never the literals.
 */
export function buildWaveformWGSL(options: WaveformShaderOptions = {}): string {
  return injectShaderTokens(waveformSource, {
    ...waveformLayoutTokens('wgsl'),
    F16_ENABLE: options.f16 ? 'enable f16;' : '',
    GLOW_T: options.f16 ? 'f16' : 'f32',
  });
}

/** f32 variant (works on every WebGPU device). */
export const waveformWGSL = buildWaveformWGSL();
