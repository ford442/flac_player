// src/visuals/visualSync.ts
// Helpers to bridge AnalyserNode data into visualizers.

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
