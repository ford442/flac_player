import React, { useEffect, useState } from 'react';
import { type PlaybackPathInfo } from '../../audioLoader';
import { AudioOutputMode } from '../../hooks/usePlayerState';
import { EQPanel, type AudioOutputControls } from '../EQPanel';
import { CacheStatsPanel } from '../OfflineCache';
import type { GaplessMode } from '../../types/gapless';
import type { ReplayGainMode } from '../../utils/replayGain';
import type { LatencyMode } from '../../audio/sampleRatePolicy';
import {
  isCompatibilityVisualizerEnabled,
  setCompatibilityVisualizer,
  subscribeVisualizerPreference,
} from '../../visuals/rendererSelection';

export interface PlayerFallbackSettingsTabProps {
  eqGains: number[];
  setEQBandGain: (i: number, g: number) => void;
  resetEQ: () => void;
  playbackRate: number;
  setPlaybackRate: (r: number) => void;
  gaplessMode: GaplessMode;
  setGaplessMode: (mode: GaplessMode) => void;
  crossfadeMs: number;
  setCrossfadeMs: (ms: number) => void;
  replayGainMode: ReplayGainMode;
  setReplayGainMode: (mode: ReplayGainMode) => void;
  replayGainLimiter: boolean;
  setReplayGainLimiter: (enabled: boolean) => void;
  latencyMode: LatencyMode;
  setLatencyMode: (mode: LatencyMode) => void;
  audioOutput: AudioOutputControls;
  outputMode: AudioOutputMode;
  setOutputMode: (m: AudioOutputMode) => void;
  playbackPath: PlaybackPathInfo | null;
  onClearCache: () => void;
}

export const PlayerFallbackSettingsTab: React.FC<PlayerFallbackSettingsTabProps> = ({
  eqGains, setEQBandGain, resetEQ, playbackRate, setPlaybackRate,
  gaplessMode, setGaplessMode, crossfadeMs, setCrossfadeMs,
  replayGainMode, setReplayGainMode, replayGainLimiter, setReplayGainLimiter,
  latencyMode, setLatencyMode, audioOutput,
  outputMode, setOutputMode, playbackPath, onClearCache,
}) => {
  const [compatibilityVisualizer, setCompatibilityVisualizerState] = useState(
    () => isCompatibilityVisualizerEnabled(),
  );

  useEffect(() => subscribeVisualizerPreference(() => {
    setCompatibilityVisualizerState(isCompatibilityVisualizerEnabled());
  }), []);

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-lg mx-auto space-y-8">
        <h2 className="text-xl font-semibold">Audio Settings</h2>
        <div className="bg-white/5 rounded-xl p-5 border border-white/10">
          <EQPanel eqGains={eqGains} onBandChange={setEQBandGain} onReset={resetEQ}
            playbackRate={playbackRate} onPlaybackRateChange={setPlaybackRate}
            gaplessMode={gaplessMode} onGaplessModeChange={setGaplessMode}
            crossfadeMs={crossfadeMs} onCrossfadeMsChange={setCrossfadeMs}
            replayGainMode={replayGainMode} onReplayGainModeChange={setReplayGainMode}
            replayGainLimiter={replayGainLimiter} onReplayGainLimiterChange={setReplayGainLimiter}
            latencyMode={latencyMode} onLatencyModeChange={setLatencyMode}
            audioOutput={audioOutput} />
        </div>
        <div className="bg-white/5 rounded-xl p-5 border border-white/10 space-y-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Audio Engine</span>
          <select value={outputMode} onChange={(e) => setOutputMode(e.target.value as AudioOutputMode)}
            className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm text-white">
            <option value="streaming">Streaming (recommended)</option>
            <option value="worklet">AudioWorklet (buffered)</option>
            <option value="web-audio">Web Audio (buffered)</option>
          </select>
          {playbackPath && (
            <div className="text-xs text-cyan-300/90 bg-cyan-950/30 border border-cyan-500/20 rounded-lg px-3 py-2" role="status">
              <span className="font-semibold">{playbackPath.label}</span>
              <span className="text-gray-400"> — {playbackPath.detail}</span>
            </div>
          )}
          <p className="text-xs text-gray-500">
            FLAC files ≥32 MB auto-stream via WASM decoder (bounded memory).
            Smaller FLAC uses buffered decode. Non-FLAC URLs use native browser streaming.
            Crossfade works in native streaming only.
          </p>
        </div>
        <div className="bg-white/5 rounded-xl p-5 border border-white/10 space-y-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Visualizer</span>
          <label className="flex items-start gap-3 text-sm text-white cursor-pointer">
            <input
              type="checkbox"
              className="mt-1"
              checked={compatibilityVisualizer}
              onChange={(e) => setCompatibilityVisualizer(e.target.checked)}
            />
            <span>
              <span className="font-medium">Compatibility visualizer</span>
              <span className="block text-xs text-gray-500 mt-1">
                Use WebGL2 ShaderGUI when WebGPU is missing (Safari / some Firefox).
                Default remains WebGPU or a fatal visualizer panel — this does not auto-fall through.
                Also available as <code>?visualizer=webgl2</code>.
              </span>
            </span>
          </label>
        </div>
        <div className="bg-white/5 rounded-xl p-5 border border-white/10 space-y-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Offline Cache</span>
          <p className="text-xs text-gray-500">
            Recently played tracks are cached automatically (up to 500 MB, LRU eviction).
            You can also download individual tracks from the library for offline use.
          </p>
          <CacheStatsPanel onClearAll={onClearCache} />
        </div>
      </div>
    </div>
  );
};
