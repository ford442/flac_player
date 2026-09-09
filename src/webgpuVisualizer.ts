import { Mat4, Vec3 } from './math';
import {
  DEFAULT_WAVEFORM_UNIFORMS,
  packWaveformUniforms,
  type WaveformUniforms,
} from './visuals/waveformContract';
import type { WebGL2DebugMode } from './visuals/types';
import { createDebugConfig, debugModeToUniform } from './visuals/webgl2/debugModes';
import type { WebGL2DebugConfig } from './visuals/types';
import type { WebGPUProbeSuccess } from './visuals/webgpuProbe';
import { buildCanvasConfiguration } from './visuals/webgpu/canvasConfig';
import { createWaveformResources, type WaveformGpuResources } from './visuals/webgpu/waveformResources';
import { createGuiResources, type GuiGpuResources } from './visuals/webgpu/guiResources';
import { createCubeResources, type CubeGpuResources } from './visuals/webgpu/cubeResources';

export type VisualizerMode = 'flat' | '3D';

/** @deprecated Prefer WaveformUniforms from visuals/waveformContract — kept as alias. */
export type ShaderGUIUniforms = WaveformUniforms;

// WebGPU shader interface for audio visualization
export class WebGPUVisualizer {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private canvasFormat: GPUTextureFormat | null = null;
  private canvas: HTMLCanvasElement;
  private animationFrameId: number | null = null;
  private analyser: AnalyserNode | null = null;
  private audioData: Uint8Array = new Uint8Array(0);
  private time: number = 0;
  private mode: VisualizerMode = 'flat';

  private waveform: WaveformGpuResources | null = null;
  private gui: GuiGpuResources | null = null;
  private cube: CubeGpuResources | null = null;
  private guiUniforms: ShaderGUIUniforms = { ...DEFAULT_WAVEFORM_UNIFORMS };
  private guiAudioData: Float32Array = new Float32Array(64);
  private debug: WebGL2DebugConfig = createDebugConfig();
  private depthTexture: GPUTexture | null = null;

  private cameraRotation = { x: 0, y: 0 };
  private isDragging = false;
  private lastMousePos = { x: 0, y: 0 };

