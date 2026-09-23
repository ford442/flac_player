import { buildWaveformWGSL } from '../../shaders/waveform';
import { checkShaderCompilation } from './checkShaderCompilation';

export interface GuiGpuResources {
  uniformBuffer: GPUBuffer;
  audioBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  pipeline: GPURenderPipeline;
  /** True when the glow math compiled as f16 (`shader-f16`). */
  f16: boolean;
}

async function compileGuiModule(device: GPUDevice): Promise<{ module: GPUShaderModule; f16: boolean }> {
  if (device.features.has('shader-f16')) {
    try {
      const module = device.createShaderModule({ code: buildWaveformWGSL({ f16: true }), label: 'gui-f16' });
      await checkShaderCompilation(module, 'gui-f16');
      return { module, f16: true };
    } catch (error) {
      console.warn('[ShaderGUI] f16 waveform failed to compile; using f32:', error);
    }
  }
  const module = device.createShaderModule({ code: buildWaveformWGSL(), label: 'gui' });
  await checkShaderCompilation(module, 'gui');
  return { module, f16: false };
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

  const { module: guiModule, f16 } = await compileGuiModule(device);

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

  return { uniformBuffer, audioBuffer, bindGroup, pipeline, f16 };
}
