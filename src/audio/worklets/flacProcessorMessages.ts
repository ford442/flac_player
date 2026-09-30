/**
 * Message protocol between WorkletAudioPlayer (main thread) and the
 * `flac-processor` AudioWorkletProcessor (flacProcessor.ts). Both sides import
 * this module, so `npm run typecheck` covers the protocol.
 *
 * Hi-fi PCM does not travel in messages when SharedArrayBuffer is available: the
 * feeder writes into a shared play ring (playRingSAB.ts) and the processor reads
 * it; the projectM tap goes the other way through a second shared ring. Messages
 * then carry control only. Without SAB (no COOP/COEP) PCM falls back to `chunk`
 * and `projectm-pcm` messages.
 */

export const FLAC_PROCESSOR_NAME = 'flac-processor';

/** Frames per projectM PCM block (setPCMCallback). */
export const PCM_TAP_BLOCK_FRAMES = 512;

/** Same clamp as useAudioSettings / SDL `_set_playback_rate`. */
export const MIN_PLAYBACK_RATE = 0.25;
export const MAX_PLAYBACK_RATE = 4;

export function clampPlaybackRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, rate));
}

export interface FlacProcessorOptions {
  sampleRate: number;
  channels: number;
  /** Chunk fallback only: size of the processor-local ring. */
  ringBufferSeconds?: number;
  /** Shared visualizer tap ring (playRingSAB layout); omitted → `projectm-pcm` messages. */
  tapRing?: SharedArrayBuffer;
}

/** Main thread → processor. */
export type FlacProcessorInbound =
  | { type: 'buffer'; buffer: Float32Array; channels: number }
  /** Hi-fi stream. `ring` = shared play ring; omitted → `chunk` messages feed a local ring. */
  | { type: 'startStreaming'; channels: number; sampleRate: number; ring?: SharedArrayBuffer }
  /** Chunk fallback only (no SharedArrayBuffer). */
  | { type: 'chunk'; buffer: Float32Array }
  /** Chunk fallback only; the shared ring uses its `ended` header slot. */
  | { type: 'endStreaming' }
  | { type: 'seek'; position: number }
  /**
   * Hi-fi stream: drop the ring up to `readFrom` (the writer's position at the seek;
   * omitted → everything queued so far), restart the clock at `position` s;
   * `epoch` tags later position / segmentEnded / ended messages.
   */
  | { type: 'seekStream'; position: number; epoch: number; readFrom?: number }
  /** Hi-fi stream: a spliced (gapless) track starts at write position `at` (omitted → the current write head). */
  | { type: 'markSegment'; at?: number }
  | { type: 'stop' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'queueBuffer'; buffer: Float32Array; channels: number }
  | { type: 'clearQueue' }
  /** Varispeed (tempo and pitch together, like SDL / preservesPitch=false); clamped 0.25–4. */
  | { type: 'setPlaybackRate'; rate: number }
  /** Enable the projectM PCM tap (off by default). */
  | { type: 'setTap'; enabled: boolean };

/** Processor → main thread. */
export type FlacProcessorOutbound =
  /** `epoch` echoes the last seekStream (streaming only). */
  | { type: 'ended'; epoch?: number }
  /** Buffered queue swap, or (streaming) the read head crossed a `markSegment`. */
  | { type: 'segmentEnded'; epoch?: number }
  /**
   * `position` is in media seconds at any playback rate. `consumed` = interleaved
   * samples read from the streaming ring since the last startStreaming/seekStream
   * (chunk-fallback backpressure); `epoch` echoes the last seekStream (streaming only).
   */
  | { type: 'position'; position: number; consumed: number; epoch?: number }
  /** Shared tap: another PCM_TAP_BLOCK_FRAMES frames are in the tap ring. */
  | { type: 'pcmTap' }
  /** Tap fallback (no SharedArrayBuffer): one transferred block. */
  | { type: 'projectm-pcm'; buffer: Float32Array; channels: number; sampleRate: number };
