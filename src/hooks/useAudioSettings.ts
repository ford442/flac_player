/**
 * useAudioSettings – persisted EQ, playback-speed, gapless, and ReplayGain state.
 */

import { useState, useCallback, useEffect } from 'react';
import { DEFAULT_EQ_BANDS } from '../audio/EQChain';
import {
  DEFAULT_CROSSFADE_MS,
  DEFAULT_GAPLESS_MODE,
  type GaplessMode,
  type GaplessSettings,
} from '../types/gapless';
import {
  DEFAULT_REPLAYGAIN_MODE,
  type ReplayGainMode,
  type ReplayGainSettings,
} from '../utils/replayGain';

const EQ_STORAGE_KEY = 'flac_player_eq_gains';
const SPEED_STORAGE_KEY = 'flac_player_playback_rate';
const CROSSFADE_KEY = 'flac_player_crossfade';
const GAPLESS_MODE_KEY = 'flac_player_gapless_mode';
const CROSSFADE_MS_KEY = 'flac_player_crossfade_ms';
const REPLAYGAIN_MODE_KEY = 'flac_player_replaygain_mode';
const REPLAYGAIN_LIMITER_KEY = 'flac_player_replaygain_limiter';

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

function loadStoredGaplessMode(): GaplessMode {
  try {
    const stored = localStorage.getItem(GAPLESS_MODE_KEY);
    if (stored === 'off' || stored === 'gapless' || stored === 'crossfade') return stored;
    const legacy = localStorage.getItem(CROSSFADE_KEY);
    if (legacy === 'true') return 'crossfade';
    if (legacy === 'false') return 'off';
  } catch { /* ignore */ }
  return DEFAULT_GAPLESS_MODE;
}

function loadStoredCrossfadeMs(): number {
  try {
    const raw = parseInt(localStorage.getItem(CROSSFADE_MS_KEY) || String(DEFAULT_CROSSFADE_MS), 10);
    if (!Number.isFinite(raw)) return DEFAULT_CROSSFADE_MS;
    return Math.max(0, Math.min(12000, raw));
  } catch {
    return DEFAULT_CROSSFADE_MS;
  }
}

function loadStoredReplayGainMode(): ReplayGainMode {
  try {
    const stored = localStorage.getItem(REPLAYGAIN_MODE_KEY);
    if (stored === 'off' || stored === 'track' || stored === 'album') return stored;
  } catch { /* ignore */ }
  return DEFAULT_REPLAYGAIN_MODE;
}

function loadStoredReplayGainLimiter(): boolean {
  try {
    return localStorage.getItem(REPLAYGAIN_LIMITER_KEY) === 'true';
  } catch {
    return true;
  }
}

export interface AudioSettingsHook {
  eqGains: number[];
  setEQBandGain: (index: number, gainDb: number) => void;
  resetEQ: () => void;
  playbackRate: number;
  setPlaybackRate: (rate: number) => void;
  /** @deprecated Use gaplessMode — kept for existing call sites during migration */
  crossfadeEnabled: boolean;
  setCrossfadeEnabled: (enabled: boolean) => void;
  gaplessMode: GaplessMode;
  setGaplessMode: (mode: GaplessMode) => void;
  crossfadeMs: number;
  setCrossfadeMs: (ms: number) => void;
  gaplessSettings: GaplessSettings;
  replayGainMode: ReplayGainMode;
  setReplayGainMode: (mode: ReplayGainMode) => void;
  replayGainLimiter: boolean;
  setReplayGainLimiter: (enabled: boolean) => void;
  replayGainSettings: ReplayGainSettings;
}

export function useAudioSettings(): AudioSettingsHook {
  const [eqGains, setEqGains] = useState<number[]>(loadStoredEQ);
  const [playbackRate, setPlaybackRateState] = useState<number>(loadStoredRate);
  const [gaplessMode, setGaplessModeState] = useState<GaplessMode>(loadStoredGaplessMode);
  const [crossfadeMs, setCrossfadeMsState] = useState<number>(loadStoredCrossfadeMs);
  const [replayGainMode, setReplayGainModeState] = useState<ReplayGainMode>(loadStoredReplayGainMode);
  const [replayGainLimiter, setReplayGainLimiterState] = useState<boolean>(loadStoredReplayGainLimiter);

  useEffect(() => {
    try { localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify(eqGains)); } catch { /* quota */ }
  }, [eqGains]);

  useEffect(() => {
    try { localStorage.setItem(SPEED_STORAGE_KEY, String(playbackRate)); } catch { /* quota */ }
  }, [playbackRate]);

  useEffect(() => {
    try {
      localStorage.setItem(GAPLESS_MODE_KEY, gaplessMode);
      localStorage.setItem(CROSSFADE_KEY, String(gaplessMode === 'crossfade'));
    } catch { /* quota */ }
  }, [gaplessMode]);

  useEffect(() => {
    try { localStorage.setItem(CROSSFADE_MS_KEY, String(crossfadeMs)); } catch { /* quota */ }
  }, [crossfadeMs]);

  useEffect(() => {
    try { localStorage.setItem(REPLAYGAIN_MODE_KEY, replayGainMode); } catch { /* quota */ }
  }, [replayGainMode]);

  useEffect(() => {
    try { localStorage.setItem(REPLAYGAIN_LIMITER_KEY, String(replayGainLimiter)); } catch { /* quota */ }
  }, [replayGainLimiter]);

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

  const setGaplessMode = useCallback((mode: GaplessMode) => {
    setGaplessModeState(mode);
  }, []);

  const setCrossfadeMs = useCallback((ms: number) => {
    setCrossfadeMsState(Math.max(0, Math.min(12000, ms)));
  }, []);

  const setCrossfadeEnabled = useCallback((enabled: boolean) => {
    setGaplessModeState(enabled ? 'crossfade' : 'off');
  }, []);

  const setReplayGainMode = useCallback((mode: ReplayGainMode) => {
    setReplayGainModeState(mode);
  }, []);

  const setReplayGainLimiter = useCallback((enabled: boolean) => {
    setReplayGainLimiterState(enabled);
  }, []);

  const gaplessSettings: GaplessSettings = { mode: gaplessMode, crossfadeMs };
  const replayGainSettings: ReplayGainSettings = { mode: replayGainMode, limiterEnabled: replayGainLimiter };

  return {
    eqGains,
    setEQBandGain,
    resetEQ,
    playbackRate,
    setPlaybackRate,
    crossfadeEnabled: gaplessMode === 'crossfade',
    setCrossfadeEnabled,
    gaplessMode,
    setGaplessMode,
    crossfadeMs,
    setCrossfadeMs,
    gaplessSettings,
    replayGainMode,
    setReplayGainMode,
    replayGainLimiter,
    setReplayGainLimiter,
    replayGainSettings,
  };
}