  private onTogglePlay: (() => void) | null = null;
  private onDeviceLostCallback?: (reason: string) => void;
  private destroyed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.setupInputListeners();
  }

  getDevice(): GPUDevice | null {
    return this.device;
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

  async initialize(analyser: AnalyserNode, boot: WebGPUProbeSuccess): Promise<boolean> {
    try {
      this.device = boot.device;
      this.context = boot.context;
      const canvasFormat = boot.format;
      this.canvasFormat = canvasFormat;

      this.device.lost.then((info) => {
        console.warn('WebGPU device lost:', info.message, 'reason:', info.reason);
        this.device = null;
        if (this.destroyed || info.reason === 'destroyed') return;
        this.onDeviceLostCallback?.(info.reason);
      });

      this.context.configure(buildCanvasConfiguration({
        device: this.device,
        format: canvasFormat,
      }));

      this.analyser = analyser;
      this.audioData = new Uint8Array(analyser.frequencyBinCount);

      this.waveform = await createWaveformResources(this.device, canvasFormat);
      this.cube = await createCubeResources(this.device, canvasFormat);
      this.gui = await createGuiResources(this.device, canvasFormat);

      return true;
    } catch (error) {
      console.error('Error initializing WebGPU:', error);
      this.cleanupPartial();
      throw error;
    }
  }

  private cleanupPartial() {
    this.destroyGpuBuffers();
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
    this.context = null;
    this.canvasFormat = null;
  }

  private destroyGpuBuffers() {
    this.waveform?.uniformBuffer.destroy();
    this.waveform = null;
    this.gui?.uniformBuffer.destroy();
    this.gui?.audioBuffer.destroy();
    this.gui = null;
    this.cube?.uniformBuffer.destroy();
    this.cube?.vertexBuffer.destroy();
    this.cube?.indexBuffer.destroy();
    this.cube?.renderTargetTexture.destroy();
    this.cube = null;
    if (this.depthTexture) {
      this.depthTexture.destroy();
      this.depthTexture = null;
    }
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
    if (!this.device || !this.context || !this.waveform) return;

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
    if (!this.device || !this.context || !this.waveform) return;

    this.device.queue.writeBuffer(this.waveform.uniformBuffer, 0, new Float32Array([
      this.canvas.width, this.canvas.height, this.time, audioLevel,
    ]));

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.1, g: 0.1, b: 0.2, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.waveform.pipeline);
    pass.setBindGroup(0, this.waveform.bindGroup);
    pass.draw(6);
    pass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  private render3D(audioLevel: number) {
    if (!this.device || !this.context || !this.waveform || !this.cube) return;

    this.device.queue.writeBuffer(this.waveform.uniformBuffer, 0, new Float32Array([
      512, 512, this.time, audioLevel,
    ]));

    const commandEncoder = this.device.createCommandEncoder();

    const waveformPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.cube.renderTargetView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    waveformPass.setPipeline(this.waveform.pipeline);
    waveformPass.setBindGroup(0, this.waveform.bindGroup);
    waveformPass.draw(6);
    waveformPass.end();

    const aspect = this.canvas.width / this.canvas.height;
    const projection = Mat4.perspective(Math.PI / 4, aspect, 0.1, 100.0);

    const radius = 5;
    this.cameraRotation.x = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, this.cameraRotation.x));

    const camX = Math.sin(this.cameraRotation.y) * radius * Math.cos(this.cameraRotation.x);
    const camY = Math.sin(this.cameraRotation.x) * radius;
    const camZ = Math.cos(this.cameraRotation.y) * radius * Math.cos(this.cameraRotation.x);

    const view = Mat4.lookAt(
      new Vec3(camX, camY, camZ),
      new Vec3(0, 0, 0),
      new Vec3(0, 1, 0),
    );

    const mvp = Mat4.multiply(projection, view);
    this.device.queue.writeBuffer(this.cube.uniformBuffer, 0, mvp.values.buffer as ArrayBuffer);

    if (!this.depthTexture
      || this.depthTexture.width !== this.canvas.width
      || this.depthTexture.height !== this.canvas.height) {
      if (this.depthTexture) this.depthTexture.destroy();
      this.depthTexture = this.device.createTexture({
        size: [this.canvas.width, this.canvas.height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    }

    const textureView = this.context.getCurrentTexture().createView();

    const cubePass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    cubePass.setPipeline(this.cube.pipeline);
    cubePass.setBindGroup(0, this.cube.bindGroup);
    cubePass.setVertexBuffer(0, this.cube.vertexBuffer);
    cubePass.setIndexBuffer(this.cube.indexBuffer, 'uint16');
    cubePass.drawIndexed(36);

    cubePass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  setUniforms(data: ShaderGUIUniforms): void {
    this.guiUniforms = data;
  }

  setDebugMode(mode: WebGL2DebugMode): void {
    this.debug = { ...this.debug, mode };
  }

  getDebugMode(): WebGL2DebugMode {
    return this.debug.mode;
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
    if (!this.device || !this.context || !this.canvasFormat) return;
    this.context.configure(buildCanvasConfiguration({
      device: this.device,
      format: this.canvasFormat,
    }));
  }

  renderGUI(): void {
    if (!this.device || !this.context || !this.gui) return;

    this.device.queue.writeBuffer(
      this.gui.uniformBuffer,
      0,
      new Float32Array(packWaveformUniforms(this.guiUniforms, debugModeToUniform(this.debug.mode))),
    );

    this.device.queue.writeBuffer(this.gui.audioBuffer, 0, this.guiAudioData.buffer as ArrayBuffer);

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.gui.pipeline);
    pass.setBindGroup(0, this.gui.bindGroup);
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
    this.destroyGpuBuffers();
    if (this.device) {
      this.device.destroy();
      this.device = null;
    }
    this.context = null;
    this.canvasFormat = null;
  }
}
