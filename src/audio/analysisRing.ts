/**
 * Analysis ring — one shared-memory tap of the post-DSP PCM the user hears,
 * read by every analysis consumer (gpu-chores `fft_spectrum`, the dsp_fft.h
 * WASM golden, and later projectM / the ShaderGUI spectrum) without a
 * postMessage hop and without any analysis work on the audio thread.
 *
 * Header layout (8 × u32) is shared with src/sdl/analysis_ring.h:
 *   [0] writePos    floats written since the last reset (wraps at 2^32)
 *   [1] generation  bumped on reset / format change; readers resync
 *   [2] capacity    floats, power of two
 *   [3] channels    interleave
 *   [4] sampleRate  Hz
 *   [5..7]          reserved
 *
 * Writers: the SDL3 audio callback (C++, in the module's SharedArrayBuffer) and
 * the `dsp-chain` AudioWorklet (dspChainProcessor.js, a SharedArrayBuffer from
 * {@link createAnalysisRingBuffer}). The ring is broadcast: readers never
 * consume, they snapshot the newest frames and detect torn copies by
 * re-checking writePos / generation afterwards. Writers copy data before
 * publishing writePos, at most {@link analysisRingBlock} floats at a time, so
 * readers stay that far behind the published position.
 */

export const ANALYSIS_RING_HEADER_WORDS = 8;
export const ANALYSIS_RING_HEADER_BYTES = ANALYSIS_RING_HEADER_WORDS * 4;
/** analysis_ring.h ANALYSIS_RING_CAPACITY (512 KiB of f32). */
export const ANALYSIS_RING_CAPACITY = 1 << 17;
/** analysis_ring.h ANALYSIS_RING_MAX_BLOCK: most floats a writer appends before publishing writePos. */
export const ANALYSIS_RING_MAX_BLOCK = 8192;

export const ANALYSIS_RING_WRITE_POS = 0;
export const ANALYSIS_RING_GENERATION = 1;
export const ANALYSIS_RING_CAPACITY_WORD = 2;
export const ANALYSIS_RING_CHANNELS = 3;
export const ANALYSIS_RING_SAMPLE_RATE = 4;

/** Copies that race a writer lapping the window are retried this many times, then dropped. */
const READ_ATTEMPTS = 3;

/** Unpublished-write margin for a ring of `capacity` floats (analysis_ring_block). */
export function analysisRingBlock(capacity: number): number {
  return Math.max(1, Math.min(ANALYSIS_RING_MAX_BLOCK, capacity >>> 1));
}

export interface AnalysisSnapshot {
  /** Interleaved PCM, `frames * channels` floats, oldest first. */
  pcm: Float32Array;
  frames: number;
  channels: number;
  sampleRate: number;
  generation: number;
}

export class AnalysisRingReader {
  private readonly header: Uint32Array;
  private readonly data: Float32Array;

  /**
   * `buffer` is the writer's SharedArrayBuffer (the SDL module's wasmMemory, or
   * one from createAnalysisRingBuffer). Shared memory never detaches, so the
   * views stay valid across WASM memory growth.
   */
  constructor(buffer: ArrayBufferLike, headerOffset: number, dataOffset: number) {
    this.header = new Uint32Array(buffer, headerOffset, ANALYSIS_RING_HEADER_WORDS);
    const capacity = this.header[ANALYSIS_RING_CAPACITY_WORD];
    this.data = new Float32Array(buffer, dataOffset, capacity);
  }

  get capacity(): number {
    return this.data.length;
  }

  get channels(): number {
    return Atomics.load(this.header, ANALYSIS_RING_CHANNELS);
  }

  get sampleRate(): number {
    return Atomics.load(this.header, ANALYSIS_RING_SAMPLE_RATE);
  }

  get generation(): number {
    return Atomics.load(this.header, ANALYSIS_RING_GENERATION);
  }

