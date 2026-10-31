import { Mat4, Vec3 } from './math';
import {
  DEFAULT_WAVEFORM_UNIFORMS,
  packWaveformUniforms,
  WAVEFORM_UNIFORM_FLOATS,
  type WaveformUniforms,
} from './waveformContract';
import type { WebGL2DebugMode } from './types';
import { createDebugConfig, debugModeToUniform } from './webgl2/debugModes';
import type { WebGL2DebugConfig } from './types';
import { updateWebGPUTiming, type WebGPUProbeSuccess } from './webgpuProbe';
import { DEFAULT_CANVAS_DISPLAY, type CanvasDisplayOptions } from './webgpu/canvasConfig';
import { GpuPassTimer } from './webgpu/gpuPassTimer';
import { createWaveformResources, type WaveformGpuResources } from './webgpu/waveformResources';
import { createGuiResources, type GuiGpuResources } from './webgpu/guiResources';
import { createCubeResources, type CubeGpuResources } from './webgpu/cubeResources';
import { downsampleAudioData } from './visualSync';
import { DEFAULT_SPECTRUM_RATE } from './spectrumBands';

export type VisualizerMode = 'flat' | '3D';

/** @deprecated Prefer WaveformUniforms from visuals/waveformContract — kept as alias. */
export type ShaderGUIUniforms = WaveformUniforms;

/**
 * WebGPU shader interface for audio visualization.
 *
 * Borrows the shared GPUDevice (GpuDeviceService) and the canvas context the probe
 * configured: it never destroys the device and never reconfigures the canvas
 * (a resize only changes canvas.width/height, picked up by getCurrentTexture()).
 * A new AnalyserNode (graph rebuilt for another sample rate) arrives through
 * {@link setAnalyser}; nothing GPU-side is recreated for it.
 */
export class WebGPUVisualizer {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private canvasFormat: GPUTextureFormat | null = null;
  private canvas: HTMLCanvasElement;
  private animationFrameId: number | null = null;
  /** Context rate of the spectra passed to setAudioData (bars are cut in Hz). */
  private sampleRate = DEFAULT_SPECTRUM_RATE;
  private time: number = 0;
  private lastFrameMs: number | null = null;
  private audioLevel = 0;
  private mode: VisualizerMode = 'flat';

  private waveform: WaveformGpuResources | null = null;
  private gui: GuiGpuResources | null = null;
  private cube: CubeGpuResources | null = null;
  private cubePending: Promise<void> | null = null;
  private cubeFailed = false;
  private guiUniforms: ShaderGUIUniforms = { ...DEFAULT_WAVEFORM_UNIFORMS };
  private readonly guiAudioData = new Float32Array(64);
  private readonly guiUniformData = new Float32Array(WAVEFORM_UNIFORM_FLOATS);
  private readonly waveformUniformData = new Float32Array(4);
  private debug: WebGL2DebugConfig = createDebugConfig();
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private display: CanvasDisplayOptions = DEFAULT_CANVAS_DISPLAY;
  private passTimer: GpuPassTimer | null = null;

  private cameraRotation = { x: 0, y: 0 };
  private isDragging = false;
  private lastMousePos = { x: 0, y: 0 };
  private readonly onMouseDown = (e: MouseEvent) => {
    this.isDragging = true;
    this.lastMousePos = { x: e.clientX, y: e.clientY };
    this.checkInteraction();
  };
  private readonly onMouseMove = (e: MouseEvent) => {
    if (this.isDragging && this.mode === '3D') {
      const deltaX = e.clientX - this.lastMousePos.x;
      const deltaY = e.clientY - this.lastMousePos.y;
      this.cameraRotation.y += deltaX * 0.01;
      this.cameraRotation.x += deltaY * 0.01;
      this.lastMousePos = { x: e.clientX, y: e.clientY };
    }
  };
  private readonly onMouseUp = () => {
    this.isDragging = false;
  };

  private onTogglePlay: (() => void) | null = null;
  private onDeviceLostCallback?: (reason: string) => void;
  private destroyed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  getDevice(): GPUDevice | null {
    return this.device;
  }

  /** Smoothed waveform-pass GPU time (timestamp-query), null if unsupported / not yet sampled. */
  getGpuTimeMs(): number | null {
    return this.passTimer?.gpuTimeMs ?? null;
  }

