import { useEffect, useState } from 'react';
import { sharedLoudnessMeter, type LoudnessMeter, type LoudnessReading } from '../audio/loudnessMeter';

/**
 * Live EBU R128 momentary / short-term loudness of the output (loudnessMeter.ts).
 * The meter runs only while a component uses this hook; null until it has a
 * reading (no dsp-chain worklet, no SharedArrayBuffer, nothing played yet).
 */
export function useLoudness(meter: LoudnessMeter = sharedLoudnessMeter): LoudnessReading | null {
  const [reading, setReading] = useState<LoudnessReading | null>(() => meter.latest());
  useEffect(() => meter.subscribe(setReading), [meter]);
  return reading;
}

/** "-14.2 LUFS", "−∞ LUFS" for digital silence, "—" while the window fills or nothing plays. */
export function formatLufs(lufs: number | null | undefined, live = true): string {
  if (!live || lufs === null || lufs === undefined || Number.isNaN(lufs)) return '—';
  if (lufs === -Infinity) return '−∞ LUFS';
  return `${lufs.toFixed(1)} LUFS`;
}
