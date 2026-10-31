import React, { useEffect, useId, useState } from 'react';
import type { AudioOutputMode } from '../../types/audio';
import { EQPanel, type AudioOutputControls } from '../EQPanel';
import { CacheStatsPanel, StorageStatusPanel } from '../OfflineCache';
import type { GaplessMode } from '../../types/gapless';
import type { ReplayGainMode } from '../../utils/replayGain';
import type { LatencyMode } from '../../audio/sampleRatePolicy';
import { useActions } from '../PlayerActionsContext';
import { useSettings, useTransport } from '../../player/selectors';
import { OutputModeOptions } from './OutputModeOptions';
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
  onClearCache: () => void;
}

export const PlayerFallbackSettingsTab: React.FC<PlayerFallbackSettingsTabProps> = ({
  eqGains, setEQBandGain, resetEQ, playbackRate, setPlaybackRate,
  gaplessMode, setGaplessMode, crossfadeMs, setCrossfadeMs,
  replayGainMode, setReplayGainMode, replayGainLimiter, setReplayGainLimiter,
  latencyMode, setLatencyMode, audioOutput,
  onClearCache,
}) => {
  const id = useId();
  const outputMode = useSettings((st) => st.outputMode);
  const playbackPath = useTransport((t) => t.playbackPath);
  const { setOutputMode } = useActions();
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
          <label htmlFor={`${id}-engine`} className="block text-xs font-semibold uppercase tracking-wider text-gray-400">Audio Engine</label>
          <select id={`${id}-engine`} value={outputMode} onChange={(e) => setOutputMode(e.target.value as AudioOutputMode)}
            className="w-full px-3 py-2 bg-white/10 border border-white/20 rounded-lg text-sm text-white">
            <OutputModeOptions />
          </select>
          {playbackPath && (
            <div className="text-xs text-cyan-300/90 bg-cyan-950/30 border border-cyan-500/20 rounded-lg px-3 py-2" role="status">
              <span className="font-semibold">{playbackPath.label}</span>
              <span className="text-gray-400"> — {playbackPath.detail}</span>
            </div>
          )}
          <p className="text-xs text-gray-400">
            FLAC files ≥32 MB auto-stream via WASM decoder (bounded memory).
            Smaller FLAC uses buffered decode. Non-FLAC URLs use native browser streaming.
            Crossfade works in native streaming only.
          </p>
          {outputMode === 'sdl' && (
            <p className="text-xs text-amber-300/90">
              The WASM engine is experimental and needs cross-origin isolation (COOP/COEP headers).
              It plays through the shared AudioWorklet and audio graph.
            </p>
          )}
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
              <span className="block text-xs text-gray-400 mt-1">
                Use WebGL2 ShaderGUI when WebGPU is missing (Safari / some Firefox).
                Default remains WebGPU or a fatal visualizer panel — this does not auto-fall through.
                While active, the visualizer shows a “WebGL2 compatibility renderer — not WebGPU” badge. Also available as <code>?webgl2=1</code>.
              </span>
            </span>
          </label>
        </div>
        <div className="bg-white/5 rounded-xl p-5 border border-white/10 space-y-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Offline</span>
          <p className="text-xs text-gray-400">
            The library catalog is kept on this device, so it browses and filters offline.
            Recently played tracks are cached automatically (up to 500 MB, LRU eviction);
            you can also download individual tracks from the library.
          </p>
          <CacheStatsPanel onClearAll={onClearCache} />
          <StorageStatusPanel />
        </div>
      </div>
    </div>
  );
};
