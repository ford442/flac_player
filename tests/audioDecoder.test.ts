import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isFlacBuffer,
  isFlacByExtension,
  isUsableFlacDecode,
  readFlacStreamInfoSampleRate,
  decodeAudio,
  decodeAudioWithBuffer,
  convertAudioBufferToDecoderResult,
} from '../src/audio/audioDecoder';
import type { FlacDecoderResult } from '../src/audio/flacDecoder';

const flacMagic = new Uint8Array([0x66, 0x4c, 0x61, 0x43]).buffer;

const goodWasmResult = (): FlacDecoderResult => ({
  sampleRate: 44100,
  channels: 2,
  interleavedBuffer: new Float32Array(4),
  duration: 0.001,
});

const wasm = vi.hoisted(() => ({
  decode: null as null | ((buf: ArrayBuffer) => Promise<unknown>),
}));

vi.mock('../src/audio/flacDecoder', () => ({
  FlacDecoder: class MockFlacDecoder {
    init = vi.fn().mockResolvedValue(undefined);
    decode = vi.fn((buf: ArrayBuffer) => wasm.decode!(buf));
    destroy = vi.fn();
  },
}));

/** "fLaC" + STREAMINFO header with the given sample rate (rest zeroed). */
function flacHeader(sampleRate: number): ArrayBuffer {
  const b = new Uint8Array(42);
  b.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0x00, 0x00, 0x22]);
  b[18] = (sampleRate >> 12) & 0xff;
  b[19] = (sampleRate >> 4) & 0xff;
  b[20] = ((sampleRate & 0x0f) << 4) | 0x02; // + channels-1 bits, irrelevant here
  return b.buffer;
}

function mockAudioBuffer(sampleRate: number, frames = 3): AudioBuffer {
  const data = new Float32Array(frames).fill(0.5);
  return {
    numberOfChannels: 2,
    length: frames,
    sampleRate,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

/** What the WASM worker returned for the projectM FLACs (LOST_SYNC on every frame). */
const emptyWasmResult = (): FlacDecoderResult => ({
  sampleRate: 0,
  channels: 0,
  interleavedBuffer: new Float32Array(0),
  duration: 0,
  samplesDecoded: 0,
  errors: 3580,
});

describe('isFlacBuffer', () => {
  it('detects FLAC magic bytes', () => {
    expect(isFlacBuffer(flacMagic)).toBe(true);
  });

  it('rejects buffers shorter than 4 bytes', () => {
    expect(isFlacBuffer(new ArrayBuffer(2))).toBe(false);
  });

  it('rejects non-FLAC content', () => {
    const buf = new Uint8Array([0x49, 0x44, 0x33, 0x04]).buffer;
    expect(isFlacBuffer(buf)).toBe(false);
  });
});

describe('isFlacByExtension', () => {
  it('matches .flac case-insensitively', () => {
    expect(isFlacByExtension('song.FLAC')).toBe(true);
  });

  it('rejects other extensions', () => {
    expect(isFlacByExtension('song.mp3')).toBe(false);
    expect(isFlacByExtension(undefined)).toBe(false);
  });
});

describe('readFlacStreamInfoSampleRate', () => {
  it('reads the 20-bit STREAMINFO sample rate', () => {
    expect(readFlacStreamInfoSampleRate(flacHeader(44100))).toBe(44100);
    expect(readFlacStreamInfoSampleRate(flacHeader(96000))).toBe(96000);
  });

  it('returns 0 without a FLAC header', () => {
    expect(readFlacStreamInfoSampleRate(new ArrayBuffer(42))).toBe(0);
    expect(readFlacStreamInfoSampleRate(flacMagic)).toBe(0);
  });
});

describe('isUsableFlacDecode', () => {
  it('accepts a complete decode', () => {
    expect(isUsableFlacDecode(goodWasmResult())).toBe(true);
    expect(isUsableFlacDecode({ ...goodWasmResult(), errors: 0 })).toBe(true);
  });

  it('rejects empty decodes (0 channels / sampleRate 0 / NaN duration)', () => {
    expect(isUsableFlacDecode(emptyWasmResult())).toBe(false);
    expect(isUsableFlacDecode({ ...goodWasmResult(), channels: 0 })).toBe(false);
    expect(isUsableFlacDecode({ ...goodWasmResult(), sampleRate: 0 })).toBe(false);
    expect(isUsableFlacDecode({ ...goodWasmResult(), duration: NaN })).toBe(false);
    expect(isUsableFlacDecode({ ...goodWasmResult(), interleavedBuffer: new Float32Array(0) })).toBe(false);
    expect(isUsableFlacDecode(null)).toBe(false);
  });

  it('rejects partial decodes that reported frame errors', () => {
    expect(isUsableFlacDecode({ ...goodWasmResult(), errors: 1290 })).toBe(false);
  });
});

describe('decodeAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    wasm.decode = async () => goodWasmResult();
  });

  it('routes FLAC magic buffers to the FLAC decoder', async () => {
    const result = await decodeAudio(flacMagic);
    expect(result.sampleRate).toBe(44100);
    expect(result.channels).toBe(2);
  });

  it('routes by .flac filename when magic bytes are absent', async () => {
    const mp3Like = new ArrayBuffer(8);
    const result = await decodeAudio(mp3Like, undefined, 'track.flac');
    expect(result.sampleRate).toBe(44100);
  });

  it('requires AudioContext for non-FLAC formats', async () => {
    const mp3Like = new ArrayBuffer(8);
    await expect(decodeAudio(mp3Like)).rejects.toThrow(/Cannot decode MP3/);
  });

  it('uses AudioContext.decodeAudioData for native formats', async () => {
    const channelData = new Float32Array([0.1, 0.2]);
    const mockBuffer = {
      numberOfChannels: 1,
      length: 2,
      sampleRate: 48000,
      getChannelData: () => channelData,
    } as unknown as AudioBuffer;

    const decodeAudioData = vi.fn().mockResolvedValue(mockBuffer);
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const result = await decodeAudio(new ArrayBuffer(16), ctx, 'track.mp3');
    expect(decodeAudioData).toHaveBeenCalledOnce();
    expect(result.sampleRate).toBe(48000);
    expect(result.channels).toBe(1);
    expect(result.interleavedBuffer.length).toBe(2);
  });
});

