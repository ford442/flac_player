import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fftBufferStats, runWebGpuFft } from '../src/gpu-chores/webgpuFft';
import { fakeDevice, installGpuEnums } from './helpers/fakeGpu';

describe('WebGPU fft_spectrum buffer cache (#259 W7)', () => {
  let restoreEnums: () => void;
  beforeEach(() => { restoreEnums = installGpuEnums(); });
  afterEach(() => restoreEnums());

  it('creates buffers and tables once per (device, N) and reuses them at meter rate', async () => {
    const dev = fakeDevice();
    const pcm = new Float32Array(2048);
    const before = fftBufferStats.created;

    await runWebGpuFft(dev.device, pcm, 64, 1, 2048);
    const firstRun = fftBufferStats.created - before;
    // twiddles, hann, params, mags, read, pcm, a, b
    expect(firstRun).toBe(8);
    const tableWrites = dev.device.queue.writeBuffer as unknown as { mock: { calls: unknown[] } };
    const writesAfterFirst = tableWrites.mock.calls.length;

    for (let i = 0; i < 30; i++) await runWebGpuFft(dev.device, pcm, 64, 1, 2048);
    expect(fftBufferStats.created - before).toBe(firstRun);
    expect(dev.buffers.every((b) => !b.destroyed)).toBe(true);
    // Per run: pcm + params only (twiddle / Hann tables were uploaded once).
    expect(tableWrites.mock.calls.length - writesAfterFirst).toBe(30 * 2);

    // A longer window grows the work buffers; a new N gets its own plan.
    await runWebGpuFft(dev.device, new Float32Array(2048 * 4), 64, 1, 2048);
    expect(fftBufferStats.created - before).toBe(firstRun + 3);
    await runWebGpuFft(dev.device, new Float32Array(1024), 64, 1, 1024);
    expect(fftBufferStats.created - before).toBe(firstRun + 3 + 8);
  });

  it('serializes concurrent runs on one plan', async () => {
    const dev = fakeDevice();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runWebGpuFft(dev.device, new Float32Array(512), 16, 1, 512)),
    );
    expect(results.every((r) => r.magnitudes.length === 256)).toBe(true);
  });
});
