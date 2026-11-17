import { getAnalysisTap, type AnalysisRingCursor, type AnalysisRingReader } from './analysisRing';
import { loadDspAnalysisInstance, type DspAnalysisExports } from './dspAnalysisInstance';

/**
 * EBU R128 momentary (400 ms) and short-term (3 s) loudness of what the user
 * hears, metered off the audio thread.
 *
 * The dsp-chain worklet only copies its output into the analysis ring
 * (analysisRing.ts); this reader follows the ring with a cursor on the main
 * thread and feeds every frame to `loudness_push` (src/sdl/dsp_loudness.h,
 * BS.1770-4 K-weighting) on the shared analysis instance of
 * public/dsp-chain.wasm. Nothing here can stall playback: a missing module or
 * ring just leaves the reading null, and frames lost to a throttled tab (the
 * writer lapped the cursor) restart the windows, which then read null until
 * they refill.
 *
 * The meter only runs while something subscribes (the Settings readout).
 */
export interface LoudnessReading {
  /** LUFS over the last 400 ms; null until the window is full, -Infinity for digital silence. */
  momentary: number | null;
  /** LUFS over the last 3 s; null until the window is full. */
  shortTerm: number | null;
  /** False once no new frames arrived for {@link STALE_MS} (paused, suspended context). */
  live: boolean;
  channels: number;
  sampleRate: number;
}

/** No new frames for this long: the reading is kept but marked not live. */
export const STALE_MS = 600;
/** Poll interval ceiling; faster when the ring holds less than ~3 polls of audio. */
const MAX_POLL_MS = 100;
const MIN_POLL_MS = 16;

type Listener = (reading: LoudnessReading | null) => void;

export interface LoudnessMeterDeps {
  loadInstance: () => Promise<DspAnalysisExports>;
  getReader: () => AnalysisRingReader | null;
  now: () => number;
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (id: ReturnType<typeof setInterval>) => void;
}

const defaultDeps: LoudnessMeterDeps = {
  loadInstance: loadDspAnalysisInstance,
  getReader: () => getAnalysisTap()?.reader ?? null,
  now: () => performance.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

function finiteOrNull(lufs: number): number | null {
  return Number.isNaN(lufs) ? null : lufs;
}

export class LoudnessMeter {
  private readonly listeners = new Set<Listener>();
  private wasm: DspAnalysisExports | null = null;
  private loading: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollMs = MAX_POLL_MS;
  private reader: AnalysisRingReader | null = null;
  private cursor: AnalysisRingCursor | null = null;
  private channels = 0;
  private sampleRate = 0;
  private lastFramesAt = -Infinity;
  private reading: LoudnessReading | null = null;
  private buffer: Float32Array | undefined;

  constructor(private readonly deps: LoudnessMeterDeps = defaultDeps) {}

  /** The newest reading, or null while the meter is stopped or has nothing to meter. */
  latest(): LoudnessReading | null {
    return this.reading;
  }

  /** Start metering (first subscriber); the listener gets each new reading. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) this.stop();
    };
  }

  private start(): void {
    if (!this.wasm && !this.loading) {
      this.loading = this.deps
        .loadInstance()
        .then((wasm) => {
          this.wasm = wasm;
        })
        .catch(() => {
          // No module: stay null. The next start() retries.
        })
        .finally(() => {
          this.loading = null;
        });
    }
    this.schedule(MAX_POLL_MS);
  }

  private stop(): void {
    if (this.timer !== null) this.deps.clearInterval(this.timer);
    this.timer = null;
    this.reader = null;
    this.cursor = null;
    this.channels = 0;
    this.sampleRate = 0;
    this.reading = null;
  }

  private schedule(ms: number): void {
    if (this.timer !== null && ms === this.pollMs) return;
    if (this.timer !== null) this.deps.clearInterval(this.timer);
    this.pollMs = ms;
    this.timer = this.deps.setInterval(() => this.poll(), ms);
  }

  /** One read of the ring; public for tests. */
  poll(): void {
    const wasm = this.wasm;
    const reader = this.deps.getReader();
    if (!wasm || !reader) {
      this.publish(null);
      return;
    }
    if (reader !== this.reader) {
      // New graph, new ring: start from its backlog.
      this.reader = reader;
      this.cursor = null;
      this.channels = 0;
    }
    const read = reader.readSince(this.cursor, this.buffer);
    if (!read) {
      this.publishStale();
      return;
    }
    if (!this.buffer || read.pcm.buffer !== this.buffer.buffer) this.buffer = new Float32Array(read.pcm.buffer);
    this.cursor = read.next;

    if (read.gap || read.channels !== this.channels || read.sampleRate !== this.sampleRate) {
      this.channels = read.channels;
      this.sampleRate = read.sampleRate;
      wasm.loudness_reset(read.channels, read.sampleRate);
      this.retune(reader);
    }
    if (read.frames === 0) {
      this.publishStale();
      return;
    }

    const scratch = new Float32Array(wasm.memory.buffer, wasm.scratch_ptr(), wasm.scratch_floats());
    const chunk = scratch.length - (scratch.length % read.channels);
    for (let pos = 0; pos < read.pcm.length; pos += chunk) {
      const piece = read.pcm.subarray(pos, Math.min(read.pcm.length, pos + chunk));
      scratch.set(piece);
      wasm.loudness_push(piece.length);
    }
    this.lastFramesAt = this.deps.now();
    this.publish({
      momentary: finiteOrNull(wasm.loudness_momentary()),
      shortTerm: finiteOrNull(wasm.loudness_short_term()),
      live: true,
      channels: read.channels,
      sampleRate: read.sampleRate,
    });
  }

  /** Poll often enough that the writer cannot lap the cursor between two polls. */
  private retune(reader: AnalysisRingReader): void {
    const ringSeconds = reader.capacity / Math.max(1, this.channels * this.sampleRate);
    const ms = Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, Math.floor((ringSeconds * 1000) / 3)));
    this.schedule(ms);
  }

  private publishStale(): void {
    const reading = this.reading;
    if (!reading || !reading.live) return;
    if (this.deps.now() - this.lastFramesAt < STALE_MS) return;
    this.publish({ ...reading, live: false });
  }

  private publish(reading: LoudnessReading | null): void {
    if (reading === null && this.reading === null) return;
    this.reading = reading;
    for (const listener of this.listeners) listener(reading);
  }
}

export const sharedLoudnessMeter = new LoudnessMeter();
