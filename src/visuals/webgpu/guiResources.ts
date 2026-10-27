import { buildWaveformWGSL } from '../../shaders/waveform';
import { checkShaderCompilation } from './checkShaderCompilation';
import { createRenderPipelineChecked, withValidationScope } from './pipelineErrors';

export interface GuiGpuResources {
  uniformBuffer: GPUBuffer;
  audioBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  pipeline: GPURenderPipeline;
  /** True when the glow math compiled as f16 (`shader-f16`). */
  f16: boolean;
}

async function compileGuiModule(
  device: GPUDevice,
  colorSpace: PredefinedColorSpace,
): Promise<{ module: GPUShaderModule; f16: boolean }> {
  if (device.features.has('shader-f16')) {
    try {
      const module = device.createShaderModule({ code: buildWaveformWGSL({ f16: true, colorSpace }), label: 'gui-f16' });
      await checkShaderCompilation(module, 'gui-f16');
      return { module, f16: true };
    } catch (error) {
      console.warn('[ShaderGUI] f16 waveform failed to compile; using f32:', error);
    }
  }
  const module = device.createShaderModule({ code: buildWaveformWGSL({ colorSpace }), label: 'gui' });
  await checkShaderCompilation(module, 'gui');
  return { module, f16: false };
}

export async function createGuiResources(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
  colorSpace: PredefinedColorSpace = 'srgb',
): Promise<GuiGpuResources> {
  const { module: guiModule, f16 } = await compileGuiModule(device, colorSpace);

  const { uniformBuffer, audioBuffer, bindGroup, layout } = await withValidationScope(device, 'gui', () => {
    const uniformBuffer = device.createBuffer({
      label: 'gui-uniforms',
      size: 88,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // 64 bars as 16 vec4s in a uniform: compatibility adapters may allow no
    // storage buffers in the fragment stage.
    const audioBuffer = device.createBuffer({
      label: 'gui-audio-bars',
      size: 64 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const guiBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });
    const bindGroup = device.createBindGroup({
      layout: guiBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: audioBuffer } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [guiBindGroupLayout] });
    return { uniformBuffer, audioBuffer, bindGroup, layout };
  });

  try {
    const pipeline = await createRenderPipelineChecked(device, {
      layout,
      vertex: { module: guiModule, entryPoint: 'vertex_main' },
      fragment: { module: guiModule, entryPoint: 'fragment_main', targets: [{ format: canvasFormat }] },
      primitive: { topology: 'triangle-list' },
    }, f16 ? 'gui-f16' : 'gui');
    return { uniformBuffer, audioBuffer, bindGroup, pipeline, f16 };
  } catch (error) {
    uniformBuffer.destroy();
    audioBuffer.destroy();
    throw error;
  }
}
