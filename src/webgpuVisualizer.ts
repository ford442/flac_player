// WebGPU shader interface for audio visualization
export class WebGPUVisualizer {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private canvas: HTMLCanvasElement;
  private animationFrameId: number | null = null;
  private analyser: AnalyserNode | null = null;
  private audioData: Uint8Array = new Uint8Array(0);

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

      await this.createPipeline(format);
      return true;
    } catch (error) {
      console.error('Error initializing WebGPU:', error);
      return false;
    }
  }

  private async createPipeline(format: GPUTextureFormat): Promise<void> {
    if (!this.device) return;

    const shaderCode = `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) color: vec4<f32>,
      };

      @vertex
      fn vertex_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        var output: VertexOutput;
        
        // Create a simple quad
        var pos = array<vec2<f32>, 6>(
          vec2<f32>(-1.0, -1.0),
          vec2<f32>(1.0, -1.0),
          vec2<f32>(-1.0, 1.0),
          vec2<f32>(-1.0, 1.0),
          vec2<f32>(1.0, -1.0),
          vec2<f32>(1.0, 1.0)
        );
        
        output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
        output.color = vec4<f32>(0.2, 0.4, 0.8, 1.0);
        
        return output;
      }

      @fragment
      fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
        // Create a gradient based on position
        let x = input.position.x / 800.0; // normalized x
        let y = input.position.y / 600.0; // normalized y
        
        return vec4<f32>(
          0.1 + x * 0.3,
          0.2 + y * 0.5,
          0.8 - x * 0.3,
          1.0
        );
      }
    `;

    const shaderModule = this.device.createShaderModule({
      code: shaderCode
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
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
    if (!this.device || !this.context || !this.pipeline) {
      return;
    }

    // Get audio data
    if (this.analyser && this.audioData.length > 0) {
      const tempData = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(tempData);
    }

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
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
  }
}
