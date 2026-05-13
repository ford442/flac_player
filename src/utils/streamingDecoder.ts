// src/utils/streamingDecoder.ts
// High-level streaming decoder that feeds chunked FLAC data to the WASM worker
// and emits decoded PCM chunks via callback. This keeps memory flat for large files.
import { FlacDecoder, FlacDecoderResult } from '../flacDecoder';

export interface StreamingChunk {
  interleavedBuffer: Float32Array;
  channels: number;
  sampleRate: number;
  duration: number;
  samplesDecoded: number;
}

export class StreamingDecoder {
  private decoder: FlacDecoder;
  private onChunkCallback?: (chunk: StreamingChunk) => void;
  private onErrorCallback?: (error: Error) => void;
  private onEndedCallback?: () => void;
  private _sampleRate = 0;
  private _channels = 0;
  private _totalSamplesDecoded = 0;
  private _destroyed = false;

  constructor() {
    this.decoder = new FlacDecoder();
  }

  async init(): Promise<void> {
    if (this._destroyed) throw new Error('StreamingDecoder has been destroyed');
    await this.decoder.init();
  }

  /**
   * Feed a raw FLAC chunk (e.g. from a fetch stream reader).
   * Decoded PCM will be delivered via onChunkDecoded callback.
   */
  async appendChunk(arrayBuffer: ArrayBuffer): Promise<void> {
    if (this._destroyed) return;
    try {
      const result = await this.decoder.decodeChunk(arrayBuffer);
      if (result) {
        this._handleResult(result);
      }
    } catch (err) {
      this.onErrorCallback?.(err as Error);
    }
  }

  /**
   * Signal the end of the stream and flush any remaining frames.
   */
  async flush(): Promise<void> {
    if (this._destroyed) return;
    try {
      const result = await this.decoder.flush();
      if (result) {
        this._handleResult(result);
      }
      this.onEndedCallback?.();
    } catch (err) {
      this.onErrorCallback?.(err as Error);
    }
  }

  private _handleResult(result: FlacDecoderResult): void {
    if (!result.interleavedBuffer) return;

    if (result.sampleRate > 0) this._sampleRate = result.sampleRate;
    if (result.channels > 0) this._channels = result.channels;
    this._totalSamplesDecoded += result.samplesDecoded || 0;

    this.onChunkCallback?.({
      interleavedBuffer: result.interleavedBuffer,
      channels: result.channels,
      sampleRate: result.sampleRate,
      duration: result.duration,
      samplesDecoded: result.samplesDecoded || 0,
    });
  }

  onChunkDecoded(callback: (chunk: StreamingChunk) => void): void {
    this.onChunkCallback = callback;
  }

  onError(callback: (error: Error) => void): void {
    this.onErrorCallback = callback;
  }

  onEnded(callback: () => void): void {
    this.onEndedCallback = callback;
  }

  get sampleRate(): number {
    return this._sampleRate;
  }

  get channels(): number {
    return this._channels;
  }

  get totalSamplesDecoded(): number {
    return this._totalSamplesDecoded;
  }

  destroy(): void {
    this._destroyed = true;
    this.decoder.destroy();
    this.onChunkCallback = undefined;
    this.onErrorCallback = undefined;
    this.onEndedCallback = undefined;
  }
}
