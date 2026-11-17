import { loadDspWasm } from './DspChainNode';

/**
 * One main-thread instance of public/dsp-chain.wasm for analysis readers:
 * `fft_spectrum` (src/audio/wasmFft.ts) and the EBU R128 meter
 * (src/audio/loudnessMeter.ts, src/sdl/dsp_loudness.h). It has its own memory;
 * the dsp-chain worklet's instance is never touched, and nothing here runs on
 * the audio thread. The module has no imports, so instantiation is synchronous.
 */
export interface DspAnalysisExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  scratch_ptr(): number;
  scratch_floats(): number;
  fft_out_ptr(): number;
  fft_lines_ptr(): number;
  fft_spectrum(numFloats: number, channels: number, fftSize: number, bins: number, simd: number): number;
  loudness_reset(channels: number, sampleRate: number): void;
  loudness_push(numFloats: number): void;
  loudness_momentary(): number;
  loudness_short_term(): number;
}

export function instantiateDspAnalysis(module: WebAssembly.Module): DspAnalysisExports {
  const exports = new WebAssembly.Instance(module, {}).exports as unknown as DspAnalysisExports;
  exports._initialize?.();
  return exports;
}

let instance: Promise<DspAnalysisExports> | null = null;

/** The shared analysis instance; rejects (and retries on the next call) when the module is unavailable. */
export function loadDspAnalysisInstance(): Promise<DspAnalysisExports> {
  if (!instance) {
    instance = loadDspWasm().then(({ module }) => instantiateDspAnalysis(module));
    instance.catch(() => {
      instance = null;
    });
  }
  return instance;
}
