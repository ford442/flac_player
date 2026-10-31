// src/visuals/visualSync.ts
// Helpers to bridge AnalyserNode data into visualizers (WebGPU + WebGL2 + Canvas2D).

import type { WaveformUniforms } from './waveformContract';
import { packWaveformUniforms } from './waveformContract';
import { BandMapper, DEFAULT_SPECTRUM_RATE } from './spectrumBands';
import type { ShaderGUIUniforms } from './webgpuVisualizer';

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

const barMappers = new Map<number, BandMapper>();

/**
 * Reduce a linear 0..Nyquist spectrum (analyser bytes or GPU bins) to `targetBins`
 * log-spaced bars between 20 Hz and min(20 kHz, Nyquist), 0..1 each. Shared by the
 * WebGPU and WebGL2 visualizers so both draw the same bars at any context rate.
 * Pass `out` (length `targetBins`) to avoid an allocation per frame.
 */
export function downsampleAudioData(
  data: Uint8Array | Float32Array,
  targetBins = 64,
  sampleRate: number = DEFAULT_SPECTRUM_RATE,
  out?: Float32Array,
): Float32Array {
  let mapper = barMappers.get(targetBins);
  if (!mapper) {
    mapper = BandMapper.logBars(targetBins);
    barMappers.set(targetBins, mapper);
  }
  const bars = mapper.map(data, sampleRate);
  if (out) {
    out.set(bars);
    return out;
  }
  return bars.slice();
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
  const [s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0] = params.spectrum;
  return {
    resolution: [params.canvasWidth, params.canvasHeight],
    time: params.time,
    beatPhase: params.beatPhase,
    rsycrb: params.rsycrb,
    fractal: params.fractal,
    pulse: params.pulse,
    audioLevel: s0 + s1 + s2,
    audioLevelL: s0,
    audioLevelR: s1,
    spectrum0: s0,
    spectrum1: s1,
    spectrum2: s2,
    spectrum3: s3,
    spectrum4: s4,
    modeNone: params.modeNone,
    modeIR: params.modeIR,
    isPlaying: params.isPlaying ? 1 : 0,
    playbackProgress: progress,
    volume: params.volume,
    colorShift: 0,
  };
}