describe('FLAC fallback to decodeAudioData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('falls back to the given AudioContext when WASM returns no audio', async () => {
    // The real FlacDecoder transfers (detaches) its input; the fallback must use a copy.
    wasm.decode = async (buf) => {
      structuredClone(buf, { transfer: [buf] });
      return emptyWasmResult();
    };
    const decodeAudioData = vi.fn(async (bytes: ArrayBuffer) => {
      expect(bytes.byteLength).toBe(42);
      return mockAudioBuffer(44100);
    });
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const result = await decodeAudio(flacHeader(44100), ctx, 'song.flac');
    expect(decodeAudioData).toHaveBeenCalledOnce();
    expect(result.channels).toBe(2);
    expect(result.sampleRate).toBe(44100);
    expect(Number.isFinite(result.duration)).toBe(true);
  });

  it('falls back when the WASM decoder throws', async () => {
    wasm.decode = async () => { throw new Error('worker died'); };
    const decodeAudioData = vi.fn().mockResolvedValue(mockAudioBuffer(48000));
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const result = await decodeAudio(flacHeader(48000), ctx);
    expect(result.sampleRate).toBe(48000);
  });

  it('falls back on a truncated decode with frame errors', async () => {
    wasm.decode = async () => ({ ...goodWasmResult(), errors: 1290 });
    const decodeAudioData = vi.fn().mockResolvedValue(mockAudioBuffer(44100, 10));
    const ctx = { decodeAudioData } as unknown as AudioContext;

    const result = await decodeAudio(flacHeader(44100), ctx);
    expect(decodeAudioData).toHaveBeenCalledOnce();
    expect(result.interleavedBuffer.length).toBe(20);
  });

  it('does not call decodeAudioData when the WASM decode is good', async () => {
    wasm.decode = async () => goodWasmResult();
    const decodeAudioData = vi.fn();
    const ctx = { decodeAudioData } as unknown as AudioContext;

    await decodeAudio(flacHeader(44100), ctx);
    expect(decodeAudioData).not.toHaveBeenCalled();
  });

  it('uses an OfflineAudioContext at the STREAMINFO rate (SDL mode, no context)', async () => {
    wasm.decode = async () => emptyWasmResult();
    const created: number[] = [];
    vi.stubGlobal('OfflineAudioContext', class {
      constructor(_ch: number, _len: number, rate: number) { created.push(rate); }
      decodeAudioData = vi.fn().mockResolvedValue(mockAudioBuffer(96000));
    });

    const result = await decodeAudio(flacHeader(96000), undefined, 'hires.flac');
    expect(created).toEqual([96000]);
    expect(result.sampleRate).toBe(96000);
  });

  it('decodeAudioWithBuffer returns the native AudioBuffer after fallback', async () => {
    wasm.decode = async () => emptyWasmResult();
    const native = mockAudioBuffer(44100);
    const ctx = { decodeAudioData: vi.fn().mockResolvedValue(native) } as unknown as AudioContext;

    const { decoderResult, audioBuffer } = await decodeAudioWithBuffer(flacHeader(44100), ctx);
    expect(audioBuffer).toBe(native);
    expect(decoderResult.channels).toBe(2);
  });

  it('throws a clear error when both decoders fail', async () => {
    wasm.decode = async () => emptyWasmResult();
    const ctx = {
      decodeAudioData: vi.fn().mockRejectedValue(new Error('EncodingError')),
    } as unknown as AudioContext;

    await expect(decodeAudio(flacHeader(44100), ctx)).rejects.toThrow(/WASM and native/);
  });

  it('throws instead of returning an empty result when no fallback exists', async () => {
    wasm.decode = async () => emptyWasmResult();
    await expect(decodeAudio(flacHeader(44100))).rejects.toThrow(/no audio/);
  });
});

describe('convertAudioBufferToDecoderResult', () => {
  it('interleaves stereo channel data', () => {
    const left = new Float32Array([1, 2]);
    const right = new Float32Array([3, 4]);
    const audioBuffer = {
      numberOfChannels: 2,
      length: 2,
      sampleRate: 44100,
      getChannelData: (ch: number) => (ch === 0 ? left : right),
    } as unknown as AudioBuffer;

    const result = convertAudioBufferToDecoderResult(audioBuffer);
    expect(result.interleavedBuffer).toEqual(new Float32Array([1, 3, 2, 4]));
    expect(result.duration).toBeCloseTo(2 / 44100);
  });
});
