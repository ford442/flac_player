import { useEffect, useRef, useState } from 'react';
import { runChore } from '../gpu-chores/dispatcher';
import { METER_HZ } from '../gpu-chores/constants';
import { reduceFftSpectrum } from '../gpu-chores/fft';
import type { GpuChoreBackend } from '../gpu-chores/types';

/** Opt-in: `?gpu_fft=1`. Off by default — AnalyserNode still drives ShaderGUI. */
export function isLiveGpuFftEnabled(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): boolean {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const value = params.get('gpu_fft');
  return value === '' || value === '1' || value === 'true';
}

export interface LiveGpuSpectrumStats {
  backend: GpuChoreBackend;
  reason: string;
  elapsedMs: number;
  fftSize: number;
  /** Max |GPU − CPU golden| on the latest checked window (checked ~1 Hz). */
  goldenMaxDiff: number | null;
  spectrum: Float32Array;
}

const GOLDEN_CHECK_EVERY = METER_HZ;

/**
 * Shadow spectrum: uploads the analyser's time-domain window to gpu-chores
 * (`fft_spectrum`, WebGPU on the adopted device) at ≤ METER_HZ on the main thread —
 * never from an audio callback. Results are only surfaced to the 🎛 HUD until the
 * goldens are trusted enough to replace AnalyserNode FFT.
 */
export function useLiveGpuSpectrum(
  analyser: AnalyserNode | null,
  enabled: boolean,
  bins = 64,
): LiveGpuSpectrumStats | null {
  const [stats, setStats] = useState<LiveGpuSpectrumStats | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled || !analyser) return undefined;
    let cancelled = false;
    let tick = 0;
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
          let goldenMaxDiff: number | null = null;
          if (checkGolden) {
            const golden = reduceFftSpectrum(pcm, bins, 1, pcm.length);
            goldenMaxDiff = 0;
            for (let i = 0; i < golden.length; i++) {
              goldenMaxDiff = Math.max(goldenMaxDiff, Math.abs(golden[i] - spectrum[i]));
            }
          }
          setStats((prev) => ({
            backend: result.backend,
            reason: result.reason,
            elapsedMs: result.elapsedMs,
            fftSize: result.fftSize ?? pcm.length,
            goldenMaxDiff: goldenMaxDiff ?? prev?.goldenMaxDiff ?? null,
            spectrum,
          }));
        })
        .catch(() => { /* chores never take down the visualizer */ })
        .finally(() => { inFlight.current = false; });
    }, 1000 / METER_HZ);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [analyser, enabled, bins]);

  return enabled ? stats : null;
}
