import { StreamingDecoder } from '../utils/streamingDecoder';
import {
  probeRemoteAudio,
  streamRemoteAudio,
  streamResponseBody,
  type RangeFetchProgress,
} from '../utils/rangeFetch';

export interface HifiStreamPipelineOptions {
  url: string;
  /** Pre-fetched Response (e.g. from track cache) — streams without full arrayBuffer(). */
  cachedResponse?: Response;
  expectedDuration?: number;
  signal?: AbortSignal;
  onProgress?: (progress: RangeFetchProgress) => void;
  onMetadata?: (meta: { channels: number; sampleRate: number }) => void;
  onPcmChunk: (interleaved: Float32Array) => void;
  onEnded: () => void;
  onError: (error: Error) => void;
}

/**
 * Fetch FLAC in HTTP Range chunks → WASM decodeChunk → PCM callbacks.
 * Never materializes the full compressed file in memory.
 */
export async function runHifiStreamPipeline(options: HifiStreamPipelineOptions): Promise<void> {
  const decoder = new StreamingDecoder();

  try {
    await decoder.init();

    let metadataSent = false;

    decoder.onChunkDecoded((chunk) => {
      if (!metadataSent && chunk.sampleRate > 0 && chunk.channels > 0) {
        metadataSent = true;
        options.onMetadata?.({ channels: chunk.channels, sampleRate: chunk.sampleRate });
      }
      options.onPcmChunk(chunk.interleavedBuffer);
    });

    decoder.onEnded(() => options.onEnded());
    decoder.onError((err) => options.onError(err));

    const streamOptions = {
      signal: options.signal,
      onProgress: options.onProgress,
    };

    if (options.cachedResponse) {
      for await (const raw of streamResponseBody(options.cachedResponse, streamOptions)) {
        if (options.signal?.aborted) return;
        await decoder.appendChunk(raw);
      }
    } else {
      // Validate range support early for clearer errors
      await probeRemoteAudio(options.url, options.signal);
      for await (const raw of streamRemoteAudio(options.url, streamOptions)) {
        if (options.signal?.aborted) return;
        await decoder.appendChunk(raw);
      }
    }

    await decoder.flush();
  } catch (err) {
    if (options.signal?.aborted) return;
    options.onError(err instanceof Error ? err : new Error(String(err)));
  } finally {
    decoder.destroy();
  }
}
