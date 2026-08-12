/**
 * useAudioSettings – persisted EQ and playback-speed state.
 *
 * Reads/writes to localStorage on change so settings survive page reloads.
 */

import { useState, useCallback, useEffect } from 'react';
import { DEFAULT_EQ_BANDS } from '../audio/EQChain';
import type { LatencyMode } from '../audio/audioContextPolicy';

const EQ_STORAGE_KEY = 'flac_player_eq_gains';
const SPEED_STORAGE_KEY = 'flac_player_playback_rate';
const CROSSFADE_KEY = 'flac_player_crossfade';
const LATENCY_MODE_KEY = 'flac_player_latency_mode';
const REPLAYGAIN_ENABLED_KEY = 'flac_player_replaygain_enabled';
const REPLAYGAIN_DB_KEY = 'flac_player_replaygain_db';

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

function loadStoredLatencyMode(): LatencyMode {
  try {
    const value = localStorage.getItem(LATENCY_MODE_KEY);
    if (value === 'interactive' || value === 'balanced' || value === 'playback') {
      return value;
    }
  } catch { /* ignore */ }
  return 'playback';
}

function loadStoredReplayGainEnabled(): boolean {
  try {
    return localStorage.getItem(REPLAYGAIN_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

function loadStoredReplayGainDb(): number {
  try {
    const v = parseFloat(localStorage.getItem(REPLAYGAIN_DB_KEY) || '0');
    return isNaN(v) ? 0 : Math.max(-24, Math.min(24, v));
  } catch {
    return 0;
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
  /** User-selected AudioContext latency mode */
  latencyMode: LatencyMode;
  setLatencyMode: (mode: LatencyMode) => void;
  /** ReplayGain stub — loudness analysis deferred to #184 */
  replayGainEnabled: boolean;
  setReplayGainEnabled: (enabled: boolean) => void;
  replayGainDb: number;
  setReplayGainDb: (db: number) => void;
}

export function useAudioSettings(): AudioSettingsHook {
  const [eqGains, setEqGains] = useState<number[]>(loadStoredEQ);
  const [playbackRate, setPlaybackRateState] = useState<number>(loadStoredRate);
  const [crossfadeEnabled, setCrossfadeEnabledState] = useState<boolean>(loadStoredCrossfade);
  const [latencyMode, setLatencyModeState] = useState<LatencyMode>(loadStoredLatencyMode);
  const [replayGainEnabled, setReplayGainEnabledState] = useState<boolean>(loadStoredReplayGainEnabled);
  const [replayGainDb, setReplayGainDbState] = useState<number>(loadStoredReplayGainDb);

  useEffect(() => {
    try { localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify(eqGains)); } catch { /* quota */ }
  }, [eqGains]);

  useEffect(() => {
    try { localStorage.setItem(SPEED_STORAGE_KEY, String(playbackRate)); } catch { /* quota */ }
  }, [playbackRate]);

  useEffect(() => {
    try { localStorage.setItem(CROSSFADE_KEY, String(crossfadeEnabled)); } catch { /* quota */ }
  }, [crossfadeEnabled]);

  useEffect(() => {
    try { localStorage.setItem(LATENCY_MODE_KEY, latencyMode); } catch { /* quota */ }
  }, [latencyMode]);

  useEffect(() => {
    try { localStorage.setItem(REPLAYGAIN_ENABLED_KEY, String(replayGainEnabled)); } catch { /* quota */ }
  }, [replayGainEnabled]);

  useEffect(() => {
    try { localStorage.setItem(REPLAYGAIN_DB_KEY, String(replayGainDb)); } catch { /* quota */ }
  }, [replayGainDb]);

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

  const setLatencyMode = useCallback((mode: LatencyMode) => {
    setLatencyModeState(mode);
  }, []);

  const setReplayGainEnabled = useCallback((enabled: boolean) => {
    setReplayGainEnabledState(enabled);
  }, []);

  const setReplayGainDb = useCallback((db: number) => {
    setReplayGainDbState(Math.max(-24, Math.min(24, db)));
  }, []);

  return {
    eqGains,
    setEQBandGain,
    resetEQ,
    playbackRate,
    setPlaybackRate,
    crossfadeEnabled,
    setCrossfadeEnabled,
    latencyMode,
    setLatencyMode,
    replayGainEnabled,
    setReplayGainEnabled,
    replayGainDb,
    setReplayGainDb,
  };
}
