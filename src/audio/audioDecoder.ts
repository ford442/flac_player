// src/audio/audioDecoder.ts
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
 * True when a WASM FLAC decode produced complete, playable audio.
 * @wasm-audio-decoders/flac hands libFLAC only the frames (codec-parser strips
 * fLaC + STREAMINFO), and libFLAC then fails on many valid frames with
 * LOST_SYNC / BAD_HEADER. Depending on where that starts, the result is either
 * empty (0 channels, sampleRate 0, duration NaN) or silently truncated, so any
 * reported frame error counts as a failure too.
 */
export function isUsableFlacDecode(result: FlacDecoderResult | null | undefined): boolean {
  if (!result) return false;
  if (!(result.sampleRate > 0) || !(result.channels > 0)) return false;
  if (!result.interleavedBuffer || result.interleavedBuffer.length === 0) return false;
  if (!Number.isFinite(result.duration) || result.duration <= 0) return false;
  return !result.errors;
}
/** STREAMINFO sample rate (20 bits at byte 18), or 0 if the header is absent. */
export function readFlacStreamInfoSampleRate(buf: ArrayBuffer): number {
  // "fLaC" + 4-byte block header + STREAMINFO (type 0) needs >= 21 bytes.
  if (!isFlacBuffer(buf) || buf.byteLength < 21) return 0;
  const b = new Uint8Array(buf, 0, 21);
  if ((b[4]! & 0x7f) !== 0) return 0;
  return (b[18]! << 12) | (b[19]! << 4) | (b[20]! >> 4);
}

/**
 * Native fallback for FLAC. Prefers an OfflineAudioContext at the STREAMINFO
 * rate so decodeAudioData does not resample; otherwise uses the given context.
 * `bytes` is detached by decodeAudioData.
 */
export async function decodeFlacNatively(
  bytes: ArrayBuffer,
  audioContext?: BaseAudioContext
): Promise<AudioBuffer> {
  const rate = readFlacStreamInfoSampleRate(bytes);
  let ctx: BaseAudioContext | undefined = audioContext;
  if (rate > 0 && typeof OfflineAudioContext !== 'undefined') {
    try {
      ctx = new OfflineAudioContext(1, 1, rate);
    } catch {
      // Rate outside the browser's supported range; fall through to audioContext.
    }
  }
  if (!ctx) throw new Error('No AudioContext available for native FLAC decode');
  return ctx.decodeAudioData(bytes);
}

/**
 * Decode FLAC with the WASM decoder, falling back to decodeAudioData when the
 * WASM result is unusable or the decoder throws. The decoder transfers its
 * input to a worker, so a copy is kept for the fallback when one is possible.
 */
async function decodeFlacWithFallback(
  arrayBuffer: ArrayBuffer,
  audioContext?: BaseAudioContext
): Promise<{ decoderResult: FlacDecoderResult; audioBuffer?: AudioBuffer }> {
  const canFallback = !!audioContext || typeof OfflineAudioContext !== 'undefined';
  const fallbackBytes = canFallback ? arrayBuffer.slice(0) : null;

  let wasmResult: FlacDecoderResult | null = null;
  let wasmError: unknown = null;
  const decoder = new FlacDecoder();
  try {
    await decoder.init();
    wasmResult = await decoder.decode(arrayBuffer);
  } catch (err) {
    wasmError = err;
  } finally {
    decoder.destroy();
  }

  if (wasmResult && isUsableFlacDecode(wasmResult)) {
    return { decoderResult: wasmResult };
  }

  console.warn('[audioDecoder] WASM FLAC decode unusable; falling back to decodeAudioData', {
    error: wasmError instanceof Error ? wasmError.message : wasmError,
    channels: wasmResult?.channels,
    sampleRate: wasmResult?.sampleRate,
    samplesDecoded: wasmResult?.samplesDecoded,
    errors: wasmResult?.errors,
  });

  if (fallbackBytes) {
    try {
      const nativeBuffer = await decodeFlacNatively(fallbackBytes, audioContext);
      return {
        decoderResult: convertAudioBufferToDecoderResult(nativeBuffer),
        audioBuffer: nativeBuffer,
      };
    } catch (nativeErr) {
      // A partial WASM decode beats nothing; otherwise report the failure.
      if (wasmResult && wasmResult.channels > 0 && wasmResult.sampleRate > 0
        && wasmResult.interleavedBuffer.length > 0) {
        console.warn('[audioDecoder] native FLAC decode failed; using partial WASM result', nativeErr);
        return { decoderResult: wasmResult };
      }
      throw new Error(`FLAC decode failed (WASM and native): ${(nativeErr as Error)?.message ?? nativeErr}`);
    }
  }

  if (wasmError) throw wasmError;
  if (wasmResult && wasmResult.channels > 0 && wasmResult.interleavedBuffer.length > 0) {
    return { decoderResult: wasmResult };
  }
  throw new Error('FLAC decode produced no audio and no native decoder is available');
}

/**
 * Decode an audio file, automatically routing to FLAC decoder or native decoder based on format.
 * Returns the decoded audio in a standardized format compatible with both Web Audio and worklet backends.
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
    // WASM FLAC decoder, with decodeAudioData fallback (OfflineAudioContext
    // when no audioContext is given, e.g. the WASM engine mode)
    const { decoderResult } = await decodeFlacWithFallback(arrayBuffer, audioContext);
    return decoderResult;
  } else {
    // Use native AudioContext.decodeAudioData for MP3 and other formats
    if (!audioContext) {
      throw new Error('Cannot decode MP3 or other non-FLAC formats in WASM engine mode. Please use Web Audio or AudioWorklet playback mode, or convert your audio to FLAC format.');
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
    // FLAC: WASM decoder result, or the native AudioBuffer if it fell back
    return decodeFlacWithFallback(arrayBuffer, audioContext);
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
      interleaved[i * channels + ch] = channelData[i]!;
    }
  }

  return {
    sampleRate,
    channels,
    interleavedBuffer: interleaved,
    duration: frameCount / sampleRate,
  };
}
