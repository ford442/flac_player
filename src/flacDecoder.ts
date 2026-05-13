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
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker?.postMessage({ id, type: 'init' });
    });
  }

  async reset(): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker?.postMessage({ id, type: 'reset' });
    });
  }

  async decode(arrayBuffer: ArrayBuffer): Promise<FlacDecoderResult> {
    if (!this.worker) throw new Error('Worker not initialized');

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      this.worker!.postMessage(
        { id, type: 'decode', data: { arrayBuffer } },
        [arrayBuffer]
      );
    }) as Promise<FlacDecoderResult>;
  }

  async decodeChunk(arrayBuffer: ArrayBuffer): Promise<FlacDecoderResult | null> {
    if (!this.worker) throw new Error('Worker not initialized');

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      this.worker!.postMessage(
        { id, type: 'decodeChunk', data: { arrayBuffer } },
        [arrayBuffer]
      );
    }) as Promise<FlacDecoderResult | null>;
  }

  async flush(): Promise<FlacDecoderResult | null> {
    if (!this.worker) throw new Error('Worker not initialized');

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, type: 'flush' });
    }) as Promise<FlacDecoderResult | null>;
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
