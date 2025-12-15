// WebGPU shader interface for audio visualization
export class WebGPUVisualizer {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private canvas: HTMLCanvasElement;
  private animationFrameId: number | null = null;
  private analyser: AnalyserNode | null = null;
  private audioData: Uint8Array = new Uint8Array(0);
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private time: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
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
      this.context = this.canvas.getContext('webgpu');
      
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

      // Create uniform buffer for passing data to shaders
      this.uniformBuffer = this.device.createBuffer({
        size: 32, // 4 floats * 4 bytes = 16 bytes, padded to 32
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });

      await this.createPipeline(format);
      return true;
    } catch (error) {
      console.error('Error initializing WebGPU:', error);
      return false;
    }
  }

  private async createPipeline(format: GPUTextureFormat): Promise<void> {
    if (!this.device || !this.uniformBuffer) return;

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
        
        // Create a full-screen quad
        var pos = array<vec2<f32>, 6>(
          vec2<f32>(-1.0, -1.0),
          vec2<f32>(1.0, -1.0),
          vec2<f32>(-1.0, 1.0),
          vec2<f32>(-1.0, 1.0),
          vec2<f32>(1.0, -1.0),
          vec2<f32>(1.0, 1.0)
        );
        
        output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
        output.uv = pos[vertexIndex] * 0.5 + 0.5;
        
        return output;
      }

      @fragment
      fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
        let uv = input.uv;
        let resolution = uniforms.resolution;
        let time = uniforms.time;
        let audio = uniforms.audioLevel;
        
        // Normalize coordinates
        let aspect = resolution.x / resolution.y;
        var p = (uv - 0.5) * 2.0;
        p.x *= aspect;
        
        // Create animated waves based on audio
        let wave1 = sin(p.x * 3.0 + time * 0.5 + audio * 2.0) * 0.3;
        let wave2 = sin(p.x * 5.0 - time * 0.7 + audio * 1.5) * 0.2;
        let wave3 = sin(p.x * 7.0 + time * 0.3 + audio) * 0.15;
        let combinedWave = wave1 + wave2 + wave3;
        
        // Distance from wave
        let dist = abs(p.y - combinedWave);
        let glow = 0.02 / dist;
        
        // Color based on audio level and position
        let r = 0.2 + audio * 0.5 + glow * 0.3;
        let g = 0.4 + sin(time * 0.5) * 0.3 + glow * 0.5;
        let b = 0.8 + audio * 0.2 + glow * 0.8;
        
        // Add gradient background
        let bgGradient = mix(
          vec3<f32>(0.1, 0.1, 0.2),
          vec3<f32>(0.2, 0.3, 0.5),
          uv.y
        );
        
        let finalColor = mix(bgGradient, vec3<f32>(r, g, b), glow * 0.5);
        
        return vec4<f32>(finalColor, 1.0);
      }
    `;

    const shaderModule = this.device.createShaderModule({
      code: shaderCode
    });

    // Create bind group layout
    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: {
          type: 'uniform'
        }
      }]
    });

    // Create bind group
    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{
        binding: 0,
        resource: {
          buffer: this.uniformBuffer
        }
      }]
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout]
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: 'vertex_main'
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragment_main',
        targets: [{
          format: format
        }]
      },
      primitive: {
        topology: 'triangle-list'
      }
    });
  }

  render(): void {
    if (!this.device || !this.context || !this.pipeline || !this.uniformBuffer || !this.bindGroup) {
      return;
    }

    // Get audio data and calculate average level
    let audioLevel = 0;
    if (this.analyser && this.audioData.length > 0) {
      const tempData = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(tempData);
      // Calculate average of frequency data
      let sum = 0;
      for (let i = 0; i < tempData.length; i++) {
        sum += tempData[i];
      }
      audioLevel = sum / tempData.length / 255.0; // Normalize to 0-1
    }

    // Update uniforms
    this.time += 0.016; // Approximate 60fps
    const uniformData = new Float32Array([
      this.canvas.width,
      this.canvas.height,
      this.time,
      audioLevel
    ]);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData);

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    renderPass.draw(6, 1, 0, 0);
    renderPass.end();

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
    if (this.uniformBuffer) {
      this.uniformBuffer.destroy();
      this.uniformBuffer = null;
    }
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
  }
}
