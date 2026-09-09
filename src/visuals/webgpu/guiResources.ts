import { waveformWGSL } from '../../shaders/waveform';
import { checkShaderCompilation } from './checkShaderCompilation';

export interface GuiGpuResources {
  uniformBuffer: GPUBuffer;
  audioBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  pipeline: GPURenderPipeline;
}

export async function createGuiResources(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
): Promise<GuiGpuResources> {
  const uniformBuffer = device.createBuffer({
    size: 88,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const audioBuffer = device.createBuffer({
    size: 64 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const guiModule = device.createShaderModule({ code: waveformWGSL });
  await checkShaderCompilation(guiModule, 'gui');

  const guiBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
    ],
  });

  const bindGroup = device.createBindGroup({
    layout: guiBindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: audioBuffer } },
    ],
  });

  const guiPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [guiBindGroupLayout],
  });

  const pipeline = device.createRenderPipeline({
    layout: guiPipelineLayout,
    vertex: { module: guiModule, entryPoint: 'vertex_main' },
    fragment: { module: guiModule, entryPoint: 'fragment_main', targets: [{ format: canvasFormat }] },
    primitive: { topology: 'triangle-list' },
  });

  return { uniformBuffer, audioBuffer, bindGroup, pipeline };
}