  /**
   * The newest `frames` frames (fewer right after a reset; null when empty or
   * when every attempt raced the writer). Pass `out` to reuse a buffer; the
   * snapshot's `pcm` is a subarray of it.
   */
  readLatest(frames: number, out?: Float32Array): AnalysisSnapshot | null {
    const capacity = this.data.length;
    if (capacity === 0 || !(frames > 0)) return null;
    // Floats behind writePos that no in-flight (unpublished) write can reach.
    const safe = capacity - analysisRingBlock(capacity);
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const generation = Atomics.load(this.header, ANALYSIS_RING_GENERATION);
      const writePos = Atomics.load(this.header, ANALYSIS_RING_WRITE_POS);
      const channels = Atomics.load(this.header, ANALYSIS_RING_CHANNELS);
      const sampleRate = Atomics.load(this.header, ANALYSIS_RING_SAMPLE_RATE);
      if (channels === 0) return null;

      // Whole frames only. writePos counts floats since the last reset (tracks
      // reset it), so the 2^32 wrap never splits a frame in practice.
      const end = writePos - (writePos % channels);
      const maxFrames = Math.floor(safe / channels);
      const take = Math.min(Math.floor(frames), maxFrames, end / channels);
      if (take <= 0) return null;
      const count = take * channels;
      const target = out && out.length >= count ? out : new Float32Array(count);

      const start = (end - count) >>> 0;
      const idx = start & (capacity - 1);
      const first = Math.min(count, capacity - idx);
      target.set(this.data.subarray(idx, idx + first), 0);
      if (count > first) target.set(this.data.subarray(0, count - first), first);

      // Torn if the writer reset, or (counting its unpublished block) reached
      // into [start, start + count) mid-copy.
      if (Atomics.load(this.header, ANALYSIS_RING_GENERATION) !== generation) continue;
      const after = Atomics.load(this.header, ANALYSIS_RING_WRITE_POS);
      if (((after - start) >>> 0) > safe) continue;

      return { pcm: target.subarray(0, count), frames: take, channels, sampleRate, generation };
    }
    return null;
  }
}

/**
 * A SharedArrayBuffer holding a ring for a JS writer (header at 0, data after
 * it), or null when the page is not cross-origin isolated.
 */
export function createAnalysisRingBuffer(capacity = ANALYSIS_RING_CAPACITY): SharedArrayBuffer | null {
  if (typeof SharedArrayBuffer === 'undefined') return null;
  if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) return null;
  if (capacity <= 0 || (capacity & (capacity - 1)) !== 0) {
    throw new RangeError(`analysis ring capacity must be a power of two, got ${capacity}`);
  }
  const buffer = new SharedArrayBuffer(ANALYSIS_RING_HEADER_BYTES + capacity * 4);
  new Uint32Array(buffer, 0, ANALYSIS_RING_HEADER_WORDS)[ANALYSIS_RING_CAPACITY_WORD] = capacity;
  return buffer;
}

/** Reader over a buffer from {@link createAnalysisRingBuffer}. */
export function readerForRingBuffer(buffer: SharedArrayBuffer): AnalysisRingReader {
  return new AnalysisRingReader(buffer, 0, ANALYSIS_RING_HEADER_BYTES);
}

/** Which writer a tap comes from. */
export type AnalysisTapSource = 'sdl' | 'dsp-chain';

const taps = new Map<AnalysisTapSource, AnalysisRingReader>();

/** Publish (or clear with null) the ring a backend writes. */
export function setAnalysisTap(source: AnalysisTapSource, reader: AnalysisRingReader | null): void {
  if (reader) taps.set(source, reader);
  else taps.delete(source);
}

/**
 * The ring carrying what the user hears: SDL's while it owns output (the
 * dsp-chain worklet then only processes silence), else the dsp-chain worklet's.
 */
export function getAnalysisTap(): { source: AnalysisTapSource; reader: AnalysisRingReader } | null {
  const sdl = taps.get('sdl');
  if (sdl) return { source: 'sdl', reader: sdl };
  const dsp = taps.get('dsp-chain');
  if (dsp) return { source: 'dsp-chain', reader: dsp };
  return null;
}
