import type { ShaderGUIUniforms, VisualizerMode } from '../webgpuVisualizer';
import type { WebGL2DebugConfig, WebGL2DebugMode } from '../types';
import { compileShader, linkProgram, collectUniforms, setUniform, type UniformInfo } from './glUtils';
import { FULLSCREEN_VERTEX, GUI_FRAGMENT, FLAT_FRAGMENT } from './shaders/waveform';
import { createDebugConfig, debugModeToUniform } from './debugModes';
import { downsampleAudioData } from '../visualSync';
import { DEFAULT_WAVEFORM_UNIFORMS } from '../waveformContract';
import { buildWebGL2ContextAttributes } from '../webgpu/canvasConfig';

type GLPass = {
  program: WebGLProgram;
  /** Uniforms of this program only, typed from the GLSL declarations. */
  uniforms: Record<string, UniformInfo>;
};

/**
 * `WEBGL_lose_context` per canvas. destroy() releases the context with
 * loseContext(); a later visualizer on the same canvas gets that lost context
 * back from getContext() and needs this object (getExtension returns null on a
 * lost context) to restore it.
 */
const loseContextByCanvas = new WeakMap<HTMLCanvasElement, WEBGL_lose_context>();

/**
 * Resolves once the `webglcontextlost` event from destroy()'s loseContext() has
 * been dispatched and cancelled. Chrome only allows restoreContext() after that
 * dispatch returns, and destroy → initialize on one canvas happens synchronously.
 */
const releasedByCanvas = new WeakMap<HTMLCanvasElement, Promise<void>>();

type LastFrame = 'gui' | 'flat' | null;

/**
 * WebGL2 reference renderer for ShaderGUI waveform effects.
 * Mirrors WebGPUVisualizer's public API for drop-in backend switching.
 *
 * Context loss: `webglcontextlost` is preventDefault-ed so the browser may
 * restore it; rendering is a no-op while lost and `webglcontextrestored`
 * rebuilds both programs. Nothing else (no buffers or textures: the passes are
 * a vertex-less fullscreen triangle and uniform arrays) holds GL objects.
 */
export class WebGL2Visualizer {
  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement;
  private analyser: AnalyserNode | null = null;
  private guiPass: GLPass | null = null;
  private flatPass: GLPass | null = null;
  private guiUniforms: ShaderGUIUniforms = { ...DEFAULT_WAVEFORM_UNIFORMS };
  private guiAudioData = new Float32Array(64);
  private debug: WebGL2DebugConfig = createDebugConfig();
  private mode: VisualizerMode = 'flat';
  private time = 0;
  private onTogglePlay: (() => void) | null = null;
  private contextAttributes: WebGLContextAttributes | null = null;
  private contextLost = false;
  private lastFrame: LastFrame = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  private readonly onContextLost = (event: Event): void => {
    // Without preventDefault the browser never fires webglcontextrestored.
    event.preventDefault();
    this.contextLost = true;
    // Programs died with the context; deleting them would only log errors.
    this.guiPass = null;
    this.flatPass = null;
    console.warn('[WebGL2Visualizer] context lost; waiting for restore');
  };

  private readonly onContextRestored = (): void => {
    const gl = this.gl;
    if (!gl) return;
    try {
      this.buildPasses(gl);
      this.contextLost = false;
    } catch (err) {
      console.error('[WebGL2Visualizer] rebuild after context restore failed:', err);
    }
  };

  setMode(mode: VisualizerMode): void {
    this.mode = mode;
  }

  setTogglePlayCallback(cb: () => void): void {
    this.onTogglePlay = cb;
  }

