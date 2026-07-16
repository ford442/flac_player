/** Byte threshold above which full-file decode is avoided (32 MB). */
export const STREAMING_THRESHOLD_BYTES = 32 * 1024 * 1024;

export type DecodeStrategy = 'buffered' | 'hifi-stream' | 'native-stream';

export interface PlaybackPathInfo {
  strategy: DecodeStrategy;
  label: string;
  detail: string;
}

export function isFlacUrl(url: string): boolean {
  try {
    const path = new URL(url, 'http://local').pathname.toLowerCase();
    return path.endsWith('.flac');
  } catch {
    return url.toLowerCase().includes('.flac');
  }
}

/**
 * Choose decode strategy from file size and output mode.
 * Small files use full WASM decode (better seek); large files stream through the worklet ring buffer.
 */
export function selectDecodeStrategy(
  contentLength: number | null,
  options: {
    outputMode: 'streaming' | 'worklet' | 'web-audio' | 'sdl' | 'sdl2';
    url: string;
    forceStream?: boolean;
  }
): DecodeStrategy {
  const { outputMode, url, forceStream } = options;
  const large = contentLength !== null && contentLength >= STREAMING_THRESHOLD_BYTES;

  if (outputMode === 'streaming') {
    if (isFlacUrl(url)) {
      return large || forceStream ? 'hifi-stream' : 'buffered';
    }
    return 'native-stream';
  }

  if (outputMode === 'worklet') {
    return large || forceStream ? 'hifi-stream' : 'buffered';
  }

  return 'buffered';
}

export function describePlaybackPath(strategy: DecodeStrategy): PlaybackPathInfo {
  switch (strategy) {
    case 'hifi-stream':
      return {
        strategy,
        label: 'Hi-Fi streaming',
        detail: 'WASM FLAC decoder → AudioWorklet ring buffer (bounded memory)',
      };
    case 'native-stream':
      return {
        strategy,
        label: 'Native streaming',
        detail: 'Browser <audio> element with HTTP range requests',
      };
    case 'buffered':
      return {
        strategy,
        label: 'Buffered decode',
        detail: 'Full-file WASM decode loaded into memory (best seek, small/medium files)',
      };
  }
}
