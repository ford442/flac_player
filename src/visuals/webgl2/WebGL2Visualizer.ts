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
 * WebGL2 reference renderer for ShaderGUI waveform effects.
 * Mirrors WebGPUVisualizer's public API for drop-in backend switching.
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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

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
    let gl = this.canvas.getContext('webgl2', requested);
    if (!gl && requested.desynchronized) {
      // desynchronized is a hint; retry without it before failing closed.
      gl = this.canvas.getContext('webgl2', { ...requested, desynchronized: false });
    }
    if (!gl) return false;
    this.contextAttributes = gl.getContextAttributes() ?? requested;

    try {
      this.gl = gl;
      this.analyser = analyser;
      this.guiPass = this.createPass(gl, FULLSCREEN_VERTEX, GUI_FRAGMENT, 'gui');
      this.flatPass = this.createPass(gl, FULLSCREEN_VERTEX, FLAT_FRAGMENT, 'flat');
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      return true;
    } catch (err) {
      console.error('[WebGL2Visualizer] init failed:', err);
      this.destroy();
      return false;
    }
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
    if (!gl || !pass) return;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.bindGuiUniforms(gl, pass);
    this.drawFullscreen(gl, pass.program);
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
    const gl = this.gl;
    const pass = this.flatPass;
    if (!gl || !pass) return;

    this.time += 0.016;
    const audioLevel = this.getAudioLevel();

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(pass.program);
    setUniform(gl, pass.uniforms['u_resolution'], [this.canvas.width, this.canvas.height]);
    setUniform(gl, pass.uniforms['u_time'], this.time);
    setUniform(gl, pass.uniforms['u_audioLevel'], audioLevel);
    this.drawFullscreen(gl, pass.program);
  }

  resize(): void {
    // Canvas dimensions are managed by TopScreen; viewport updated each frame.
  }

  readPixels(): Uint8Array | null {
    const gl = this.gl;
    if (!gl) return null;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w <= 0 || h <= 0) return null;
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

  destroy(): void {
    const gl = this.gl;
    if (gl) {
      if (this.guiPass) gl.deleteProgram(this.guiPass.program);
      if (this.flatPass) gl.deleteProgram(this.flatPass.program);
    }
    this.gl = null;
    this.contextAttributes = null;
    this.guiPass = null;
    this.flatPass = null;
    this.analyser = null;
    this.onTogglePlay = null;
  }
}
