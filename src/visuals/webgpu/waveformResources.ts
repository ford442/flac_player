import { checkShaderCompilation } from './checkShaderCompilation';

export interface WaveformGpuResources {
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  pipeline: GPURenderPipeline;
}

const WAVEFORM_SHADER = `
      struct Uniforms {
        resolution: vec2<f32>,
        time: f32,
        audioLevel: f32,
      };
      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
      };

      @vertex
      fn vertex_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        var output: VertexOutput;
        var pos = array<vec2<f32>, 6>(
          vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
          vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0)
        );
        output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
        output.uv = pos[vertexIndex] * 0.5 + 0.5;
        return output;
      }

      @fragment
      fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
        let uv = input.uv;
        let time = uniforms.time;
        let audio = uniforms.audioLevel;

        var p = (uv - 0.5) * 2.0;

        let wave = sin(p.x * 3.0 + time + audio * 3.0) * 0.5 * audio;
        let dist = abs(p.y - wave);
        let glow = 0.05 / (dist + 0.01);

        let color = vec3<f32>(0.2, 0.5, 1.0) * glow;

        let grid = step(0.95, fract(uv.x * 20.0)) + step(0.95, fract(uv.y * 20.0));
        let screenColor = mix(color, vec3<f32>(0.0, 0.2, 0.4), grid * 0.1);

        return vec4<f32>(screenColor, 1.0);
      }
    `;

export async function createWaveformResources(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
): Promise<WaveformGpuResources> {
  const uniformBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const module = device.createShaderModule({ code: WAVEFORM_SHADER });
  await checkShaderCompilation(module, 'waveform');

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });

  const pipeline = device.createRenderPipeline({
    layout,
    vertex: { module, entryPoint: 'vertex_main' },
    fragment: { module, entryPoint: 'fragment_main', targets: [{ format: canvasFormat }] },
    primitive: { topology: 'triangle-list' },
  });

  return { uniformBuffer, bindGroup, pipeline };
}
