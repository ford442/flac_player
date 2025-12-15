import { Mat4, Vec3 } from './math';

export type VisualizerMode = 'flat' | '3D';

// WebGPU shader interface for audio visualization
export class WebGPUVisualizer {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private canvas: HTMLCanvasElement;
  private animationFrameId: number | null = null;
  private analyser: AnalyserNode | null = null;
  private audioData: Uint8Array = new Uint8Array(0);
  private time: number = 0;
  private mode: VisualizerMode = 'flat';

  // --- Common Resources ---
  private waveformUniformBuffer: GPUBuffer | null = null;
  private waveformBindGroup: GPUBindGroup | null = null;
  private waveformPipeline: GPURenderPipeline | null = null;

  // --- 3D Mode Resources ---
  private cubeVertexBuffer: GPUBuffer | null = null;
  private cubeIndexBuffer: GPUBuffer | null = null;
  private cubeUniformBuffer: GPUBuffer | null = null;
  private cubeBindGroup: GPUBindGroup | null = null;
  private cubePipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private depthTexture: GPUTexture | null = null;

  // Render Target for Waveform (used in 3D mode)
  private renderTargetTexture: GPUTexture | null = null;
  private renderTargetView: GPUTextureView | null = null;

  // Camera State
  private cameraRotation = { x: 0, y: 0 };
  private isDragging = false;
  private lastMousePos = { x: 0, y: 0 };

