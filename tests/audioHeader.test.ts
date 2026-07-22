import { describe, it, expect } from 'vitest';
import { parseFlacHeader, parseWavHeader, parseAudioHeader } from '../src/utils/audioHeader';

function buildFlacStreamInfo(sampleRate: number, channels: number, totalSamples: number): ArrayBuffer {
  const buf = new Uint8Array(64);
  buf[0] = 0x66; buf[1] = 0x4c; buf[2] = 0x61; buf[3] = 0x43; // fLaC
  buf[4] = 0x00; // STREAMINFO block, not last
  buf[5] = 0x00; buf[6] = 0x00; buf[7] = 0x22; // block size 34

  const infoOffset = 8 + 10;
  const b10 = (sampleRate >> 12) & 0xff;
  const b11 = (sampleRate >> 4) & 0xff;
  const b12 = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1);
  const b13 = ((totalSamples / 0x100000000) & 0x0f) | 0x00;
  const ts = totalSamples % 0x100000000;
  const b14 = (ts >> 24) & 0xff;
  const b15 = (ts >> 16) & 0xff;
  const b16 = (ts >> 8) & 0xff;
  const b17 = ts & 0xff;

  buf[infoOffset] = b10;
  buf[infoOffset + 1] = b11;
  buf[infoOffset + 2] = b12;
  buf[infoOffset + 3] = b13;
  buf[infoOffset + 4] = b14;
  buf[infoOffset + 5] = b15;
  buf[infoOffset + 6] = b16;
  buf[infoOffset + 7] = b17;
  return buf.buffer;
}

function buildWav(durationSeconds: number, sampleRate = 44100, channels = 2): ArrayBuffer {
  const bitsPerSample = 16;
  const bytesPerFrame = channels * (bitsPerSample / 8);
  const totalSamples = Math.floor(durationSeconds * sampleRate);
  const dataSize = totalSamples * bytesPerFrame;
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerFrame, true);
  view.setUint16(32, bytesPerFrame, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  return buf;
}

describe('audioHeader', () => {
  it('parses FLAC STREAMINFO duration', () => {
    const header = parseFlacHeader(buildFlacStreamInfo(48000, 2, 48000 * 120));
    expect(header).not.toBeNull();
    expect(header?.format).toBe('flac');
    expect(header?.sampleRate).toBe(48000);
    expect(header?.channels).toBe(2);
    expect(header?.durationSeconds).toBeCloseTo(120, 3);
  });

  it('parses WAV header duration', () => {
    const header = parseWavHeader(buildWav(90));
    expect(header).not.toBeNull();
    expect(header?.format).toBe('wav');
    expect(header?.durationSeconds).toBeCloseTo(90, 1);
  });

  it('delegates to FLAC or WAV parser', () => {
    expect(parseAudioHeader(buildFlacStreamInfo(44100, 2, 44100))?.format).toBe('flac');
    expect(parseAudioHeader(buildWav(30))?.format).toBe('wav');
  });
});
