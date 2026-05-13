import { Mat4, Vec3 } from './math';
import { waveformWGSL } from './shaders/waveform';

export type VisualizerMode = 'flat' | '3D';

export interface ShaderGUIUniforms {
  resolution: [number, number];
  time: number;
  beatPhase: number;
  rsycrb: number;
  fractal: number;
  pulse: number;
  audioLevel: number;
  audioLevelL: number;
  audioLevelR: number;
  spectrum0: number;
  spectrum1: number;
  spectrum2: number;
  spectrum3: number;
  spectrum4: number;
  modeNone: number;
  modeIR: number;
  isPlaying: number;
  playbackProgress: number;
  volume: number;
  colorShift: number;
}

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

  // --- GUI Mode Resources ---
  private guiUniformBuffer: GPUBuffer | null = null;
  private guiAudioBuffer: GPUBuffer | null = null;
  private guiBindGroup: GPUBindGroup | null = null;
  private guiPipeline: GPURenderPipeline | null = null;
  private guiUniforms: ShaderGUIUniforms = {
    resolution: [1, 1], time: 0, beatPhase: 0,
    rsycrb: 0, fractal: 0, pulse: 0,
    audioLevel: 0, audioLevelL: 0, audioLevelR: 0,
    spectrum0: 0, spectrum1: 0, spectrum2: 0, spectrum3: 0, spectrum4: 0,
    modeNone: 0, modeIR: 0, isPlaying: 0, playbackProgress: 0,
    volume: 1, colorShift: 0
  };
  private guiAudioData: Float32Array = new Float32Array(64);

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
  private onDeviceLostCallback?: (reason: string) => void;
  private destroyed = false;

  /** Notify the app that the visualizer has fallen back (e.g. device lost). */
  private notifyFallback(message: string): void {
    window.dispatchEvent(new CustomEvent('visualizer-fallback', { detail: message }));
  }

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

  setOnDeviceLost(cb: (reason: string) => void) {
    this.onDeviceLostCallback = cb;
  }

  async initialize(analyser: AnalyserNode): Promise<boolean> {
    if (!navigator.gpu) {
      throw new Error('webgpu-unsupported');
    }

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        throw new Error('webgpu-no-adapter');
      }

      this.device = await adapter.requestDevice();

      // Device loss handler
      this.device.lost.then((info) => {
        console.warn('WebGPU device lost:', info.message, 'reason:', info.reason);
        this.device = null;
        this.onDeviceLostCallback?.(info.reason);
      });

      this.context = this.canvas.getContext('webgpu') as unknown as GPUCanvasContext;

      if (!this.context) {
        throw new Error('webgpu-no-context');
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
      await this.initGUIResources(format);

      return true;
    } catch (error) {
      console.error('Error initializing WebGPU:', error);
      this.cleanupPartial();
      throw error;
    }
  }

  private cleanupPartial() {
    // Destroy any resources that were successfully created before the failure
    if (this.waveformUniformBuffer) { this.waveformUniformBuffer.destroy(); this.waveformUniformBuffer = null; }
    if (this.guiUniformBuffer) { this.guiUniformBuffer.destroy(); this.guiUniformBuffer = null; }
    if (this.guiAudioBuffer) { this.guiAudioBuffer.destroy(); this.guiAudioBuffer = null; }
    if (this.cubeUniformBuffer) { this.cubeUniformBuffer.destroy(); this.cubeUniformBuffer = null; }
    if (this.cubeVertexBuffer) { this.cubeVertexBuffer.destroy(); this.cubeVertexBuffer = null; }
    if (this.cubeIndexBuffer) { this.cubeIndexBuffer.destroy(); this.cubeIndexBuffer = null; }
    if (this.renderTargetTexture) { this.renderTargetTexture.destroy(); this.renderTargetTexture = null; }
    if (this.depthTexture) { this.depthTexture.destroy(); this.depthTexture = null; }
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
    this.context = null;
  }

  private async checkShaderCompilation(module: GPUShaderModule, label: string) {
    const info = await module.getCompilationInfo();
    for (const msg of info.messages) {
      const log = msg.type === 'error' ? console.error : console.warn;
      log(`[WebGPU Shader ${label}] ${msg.type}: ${msg.message} (line ${msg.lineNum}, col ${msg.linePos})`);
    }
    if (info.messages.some(m => m.type === 'error')) {
      throw new Error(`webgpu-shader-compile-error: ${label}`);
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

        let wave = sin(p.x * 3.0 + time + audio * 3.0) * 0.5 * audio;
        let dist = abs(p.y - wave);
        let glow = 0.05 / (dist + 0.01);

        let color = vec3<f32>(0.2, 0.5, 1.0) * glow;

        let grid = step(0.95, fract(uv.x * 20.0)) + step(0.95, fract(uv.y * 20.0));
        let screenColor = mix(color, vec3<f32>(0.0, 0.2, 0.4), grid * 0.1);

        return vec4<f32>(screenColor, 1.0);
      }
    `;
    const module = this.device.createShaderModule({ code: shaderCode });
    await this.checkShaderCompilation(module, 'waveform');

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

  private async initGUIResources(canvasFormat: GPUTextureFormat) {
    if (!this.device) return;

    this.guiUniformBuffer = this.device.createBuffer({
      size: 88,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.guiAudioBuffer = this.device.createBuffer({
      size: 64 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });

    const guiModule = this.device.createShaderModule({ code: waveformWGSL });
    await this.checkShaderCompilation(guiModule, 'gui');

    const guiBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }
      ]
    });

    this.guiBindGroup = this.device.createBindGroup({
      layout: guiBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.guiUniformBuffer } },
        { binding: 1, resource: { buffer: this.guiAudioBuffer } }
      ]
    });

    const guiPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [guiBindGroupLayout]
    });

    this.guiPipeline = this.device.createRenderPipeline({
      layout: guiPipelineLayout,
      vertex: { module: guiModule, entryPoint: 'vertex_main' },
      fragment: { module: guiModule, entryPoint: 'fragment_main', targets: [{ format: canvasFormat }] },
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

            return color;
        }
      `;

      const cubeModule = this.device.createShaderModule({ code: cubeShader });
      await this.checkShaderCompilation(cubeModule, 'cube');

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
          this.checkInteraction();
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

  private checkInteraction() {
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
      this.device.queue.writeBuffer(this.cubeUniformBuffer!, 0, mvp.values.buffer as ArrayBuffer);

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

  setUniforms(data: ShaderGUIUniforms): void {
    this.guiUniforms = data;
  }

  setAudioData(data: Uint8Array | Float32Array): void {
    const targetBins = 64;
    const sourceBins = data.length;
    const binRatio = sourceBins / targetBins;
    for (let i = 0; i < targetBins; i++) {
      let sum = 0;
      const start = Math.floor(i * binRatio);
      const end = Math.floor((i + 1) * binRatio);
      for (let j = start; j < end; j++) {
        sum += data[j];
      }
      this.guiAudioData[i] = sum / ((end - start) * 255);
    }
  }

  resize(): void {
    if (!this.device || !this.context) return;
    const format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format,
      alphaMode: 'opaque'
    });
  }

  renderGUI(): void {
    if (!this.device || !this.context || !this.guiPipeline || !this.guiBindGroup || !this.guiUniformBuffer || !this.guiAudioBuffer) return;

    const u = this.guiUniforms;
    this.device.queue.writeBuffer(this.guiUniformBuffer, 0, new Float32Array([
      u.resolution[0], u.resolution[1], u.time, u.beatPhase,
      u.rsycrb, u.fractal, u.pulse,
      u.audioLevel, u.audioLevelL, u.audioLevelR,
      u.spectrum0, u.spectrum1, u.spectrum2, u.spectrum3, u.spectrum4,
      u.modeNone, u.modeIR, u.isPlaying, u.playbackProgress,
      u.volume, u.colorShift,
      0.0
    ]));

    this.device.queue.writeBuffer(this.guiAudioBuffer, 0, this.guiAudioData.buffer as ArrayBuffer);

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    pass.setPipeline(this.guiPipeline);
    pass.setBindGroup(0, this.guiBindGroup);
    pass.draw(6);
    pass.end();
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
    this.destroyed = true;
    this.stopAnimation();
    if (this.waveformUniformBuffer) { this.waveformUniformBuffer.destroy(); this.waveformUniformBuffer = null; }
    if (this.guiUniformBuffer) { this.guiUniformBuffer.destroy(); this.guiUniformBuffer = null; }
    if (this.guiAudioBuffer) { this.guiAudioBuffer.destroy(); this.guiAudioBuffer = null; }
    if (this.cubeUniformBuffer) { this.cubeUniformBuffer.destroy(); this.cubeUniformBuffer = null; }
    if (this.cubeVertexBuffer) { this.cubeVertexBuffer.destroy(); this.cubeVertexBuffer = null; }
    if (this.cubeIndexBuffer) { this.cubeIndexBuffer.destroy(); this.cubeIndexBuffer = null; }
    if (this.renderTargetTexture) { this.renderTargetTexture.destroy(); this.renderTargetTexture = null; }
    if (this.depthTexture) { this.depthTexture.destroy(); this.depthTexture = null; }
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
  }
}
