import { describe, expect, it } from 'vitest';
import { DspChainNode } from '../../src/audio/DspChainNode';
import { WasmFft } from '../../src/audio/wasmFft';
import { FFT_GPU_EPSILON } from '../../src/gpu-chores/fft';
import { runWebGpuFft } from '../../src/gpu-chores/webgpuFft';

// End to end in Chromium: dsp-chain worklet → analysis ring (SharedArrayBuffer,
// the page is cross-origin isolated by vitest.browser.config.ts) → dsp_fft.h in
// WASM, and the WebGPU `fft_spectrum` checked against that golden.
const RATE = 48000;
const FRAMES = 128 * 375; // whole render quanta, so the ring ends on the last output frame
const N = 2048;
const TONE_BIN = 64; // 1500 Hz at 48 kHz / 2048

async function getDevice(): Promise<GPUDevice | null> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return null;
  const adapter = await gpu.requestAdapter().catch(() => null);
  return adapter ? adapter.requestDevice() : null;
}

async function renderThroughDsp(): Promise<{ dsp: DspChainNode; rendered: AudioBuffer }> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: FRAMES, sampleRate: RATE });
  const osc = new OscillatorNode(ctx, { frequency: (TONE_BIN * RATE) / N });
  const level = new GainNode(ctx, { gain: 0.5 });
  const dsp = await DspChainNode.create(ctx, 2);
  osc.connect(level).connect(dsp.node).connect(ctx.destination);
  osc.start();
  return { dsp, rendered: await ctx.startRendering() };
}

async function loadFft(): Promise<WasmFft> {
  const res = await fetch('/dsp-chain.wasm');
  return WasmFft.fromModule(await WebAssembly.compile(await res.arrayBuffer()));
}

describe('analysis ring tap (dsp-chain worklet)', async () => {
  const device = await getDevice();

  it('holds the exact post-DSP frames the worklet output', async () => {
    expect(crossOriginIsolated).toBe(true);
    const { dsp, rendered } = await renderThroughDsp();
    expect(dsp.analysisRing).not.toBeNull();
    const snap = dsp.analysisRing!.readLatest(N)!;
    expect(snap.channels).toBe(2);
    expect(snap.sampleRate).toBe(RATE);
    expect(snap.frames).toBe(N);
    const left = rendered.getChannelData(0);
    const right = rendered.getChannelData(1);
    for (let i = 0; i < N; i++) {
      expect(snap.pcm[2 * i]).toBe(left[FRAMES - N + i]);
      expect(snap.pcm[2 * i + 1]).toBe(right[FRAMES - N + i]);
    }
  });

  it('feeds dsp_fft.h, and WebGPU agrees within FFT_GPU_EPSILON', async () => {
    const { dsp } = await renderThroughDsp();
    const snap = dsp.analysisRing!.readLatest(N)!;
    const golden = (await loadFft()).spectrum(snap.pcm, snap.channels, N, 64);
    expect(golden.magnitudes[TONE_BIN]).toBeCloseTo(0.5, 3);
    if (!device) return;
    const gpu = await runWebGpuFft(device, snap.pcm, 64, snap.channels, N);
    let diff = 0;
    for (let k = 0; k < golden.magnitudes.length; k++) {
      diff = Math.max(diff, Math.abs(golden.magnitudes[k] - gpu.magnitudes[k]));
    }
    expect(diff).toBeLessThan(FFT_GPU_EPSILON);
    for (let b = 0; b < 64; b++) expect(Math.abs(golden.spectrum[b] - gpu.spectrum[b])).toBeLessThan(FFT_GPU_EPSILON);
  });
});
