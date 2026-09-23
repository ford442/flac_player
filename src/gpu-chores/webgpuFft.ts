/**
 * WebGPU `fft_spectrum`: radix-2 Stockham FFT on the adopted visualizer device.
 * Never requestDevice(); failures throw and the dispatcher falls back to Worker/CPU.
 *
 * Dispatch chain (one submit):
 *   window_main   pcm → A        mono mixdown × Hann table, one invocation per point
 *   stage_main    A ⇄ B          log2(N) Stockham stages (mirror: stockhamFftReference)
 *   magnitude_main A|B → mags    |X[k]| · 2/Σw averaged over segments
 * Only the N/2 magnitudes are read back; HUD binning is `binFftMagnitudes` on CPU.
 */

import { GPU_FFT_WORKGROUP_SIZE } from './constants';
import { binFftMagnitudes, fftTwiddles, hannWindow, planFft } from './fft';
import fftSource from './fft.wgsl?raw';

const FFT_WGSL = fftSource.replace(/\{\{WORKGROUP_SIZE\}\}/g, String(GPU_FFT_WORKGROUP_SIZE));

/** Params slot stride (minUniformBufferOffsetAlignment is ≤ 256 on every adapter). */
const PARAMS_STRIDE = 256;
const PARAMS_BYTES = 32;

interface CachedFft {
  layout: GPUBindGroupLayout;
  window: GPUComputePipeline;
  stage: GPUComputePipeline;
  magnitude: GPUComputePipeline;
}

const cache = new WeakMap<GPUDevice, CachedFft>();

async function getPipelines(device: GPUDevice): Promise<CachedFft> {
  const hit = cache.get(device);
  if (hit) return hit;

  const module = device.createShaderModule({ code: FFT_WGSL, label: 'gpu-chores-fft' });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) throw new Error(`gpu-chores-fft-compile: ${errors[0].message}`);

  const layout = device.createBindGroupLayout({
    label: 'gpu-chores-fft-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PARAMS_BYTES },
      },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const make = (entryPoint: string) => device.createComputePipeline({
    label: `gpu-chores-fft-${entryPoint}`,
    layout: pipelineLayout,
    compute: { module, entryPoint },
  });

  const created = {
    layout,
    window: make('window_main'),
    stage: make('stage_main'),
    magnitude: make('magnitude_main'),
  };
  cache.set(device, created);
  return created;
}

function destroyBuf(buffer: GPUBuffer | null): void {
  try { buffer?.destroy(); } catch { /* already destroyed */ }
}

export interface WebGpuFftOutput {
  spectrum: Float32Array;
  /** Raw N/2 segment-averaged magnitudes (before HUD binning). */
  magnitudes: Float32Array;
  fftSize: number;
}

