// src/flacDecoder.ts
// Off-main-thread FLAC decoder using a Web Worker + WASM.
// Supports both full-file decode and chunked/streaming decode.
export interface FlacDecoderResult {
  sampleRate: number;
  channels: number;
  interleavedBuffer: Float32Array;
  duration: number;
  bitDepth?: number;
  samplesDecoded?: number;
}

export class FlacDecoder {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  >();

  private request<T>(
    type: string,
    data?: Record<string, unknown>,
    transfer: Transferable[] = []
  ): Promise<T> {
    if (!this.worker) return Promise.reject(new Error('Worker not initialized'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.worker!.postMessage({ id, type, ...(data ? { data } : {}) }, transfer);
    });
  }

  constructor() {
    this.worker = new Worker(
      new URL('./workers/flacDecoderWorker.ts', import.meta.url)
    );

    this.worker.onmessage = (e) => {
      const { id, type, result, error } = e.data;
      const pending = this.pending.get(id);
      if (!pending) return;

      if (type === 'error') {
        pending.reject(new Error(error || 'Unknown worker error'));
      } else {
        pending.resolve(result);
      }
      this.pending.delete(id);
    };

    this.worker.onerror = (err) => {
      console.error('FlacDecoderWorker error:', err);
      this.pending.forEach(({ reject }) =>
        reject(new Error('Worker failed to load'))
      );
      this.pending.clear();
    };
  }

  async init(): Promise<void> {
    return this.request<void>('init');
  }

  async reset(): Promise<void> {
    return this.request<void>('reset');
  }

  async decode(arrayBuffer: ArrayBuffer): Promise<FlacDecoderResult> {
    return this.request<FlacDecoderResult>('decode', { arrayBuffer }, [arrayBuffer]);
  }

  async decodeChunk(arrayBuffer: ArrayBuffer): Promise<FlacDecoderResult | null> {
    return this.request<FlacDecoderResult | null>('decodeChunk', { arrayBuffer }, [arrayBuffer]);
  }

  async flush(): Promise<FlacDecoderResult | null> {
    return this.request<FlacDecoderResult | null>('flush');
  }

  createAudioBuffer(
    audioContext: AudioContext,
    decodedData: FlacDecoderResult
  ): AudioBuffer {
    const frameCount =
      decodedData.interleavedBuffer.length / decodedData.channels;
    const audioBuffer = audioContext.createBuffer(
      decodedData.channels,
      frameCount,
      decodedData.sampleRate
    );

    for (let ch = 0; ch < decodedData.channels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        channelData[i] =
          decodedData.interleavedBuffer[i * decodedData.channels + ch];
      }
    }

    return audioBuffer;
  }

  destroy() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
