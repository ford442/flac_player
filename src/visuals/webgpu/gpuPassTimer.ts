/**
 * GPU pass timings via `timestamp-query`.
 *
 * Begin/end timestamps are written around one render pass per frame, resolved
 * into a small ring of MAP_READ buffers, and read back asynchronously (a few
 * frames of latency is fine for a HUD). When the device lacks the feature every
 * method is a no-op and `gpuTimeMs` stays null — rendering is unaffected.
 */

/** Readback slots in flight; a frame skips timing when all are still mapping. */
export const GPU_TIMER_RING_SIZE = 4;

/** Exponential smoothing for the HUD number (raw values jitter per frame). */
export const GPU_TIMER_SMOOTHING = 0.1;

const QUERY_BYTES = 2 * 8;

interface Slot {
  buffer: GPUBuffer;
  busy: boolean;
}

/** ns delta between two u64 timestamps → ms. Returns null for invalid / wrapped pairs. */
export function timestampDeltaMs(begin: bigint, end: bigint): number | null {
  if (begin === 0n || end < begin) return null;
  return Number(end - begin) / 1e6;
}

export function smoothGpuTime(previous: number | null, sample: number, alpha = GPU_TIMER_SMOOTHING): number {
  return previous === null ? sample : previous + (sample - previous) * alpha;
}

export class GpuPassTimer {
  private querySet: GPUQuerySet | null = null;
  private resolveBuffer: GPUBuffer | null = null;
  private readonly slots: Slot[] = [];
  private pendingSlot: Slot | null = null;
  private destroyed = false;
  private smoothed: number | null = null;
  private last: number | null = null;

  constructor(device: GPUDevice) {
    if (!device.features.has('timestamp-query')) return;
    try {
      this.querySet = device.createQuerySet({ type: 'timestamp', count: 2, label: 'shadergui-pass-timer' });
      this.resolveBuffer = device.createBuffer({
        label: 'shadergui-timer-resolve',
        size: QUERY_BYTES,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      for (let i = 0; i < GPU_TIMER_RING_SIZE; i++) {
        this.slots.push({
          buffer: device.createBuffer({
            label: `shadergui-timer-read-${i}`,
            size: QUERY_BYTES,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          }),
          busy: false,
        });
      }
    } catch (error) {
      console.warn('[GpuPassTimer] timestamp-query unavailable:', error);
      this.querySet?.destroy();
      this.resolveBuffer?.destroy();
      this.slots.length = 0;
      this.querySet = null;
      this.resolveBuffer = null;
    }
  }

  get supported(): boolean {
    return this.querySet !== null;
  }

  /** Smoothed pass time in ms; null until a sample lands or when unsupported. */
  get gpuTimeMs(): number | null {
    return this.smoothed;
  }

  get lastSampleMs(): number | null {
    return this.last;
  }

  /**
   * `timestampWrites` for the pass to measure this frame, or undefined when
   * unsupported / every readback slot is still in flight.
   */
  passTimestampWrites(): GPURenderPassTimestampWrites | undefined {
    if (!this.querySet || this.destroyed) return undefined;
    const slot = this.slots.find((s) => !s.busy);
    if (!slot) return undefined;
    this.pendingSlot = slot;
    return { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }

  /** Record resolve + copy after the measured pass (same encoder, before finish()). */
  resolve(encoder: GPUCommandEncoder): void {
    const slot = this.pendingSlot;
    if (!slot || !this.querySet || !this.resolveBuffer) return;
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, slot.buffer, 0, QUERY_BYTES);
  }

  /** Call after queue.submit(); maps the slot and folds the sample into gpuTimeMs. */
  afterSubmit(): void {
    const slot = this.pendingSlot;
    this.pendingSlot = null;
    if (!slot) return;
    slot.busy = true;
    slot.buffer.mapAsync(GPUMapMode.READ).then(() => {
      if (this.destroyed) return;
      const times = new BigUint64Array(slot.buffer.getMappedRange().slice(0));
      slot.buffer.unmap();
      slot.busy = false;
      const ms = timestampDeltaMs(times[0], times[1]);
      if (ms === null) return;
      this.last = ms;
      this.smoothed = smoothGpuTime(this.smoothed, ms);
    }).catch(() => {
      // Device lost / destroyed mid-map: drop the sample.
      slot.busy = false;
    });
  }

  destroy(): void {
    this.destroyed = true;
    try { this.querySet?.destroy(); } catch { /* already gone */ }
    try { this.resolveBuffer?.destroy(); } catch { /* already gone */ }
    for (const slot of this.slots) {
      try { slot.buffer.destroy(); } catch { /* already gone */ }
    }
    this.slots.length = 0;
  }
}