export async function runWebGpuFft(
  device: GPUDevice,
  pcm: Float32Array,
  binCount: number,
  channels: number,
  fftSize: number | undefined,
  signal?: AbortSignal,
): Promise<WebGpuFftOutput> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const plan = planFft(pcm.length, channels, fftSize);
  const n = plan.fftSize;
  const lines = n >> 1;
  const points = plan.segments * n;
  const log2n = Math.round(Math.log2(n));
  const complexBytes = points * 8;
  const magBytes = lines * 4;

  const pipes = await getPipelines(device);

  // Slot 0 = window, 1..log2n = stages, log2n+1 = magnitude.
  const slotCount = log2n + 2;
  const params = new ArrayBuffer(slotCount * PARAMS_STRIDE);
  const writeSlot = (slot: number, ns: number, flip: number) => {
    const view = new DataView(params, slot * PARAMS_STRIDE, PARAMS_BYTES);
    view.setUint32(0, n, true);
    view.setUint32(4, plan.segments, true);
    view.setUint32(8, plan.channels, true);
    view.setUint32(12, ns, true);
    view.setUint32(16, flip, true);
    view.setUint32(20, plan.frames, true);
    view.setFloat32(24, plan.norm, true);
    view.setUint32(28, pcm.length, true);
  };
  writeSlot(0, 0, 0);
  for (let s = 0; s < log2n; s++) writeSlot(s + 1, 1 << s, s & 1);
  // After log2n stages the result lives in A when log2n is even, else B.
  writeSlot(log2n + 1, 0, log2n & 1);

  const pcmBuffer = device.createBuffer({
    label: 'gpu-chores-fft-pcm',
    size: Math.max(4, pcm.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const bufA = device.createBuffer({ label: 'gpu-chores-fft-a', size: complexBytes, usage: GPUBufferUsage.STORAGE });
  const bufB = device.createBuffer({ label: 'gpu-chores-fft-b', size: complexBytes, usage: GPUBufferUsage.STORAGE });
  const magBuffer = device.createBuffer({
    label: 'gpu-chores-fft-mags',
    size: magBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const paramBuffer = device.createBuffer({
    label: 'gpu-chores-fft-params',
    size: params.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const twiddles = fftTwiddles(n);
  const hann = new Float32Array(n);
  for (let i = 0; i < n; i++) hann[i] = hannWindow(i, n);
  const twiddleBuffer = device.createBuffer({
    label: 'gpu-chores-fft-twiddles',
    size: twiddles.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const hannBuffer = device.createBuffer({
    label: 'gpu-chores-fft-hann',
    size: hann.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const readBuffer = device.createBuffer({
    label: 'gpu-chores-fft-read',
    size: magBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  try {
    if (pcm.byteLength > 0) {
      device.queue.writeBuffer(pcmBuffer, 0, pcm.buffer, pcm.byteOffset, pcm.byteLength);
    }
    device.queue.writeBuffer(paramBuffer, 0, params);
    device.queue.writeBuffer(twiddleBuffer, 0, twiddles);
    device.queue.writeBuffer(hannBuffer, 0, hann);

    const bindGroup = device.createBindGroup({
      layout: pipes.layout,
      entries: [
        { binding: 0, resource: { buffer: pcmBuffer } },
        { binding: 1, resource: { buffer: bufA } },
        { binding: 2, resource: { buffer: bufB } },
        { binding: 3, resource: { buffer: magBuffer } },
        { binding: 4, resource: { buffer: paramBuffer, size: PARAMS_BYTES } },
        { binding: 5, resource: { buffer: twiddleBuffer } },
        { binding: 6, resource: { buffer: hannBuffer } },
      ],
    });

    const groups = (count: number) => Math.ceil(count / GPU_FFT_WORKGROUP_SIZE);
    const encoder = device.createCommandEncoder({ label: 'gpu-chores-fft' });
    const pass = encoder.beginComputePass({ label: 'gpu-chores-fft' });
    pass.setPipeline(pipes.window);
    pass.setBindGroup(0, bindGroup, [0]);
    pass.dispatchWorkgroups(groups(points));
    pass.setPipeline(pipes.stage);
    for (let s = 0; s < log2n; s++) {
      pass.setBindGroup(0, bindGroup, [(s + 1) * PARAMS_STRIDE]);
      pass.dispatchWorkgroups(groups(points >> 1));
    }
    pass.setPipeline(pipes.magnitude);
    pass.setBindGroup(0, bindGroup, [(log2n + 1) * PARAMS_STRIDE]);
    pass.dispatchWorkgroups(groups(lines));
    pass.end();
    encoder.copyBufferToBuffer(magBuffer, 0, readBuffer, 0, magBytes);
    device.queue.submit([encoder.finish()]);

    await readBuffer.mapAsync(GPUMapMode.READ);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const magnitudes = new Float32Array(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();

    return { spectrum: binFftMagnitudes(magnitudes, binCount), magnitudes, fftSize: n };
  } finally {
    destroyBuf(pcmBuffer);
    destroyBuf(bufA);
    destroyBuf(bufB);
    destroyBuf(magBuffer);
    destroyBuf(paramBuffer);
    destroyBuf(twiddleBuffer);
    destroyBuf(hannBuffer);
    destroyBuf(readBuffer);
  }
}
