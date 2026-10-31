/**
 * WebGPU `fft_spectrum`: radix-2 Stockham FFT on the adopted visualizer device.
 * Never requestDevice(); failures throw and the dispatcher falls back to Worker/CPU.
 *
 * Dispatch chain (one submit):
 *   window_main   pcm → A        mono mixdown × Hann table, one invocation per point
 *   stage_main    A ⇄ B          log2(N) Stockham stages (mirror: stockhamFftReference)
 *   magnitude_main A|B → mags    |X[k]| · 2/Σw averaged over segments
 * Only the N/2 magnitudes are read back; HUD binning is `binFftMagnitudes` on CPU.
 *
 * Buffers are cached per (device, N) like the pipelines (#259 W7): the twiddle and
 * Hann tables are computed and uploaded once, the work buffers grow to the largest
 * window seen, and runs on the same plan are serialized so they never share a
 * buffer mid-flight. The 30 Hz meter therefore allocates nothing on the GPU.
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
  if (errors.length > 0) throw new Error(`gpu-chores-fft-compile: ${errors[0]!.message}`);

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

/** Per-(device, N) buffers. `pcm` / `a` / `b` grow with the window; the rest are fixed by N. */
interface FftPlanBuffers {
  twiddles: GPUBuffer;
  hann: GPUBuffer;
  params: GPUBuffer;
  mags: GPUBuffer;
  read: GPUBuffer;
  pcm: GPUBuffer | null;
  a: GPUBuffer | null;
  b: GPUBuffer | null;
  bindGroup: GPUBindGroup | null;
  /** Runs on this plan, chained so one finishes (and unmaps) before the next writes. */
  tail: Promise<unknown>;
}

const planBuffers = new WeakMap<GPUDevice, Map<number, FftPlanBuffers>>();

/** Buffers created per (device, N) since load — the unit test checks they are reused. */
export const fftBufferStats = { created: 0 };

function createBuffer(device: GPUDevice, descriptor: GPUBufferDescriptor): GPUBuffer {
  fftBufferStats.created += 1;
  return device.createBuffer(descriptor);
}

function getPlanBuffers(device: GPUDevice, n: number): FftPlanBuffers {
  let byN = planBuffers.get(device);
  if (!byN) {
    byN = new Map();
    planBuffers.set(device, byN);
  }
  const hit = byN.get(n);
  if (hit) return hit;

  const log2n = Math.round(Math.log2(n));
  const lines = n >> 1;
  const twiddleTable = fftTwiddles(n);
  const hannTable = new Float32Array(n);
  for (let i = 0; i < n; i++) hannTable[i] = hannWindow(i, n);
  const twiddles = createBuffer(device, {
    label: 'gpu-chores-fft-twiddles',
    size: twiddleTable.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const hann = createBuffer(device, {
    label: 'gpu-chores-fft-hann',
    size: hannTable.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(twiddles, 0, twiddleTable);
  device.queue.writeBuffer(hann, 0, hannTable);

  const created: FftPlanBuffers = {
    twiddles,
    hann,
    // Slot 0 = window, 1..log2n = stages, log2n+1 = magnitude.
    params: createBuffer(device, {
      label: 'gpu-chores-fft-params',
      size: (log2n + 2) * PARAMS_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    mags: createBuffer(device, {
      label: 'gpu-chores-fft-mags',
      size: lines * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    }),
    read: createBuffer(device, {
      label: 'gpu-chores-fft-read',
      size: lines * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
    pcm: null,
    a: null,
    b: null,
    bindGroup: null,
    tail: Promise.resolve(),
  };
  byN.set(n, created);
  return created;
}

/** Grow the window-sized buffers to fit; rebuilds the bind group when any changed. */
function ensureWorkBuffers(
  device: GPUDevice,
  bufs: FftPlanBuffers,
  layout: GPUBindGroupLayout,
  pcmBytes: number,
  complexBytes: number,
): GPUBindGroup {
  let changed = bufs.bindGroup === null;
  if (!bufs.pcm || bufs.pcm.size < pcmBytes) {
    bufs.pcm?.destroy();
    bufs.pcm = createBuffer(device, {
      label: 'gpu-chores-fft-pcm',
      size: pcmBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    changed = true;
  }
  if (!bufs.a || !bufs.b || bufs.a.size < complexBytes) {
    bufs.a?.destroy();
    bufs.b?.destroy();
    bufs.a = createBuffer(device, { label: 'gpu-chores-fft-a', size: complexBytes, usage: GPUBufferUsage.STORAGE });
    bufs.b = createBuffer(device, { label: 'gpu-chores-fft-b', size: complexBytes, usage: GPUBufferUsage.STORAGE });
    changed = true;
  }
  if (changed || !bufs.bindGroup) {
    bufs.bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: bufs.pcm } },
        { binding: 1, resource: { buffer: bufs.a } },
        { binding: 2, resource: { buffer: bufs.b } },
        { binding: 3, resource: { buffer: bufs.mags } },
        { binding: 4, resource: { buffer: bufs.params, size: PARAMS_BYTES } },
        { binding: 5, resource: { buffer: bufs.twiddles } },
        { binding: 6, resource: { buffer: bufs.hann } },
      ],
    });
  }
  return bufs.bindGroup;
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
  const pipes = await getPipelines(device);
  const bufs = getPlanBuffers(device, n);
  const run = bufs.tail.then(() => dispatchFft(device, pipes, bufs, plan, pcm, binCount, signal));
  bufs.tail = run.catch(() => undefined);
  return run;
}

async function dispatchFft(
  device: GPUDevice,
  pipes: CachedFft,
  bufs: FftPlanBuffers,
  plan: ReturnType<typeof planFft>,
  pcm: Float32Array,
  binCount: number,
  signal: AbortSignal | undefined,
): Promise<WebGpuFftOutput> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const n = plan.fftSize;
  const lines = n >> 1;
  const points = plan.segments * n;
  const log2n = Math.round(Math.log2(n));
  const magBytes = lines * 4;

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

  const bindGroup = ensureWorkBuffers(device, bufs, pipes.layout, Math.max(4, pcm.byteLength), points * 8);
  if (pcm.byteLength > 0) {
    device.queue.writeBuffer(bufs.pcm!, 0, pcm.buffer, pcm.byteOffset, pcm.byteLength);
  }
  device.queue.writeBuffer(bufs.params, 0, params);

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
  encoder.copyBufferToBuffer(bufs.mags, 0, bufs.read, 0, magBytes);
  device.queue.submit([encoder.finish()]);

  await bufs.read.mapAsync(GPUMapMode.READ);
  const magnitudes = new Float32Array(bufs.read.getMappedRange().slice(0));
  bufs.read.unmap();
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  return { spectrum: binFftMagnitudes(magnitudes, binCount), magnitudes, fftSize: n };
}
