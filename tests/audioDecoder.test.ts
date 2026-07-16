import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isFlacBuffer,
  isFlacByExtension,
  decodeAudio,
  convertAudioBufferToDecoderResult,
} from '../src/audioDecoder';

const flacMagic = new Uint8Array([0x66, 0x4c, 0x61, 0x43]).buffer;

vi.mock('../src/flacDecoder', () => ({
  FlacDecoder: class MockFlacDecoder {
    init = vi.fn().mockResolvedValue(undefined);
    decode = vi.fn().mockResolvedValue({
      sampleRate: 44100,
      channels: 2,
      interleavedBuffer: new Float32Array(4),
      duration: 0.001,
    });
    destroy = vi.fn();
  },
}));

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

describe('decodeAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
