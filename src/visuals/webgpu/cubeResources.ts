import { checkShaderCompilation } from './checkShaderCompilation';
import { outputColorWGSL } from './outputColor';
import { createRenderPipelineChecked, withValidationScope } from './pipelineErrors';

export interface CubeGpuResources {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  pipeline: GPURenderPipeline;
  sampler: GPUSampler;
  renderTargetTexture: GPUTexture;
  renderTargetView: GPUTextureView;
}

const cubeShader = (colorSpace: PredefinedColorSpace) => `
${outputColorWGSL(colorSpace)}

struct Uniforms {
            modelViewProjectionMatrix : mat4x4<f32>,
        };
        @group(0) @binding(0) var<uniform> uniforms : Uniforms;
        @group(0) @binding(1) var mySampler: sampler;
        @group(0) @binding(2) var myTexture: texture_2d<f32>;

        struct VertexOutput {
            @builtin(position) Position : vec4<f32>,
            @location(0) uv : vec2<f32>,
            @location(1) vertexPos : vec3<f32>,
        };

        @vertex
        fn vertex_main(@location(0) pos: vec3<f32>, @location(1) uv: vec2<f32>) -> VertexOutput {
            var output : VertexOutput;
            output.Position = uniforms.modelViewProjectionMatrix * vec4<f32>(pos, 1.0);
            output.uv = uv;
            output.vertexPos = pos;
            return output;
        }

        @fragment
        fn fragment_main(@location(0) uv : vec2<f32>, @location(1) vertexPos : vec3<f32>) -> @location(0) vec4<f32> {
            let texColor = textureSample(myTexture, mySampler, uv);

            var color: vec4<f32>;

            if (vertexPos.z > 0.9) {
                 let d = distance(uv, vec2<f32>(0.5, 0.2));
                 var buttonColor = vec4<f32>(0.0);
                 if (d < 0.1) {
                     buttonColor = vec4<f32>(0.0, 1.0, 0.0, 0.5);
                 }

                 color = mix(texColor, buttonColor, 0.3);
            } else {
                 color = vec4<f32>(0.1, 0.1, 0.1, 1.0);
                 let edge = step(0.95, abs(uv.x)) + step(0.95, abs(uv.y));
                 color = color + vec4<f32>(edge * 0.2);
            }

            return vec4<f32>(toOutputColor(color.rgb), color.a);
        }
      `;

/** Built lazily on the first 3D frame (the default mode is flat). */
export async function createCubeResources(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
  colorSpace: PredefinedColorSpace = 'srgb',
): Promise<CubeGpuResources> {
  const texSize = 512;
  const vertexData = new Float32Array([
    -1, -1, 1, 0, 1,
    1, -1, 1, 1, 1,
    1, 1, 1, 1, 0,
    -1, 1, 1, 0, 0,
    -1, -1, -1, 1, 1,
    -1, 1, -1, 1, 0,
    1, 1, -1, 0, 0,
    1, -1, -1, 0, 1,
    -1, 1, -1, 0, 1,
    -1, 1, 1, 0, 0,
    1, 1, 1, 1, 0,
    1, 1, -1, 1, 1,
    -1, -1, -1, 1, 1,
    1, -1, -1, 0, 1,
    1, -1, 1, 0, 0,
    -1, -1, 1, 1, 0,
    1, -1, -1, 1, 1,
    1, 1, -1, 1, 0,
    1, 1, 1, 0, 0,
    1, -1, 1, 0, 1,
    -1, -1, -1, 0, 1,
    -1, -1, 1, 1, 1,
    -1, 1, 1, 1, 0,
    -1, 1, -1, 0, 0,
  ]);

  const indexData = new Uint16Array([
    0, 1, 2, 0, 2, 3,
    4, 5, 6, 4, 6, 7,
    8, 9, 10, 8, 10, 11,
    12, 13, 14, 12, 14, 15,
    16, 17, 18, 16, 18, 19,
    20, 21, 22, 20, 22, 23,
  ]);

  const cubeModule = device.createShaderModule({ code: cubeShader(colorSpace), label: 'cube' });
  await checkShaderCompilation(cubeModule, 'cube');

  const created = await withValidationScope(device, 'cube', () => {
    const renderTargetTexture = device.createTexture({
      label: 'cube-face',
      size: [texSize, texSize],
      format: canvasFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const renderTargetView = renderTargetTexture.createView();
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const vertexBuffer = device.createBuffer({
      label: 'cube-vertices',
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, vertexData);
    const indexBuffer = device.createBuffer({
      label: 'cube-indices',
      size: indexData.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuffer, 0, indexData);
    const uniformBuffer = device.createBuffer({
      label: 'cube-uniforms',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const cubeBindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const bindGroup = device.createBindGroup({
      layout: cubeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: renderTargetView },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [cubeBindGroupLayout] });
    return { vertexBuffer, indexBuffer, uniformBuffer, bindGroup, sampler, renderTargetTexture, renderTargetView, layout };
  });

  try {
    const pipeline = await createRenderPipelineChecked(device, {
      layout: created.layout,
      vertex: {
        module: cubeModule,
        entryPoint: 'vertex_main',
        buffers: [{
          arrayStride: 20,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x2' },
          ],
        }],
      },
      fragment: {
        module: cubeModule,
        entryPoint: 'fragment_main',
        targets: [{ format: canvasFormat }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: 'depth24plus',
      },
    }, 'cube');
    return {
      vertexBuffer: created.vertexBuffer,
      indexBuffer: created.indexBuffer,
      uniformBuffer: created.uniformBuffer,
      bindGroup: created.bindGroup,
      pipeline,
      sampler: created.sampler,
      renderTargetTexture: created.renderTargetTexture,
      renderTargetView: created.renderTargetView,
    };
  } catch (error) {
    created.vertexBuffer.destroy();
    created.indexBuffer.destroy();
    created.uniformBuffer.destroy();
    created.renderTargetTexture.destroy();
    throw error;
  }
}