  private onTogglePlay: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.setupInputListeners();
  }

  setMode(mode: VisualizerMode) {
    this.mode = mode;
  }

  setTogglePlayCallback(cb: () => void) {
      this.onTogglePlay = cb;
  }

  async initialize(analyser: AnalyserNode): Promise<boolean> {
    if (!navigator.gpu) {
      console.warn('WebGPU not supported in this browser');
      return false;
    }

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        console.error('No GPU adapter found');
        return false;
      }

      this.device = await adapter.requestDevice();
      this.context = this.canvas.getContext('webgpu') as unknown as GPUCanvasContext;
      
      if (!this.context) {
        console.error('Could not get WebGPU context');
        return false;
      }

      const format = navigator.gpu.getPreferredCanvasFormat();
      this.context.configure({
        device: this.device,
        format: format,
        alphaMode: 'opaque'
      });

      this.analyser = analyser;
      this.audioData = new Uint8Array(analyser.frequencyBinCount);

      await this.initWaveformResources(format);
      await this.init3DResources(format);

      return true;
    } catch (error) {
      console.error('Error initializing WebGPU:', error);
      return false;
    }
  }

  private async initWaveformResources(canvasFormat: GPUTextureFormat) {
    if (!this.device) return;

    this.waveformUniformBuffer = this.device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    const shaderCode = `
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
        
        let aspect = uniforms.resolution.x / uniforms.resolution.y;
        var p = (uv - 0.5) * 2.0;
        
        // Circular waveform for 3D screen? Or standard linear?
        // Let's keep the linear wave.
        let wave = sin(p.x * 3.0 + time + audio * 3.0) * 0.5 * audio;
        let dist = abs(p.y - wave);
        let glow = 0.05 / (dist + 0.01);
        
        let color = vec3<f32>(0.2, 0.5, 1.0) * glow;
        
        // Add a border/grid effect to look like a screen
        let grid = step(0.95, fract(uv.x * 20.0)) + step(0.95, fract(uv.y * 20.0));
        let screenColor = mix(color, vec3<f32>(0.0, 0.2, 0.4), grid * 0.1);
        
        return vec4<f32>(screenColor, 1.0);
      }
    `;
    const module = this.device.createShaderModule({ code: shaderCode });

    this.waveformBindGroup = this.device.createBindGroup({
        layout: this.device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }]
        }),
        entries: [{ binding: 0, resource: { buffer: this.waveformUniformBuffer } }]
    });

    const layout = this.device.createPipelineLayout({
        bindGroupLayouts: [this.device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }]
        })]
    });

    this.waveformPipeline = this.device.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: 'vertex_main' },
        fragment: { module, entryPoint: 'fragment_main', targets: [{ format: canvasFormat }] },
        primitive: { topology: 'triangle-list' }
    });
  }

  private async init3DResources(canvasFormat: GPUTextureFormat) {
      if (!this.device) return;

      const texSize = 512;
      this.renderTargetTexture = this.device.createTexture({
          size: [texSize, texSize],
          format: canvasFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      });
      this.renderTargetView = this.renderTargetTexture.createView();

      this.sampler = this.device.createSampler({
          magFilter: 'linear',
          minFilter: 'linear',
      });

      // Box Geometry
      const vertexData = new Float32Array([
          // Front (Screen)
          -1, -1,  1,  0, 1,
           1, -1,  1,  1, 1,
           1,  1,  1,  1, 0,
          -1,  1,  1,  0, 0,
          // Back
          -1, -1, -1,  1, 1,
          -1,  1, -1,  1, 0,
           1,  1, -1,  0, 0,
           1, -1, -1,  0, 1,
          // Top
          -1,  1, -1,  0, 1,
          -1,  1,  1,  0, 0,
           1,  1,  1,  1, 0,
           1,  1, -1,  1, 1,
          // Bottom
          -1, -1, -1,  1, 1,
           1, -1, -1,  0, 1,
           1, -1,  1,  0, 0,
          -1, -1,  1,  1, 0,
          // Right
           1, -1, -1,  1, 1,
           1,  1, -1,  1, 0,
           1,  1,  1,  0, 0,
           1, -1,  1,  0, 1,
          // Left
          -1, -1, -1,  0, 1,
          -1, -1,  1,  1, 1,
          -1,  1,  1,  1, 0,
          -1,  1, -1,  0, 0,
      ]);

      const indexData = new Uint16Array([
          0, 1, 2, 0, 2, 3, // Front
          4, 5, 6, 4, 6, 7, // Back
          8, 9, 10, 8, 10, 11, // Top
          12, 13, 14, 12, 14, 15, // Bottom
          16, 17, 18, 16, 18, 19, // Right
          20, 21, 22, 20, 22, 23  // Left
      ]);

      this.cubeVertexBuffer = this.device.createBuffer({
          size: vertexData.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.cubeVertexBuffer, 0, vertexData);

      this.cubeIndexBuffer = this.device.createBuffer({
          size: indexData.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(this.cubeIndexBuffer, 0, indexData);

      this.cubeUniformBuffer = this.device.createBuffer({
          size: 64,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });

      const cubeShader = `
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
            // Apply texture only to Front Face (z close to 1)
            // Since we use a simple cube, we can check vertexPos.z > 0.9
            // But texture mapping is already set up.

            // Check if it's the front face. Due to interpolation, z might vary slightly.
            // However, with separate vertices, the front face has Z=1.

            // Actually, we mapped UVs for all faces.
            // Let's just draw the screen on the front, and a dark "case" on others.

            var color: vec4<f32>;

            if (vertexPos.z > 0.9) {
                 // Front Face: Screen
                 // Draw Play Button Overlay?
                 let texColor = textureSample(myTexture, mySampler, uv);

                 // Simple Play Icon logic (circle triangle)
                 // center 0.5, 0.2 (bottom)
                 let d = distance(uv, vec2<f32>(0.5, 0.2));
                 var buttonColor = vec4<f32>(0.0);
                 if (d < 0.1) {
                     buttonColor = vec4<f32>(0.0, 1.0, 0.0, 0.5);
                 }

                 color = mix(texColor, buttonColor, 0.3);
            } else {
                 // Case
                 color = vec4<f32>(0.1, 0.1, 0.1, 1.0);
                 // Add some edge highlighting
                 let edge = step(0.95, abs(uv.x)) + step(0.95, abs(uv.y));
                 color = color + vec4<f32>(edge * 0.2);
            }

            return color;
        }
      `;

      const cubeModule = this.device.createShaderModule({ code: cubeShader });

      const cubeBindGroupLayout = this.device.createBindGroupLayout({
          entries: [
              { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
              { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
              { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
          ]
      });

      this.cubeBindGroup = this.device.createBindGroup({
          layout: cubeBindGroupLayout,
          entries: [
              { binding: 0, resource: { buffer: this.cubeUniformBuffer } },
              { binding: 1, resource: this.sampler },
              { binding: 2, resource: this.renderTargetView! }
          ]
      });

      const cubePipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [cubeBindGroupLayout] });

      this.cubePipeline = this.device.createRenderPipeline({
          layout: cubePipelineLayout,
          vertex: {
              module: cubeModule,
              entryPoint: 'vertex_main',
              buffers: [{
                  arrayStride: 20,
                  attributes: [
                      { shaderLocation: 0, offset: 0, format: 'float32x3' },
                      { shaderLocation: 1, offset: 12, format: 'float32x2' }
                  ]
              }]
          },
          fragment: {
              module: cubeModule,
              entryPoint: 'fragment_main',
              targets: [{ format: canvasFormat }]
          },
          primitive: { topology: 'triangle-list', cullMode: 'back' },
          depthStencil: {
             depthWriteEnabled: true,
             depthCompare: 'less',
             format: 'depth24plus',
          }
      });
  }

  private setupInputListeners() {
      this.canvas.addEventListener('mousedown', (e) => {
          this.isDragging = true;
          this.lastMousePos = { x: e.clientX, y: e.clientY };
          this.checkInteraction(e.clientX, e.clientY);
      });

      window.addEventListener('mousemove', (e) => {
          if (this.isDragging && this.mode === '3D') {
              const deltaX = e.clientX - this.lastMousePos.x;
              const deltaY = e.clientY - this.lastMousePos.y;
              this.cameraRotation.y += deltaX * 0.01;
              this.cameraRotation.x += deltaY * 0.01;
              this.lastMousePos = { x: e.clientX, y: e.clientY };
          }
      });

      window.addEventListener('mouseup', () => {
          this.isDragging = false;
      });
  }

  private checkInteraction(mx: number, my: number) {
      if (this.mode !== '3D') return;
      if (this.onTogglePlay) {
          this.onTogglePlay();
      }
  }

  render(): void {
    if (!this.device || !this.context || !this.waveformPipeline) return;

    let audioLevel = 0;
    if (this.analyser && this.audioData.length > 0) {
      const tempData = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(tempData);
      let sum = 0;
      for (let i = 0; i < tempData.length; i++) sum += tempData[i];
      audioLevel = sum / tempData.length / 255.0;
    }
    this.time += 0.016;

    if (this.mode === 'flat') {
        this.renderFlat(audioLevel);
    } else {
        this.render3D(audioLevel);
    }
  }

  private renderFlat(audioLevel: number) {
      if (!this.device || !this.context || !this.waveformPipeline || !this.waveformBindGroup) return;

      this.device.queue.writeBuffer(this.waveformUniformBuffer!, 0, new Float32Array([
          this.canvas.width, this.canvas.height, this.time, audioLevel
      ]));

      const commandEncoder = this.device.createCommandEncoder();
      const textureView = this.context.getCurrentTexture().createView();

      const pass = commandEncoder.beginRenderPass({
          colorAttachments: [{
              view: textureView,
              clearValue: { r: 0.1, g: 0.1, b: 0.2, a: 1.0 },
              loadOp: 'clear',
              storeOp: 'store'
          }]
      });
      pass.setPipeline(this.waveformPipeline);
      pass.setBindGroup(0, this.waveformBindGroup);
      pass.draw(6);
      pass.end();
      this.device.queue.submit([commandEncoder.finish()]);
  }

  private render3D(audioLevel: number) {
     if (!this.device || !this.context || !this.cubePipeline || !this.renderTargetView || !this.cubeBindGroup || !this.cubeVertexBuffer || !this.cubeIndexBuffer) return;

      this.device.queue.writeBuffer(this.waveformUniformBuffer!, 0, new Float32Array([
          512, 512, this.time, audioLevel
      ]));

      const commandEncoder = this.device.createCommandEncoder();

      const waveformPass = commandEncoder.beginRenderPass({
          colorAttachments: [{
              view: this.renderTargetView!,
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              loadOp: 'clear',
              storeOp: 'store'
          }]
      });
      waveformPass.setPipeline(this.waveformPipeline!);
      waveformPass.setBindGroup(0, this.waveformBindGroup!);
      waveformPass.draw(6);
      waveformPass.end();

      const aspect = this.canvas.width / this.canvas.height;
      const projection = Mat4.perspective(Math.PI / 4, aspect, 0.1, 100.0);

      const radius = 5;
      // Clamp X rotation to avoid flipping
      this.cameraRotation.x = Math.max(-Math.PI/2 + 0.1, Math.min(Math.PI/2 - 0.1, this.cameraRotation.x));

      const camX = Math.sin(this.cameraRotation.y) * radius * Math.cos(this.cameraRotation.x);
      const camY = Math.sin(this.cameraRotation.x) * radius;
      const camZ = Math.cos(this.cameraRotation.y) * radius * Math.cos(this.cameraRotation.x);

      const view = Mat4.lookAt(
          new Vec3(camX, camY, camZ),
          new Vec3(0, 0, 0),
          new Vec3(0, 1, 0)
      );

      const mvp = Mat4.multiply(projection, view);
      this.device.queue.writeBuffer(this.cubeUniformBuffer!, 0, mvp.values as any);

      if (!this.depthTexture ||
          this.depthTexture.width !== this.canvas.width ||
          this.depthTexture.height !== this.canvas.height) {
          if (this.depthTexture) this.depthTexture.destroy();
          this.depthTexture = this.device.createTexture({
              size: [this.canvas.width, this.canvas.height],
              format: 'depth24plus',
              usage: GPUTextureUsage.RENDER_ATTACHMENT
          });
      }

      const textureView = this.context.getCurrentTexture().createView();

      const cubePass = commandEncoder.beginRenderPass({
          colorAttachments: [{
              view: textureView,
              clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1.0 },
              loadOp: 'clear',
              storeOp: 'store'
          }],
          depthStencilAttachment: {
              view: this.depthTexture.createView(),
              depthClearValue: 1.0,
              depthLoadOp: 'clear',
              depthStoreOp: 'store'
          }
      });

      cubePass.setPipeline(this.cubePipeline);
      cubePass.setBindGroup(0, this.cubeBindGroup);
      cubePass.setVertexBuffer(0, this.cubeVertexBuffer);
      cubePass.setIndexBuffer(this.cubeIndexBuffer, 'uint16');
      cubePass.drawIndexed(36);

      cubePass.end();
      this.device.queue.submit([commandEncoder.finish()]);
  }

  startAnimation(): void {
    const animate = () => {
      this.render();
      this.animationFrameId = requestAnimationFrame(animate);
    };
    animate();
  }

  stopAnimation(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  destroy(): void {
    this.stopAnimation();
    if (this.waveformUniformBuffer) this.waveformUniformBuffer.destroy();
    if (this.cubeUniformBuffer) this.cubeUniformBuffer.destroy();
    if (this.cubeVertexBuffer) this.cubeVertexBuffer.destroy();
    if (this.cubeIndexBuffer) this.cubeIndexBuffer.destroy();
    if (this.renderTargetTexture) this.renderTargetTexture.destroy();
    if (this.depthTexture) this.depthTexture.destroy();
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
  }
}
