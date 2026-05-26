/**
 * useAudioSettings – persisted EQ and playback-speed state.
 *
 * Reads/writes to localStorage on change so settings survive page reloads.
 */

import { useState, useCallback, useEffect } from 'react';
import { DEFAULT_EQ_BANDS } from '../audio/EQChain';

const EQ_STORAGE_KEY    = 'flac_player_eq_gains';
const SPEED_STORAGE_KEY = 'flac_player_playback_rate';
const CROSSFADE_KEY     = 'flac_player_crossfade';

function loadStoredEQ(): number[] {
  try {
    const raw = localStorage.getItem(EQ_STORAGE_KEY);
    if (!raw) return DEFAULT_EQ_BANDS.map(() => 0);
    const parsed = JSON.parse(raw) as number[];
    if (Array.isArray(parsed) && parsed.length === DEFAULT_EQ_BANDS.length) return parsed;
  } catch { /* ignore */ }
  return DEFAULT_EQ_BANDS.map(() => 0);
}

function loadStoredRate(): number {
  try {
    const v = parseFloat(localStorage.getItem(SPEED_STORAGE_KEY) || '1');
    return isNaN(v) ? 1 : Math.max(0.25, Math.min(4, v));
  } catch {
    return 1;
  }
}

function loadStoredCrossfade(): boolean {
  try {
    return localStorage.getItem(CROSSFADE_KEY) === 'true';
  } catch {
    return false;
  }
}

export interface AudioSettingsHook {
  /** Gain (dB) for each of the 5 EQ bands */
  eqGains: number[];
  /** Set one band's gain (−12 to +12 dB) */
  setEQBandGain: (index: number, gainDb: number) => void;
  /** Reset all bands to 0 dB */
  resetEQ: () => void;
  /** Current playback rate (0.25 – 4.0) */
  playbackRate: number;
  setPlaybackRate: (rate: number) => void;
  /** Crossfade / gapless enabled */
  crossfadeEnabled: boolean;
  setCrossfadeEnabled: (enabled: boolean) => void;
}

export function useAudioSettings(): AudioSettingsHook {
  const [eqGains, setEqGains] = useState<number[]>(loadStoredEQ);
  const [playbackRate, setPlaybackRateState] = useState<number>(loadStoredRate);
  const [crossfadeEnabled, setCrossfadeEnabledState] = useState<boolean>(loadStoredCrossfade);

  // Persist EQ changes
  useEffect(() => {
    try { localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify(eqGains)); } catch { /* quota */ }
  }, [eqGains]);

  // Persist playback rate
  useEffect(() => {
    try { localStorage.setItem(SPEED_STORAGE_KEY, String(playbackRate)); } catch { /* quota */ }
  }, [playbackRate]);

  // Persist crossfade
  useEffect(() => {
    try { localStorage.setItem(CROSSFADE_KEY, String(crossfadeEnabled)); } catch { /* quota */ }
  }, [crossfadeEnabled]);

  const setEQBandGain = useCallback((index: number, gainDb: number) => {
    setEqGains(prev => {
      const next = [...prev];
      next[index] = Math.max(-12, Math.min(12, gainDb));
      return next;
    });
  }, []);

  const resetEQ = useCallback(() => {
    setEqGains(DEFAULT_EQ_BANDS.map(() => 0));
  }, []);

  const setPlaybackRate = useCallback((rate: number) => {
    setPlaybackRateState(Math.max(0.25, Math.min(4.0, rate)));
  }, []);

  const setCrossfadeEnabled = useCallback((enabled: boolean) => {
    setCrossfadeEnabledState(enabled);
  }, []);

  return {
    eqGains,
    setEQBandGain,
    resetEQ,
    playbackRate,
    setPlaybackRate,
    crossfadeEnabled,
    setCrossfadeEnabled,
  };
}