  /** Device features actually in use (for the debug HUD). */
  getRenderInfo(): { timestampQuery: boolean; f16: boolean; display: CanvasDisplayOptions } {
    return {
      timestampQuery: this.passTimer?.supported ?? false,
      f16: this.gui?.f16 ?? false,
      display: this.display,
    };
  }

  setMode(mode: VisualizerMode) {
    this.mode = mode;
    if (mode === '3D') void this.ensureCube();
  }

  setTogglePlayCallback(cb: () => void) {
    this.onTogglePlay = cb;
  }

  setOnDeviceLost(cb: (reason: string) => void) {
    this.onDeviceLostCallback = cb;
  }

  /** Swap the spectrum source (graph rebuilt at another rate) without touching the GPU. */
  setAnalyser(analyser: AnalyserNode | null): void {
    this.sampleRate = analyser?.context?.sampleRate ?? DEFAULT_SPECTRUM_RATE;
  }

  /**
   * Build the flat + GUI pipelines on the probed device. Rejects (and leaves the
   * device alone) on a shader, pipeline or validation error, so the caller shows the
   * failure instead of a black canvas behind a `ready` status.
   */
  async initialize(analyser: AnalyserNode | null, boot: WebGPUProbeSuccess): Promise<boolean> {
    try {
      const device = boot.device;
      this.device = device;
      this.context = boot.context;
      this.canvasFormat = boot.format;
      this.display = boot.display;
      this.setAnalyser(analyser);

      void device.lost?.then((info) => {
        if (this.device === device) this.device = null;
        if (this.destroyed || info.reason === 'destroyed') return;
        this.onDeviceLostCallback?.(info.reason);
      });

      const [waveform, gui] = await Promise.all([
        createWaveformResources(device, boot.format),
        createGuiResources(device, boot.format, boot.display.colorSpace),
      ]);
      this.waveform = waveform;
      this.gui = gui;
      if (this.destroyed) {
        this.destroyGpuResources();
        return false;
      }
      this.passTimer = new GpuPassTimer(device);
      if (this.mode === '3D') void this.ensureCube();
      return true;
    } catch (error) {
      console.error('Error initializing WebGPU:', error);
      this.destroyGpuResources();
      this.device = null;
      this.context = null;
      this.canvasFormat = null;
      throw error;
    }
  }

  /** Cube pipeline on first 3D use; on failure 3D keeps drawing the flat waveform. */
  private ensureCube(): Promise<void> {
    if (this.cube || this.cubeFailed || !this.device || !this.canvasFormat) return Promise.resolve();
    if (!this.cubePending) {
      const device = this.device;
      this.cubePending = createCubeResources(device, this.canvasFormat, this.display.colorSpace)
        .then((cube) => {
          if (this.destroyed || this.device !== device) {
            destroyCube(cube);
            return;
          }
          this.cube = cube;
        })
        .catch((error: unknown) => {
          this.cubeFailed = true;
          console.error('[WebGPUVisualizer] 3D cube pipeline failed; staying flat:', error);
        })
        .finally(() => {
          this.cubePending = null;
        });
    }
    return this.cubePending;
  }

  private destroyGpuResources() {
    this.passTimer?.destroy();
    this.passTimer = null;
    this.waveform?.uniformBuffer.destroy();
    this.waveform = null;
    this.gui?.uniformBuffer.destroy();
    this.gui?.audioBuffer.destroy();
    this.gui = null;
    if (this.cube) destroyCube(this.cube);
    this.cube = null;
    this.depthTexture?.destroy();
    this.depthTexture = null;
    this.depthView = null;
  }

  private checkInteraction() {
    if (this.mode !== '3D') return;
    if (this.onTogglePlay) {
      this.onTogglePlay();
    }
  }

