import { useEffect, useRef, useState } from 'react';
import { runChore } from '../gpu-chores/dispatcher';
import { METER_HZ } from '../gpu-chores/constants';
import { reduceFftSpectrum } from '../gpu-chores/fft';
import type { GpuChoreBackend } from '../gpu-chores/types';
import { GoldenTrust, resolveSpectrumSource } from '../visuals/spectrumSource';

/**
 * `?gpu_fft=1` (or the GPU default, unless `?analyser_fft=1` / `?no_gpu_compute`).
 * @see resolveSpectrumSource
 */
export function isLiveGpuFftEnabled(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): boolean {
  return resolveSpectrumSource(search).source === 'gpu';
}

export interface LiveGpuSpectrumStats {
  backend: GpuChoreBackend;
  reason: string;
  elapsedMs: number;
  fftSize: number;
  /** Max |GPU − CPU golden| on the latest checked window (checked ~1 Hz). */
  goldenMaxDiff: number | null;
  /** Golden stayed within epsilon for GPU_SPECTRUM_TRUST_CHECKS checks in a row. */
  trusted: boolean;
  spectrum: Float32Array;
}

/** Newest GPU spectrum for the render loop (read by ref; no React re-render per frame). */
export interface LiveGpuSpectrumFrame {
  spectrum: Float32Array;
  /** Increments per result so the loop can tell a new frame from a held one. */
  seq: number;
  trusted: boolean;
}

export interface LiveGpuSpectrum {
  /** HUD snapshot, refreshed at the ~1 Hz golden check. Null while disabled / warming up. */
  stats: LiveGpuSpectrumStats | null;
  frameRef: React.MutableRefObject<LiveGpuSpectrumFrame | null>;
}

const GOLDEN_CHECK_EVERY = METER_HZ;

/**
 * Uploads the analyser's time-domain window to gpu-chores (`fft_spectrum`, WebGPU
 * on the adopted device) at ≤ METER_HZ on the main thread — never from an audio
 * callback — and checks it against the CPU golden at ~1 Hz. ShaderGUI promotes
 * `frameRef` bins to its spectrum uniforms only while `trusted`.
 *
 * Input is still the analyser tap; the worklet/SDL SAB is the planned source.
 */
export function useLiveGpuSpectrum(
  analyser: AnalyserNode | null,
  enabled: boolean,
  bins = 64,
): LiveGpuSpectrum {
  const [stats, setStats] = useState<LiveGpuSpectrumStats | null>(null);
  const frameRef = useRef<LiveGpuSpectrumFrame | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    frameRef.current = null;
    setStats(null);
    if (!enabled || !analyser) return undefined;
    let cancelled = false;
    let tick = 0;
    let seq = 0;
    let goldenMaxDiff: number | null = null;
    const trust = new GoldenTrust();
    const window_ = new Float32Array(analyser.fftSize);

    const id = setInterval(() => {
      if (inFlight.current) return; // drop frames rather than queue GPU work
      inFlight.current = true;
      analyser.getFloatTimeDomainData(window_);
      const pcm = window_.slice();
      const checkGolden = tick++ % GOLDEN_CHECK_EVERY === 0;

      runChore({ kind: 'fft_spectrum', pcm, binCount: bins, fftSize: pcm.length, prefer: 'webgpu' })
        .then((result) => {
          const spectrum = result.spectrum;
          if (cancelled || !spectrum) return;
          if (checkGolden) {
            const golden = reduceFftSpectrum(pcm, bins, 1, pcm.length);
            let diff = golden.length === spectrum.length ? 0 : Infinity;
            for (let i = 0; i < golden.length && diff !== Infinity; i++) {
              diff = Math.max(diff, Math.abs(golden[i]! - spectrum[i]!));
            }
            goldenMaxDiff = diff;
            trust.record(diff);
          }
          frameRef.current = { spectrum, seq: ++seq, trusted: trust.trusted };
          if (checkGolden) {
            setStats({
              backend: result.backend,
              reason: result.reason,
              elapsedMs: result.elapsedMs,
              fftSize: result.fftSize ?? pcm.length,
              goldenMaxDiff,
              trusted: trust.trusted,
              spectrum,
            });
          }
        })
        .catch(() => {
          // Chores never take down the visualizer; an error drops back to the analyser.
          trust.reset();
          if (frameRef.current) frameRef.current = { ...frameRef.current, trusted: false };
        })
        .finally(() => { inFlight.current = false; });
    }, 1000 / METER_HZ);

    return () => {
      cancelled = true;
      clearInterval(id);
      frameRef.current = null;
    };
  }, [analyser, enabled, bins]);

  return { stats: enabled ? stats : null, frameRef };
}
