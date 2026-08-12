import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { probeAudioHeader } from '../src/audio/audioHeader';

describe('probeAudioHeader', () => {
  it('parses FLAC STREAMINFO from the test fixture', () => {
    const data = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/test.flac'));
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const info = probeAudioHeader(buffer);

    expect(info).not.toBeNull();
    expect(info?.sampleRate).toBe(44100);
    expect(info?.channels).toBe(2);
  });

  it('parses a minimal WAV fmt chunk', () => {
    const buffer = new ArrayBuffer(44);
    const view = new DataView(buffer);
    const writeAscii = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 2, true); // stereo
    view.setUint32(24, 48000, true);
    view.setUint32(28, 192000, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    writeAscii(36, 'data');
    view.setUint32(40, 0, true);

    const info = probeAudioHeader(buffer);
    expect(info?.sampleRate).toBe(48000);
    expect(info?.channels).toBe(2);
  });

  it('returns null for unknown formats', () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(probeAudioHeader(buffer)).toBeNull();
  });
});
