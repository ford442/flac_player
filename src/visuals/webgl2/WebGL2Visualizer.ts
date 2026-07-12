import type { ShaderGUIUniforms, VisualizerMode } from '../../webgpuVisualizer';
import type { WebGL2DebugConfig, WebGL2DebugMode } from '../types';
import { compileShader, linkProgram, collectUniforms } from './glUtils';
import { FULLSCREEN_VERTEX, GUI_FRAGMENT, FLAT_FRAGMENT } from './shaders/waveform';
import { createDebugConfig, debugModeToUniform } from './debugModes';
import { downsampleAudioData } from '../visualSync';

type GLPass = {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
};

const GUI_UNIFORM_NAMES = [
  'u_resolution', 'u_time', 'u_beatPhase',
  'u_rsycrb', 'u_fractal', 'u_pulse',
  'u_audioLevel', 'u_audioLevelL', 'u_audioLevelR',
  'u_spectrum0', 'u_spectrum1', 'u_spectrum2', 'u_spectrum3', 'u_spectrum4',
  'u_modeNone', 'u_modeIR', 'u_isPlaying', 'u_playbackProgress',
  'u_volume', 'u_colorShift', 'u_audioData', 'u_debugMode',
];

const FLAT_UNIFORM_NAMES = ['u_resolution', 'u_time', 'u_audioLevel'];

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
  private guiUniforms: ShaderGUIUniforms = {
    resolution: [1, 1], time: 0, beatPhase: 0,
    rsycrb: 0, fractal: 0, pulse: 0,
    audioLevel: 0, audioLevelL: 0, audioLevelR: 0,
    spectrum0: 0, spectrum1: 0, spectrum2: 0, spectrum3: 0, spectrum4: 0,
    modeNone: 0, modeIR: 0, isPlaying: 0, playbackProgress: 0,
    volume: 1, colorShift: 0,
  };
  private guiAudioData = new Float32Array(64);
  private debug: WebGL2DebugConfig = createDebugConfig();
  private mode: VisualizerMode = 'flat';
  private time = 0;
  private onTogglePlay: (() => void) | null = null;

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
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      antialias: true,
    });
    if (!gl) return false;

    try {
      this.gl = gl;
      this.analyser = analyser;
      this.guiPass = this.createPass(gl, FULLSCREEN_VERTEX, GUI_FRAGMENT, 'gui', GUI_UNIFORM_NAMES);
      this.flatPass = this.createPass(gl, FULLSCREEN_VERTEX, FLAT_FRAGMENT, 'flat', FLAT_UNIFORM_NAMES);
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
    uniformNames: string[],
  ): GLPass {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc, `${label}-vs`);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc, `${label}-fs`);
    const program = linkProgram(gl, vs, fs, label);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return { program, uniforms: collectUniforms(gl, program, uniformNames) };
  }

  setUniforms(data: ShaderGUIUniforms): void {
    this.guiUniforms = data;
  }

  setAudioData(data: Uint8Array | Float32Array): void {
    const sampled = downsampleAudioData(data, 64);
    this.guiAudioData.set(sampled);
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
    const loc = pass.uniforms;

    gl.uniform2f(loc.u_resolution, u.resolution[0], u.resolution[1]);
    gl.uniform1f(loc.u_time, u.time);
    gl.uniform1f(loc.u_beatPhase, u.beatPhase);
    gl.uniform1f(loc.u_rsycrb, u.rsycrb);
    gl.uniform1f(loc.u_fractal, u.fractal);
    gl.uniform1f(loc.u_pulse, u.pulse);
    gl.uniform1f(loc.u_audioLevel, u.audioLevel);
    gl.uniform1f(loc.u_audioLevelL, u.audioLevelL);
    gl.uniform1f(loc.u_audioLevelR, u.audioLevelR);
    gl.uniform1f(loc.u_spectrum0, u.spectrum0);
    gl.uniform1f(loc.u_spectrum1, u.spectrum1);
    gl.uniform1f(loc.u_spectrum2, u.spectrum2);
    gl.uniform1f(loc.u_spectrum3, u.spectrum3);
    gl.uniform1f(loc.u_spectrum4, u.spectrum4);
    gl.uniform1f(loc.u_modeNone, u.modeNone);
    gl.uniform1f(loc.u_modeIR, u.modeIR);
    gl.uniform1f(loc.u_isPlaying, u.isPlaying);
    gl.uniform1f(loc.u_playbackProgress, u.playbackProgress);
    gl.uniform1f(loc.u_volume, u.volume);
    gl.uniform1f(loc.u_colorShift, u.colorShift);
    gl.uniform1f(loc.u_debugMode, debugModeToUniform(this.debug.mode));

    if (loc.u_audioData) {
      gl.uniform1fv(loc.u_audioData, this.guiAudioData);
    }
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
    for (let i = 0; i < temp.length; i++) sum += temp[i];
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
    gl.uniform2f(pass.uniforms.u_resolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(pass.uniforms.u_time, this.time);
    gl.uniform1f(pass.uniforms.u_audioLevel, audioLevel);
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

  destroy(): void {
    const gl = this.gl;
    if (gl) {
      if (this.guiPass) gl.deleteProgram(this.guiPass.program);
      if (this.flatPass) gl.deleteProgram(this.flatPass.program);
    }
    this.gl = null;
    this.guiPass = null;
    this.flatPass = null;
    this.analyser = null;
    this.onTogglePlay = null;
  }
}