  initialize(analyser: AnalyserNode): boolean {
    this.destroy();
    // antialias stays false: the 3D cube is WebGPU-only, so every GL pass is the
    // fullscreen ShaderGUI shader, which does its own glow.
    const requested = buildWebGL2ContextAttributes();
    const gl = this.canvas.getContext('webgl2', requested);
    if (!gl) return false;

    this.gl = gl;
    this.analyser = analyser;
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    if (gl.isContextLost()) {
      // A previous visualizer on this canvas released it (destroy → loseContext):
      // ask for it back; onContextRestored builds the passes.
      const loseContext = loseContextByCanvas.get(this.canvas);
      if (!loseContext) {
        this.destroy();
        return false;
      }
      this.contextLost = true;
      const released = releasedByCanvas.get(this.canvas) ?? Promise.resolve();
      void released.then(() => {
        if (this.gl === gl && gl.isContextLost()) loseContext.restoreContext();
      });
      return true;
    }

    const loseContext = gl.getExtension('WEBGL_lose_context');
    if (loseContext) loseContextByCanvas.set(this.canvas, loseContext);
    try {
      this.buildPasses(gl);
      return true;
    } catch (err) {
      console.error('[WebGL2Visualizer] init failed:', err);
      this.destroy();
      return false;
    }
  }

