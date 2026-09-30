import { useRef, useCallback } from 'react';

export type BeatBands = [number, number, number, number, number];

export interface BeatDetectionState {
  beatPhaseRef: React.MutableRefObject<number>;
  spectrumRef: React.MutableRefObject<BeatBands>;
  /** Read the analyser's byte spectrum and run {@link BeatDetectionState.processBytes}. */
  processFrame: (analyser: AnalyserNode | null) => void;
  /**
   * Bands + beat from a getByteFrequencyData-scaled spectrum (analyser or GPU bins
   * mapped by amplitudesToAnalyserBytes). `null` = no new spectrum this frame:
   * bands hold, beatPhase keeps ramping.
   */
  processBytes: (data: Uint8Array | null) => void;
}

/** 5 bands over the byte spectrum (bass / low-mid / mid / high-mid / treble), each 0..1. */
export function spectrumBands(data: ArrayLike<number>): BeatBands {
  const binCount = data.length;
  const bandSizes = [
    Math.floor(binCount * 0.02),   // Bass: bins 0-40
    Math.floor(binCount * 0.05),   // Low-mid: bins 41-140
    Math.floor(binCount * 0.15),   // Mid: bins 141-440
    Math.floor(binCount * 0.30),   // High-mid: bins 441-1050
    binCount - Math.floor(binCount * 0.52), // Treble: rest
  ];

  let binIndex = 0;
  const bands: BeatBands = [0, 0, 0, 0, 0];
  for (let b = 0; b < 5; b++) {
    let sum = 0;
    const end = Math.min(binIndex + bandSizes[b]!, binCount);
    for (let i = binIndex; i < end; i++) {
      sum += data[i]!;
    }
    bands[b] = end > binIndex ? sum / ((end - binIndex) * 255) : 0;
    binIndex = end;
  }
  return bands;
}

export function useBeatDetection(): BeatDetectionState {
  const beatPhaseRef = useRef(0);
  const spectrumRef = useRef<BeatBands>([0, 0, 0, 0, 0]);
  const lastBeatTime = useRef(0);
  const bassHistory = useRef<number[]>([]);

  const processBytes = useCallback((data: Uint8Array | null) => {
    if (!data) {
      beatPhaseRef.current = Math.min(1, beatPhaseRef.current + 0.03);
      return;
    }
    const bands = spectrumBands(data);
    spectrumRef.current = bands;

    // Simple beat detection using bass band
    const bass = bands[0];
    bassHistory.current.push(bass);
    if (bassHistory.current.length > 10) {
      bassHistory.current.shift();
    }

    const avgBass = bassHistory.current.reduce((a, b) => a + b, 0) / bassHistory.current.length;
    const threshold = avgBass * 1.3 + 0.05;

    const now = performance.now();
    if (bass > threshold && now - lastBeatTime.current > 250) {
      lastBeatTime.current = now;
      beatPhaseRef.current = 0;
    } else {
      // Ramp beatPhase 0→1 over ~500ms
      beatPhaseRef.current = Math.min(1, beatPhaseRef.current + 0.03);
    }
  }, []);

  const processFrame = useCallback((analyser: AnalyserNode | null) => {
    if (!analyser) {
      beatPhaseRef.current = 0;
      spectrumRef.current = [0, 0, 0, 0, 0];
      return;
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    processBytes(data);
  }, [processBytes]);

  return {
    beatPhaseRef,
    spectrumRef,
    processFrame,
    processBytes,
  };
}

export default useBeatDetection;
