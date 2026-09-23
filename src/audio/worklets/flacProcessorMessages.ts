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
  | { type: 'stop' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'queueBuffer'; buffer: Float32Array; channels: number }
  | { type: 'clearQueue' };

/** Processor → main thread. */
export type FlacProcessorOutbound =
  | { type: 'ended' }
  | { type: 'segmentEnded' }
  /** `consumed` = interleaved samples read from the streaming ring so far. */
  | { type: 'position'; position: number; consumed: number }
  | { type: 'projectm-pcm'; buffer: Float32Array; channels: number; sampleRate: number };