  /** Real frame time (clamped so a background tab does not jump the animation). */
  private advanceTime(): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.lastFrameMs !== null) this.time += Math.min(Math.max((now - this.lastFrameMs) / 1000, 0), 0.1);
    this.lastFrameMs = now;
  }

  render(): void {
    if (!this.device || !this.context || !this.waveform) return;
    this.advanceTime();

    if (this.mode === 'flat' || !this.cube) {
      this.renderFlat(this.audioLevel);
    } else {
      this.render3D(this.audioLevel);
    }
  }

  private writeWaveformUniforms(width: number, height: number, audioLevel: number): void {
    const data = this.waveformUniformData;
    data[0] = width;
    data[1] = height;
    data[2] = this.time;
    data[3] = audioLevel;
    this.device!.queue.writeBuffer(this.waveform!.uniformBuffer, 0, data);
  }

  private renderFlat(audioLevel: number) {
    if (!this.device || !this.context || !this.waveform) return;

    this.writeWaveformUniforms(this.canvas.width, this.canvas.height, audioLevel);

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.1, g: 0.1, b: 0.2, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      timestampWrites: this.passTimer?.passTimestampWrites(),
    });
    pass.setPipeline(this.waveform.pipeline);
    pass.setBindGroup(0, this.waveform.bindGroup);
    pass.draw(6);
    pass.end();
    this.submitTimed(commandEncoder);
  }

  private render3D(audioLevel: number) {
    if (!this.device || !this.context || !this.waveform || !this.cube) return;

    this.writeWaveformUniforms(512, 512, audioLevel);

    const commandEncoder = this.device.createCommandEncoder();

    const waveformPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: this.cube.renderTargetView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      timestampWrites: this.passTimer?.passTimestampWrites(),
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

    if (!this.depthTexture || !this.depthView
      || this.depthTexture.width !== this.canvas.width
      || this.depthTexture.height !== this.canvas.height) {
      this.depthTexture?.destroy();
      this.depthTexture = this.device.createTexture({
        size: [this.canvas.width, this.canvas.height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.depthView = this.depthTexture.createView();
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
        view: this.depthView,
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
    this.submitTimed(commandEncoder);
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

  /**
   * A linear 0..Nyquist spectrum (analyser bytes or GPU bins, 0..255) for this frame:
   * 64 log-spaced bars in Hz for the GUI shader, plus the mean level for the 3D pass.
   */
  setAudioData(data: Uint8Array | Float32Array): void {
    downsampleAudioData(data, 64, this.sampleRate, this.guiAudioData);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i]!;
    this.audioLevel = data.length > 0 ? sum / data.length / 255 : 0;
  }

  /** No-op: the probe configured the canvas once; getCurrentTexture() follows canvas.width/height. */
  resize(): void {}

  renderGUI(): void {
    if (!this.device || !this.context || !this.gui) return;

    packWaveformUniforms(this.guiUniforms, debugModeToUniform(this.debug.mode), this.guiUniformData);
    this.device.queue.writeBuffer(this.gui.uniformBuffer, 0, this.guiUniformData);

    this.device.queue.writeBuffer(this.gui.audioBuffer, 0, this.guiAudioData);

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.05, g: 0.05, b: 0.05, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      timestampWrites: this.passTimer?.passTimestampWrites(),
    });
    pass.setPipeline(this.gui.pipeline);
    pass.setBindGroup(0, this.gui.bindGroup);
    pass.draw(6);
    pass.end();
    this.submitTimed(commandEncoder);
  }

  /** Resolve the frame's pass timestamps (if any), submit, and publish gpuTimeMs. */
  private submitTimed(commandEncoder: GPUCommandEncoder): void {
    if (!this.device) return;
    this.passTimer?.resolve(commandEncoder);
    this.device.queue.submit([commandEncoder.finish()]);
    this.passTimer?.afterSubmit();
    updateWebGPUTiming(this.getGpuTimeMs());
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

  /**
   * Release this visualizer's buffers, pipelines' resources and input listeners.
   * The device is borrowed and stays alive; the canvas stays configured for the
   * next visualizer on it.
   */
  destroy(): void {
    this.destroyed = true;
    this.stopAnimation();
    this.destroyGpuResources();
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.device = null;
    this.context = null;
    this.canvasFormat = null;
    this.onTogglePlay = null;
  }
}

function destroyCube(cube: CubeGpuResources): void {
  cube.uniformBuffer.destroy();
  cube.vertexBuffer.destroy();
  cube.indexBuffer.destroy();
  cube.renderTargetTexture.destroy();
}
