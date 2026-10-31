/**
 * SPSC float ring shared by the main thread and the `flac-processor` AudioWorklet.
 * Same shape as the SDL play ring (`src/sdl/play_ring.h`): a small Int32 header
 * (`writePos`, `readPos`, `capacity`, `ended`) followed by interleaved f32 PCM.
 *
 * Backed by a SharedArrayBuffer under COOP/COEP (the writer and the audio thread
 * see the same memory; nothing is copied through `postMessage`), or by a plain
 * ArrayBuffer inside the processor for the `chunk` message fallback.
 *
 * Positions are monotonic sample counts that wrap at `wrap` — the largest multiple
 * of `capacity` below 2^31 — so `pos % capacity` stays continuous across the wrap
 * and differences fit in an int32. The writer owns `writePos`/`ended`; the reader
 * owns `readPos`.
 *
 * Imported by the processor (bundled into the worklet) — keep it free of DOM and
 * main-thread-only APIs.
 */

/** Header slot indices (Int32), mirroring `PlayRingState` + `g_streamEnded`. */
export const PLAY_RING_WRITE_POS = 0;
export const PLAY_RING_READ_POS = 1;
export const PLAY_RING_CAPACITY = 2;
export const PLAY_RING_ENDED = 3;
const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * 4;

export interface PlayRing {
  readonly buffer: ArrayBufferLike;
  readonly header: Int32Array;
  readonly data: Float32Array;
  /** Floats. A multiple of the frame size, so a frame never straddles the wrap. */
  readonly capacity: number;
  /** Position modulus: a multiple of `capacity`, ≤ 2^31 − 1. */
  readonly wrap: number;
}

