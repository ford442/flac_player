// src/workers/flacDecoderWorker.ts
// Web Worker that wraps the WASM FLAC decoder.
// Supports both full-file decode (decodeFile) and chunked/streaming decode.
import { FLACDecoder } from '@wasm-audio-decoders/flac';

let decoder: FLACDecoder | null = null;

function interleave(decoded: {
  sampleRate: number;
  channelData: Float32Array[];
  samplesDecoded: number;
  bitDepth: number;
}) {
  const { sampleRate, channelData, samplesDecoded, bitDepth } = decoded;
  const channels = channelData.length;
  const duration = samplesDecoded / sampleRate;

  const interleaved = new Float32Array(samplesDecoded * channels);
  for (let ch = 0; ch < channels; ch++) {
    const channelSamples = channelData[ch];
    for (let i = 0; i < samplesDecoded; i++) {
      interleaved[i * channels + ch] = channelSamples[i];
    }
  }

  return {
    sampleRate,
    channels,
    interleavedBuffer: interleaved,
    duration,
    bitDepth,
    samplesDecoded,
  };
}

self.onmessage = async (e: MessageEvent) => {
  const { id, type, data } = e.data;

  try {
    if (type === 'init') {
      decoder = new FLACDecoder();
      await decoder.ready;
      self.postMessage({ id, type: 'ready' });
      return;
    }

    if (type === 'reset') {
      if (decoder) {
        decoder.free();
      }
      decoder = new FLACDecoder();
      await decoder.ready;
      self.postMessage({ id, type: 'ready' });
      return;
    }

    if (type === 'decode' && data?.arrayBuffer) {
      if (!decoder) throw new Error('Decoder not initialized');

      const uint8Data = new Uint8Array(data.arrayBuffer);
      const decoded = await decoder.decodeFile(uint8Data);
      const result = interleave(decoded);

      self.postMessage(
        { id, type: 'decoded', result },
        [result.interleavedBuffer.buffer]
      );
      return;
    }

    if (type === 'decodeChunk' && data?.arrayBuffer) {
      if (!decoder) throw new Error('Decoder not initialized');

      const uint8Data = new Uint8Array(data.arrayBuffer);
      const decoded = await decoder.decode(uint8Data);

      if (decoded.samplesDecoded === 0) {
        // No frames decoded yet (e.g. still parsing headers)
        self.postMessage({ id, type: 'chunkDecoded', result: null });
        return;
      }

      const result = interleave(decoded);
      self.postMessage(
        { id, type: 'chunkDecoded', result },
        [result.interleavedBuffer.buffer]
      );
      return;
    }

    if (type === 'flush') {
      if (!decoder) throw new Error('Decoder not initialized');

      const decoded = await decoder.flush();

      if (decoded.samplesDecoded === 0) {
        self.postMessage({ id, type: 'flushed', result: null });
        return;
      }

      const result = interleave(decoded);
      self.postMessage(
        { id, type: 'flushed', result },
        [result.interleavedBuffer.buffer]
      );
      return;
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: (err as Error).message });
  }
};

export {};
