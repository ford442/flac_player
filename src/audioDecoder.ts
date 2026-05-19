// src/audioDecoder.ts
// Unified audio decoder that detects FLAC vs native formats and routes accordingly
import { FlacDecoder, FlacDecoderResult } from './flacDecoder';

/**
 * Detect if an ArrayBuffer contains FLAC audio by checking for the FLAC magic bytes "fLaC"
 * at offset 0, or by file extension.
 */
export function isFlacBuffer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const view = new Uint8Array(buf, 0, 4);
  // Check for "fLaC" magic bytes (0x66 0x4C 0x61 0x43)
  return view[0] === 0x66 && view[1] === 0x4C && view[2] === 0x61 && view[3] === 0x43;
}

export function isFlacByExtension(filename?: string): boolean {
  if (!filename) return false;
  return filename.toLowerCase().endsWith('.flac');
}

/**
 * Decode an audio file, automatically routing to FLAC decoder or native decoder based on format.
 * Returns the decoded audio in a standardized format compatible with both Web Audio and worklet backends.
 * 
 * @param arrayBuffer - The audio data to decode
 * @param audioContext - Optional AudioContext for decoding native formats. If not provided, only FLAC will be supported.
 * @param filename - Optional filename for extension-based format detection
 */
export async function decodeAudio(
  arrayBuffer: ArrayBuffer,
  audioContext?: AudioContext,
  filename?: string
): Promise<FlacDecoderResult> {
  const isFlac = isFlacBuffer(arrayBuffer) || isFlacByExtension(filename);

  if (isFlac) {
    // Use FLAC decoder for FLAC files
    const decoder = new FlacDecoder();
    await decoder.init();
    const decodedData = await decoder.decode(arrayBuffer);
    decoder.destroy();
    return decodedData;
  } else {
    // Use native AudioContext.decodeAudioData for MP3 and other formats
    if (!audioContext) {
      throw new Error('Cannot decode non-FLAC audio without an AudioContext. Provide an AudioContext or use FLAC format.');
    }
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Convert AudioBuffer to FlacDecoderResult format for consistency
    return convertAudioBufferToDecoderResult(audioBuffer);
  }
}

/**
 * Decode audio and return the original AudioBuffer if available (for Web Audio API use).
 * This optimizes native format playback by avoiding unnecessary conversions.
 */
export async function decodeAudioWithBuffer(
  arrayBuffer: ArrayBuffer,
  audioContext: AudioContext,
  filename?: string
): Promise<{ decoderResult: FlacDecoderResult; audioBuffer?: AudioBuffer }> {
  const isFlac = isFlacBuffer(arrayBuffer) || isFlacByExtension(filename);

  if (isFlac) {
    // FLAC: return only decoder result
    const decoder = new FlacDecoder();
    await decoder.init();
    const decodedData = await decoder.decode(arrayBuffer);
    decoder.destroy();
    return { decoderResult: decodedData };
  } else {
    // Native format: return both for efficiency
    const nativeBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const decoderResult = convertAudioBufferToDecoderResult(nativeBuffer);
    return { decoderResult, audioBuffer: nativeBuffer };
  }
}

/**
 * Convert an AudioBuffer (from native decoding) to FlacDecoderResult format
 * to maintain consistency across the codebase.
 */
export function convertAudioBufferToDecoderResult(
  audioBuffer: AudioBuffer
): FlacDecoderResult {
  const channels = audioBuffer.numberOfChannels;
  const frameCount = audioBuffer.length;
  const sampleRate = audioBuffer.sampleRate;

  // Create interleaved buffer (channel 0, channel 1, channel 0, channel 1, ...)
  const interleaved = new Float32Array(frameCount * channels);
  for (let ch = 0; ch < channels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < frameCount; i++) {
      interleaved[i * channels + ch] = channelData[i];
    }
  }

  return {
    sampleRate,
    channels,
    interleavedBuffer: interleaved,
    duration: frameCount / sampleRate,
  };
}
