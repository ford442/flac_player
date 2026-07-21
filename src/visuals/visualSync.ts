// src/visuals/visualSync.ts
// Helpers to bridge AnalyserNode data into visualizers (WebGPU + WebGL2 + Canvas2D).

import type { WaveformUniforms } from './waveformContract';
import { packWaveformUniforms } from './waveformContract';
import type { ShaderGUIUniforms } from '../webgpuVisualizer';

/**
 * Create and configure an AnalyserNode connected to an audio source.
 */
export function createAudioAnalyzer(
  audioContext: AudioContext,
  source: AudioNode
): AnalyserNode {
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;
  source.connect(analyser);
  return analyser;
}

/**
 * Get both frequency and time-domain data from an analyser in one call.
 */
export function getVisualizationData(analyser: AnalyserNode): {
  frequency: Uint8Array;
  waveform: Uint8Array;
} {
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  const waveData = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(freqData);
  analyser.getByteTimeDomainData(waveData);
  return { frequency: freqData, waveform: waveData };
}

/**
 * Downsample raw analyser bins to a fixed count for GPU uniform arrays.
 * Matches WebGPUVisualizer.setAudioData() bin-averaging logic.
 */
export function downsampleAudioData(
  data: Uint8Array | Float32Array,
  targetBins = 64,
): Float32Array {
  const out = new Float32Array(targetBins);
  const sourceBins = data.length;
  const binRatio = sourceBins / targetBins;
  for (let i = 0; i < targetBins; i++) {
    let sum = 0;
    const start = Math.floor(i * binRatio);
    const end = Math.floor((i + 1) * binRatio);
    for (let j = start; j < end; j++) {
      sum += data[j];
    }
    out[i] = sum / ((end - start) * 255);
  }
  return out;
}

/**
 * Pack ShaderGUI uniforms into the Float32Array layout used by WebGPU.
 * WebGL2 sets individual uniforms but shares the same source object.
 */
export function buildShaderGUIUniformPayload(
  u: ShaderGUIUniforms | WaveformUniforms,
  debugMode = 0,
): Float32Array {
  return packWaveformUniforms(u, debugMode);
}

/**
 * Build the uniform object passed to all visualization backends each frame.
 */
export function buildFrameUniforms(params: {
  canvasWidth: number;
  canvasHeight: number;
  time: number;
  beatPhase: number;
  rsycrb: number;
  fractal: number;
  pulse: number;
  spectrum: readonly number[];
  modeNone: number;
  modeIR: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
}): ShaderGUIUniforms {
  const progress = params.duration > 0 ? params.currentTime / params.duration : 0;
  return {
    resolution: [params.canvasWidth, params.canvasHeight],
    time: params.time,
    beatPhase: params.beatPhase,
    rsycrb: params.rsycrb,
    fractal: params.fractal,
    pulse: params.pulse,
    audioLevel: params.spectrum[0] + params.spectrum[1] + params.spectrum[2],
    audioLevelL: params.spectrum[0],
    audioLevelR: params.spectrum[1],
    spectrum0: params.spectrum[0],
    spectrum1: params.spectrum[1],
    spectrum2: params.spectrum[2],
    spectrum3: params.spectrum[3],
    spectrum4: params.spectrum[4],
    modeNone: params.modeNone,
    modeIR: params.modeIR,
    isPlaying: params.isPlaying ? 1 : 0,
    playbackProgress: progress,
    volume: params.volume,
    colorShift: 0,
  };
}
