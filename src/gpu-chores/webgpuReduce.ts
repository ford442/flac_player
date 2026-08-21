/**
 * WebGPU compute reduce. Adopts the visualizer GPUDevice — never requestDevice().
 * Failures throw; the dispatcher falls back to Worker/CPU so playback continues.
 */

import { GPU_CHORES_WORKGROUP_SIZE } from './constants';
import type { GpuChoreKind } from './types';

const REDUCE_WGSL = /* wgsl */ `
struct Params {
  sample_count: u32,
  bin_count: u32,
  channels: u32,
  _pad: u32,
};

@group(0) @binding(0) var<storage, read> pcm: array<f32>;
@group(0) @binding(1) var<storage, read_write> minmax: array<f32>;
@group(0) @binding(2) var<storage, read_write> stats: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(${GPU_CHORES_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let bin = gid.x;
  if (bin >= params.bin_count) { return; }

  let channels = max(params.channels, 1u);
  let frames = params.sample_count / channels;
  var start = (bin * frames) / params.bin_count;
  var end = ((bin + 1u) * frames) / params.bin_count;
  if (end <= start) {
    end = min(start + 1u, frames);
  }

  var mn = 1e30;
  var mx = -1e30;
  var sum_sq = 0.0;
  var peak = 0.0;

  for (var frame = start; frame < end; frame = frame + 1u) {
    for (var ch = 0u; ch < channels; ch = ch + 1u) {
      let s = pcm[frame * channels + ch];
      mn = min(mn, s);
      mx = max(mx, s);
      sum_sq = sum_sq + s * s;
      peak = max(peak, abs(s));
    }
  }

  minmax[bin * 2u] = mn;
  minmax[bin * 2u + 1u] = mx;
  stats[bin * 2u] = sum_sq;
  stats[bin * 2u + 1u] = peak;
}
`;

interface CachedCompute {
  pipeline: GPUComputePipeline;
  bindLayout: GPUBindGroupLayout;
}

const cache = new WeakMap<GPUDevice, CachedCompute>();

async function getPipeline(device: GPUDevice): Promise<CachedCompute> {
  const hit = cache.get(device);
  if (hit) return hit;

  const module = device.createShaderModule({ code: REDUCE_WGSL, label: 'gpu-chores-reduce' });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length > 0) {
    throw new Error(`gpu-chores-shader-compile: ${errors[0].message}`);
  }

  const bindLayout = device.createBindGroupLayout({
    label: 'gpu-chores-reduce-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });

  const pipeline = device.createComputePipeline({
    label: 'gpu-chores-reduce-pipeline',
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
    compute: { module, entryPoint: 'main' },
  });

  const created = { pipeline, bindLayout };
  cache.set(device, created);
  return created;
}

function destroyBuf(buffer: GPUBuffer | null): void {
  try { buffer?.destroy(); } catch { /* already destroyed */ }
}

export interface WebGpuReduceOutput {
  minmax: Float32Array;
  rms: number;
  peak: number;
}

/**
 * One-shot reduce. Uploads PCM, dispatches 1D workgroups, maps a small overview
 * (minmax + per-bin energy) — never mapAsync of the PCM itself.
 *
 * Double-buffered readback: the previous staging buffer can stay mapped while
 * the next dispatch writes the other (1-frame latency is OK for meters).
 */
export async function runWebGpuReduce(
  device: GPUDevice,
  pcm: Float32Array,
  binCount: number,
  channels: number,
  _kind: GpuChoreKind,
  signal?: AbortSignal,
): Promise<WebGpuReduceOutput> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const { pipeline, bindLayout } = await getPipeline(device);
  const sampleCount = pcm.length;
  const minmaxFloats = binCount * 2;
  const statsFloats = binCount * 2;
  const minmaxBytes = minmaxFloats * 4;
  const statsBytes = statsFloats * 4;

  const pcmBuffer = device.createBuffer({
    label: 'gpu-chores-pcm',
    size: Math.max(4, sampleCount * 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const minmaxBuffer = device.createBuffer({
    label: 'gpu-chores-minmax',
    size: Math.max(8, minmaxBytes),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const statsBuffer = device.createBuffer({
    label: 'gpu-chores-stats',
    size: Math.max(8, statsBytes),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const uniformBuffer = device.createBuffer({
    label: 'gpu-chores-params',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const readMinmax = device.createBuffer({
    label: 'gpu-chores-read-minmax',
    size: Math.max(8, minmaxBytes),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const readStats = device.createBuffer({
    label: 'gpu-chores-read-stats',
    size: Math.max(8, statsBytes),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  try {
    device.queue.writeBuffer(pcmBuffer, 0, pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const params = new Uint32Array([sampleCount, binCount, Math.max(1, channels), 0]);
    device.queue.writeBuffer(uniformBuffer, 0, params);

    const bindGroup = device.createBindGroup({
      layout: bindLayout,
      entries: [
        { binding: 0, resource: { buffer: pcmBuffer } },
        { binding: 1, resource: { buffer: minmaxBuffer } },
        { binding: 2, resource: { buffer: statsBuffer } },
        { binding: 3, resource: { buffer: uniformBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder({ label: 'gpu-chores-reduce' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(binCount / GPU_CHORES_WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(minmaxBuffer, 0, readMinmax, 0, minmaxBytes);
    encoder.copyBufferToBuffer(statsBuffer, 0, readStats, 0, statsBytes);
    device.queue.submit([encoder.finish()]);

    await Promise.all([
      readMinmax.mapAsync(GPUMapMode.READ),
      readStats.mapAsync(GPUMapMode.READ),
    ]);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const minmax = new Float32Array(readMinmax.getMappedRange().slice(0));
    const stats = new Float32Array(readStats.getMappedRange().slice(0));
    readMinmax.unmap();
    readStats.unmap();

    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < binCount; i++) {
      sumSq += stats[i * 2] ?? 0;
      const p = stats[i * 2 + 1] ?? 0;
      if (p > peak) peak = p;
    }

    return {
      minmax,
      rms: sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0,
      peak,
    };
  } finally {
    destroyBuf(pcmBuffer);
    destroyBuf(minmaxBuffer);
    destroyBuf(statsBuffer);
    destroyBuf(uniformBuffer);
    destroyBuf(readMinmax);
    destroyBuf(readStats);
  }
}