/** True when a SharedArrayBuffer can be handed to an AudioWorklet (COOP/COEP). */
export function sharedPlayRingSupported(): boolean {
  return typeof SharedArrayBuffer === 'function'
    && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

export function createPlayRing(capacityFloats: number, shared: boolean): PlayRing {
  const capacity = Math.max(1, Math.floor(capacityFloats));
  const bytes = HEADER_BYTES + capacity * 4;
  const buffer = shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  new Int32Array(buffer, 0, HEADER_INTS)[PLAY_RING_CAPACITY] = capacity;
  return attachPlayRing(buffer);
}

/** View an existing ring (e.g. the SharedArrayBuffer received by the processor). */
export function attachPlayRing(buffer: ArrayBufferLike): PlayRing {
  const header = new Int32Array(buffer, 0, HEADER_INTS);
  const capacity = header[PLAY_RING_CAPACITY]!;
  return {
    buffer,
    header,
    data: new Float32Array(buffer, HEADER_BYTES, capacity),
    capacity,
    wrap: capacity * Math.floor(0x7fffffff / capacity),
  };
}

/** Samples from position `from` forward to `to` (ring coordinates). */
export function ringDistance(ring: PlayRing, from: number, to: number): number {
  const d = to - from;
  return d < 0 ? d + ring.wrap : d;
}

export function ringAdvance(ring: PlayRing, pos: number, samples: number): number {
  const p = pos + samples;
  return p >= ring.wrap ? p - ring.wrap : p;
}

export function playRingWritePos(ring: PlayRing): number {
  return Atomics.load(ring.header, PLAY_RING_WRITE_POS);
}

export function playRingReadPos(ring: PlayRing): number {
  return Atomics.load(ring.header, PLAY_RING_READ_POS);
}

export function playRingFill(ring: PlayRing): number {
  return ringDistance(ring, playRingReadPos(ring), playRingWritePos(ring));
}

export function playRingEnded(ring: PlayRing): boolean {
  return Atomics.load(ring.header, PLAY_RING_ENDED) !== 0;
}

/** Writer: the stream has no more samples after the current write position. */
export function playRingSetEnded(ring: PlayRing, ended: boolean): void {
  Atomics.store(ring.header, PLAY_RING_ENDED, ended ? 1 : 0);
}

/** Writer, non-blocking (play_ring_push). Returns the number of floats stored. */
export function playRingPush(ring: PlayRing, samples: Float32Array): number {
  const { capacity: cap, data, header } = ring;
  const w = Atomics.load(header, PLAY_RING_WRITE_POS);
  const space = cap - ringDistance(ring, Atomics.load(header, PLAY_RING_READ_POS), w);
  const n = Math.min(samples.length, space);
  if (n <= 0) return 0;
  const idx = w % cap;
  const first = Math.min(n, cap - idx);
  data.set(first === samples.length ? samples : samples.subarray(0, first), idx);
  if (n > first) data.set(samples.subarray(first, n), 0);
  Atomics.store(header, PLAY_RING_WRITE_POS, ringAdvance(ring, w, n));
  return n;
}

/**
 * Reader: deinterleave up to `frames` whole frames into `out[ch][offset…]`.
 * Output channels beyond `channels` are left untouched. Returns frames read.
 */
export function playRingReadFrames(
  ring: PlayRing,
  out: Float32Array[],
  offset: number,
  frames: number,
  channels: number
): number {
  const { capacity: cap, data, header } = ring;
  const r = Atomics.load(header, PLAY_RING_READ_POS);
  const avail = Math.floor(ringDistance(ring, r, Atomics.load(header, PLAY_RING_WRITE_POS)) / channels);
  const n = Math.min(frames, avail);
  if (n <= 0) return 0;
  const outChannels = Math.min(out.length, channels);
  let idx = r % cap;
  let o = offset;
  let left = n;
  while (left > 0) {
    const seg = Math.min(left, (cap - idx) / channels);
    for (let ch = 0; ch < outChannels; ch++) {
      const dst = out[ch]!;
      for (let i = 0, j = idx + ch; i < seg; i++, j += channels) dst[o + i] = data[j]!;
    }
    o += seg;
    left -= seg;
    idx += seg * channels;
    if (idx >= cap) idx = 0;
  }
  Atomics.store(header, PLAY_RING_READ_POS, ringAdvance(ring, r, n * channels));
  return n;
}

/** Reader: copy up to `frames` whole interleaved frames into `dest[offset…]`. Returns frames read. */
export function playRingReadInterleaved(
  ring: PlayRing,
  dest: Float32Array,
  offset: number,
  frames: number,
  channels: number
): number {
  const { capacity: cap, data, header } = ring;
  const r = Atomics.load(header, PLAY_RING_READ_POS);
  const avail = Math.floor(ringDistance(ring, r, Atomics.load(header, PLAY_RING_WRITE_POS)) / channels);
  const n = Math.min(frames, avail);
  if (n <= 0) return 0;
  const count = n * channels;
  const idx = r % cap;
  const first = Math.min(count, cap - idx);
  dest.set(data.subarray(idx, idx + first), offset);
  if (count > first) dest.set(data.subarray(0, count - first), offset + first);
  Atomics.store(header, PLAY_RING_READ_POS, ringAdvance(ring, r, count));
  return n;
}

/**
 * Reader: drop everything before `pos` (a writer position taken at seek time).
 * Returns how many floats the reader had already consumed past `pos` (0 when it
 * jumped forward) so the caller can keep its clock exact.
 */
export function playRingSkipTo(ring: PlayRing, pos: number): number {
  const { header } = ring;
  const r = Atomics.load(header, PLAY_RING_READ_POS);
  const w = Atomics.load(header, PLAY_RING_WRITE_POS);
  if (ringDistance(ring, r, pos) <= ringDistance(ring, r, w)) {
    Atomics.store(header, PLAY_RING_READ_POS, pos);
    return 0;
  }
  return ringDistance(ring, pos, r);
}

/**
 * Overwrite-on-full writer for the visualizer tap (pcm_ring_write): interleave
 * `frames` frames of `out` at the write head without checking the reader.
 */
export function pcmTapWrite(ring: PlayRing, out: Float32Array[], frames: number, channels: number): void {
  const { capacity: cap, data, header } = ring;
  const w = Atomics.load(header, PLAY_RING_WRITE_POS);
  let idx = w % cap;
  const outChannels = Math.min(out.length, channels);
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) data[idx + ch] = ch < outChannels ? out[ch]![i]! : 0;
    idx += channels;
    if (idx >= cap) idx = 0;
  }
  Atomics.store(header, PLAY_RING_WRITE_POS, ringAdvance(ring, w, frames * channels));
}
