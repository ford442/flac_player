import { loadDspWasm } from './DspChainNode';

/**
 * `fft_spectrum` from src/sdl/dsp_fft.h, compiled into public/dsp-chain.wasm.
 *
 * A main-thread instance of the same module the dsp-chain worklet runs (its own
 * memory; the worklet's instance is never touched). It is the CPU golden for
 * the gpu-chores WebGPU FFT — dsp_fft.h mirrors the WGSL kernels in f32 — and a
 * spectrum path that needs no WebGPU. Definition: src/gpu-chores/fft.ts.
 */

/** dsp_fft.h DSP_FFT_MAX_BINS. */
export const WASM_FFT_MAX_BINS = 4096;

interface FftExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  scratch_ptr(): number;
  scratch_floats(): number;
  fft_out_ptr(): number;
  fft_lines_ptr(): number;
  fft_spectrum(numFloats: number, channels: number, fftSize: number, bins: number, simd: number): number;
}

export interface WasmFftResult {
  /** `bins` HUD bins (copied out of WASM memory). */
  spectrum: Float32Array;
  /** Raw fftSize/2 normalized magnitude lines (copied). */
  magnitudes: Float32Array;
  fftSize: number;
}

export class WasmFft {
  private readonly scratch: Float32Array;

  private constructor(private readonly exports: FftExports) {
    // ALLOW_MEMORY_GROWTH=0: this view never detaches.
    this.scratch = new Float32Array(exports.memory.buffer, exports.scratch_ptr(), exports.scratch_floats());
  }

  /** Synchronous instantiation (the module has no imports). */
  static fromModule(module: WebAssembly.Module): WasmFft {
    const exports = new WebAssembly.Instance(module, {}).exports as unknown as FftExports;
    exports._initialize?.();
    return new WasmFft(exports);
  }

  /** Largest interleaved input, in floats (16384 stereo frames). */
  get maxSamples(): number {
    return this.scratch.length;
  }

  /**
   * `fft_spectrum` of interleaved `pcm`. `simd: false` forces the scalar stages
   * (bit-identical; for the golden test). Throws RangeError past maxSamples.
   */
  spectrum(
    pcm: Float32Array,
    channels: number,
    fftSize: number,
    bins: number,
    { simd = true }: { simd?: boolean } = {},
  ): WasmFftResult {
    if (pcm.length > this.scratch.length) {
      throw new RangeError(`wasm fft input ${pcm.length} floats > ${this.scratch.length}`);
    }
    this.scratch.set(pcm);
    const n = this.exports.fft_spectrum(pcm.length, channels, fftSize, bins, simd ? 1 : 0);
    const whole = Math.trunc(bins); // i32 conversion, as the C ABI sees it
    const binCount = whole > 0 ? Math.min(whole, WASM_FFT_MAX_BINS) : 64;
    const memory = this.exports.memory.buffer;
    return {
      spectrum: new Float32Array(memory, this.exports.fft_out_ptr(), binCount).slice(),
      magnitudes: new Float32Array(memory, this.exports.fft_lines_ptr(), n >> 1).slice(),
      fftSize: n,
    };
  }
}

let instance: Promise<WasmFft> | null = null;

/** Shared main-thread instance; rejects (and retries next call) when the module is unavailable. */
export function loadWasmFft(): Promise<WasmFft> {
  if (!instance) {
    instance = loadDspWasm().then(({ module }) => WasmFft.fromModule(module));
    instance.catch(() => {
      instance = null;
    });
  }
  return instance;
}
