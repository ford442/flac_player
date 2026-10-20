/**
 * Main-thread reader for the processor's shared projectM tap ring (overwrite-on-full,
 * like the SDL viz ring in pcm_ring.h). The processor writes every output frame and
 * posts a payload-free `pcmTap` per 512 frames; {@link PcmTapReader.drain} then
 * hands each complete block to the callback.
 */
import { PCM_TAP_BLOCK_FRAMES } from '../../worklets/flacProcessorMessages';
import { createPlayRing, playRingWritePos, ringAdvance, ringDistance, type PlayRing } from '../../worklets/playRingSAB';

/** Tap ring depth (~0.7 s at 44.1 kHz): how late the main thread may drain before blocks are lost. */
const TAP_RING_BLOCKS = 64;

export class PcmTapReader {
  readonly ring: PlayRing;
  private cursor: number;
  private readonly blockFloats: number;

  constructor(readonly channels: number) {
    this.blockFloats = PCM_TAP_BLOCK_FRAMES * channels;
    this.ring = createPlayRing(this.blockFloats * TAP_RING_BLOCKS, true);
    this.cursor = playRingWritePos(this.ring);
  }

  get buffer(): SharedArrayBuffer {
    return this.ring.buffer as SharedArrayBuffer;
  }

  drain(onBlock: (block: Float32Array) => void): void {
    const { ring, blockFloats } = this;
    const write = playRingWritePos(ring);
    let avail = ringDistance(ring, this.cursor, write);
    if (avail > ring.capacity) {
      // Lapped by the writer: keep the newest ring's worth.
      this.cursor = ringAdvance(ring, write, ring.wrap - ring.capacity);
      avail = ring.capacity;
    }
    while (avail >= blockFloats) {
      const block = new Float32Array(blockFloats);
      const idx = this.cursor % ring.capacity;
      const first = Math.min(blockFloats, ring.capacity - idx);
      block.set(ring.data.subarray(idx, idx + first));
      if (first < blockFloats) block.set(ring.data.subarray(0, blockFloats - first), first);
      this.cursor = ringAdvance(ring, this.cursor, blockFloats);
      avail -= blockFloats;
      onBlock(block);
    }
  }
}
