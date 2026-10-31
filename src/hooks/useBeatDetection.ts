import { useRef, useCallback } from 'react';
import { BEAT_BAND_EDGES_HZ, BandMapper, DEFAULT_SPECTRUM_RATE } from '../visuals/spectrumBands';

export type BeatBands = [number, number, number, number, number];

export interface BeatDetectionState {
  beatPhaseRef: React.MutableRefObject<number>;
  spectrumRef: React.MutableRefObject<BeatBands>;
  /** Read the analyser's byte spectrum and run {@link BeatDetectionState.processBytes}. */
  processFrame: (analyser: AnalyserNode | null) => void;
  /**
   * Bands + beat from a getByteFrequencyData-scaled spectrum (analyser or GPU bins
   * mapped by amplitudesToAnalyserBytes). `null` = no new spectrum this frame:
   * bands hold, beatPhase keeps ramping. `sampleRate` is the spectrum's context
   * rate (Nyquist = last bin); omitted = 44.1 kHz.
   */
  processBytes: (data: Uint8Array | null, sampleRate?: number) => void;
}

const beatBandMapper = new BandMapper(() => BEAT_BAND_EDGES_HZ, 5);

/**
 * 5 bands over the byte spectrum (bass / low-mid / mid / high-mid / treble), each
 * 0..1, cut in Hz (BEAT_BAND_EDGES_HZ) so bass stays ~20–440 Hz at any context rate.
 */
export function spectrumBands(data: ArrayLike<number>, sampleRate = DEFAULT_SPECTRUM_RATE): BeatBands {
  const out = beatBandMapper.map(data, sampleRate);
  return [out[0]!, out[1]!, out[2]!, out[3]!, out[4]!];
}

export function useBeatDetection(): BeatDetectionState {
  const beatPhaseRef = useRef(0);
  const spectrumRef = useRef<BeatBands>([0, 0, 0, 0, 0]);
  const lastBeatTime = useRef(0);
  const bassHistory = useRef<number[]>([]);

  const scratch = useRef<Uint8Array<ArrayBuffer>>(new Uint8Array(0));

  const processBytes = useCallback((data: Uint8Array | null, sampleRate?: number) => {
    if (!data) {
      beatPhaseRef.current = Math.min(1, beatPhaseRef.current + 0.03);
      return;
    }
    const bands = spectrumBands(data, sampleRate);
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
    if (scratch.current.length !== analyser.frequencyBinCount) {
      scratch.current = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteFrequencyData(scratch.current);
    processBytes(scratch.current, analyser.context?.sampleRate);
  }, [processBytes]);

  return {
    beatPhaseRef,
    spectrumRef,
    processFrame,
    processBytes,
  };
}

export default useBeatDetection;
