#!/usr/bin/env node
// Regenerate the index-coded FLAC fixtures used by the seek / gapless tests.
// Stereo 16-bit 44.1 kHz (one 48 kHz file); every frame encodes its absolute sample index n:
//   ch0 = (n mod 4096) × 16 − 32768     ch1 = (floor(n / 4096) mod 1024) × 64 − 32768
// so any decoded frame reveals its exact position (see tests/helpers/indexCodedPcm.ts).
//
//   node scripts/make-seek-fixtures.mjs   (needs ffmpeg on PATH)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RATE = 44100;
const OUT = resolve(import.meta.dirname, '../tests/fixtures');

function pcm(startIndex, frames) {
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const n = startIndex + i;
    buf.writeInt16LE((n % 4096) * 16 - 32768, i * 4);
    buf.writeInt16LE((Math.floor(n / 4096) % 1024) * 64 - 32768, i * 4 + 2);
  }
  return buf;
}

function encode(name, startIndex, seconds, rate = RATE) {
  const dir = mkdtempSync(join(tmpdir(), 'seekfx-'));
  const raw = join(dir, 'in.raw');
  writeFileSync(raw, pcm(startIndex, Math.round(seconds * rate)));
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 's16le', '-ar', String(rate), '-ac', '2', '-i', raw,
    '-map_metadata', '-1', '-c:a', 'flac', '-compression_level', '5', join(OUT, name),
  ]);
  rmSync(dir, { recursive: true, force: true });
}

encode('seek-index-40s.flac', 0, 40);
// Gapless pair: B continues A's index, so a gap-free handoff reads n, n+1, …
encode('gapless-a.flac', 0, 3);
encode('gapless-b.flac', 3 * RATE, 3);
// Rate change: must not splice (the backend reloads via ensureForTrack).
encode('gapless-48k.flac', 0, 1, 48000);
console.log('Wrote seek-index-40s.flac, gapless-a.flac, gapless-b.flac, gapless-48k.flac');
