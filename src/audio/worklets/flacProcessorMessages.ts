/**
 * Message protocol between WorkletAudioPlayer (main thread) and the
 * `flac-processor` AudioWorkletProcessor (flacProcessor.js). The processor
 * imports these via JSDoc so `npm run typecheck` covers both sides.
 */

export const FLAC_PROCESSOR_NAME = 'flac-processor';

export interface FlacProcessorOptions {
  sampleRate: number;
  channels: number;
  ringBufferSeconds?: number;
}

/** Main thread → processor. */
export type FlacProcessorInbound =
  | { type: 'buffer'; buffer: Float32Array; channels: number }
  | { type: 'startStreaming'; channels: number; sampleRate: number }
  | { type: 'chunk'; buffer: Float32Array }
  | { type: 'endStreaming' }
  | { type: 'seek'; position: number }
  /** Hi-fi stream: empty the ring, clock restarts at `position` s; `epoch` tags later positions. */
  | { type: 'seekStream'; position: number; epoch: number }
  /** Hi-fi stream: the next chunk begins a spliced (gapless) track. */
  | { type: 'markSegment' }
  | { type: 'stop' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'queueBuffer'; buffer: Float32Array; channels: number }
  | { type: 'clearQueue' };

/** Processor → main thread. */
export type FlacProcessorOutbound =
  | { type: 'ended' }
  /** Buffered queue swap, or (streaming) the read head crossed a `markSegment`. */
  | { type: 'segmentEnded'; epoch?: number }
  /**
   * `consumed` = interleaved samples read from the streaming ring since the last
   * startStreaming/seekStream; `epoch` echoes the last seekStream (streaming only).
   */
  | { type: 'position'; position: number; consumed: number; epoch?: number }
  | { type: 'projectm-pcm'; buffer: Float32Array; channels: number; sampleRate: number };
