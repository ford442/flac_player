import { useEffect, useRef, useState } from 'react';
import { getAnalysisTap, type AnalysisTapSource } from '../audio/analysisRing';
import { loadWasmFft, type WasmFft } from '../audio/wasmFft';
import { runChore } from '../gpu-chores/dispatcher';
import { DEFAULT_FFT_SIZE, METER_HZ } from '../gpu-chores/constants';
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

/** Where the PCM window came from: an analysis ring writer, or the AnalyserNode. */
export type LiveSpectrumSource = AnalysisTapSource | 'analyser';

/** Which CPU golden the GPU result was checked against. */
export type LiveSpectrumGolden = 'wasm' | 'js';

export interface LiveGpuSpectrumStats {
  backend: GpuChoreBackend;
  reason: string;
  elapsedMs: number;
  fftSize: number;
  source: LiveSpectrumSource;
  /** Max |GPU − CPU golden| on the latest checked window (checked ~1 Hz). */
  goldenMaxDiff: number | null;
  golden: LiveSpectrumGolden | null;
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

interface PcmWindow {
  pcm: Float32Array;
  channels: number;
  fftSize: number;
  source: LiveSpectrumSource;
}

/**
 * Newest FFT window: the analysis ring (post-DSP PCM, interleaved, from the
 * dsp-chain worklet) when one is published, else the
 * analyser's mono time-domain buffer.
 */
function readWindow(analyser: AnalyserNode, scratch: Float32Array<ArrayBuffer>): PcmWindow {
  const tap = getAnalysisTap();
  if (tap) {
    const snapshot = tap.reader.readLatest(DEFAULT_FFT_SIZE);
    if (snapshot) {
      return { pcm: snapshot.pcm, channels: snapshot.channels, fftSize: DEFAULT_FFT_SIZE, source: tap.source };
    }
  }
  analyser.getFloatTimeDomainData(scratch);
  return { pcm: scratch.slice(), channels: 1, fftSize: scratch.length, source: 'analyser' };
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Infinity;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i]! - b[i]!));
  return diff;
}

/**
 * Uploads the newest PCM window to gpu-chores (`fft_spectrum`, WebGPU on the
 * adopted device) at ≤ METER_HZ on the main thread — never from an audio
 * callback. ~1 Hz the result is checked against the dsp_fft.h WASM golden (JS
 * golden until the module loads). ShaderGUI promotes `frameRef` bins to its
 * spectrum uniforms only while `trusted`.
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
    let golden: LiveSpectrumGolden | null = null;
    const trust = new GoldenTrust();
    let wasmFft: WasmFft | null = null;
    loadWasmFft()
      .then((fft) => { wasmFft = fft; })
      .catch(() => { /* JS golden only */ });
    const timeDomain = new Float32Array(analyser.fftSize);

    const id = setInterval(() => {
      if (inFlight.current) return; // drop frames rather than queue GPU work
      inFlight.current = true;
      const { pcm, channels, fftSize, source } = readWindow(analyser, timeDomain);
      const checkGolden = tick++ % GOLDEN_CHECK_EVERY === 0;

      runChore({ kind: 'fft_spectrum', pcm, channels, binCount: bins, fftSize, prefer: 'webgpu' })
        .then((result) => {
          const spectrum = result.spectrum;
          if (cancelled || !spectrum) return;
          if (checkGolden) {
            if (wasmFft && pcm.length <= wasmFft.maxSamples) {
              goldenMaxDiff = maxAbsDiff(wasmFft.spectrum(pcm, channels, fftSize, bins).spectrum, spectrum);
              golden = 'wasm';
            } else {
              goldenMaxDiff = maxAbsDiff(reduceFftSpectrum(pcm, bins, channels, fftSize), spectrum);
              golden = 'js';
            }
            trust.record(goldenMaxDiff);
          }
          frameRef.current = { spectrum, seq: ++seq, trusted: trust.trusted };
          if (checkGolden) {
            setStats({
              backend: result.backend,
              reason: result.reason,
              elapsedMs: result.elapsedMs,
              fftSize: result.fftSize ?? fftSize,
              source,
              goldenMaxDiff,
              golden,
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
