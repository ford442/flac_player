// Node env (vitest.decoder.config.ts): loads public/speex-resampler.{js,wasm}.
// THD+N is measured by least-squares fitting the ideal sine at the output rate
// and taking the residual — independent of the filter's (sub-sample) delay.
import { createRequire } from 'module';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createStreamResampler,
  resampleInterleaved,
  resetSpeexResamplerForTests,
  type SpeexResamplerFactory,
} from '../src/audio/resampler';
import { resampleInterleavedLinear } from '../src/audio/linearResampler';

const require = createRequire(import.meta.url);
const speexFactory: SpeexResamplerFactory = () =>
  require(path.join(process.cwd(), 'public/speex-resampler.js'))();

function sine(freq: number, rate: number, seconds: number, channels = 2): Float32Array {
  const frames = Math.round(rate * seconds);
  const out = new Float32Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    const v = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
    for (let c = 0; c < channels; c++) out[i * channels + c] = v;
  }
  return out;
}

/** Signal-to-(noise+distortion) in dB for channel 0 of `pcm`, ignoring 2000 edge frames. */
function thdnDb(pcm: Float32Array, channels: number, freq: number, rate: number): number {
  const frames = Math.floor(pcm.length / channels);
  const w = (2 * Math.PI * freq) / rate;
  let ss = 0, cc = 0, sc = 0, ys = 0, yc = 0;
  const lo = 2000, hi = frames - 2000;
  for (let i = lo; i < hi; i++) {
    const s = Math.sin(w * i), c = Math.cos(w * i), y = pcm[i * channels];
    ss += s * s; cc += c * c; sc += s * c; ys += y * s; yc += y * c;
  }
  const det = ss * cc - sc * sc;
  const a = (ys * cc - yc * sc) / det;
  const b = (yc * ss - ys * sc) / det;
  let sig = 0, err = 0;
  for (let i = lo; i < hi; i++) {
    const fit = a * Math.sin(w * i) + b * Math.cos(w * i);
    const e = pcm[i * channels] - fit;
    sig += fit * fit;
    err += e * e;
  }
  return 10 * Math.log10(sig / err);
}

async function measure(freq: number, from: number, to: number) {
  const input = sine(freq, from, 1);
  const speex = await resampleInterleaved(input, 2, from, to, { factory: speexFactory });
  const linear = resampleInterleavedLinear(input, 2, from, to);
  return { speex: thdnDb(speex, 2, freq, to), linear: thdnDb(linear, 2, freq, to), frames: speex.length / 2 };
}

describe('SpeexDSP resampler vs linear', () => {
  afterEach(() => resetSpeexResamplerForTests());

  // Documented in docs/AUDIO_BACKENDS.md ("Sample-rate conversion").
  const cases: Array<[number, number, number, number]> = [
    // freq, from, to, minimum SpeexDSP THD+N (dB)
    [1000, 44100, 48000, 120],
    [10000, 44100, 48000, 120],
    [1000, 96000, 48000, 120],
    [15000, 96000, 48000, 120],
  ];

  it.each(cases)('%i Hz %i → %i: speex beats linear', async (freq, from, to, minDb) => {
    const r = await measure(freq, from, to);
    console.log(`THD+N ${freq} Hz ${from}→${to}: speex ${r.speex.toFixed(1)} dB, linear ${r.linear.toFixed(1)} dB`);
    expect(r.speex).toBeGreaterThan(minDb);
    expect(r.speex).toBeGreaterThan(r.linear + 20);
    expect(r.frames).toBe(to); // exact output length for 1 s of input
  });

  it('is seamless across stream chunks (equals one-shot)', async () => {
    const input = sine(3000, 44100, 1);
    const whole = await resampleInterleaved(input, 2, 44100, 48000, { factory: speexFactory });
    const rs = await createStreamResampler(2, 44100, 48000, { factory: speexFactory });
    expect(rs.kind).toBe('speex');
    const parts: Float32Array[] = [];
    for (let at = 0; at < input.length; at += 2 * 3001) parts.push(rs.process(input.subarray(at, at + 2 * 3001)));
    parts.push(rs.flush());
    rs.destroy();
    const joined = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { joined.set(p, o); o += p.length; }
    expect(joined.length).toBe(whole.length);
    let maxDiff = 0;
    for (let i = 0; i < joined.length; i++) maxDiff = Math.max(maxDiff, Math.abs(joined[i] - whole[i]));
    expect(maxDiff).toBeLessThan(1e-6);
  });

  it('falls back to linear when the WASM module fails to load', async () => {
    const broken: SpeexResamplerFactory = () => Promise.reject(new Error('no wasm'));
    const rs = await createStreamResampler(2, 44100, 48000, { factory: broken });
    expect(rs.kind).toBe('linear');
    const out = await resampleInterleaved(sine(1000, 44100, 0.1), 2, 44100, 48000, { factory: broken });
    expect(out.length).toBeGreaterThan(0);
  });

  it('linear stream resampler is continuous across chunks', async () => {
    const input = sine(1000, 44100, 1);
    const rs = await createStreamResampler(2, 44100, 48000, { forceLinear: true });
    const a = rs.process(input.subarray(0, 20000));
    const b = rs.process(input.subarray(20000));
    const joined = new Float32Array(a.length + b.length);
    joined.set(a); joined.set(b, a.length);
    expect(thdnDb(joined, 2, 1000, 48000)).toBeGreaterThan(40);
  });

  it('does not touch the buffer when rates already match', async () => {
    const input = sine(1000, 48000, 0.1);
    expect(await resampleInterleaved(input, 2, 48000, 48000, { factory: speexFactory })).toBe(input);
  });
});