  /** Programs + fixed state for a fresh (or restored) context. */
  private buildPasses(gl: WebGL2RenderingContext): void {
    this.contextAttributes = gl.getContextAttributes() ?? buildWebGL2ContextAttributes();
    // The shaders write sRGB values; say so rather than inherit a wide-gamut default.
    if ('drawingBufferColorSpace' in gl) gl.drawingBufferColorSpace = 'srgb';
    this.guiPass = this.createPass(gl, FULLSCREEN_VERTEX, GUI_FRAGMENT, 'gui');
    this.flatPass = this.createPass(gl, FULLSCREEN_VERTEX, FLAT_FRAGMENT, 'flat');
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  /** True while the context is lost (rendering is skipped until it is restored). */
  isContextLost(): boolean {
    return this.contextLost;
  }

  private createPass(
    gl: WebGL2RenderingContext,
    vsSrc: string,
    fsSrc: string,
    label: string,
  ): GLPass {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, `${label}-vs`);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, `${label}-fs`);
    const program = linkProgram(gl, vs, fs, label);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return { program, uniforms: collectUniforms(gl, program, label) };
  }

  setUniforms(data: ShaderGUIUniforms): void {
    this.guiUniforms = data;
  }

  /** Swap the spectrum source (graph rebuilt at another rate) without touching GL. */
  setAnalyser(analyser: AnalyserNode | null): void {
    this.analyser = analyser;
  }

  setAudioData(data: Uint8Array | Float32Array): void {
    downsampleAudioData(data, 64, this.analyser?.context?.sampleRate, this.guiAudioData);
  }

  setDebugConfig(partial: Partial<WebGL2DebugConfig>): void {
    this.debug = { ...this.debug, ...partial };
  }

  getDebugConfig(): WebGL2DebugConfig {
    return this.debug;
  }

  setDebugMode(mode: WebGL2DebugMode): void {
    this.debug = { ...this.debug, mode };
  }

  getDebugMode(): WebGL2DebugMode {
    return this.debug.mode;
  }

  private bindGuiUniforms(gl: WebGL2RenderingContext, pass: GLPass): void {
    const u = this.guiUniforms;
    // Uniform locations belong to one program; set them on that program, not whichever was last bound.
    gl.useProgram(pass.program);
    const set = (name: string, value: number | number[] | Float32Array): void =>
      setUniform(gl, pass.uniforms[name], value);

    set('u_resolution', [u.resolution[0], u.resolution[1]]);
    set('u_time', u.time);
    set('u_beatPhase', u.beatPhase);
    set('u_rsycrb', u.rsycrb);
    set('u_fractal', u.fractal);
    set('u_pulse', u.pulse);
    set('u_audioLevel', u.audioLevel);
    set('u_audioLevelL', u.audioLevelL);
    set('u_audioLevelR', u.audioLevelR);
    set('u_spectrum0', u.spectrum0);
    set('u_spectrum1', u.spectrum1);
    set('u_spectrum2', u.spectrum2);
    set('u_spectrum3', u.spectrum3);
    set('u_spectrum4', u.spectrum4);
    set('u_modeNone', u.modeNone);
    set('u_modeIR', u.modeIR);
    set('u_isPlaying', u.isPlaying);
    set('u_playbackProgress', u.playbackProgress);
    set('u_volume', u.volume);
    set('u_colorShift', u.colorShift);
    set('u_debugMode', debugModeToUniform(this.debug.mode));
    set('u_audioData', this.guiAudioData);
  }

  private drawFullscreen(gl: WebGL2RenderingContext, program: WebGLProgram): void {
    gl.useProgram(program);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  renderGUI(): void {
    const gl = this.gl;
    const pass = this.guiPass;
    if (!gl || !pass || this.contextLost) return;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.bindGuiUniforms(gl, pass);
    this.drawFullscreen(gl, pass.program);
    this.lastFrame = 'gui';
  }

  render(): void {
    if (this.mode === 'flat') {
      this.renderFlat();
    } else {
      // 3D cube is WebGPU-only; render GUI shader for visual continuity.
      this.renderGUI();
    }
  }

  private getAudioLevel(): number {
    if (!this.analyser) return 0;
    const temp = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(temp);
    let sum = 0;
    for (let i = 0; i < temp.length; i++) sum += temp[i]!;
    return sum / temp.length / 255.0;
  }

  renderFlat(): void {
    if (!this.gl || !this.flatPass || this.contextLost) return;
    this.time += 0.016;
    this.drawFlat();
  }

  private drawFlat(): void {
    const gl = this.gl;
    const pass = this.flatPass;
    if (!gl || !pass) return;
    const audioLevel = this.getAudioLevel();

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(pass.program);
    setUniform(gl, pass.uniforms['u_resolution'], [this.canvas.width, this.canvas.height]);
    setUniform(gl, pass.uniforms['u_time'], this.time);
    setUniform(gl, pass.uniforms['u_audioLevel'], audioLevel);
    this.drawFullscreen(gl, pass.program);
    this.lastFrame = 'flat';
  }

  resize(): void {
    // Canvas dimensions are managed by TopScreen; viewport updated each frame.
  }

  /**
   * RGBA of the current frame (bottom-left origin). The drawing buffer is not
   * preserved after compositing, so this redraws the last frame (same uniforms,
   * clock not advanced) and reads it back in the same task.
   */
  readPixels(): Uint8Array | null {
    const gl = this.gl;
    if (!gl || this.contextLost || !this.lastFrame) return null;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w <= 0 || h <= 0) return null;
    if (this.lastFrame === 'gui') this.renderGUI();
    else this.drawFlat();
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /** Attributes the browser actually granted (for the probe breadcrumb / HUD). */
  getContextAttributes(): WebGLContextAttributes | null {
    return this.contextAttributes;
  }

  /**
   * Delete the programs and release the context (WEBGL_lose_context) so
   * renderer switches don't pile up live contexts until GC.
   */
  destroy(): void {
    const gl = this.gl;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    if (gl && !gl.isContextLost()) {
      if (this.guiPass) gl.deleteProgram(this.guiPass.program);
      if (this.flatPass) gl.deleteProgram(this.flatPass.program);
      const loseContext = loseContextByCanvas.get(this.canvas);
      if (loseContext) {
        // restoreContext() (next initialize on this canvas) needs a cancelled lost
        // event, and may only run once its dispatch has returned (next task).
        releasedByCanvas.set(this.canvas, new Promise<void>((resolve) => {
          this.canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            setTimeout(resolve, 0);
          }, { once: true });
        }));
        loseContext.loseContext();
      }
    }
    this.gl = null;
    this.contextAttributes = null;
    this.contextLost = false;
    this.lastFrame = null;
    this.guiPass = null;
    this.flatPass = null;
    this.analyser = null;
    this.onTogglePlay = null;
  }
}
