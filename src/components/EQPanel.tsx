import React from 'react';
import { DEFAULT_EQ_BANDS } from '../audio/EQChain';
import type { GaplessMode } from '../types/gapless';
import { MAX_CROSSFADE_MS, MIN_CROSSFADE_MS } from '../types/gapless';
import type { ReplayGainMode } from '../utils/replayGain';
import type { LatencyMode } from '../audio/sampleRatePolicy';
import type { AudioOutputInfo } from '../audio/AudioContextManager';
import type { OutputDeviceOption } from '../hooks/useAudioOutputInfo';

/** Output sink picker + read-only graph latency, composed in Player.tsx. */
export interface AudioOutputControls {
  /** '' = system default. */
  deviceId: string;
  deviceLabel: string;
  /** `AudioContext.setSinkId` exists. */
  sinkSupported: boolean;
  /** `navigator.mediaDevices.selectAudioOutput` exists. */
  pickerSupported: boolean;
  devices: OutputDeviceOption[];
  onSelectOutputDevice: (deviceId?: string, label?: string) => Promise<void>;
  info: AudioOutputInfo | null;
  /** SDL owns the device; the Web Audio sink does not apply. */
  externalPlayback: boolean;
}

function formatMs(seconds: number | null): string {
  return seconds === null ? '—' : `${(seconds * 1000).toFixed(1)} ms`;
}

interface EQPanelProps {
  eqGains: number[];
  onBandChange: (index: number, gainDb: number) => void;
  onReset: () => void;
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
  gaplessMode: GaplessMode;
  onGaplessModeChange: (mode: GaplessMode) => void;
  crossfadeMs: number;
  onCrossfadeMsChange: (ms: number) => void;
  replayGainMode: ReplayGainMode;
  onReplayGainModeChange: (mode: ReplayGainMode) => void;
  replayGainLimiter: boolean;
  onReplayGainLimiterChange: (enabled: boolean) => void;
  latencyMode: LatencyMode;
  onLatencyModeChange: (mode: LatencyMode) => void;
  audioOutput?: AudioOutputControls;
  /** @deprecated kept for callers still passing the legacy toggle */
  crossfadeEnabled?: boolean;
  onCrossfadeChange?: (enabled: boolean) => void;
}

const SPEED_PRESETS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

const GAPLESS_OPTIONS: { mode: GaplessMode; label: string; hint: string }[] = [
  { mode: 'gapless', label: 'Gapless', hint: 'Sample-accurate handoff between tracks' },
  { mode: 'crossfade', label: 'Crossfade', hint: 'Overlap and fade between tracks' },
  { mode: 'off', label: 'Off', hint: 'Stop at track end, then load next' },
];

const REPLAYGAIN_OPTIONS: { mode: ReplayGainMode; label: string; hint: string }[] = [
  { mode: 'off', label: 'Off', hint: 'Play files at their original level' },
  { mode: 'track', label: 'Track', hint: 'Normalize each track to reference loudness' },
  { mode: 'album', label: 'Album', hint: 'Use album gain from the first queued track' },
];

const LATENCY_OPTIONS: { mode: LatencyMode; label: string; hint: string }[] = [
  { mode: 'playback', label: 'Playback', hint: 'Higher buffering — library listening and streaming' },
  { mode: 'interactive', label: 'Interactive', hint: 'Lower latency — scrubbing, worklet, projectM' },
  { mode: 'balanced', label: 'Balanced', hint: 'Numeric hint (~30 ms) when the browser supports it' },
];

export const EQPanel: React.FC<EQPanelProps> = ({
  eqGains,
  onBandChange,
  onReset,
  playbackRate,
  onPlaybackRateChange,
  gaplessMode,
  onGaplessModeChange,
  crossfadeMs,
  onCrossfadeMsChange,
  replayGainMode,
  onReplayGainModeChange,
  replayGainLimiter,
  onReplayGainLimiterChange,
  latencyMode,
  onLatencyModeChange,
  audioOutput,
}) => {
  return (
    <div className="eq-panel space-y-4 text-sm text-white">
      {/* EQ Section */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Equalizer
          </span>
          <button
            onClick={onReset}
            className="text-xs text-purple-400 hover:text-purple-200 transition-colors"
            title="Reset all bands to 0 dB"
          >
            Reset
          </button>
        </div>

        <div className="flex gap-3 items-end justify-between">
          {DEFAULT_EQ_BANDS.map((band, i) => {
            const gain = eqGains[i] ?? 0;
            return (
              <div key={band.label} className="flex flex-col items-center gap-1 flex-1">
                <div className="relative flex flex-col items-center" style={{ height: 100 }}>
                  <input
                    type="range"
                    min={-12}
                    max={12}
                    step={0.5}
                    value={gain}
                    onChange={(e) => onBandChange(i, parseFloat(e.target.value))}
                    className="eq-slider"
                    style={{
                      writingMode: 'vertical-lr',
                      direction: 'rtl',
                      WebkitAppearance: 'slider-vertical',
                      width: 24,
                      height: 100,
                      cursor: 'pointer',
                      accentColor: gain >= 0 ? '#a78bfa' : '#f87171',
                    }}
                    title={`${band.label}: ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`}
                    aria-label={`${band.label} EQ band`}
                  />
                </div>
                <span
                  className="text-xs text-gray-400 text-center w-full truncate"
                  title={`${band.frequency >= 1000 ? (band.frequency / 1000) + 'k' : band.frequency} Hz`}
                >
                  {band.label}
                </span>
                <span className={`text-xs font-mono ${gain > 0 ? 'text-purple-300' : gain < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                  {gain >= 0 ? '+' : ''}{gain.toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Playback Speed */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Speed
          </span>
          <span className="text-xs font-mono text-purple-300">{playbackRate.toFixed(2)}×</span>
        </div>

        <input
          type="range"
          min={0.25}
          max={2.5}
          step={0.05}
          value={playbackRate}
          onChange={(e) => onPlaybackRateChange(parseFloat(e.target.value))}
          className="w-full"
          style={{ accentColor: '#a78bfa' }}
          aria-label="Playback speed"
        />

        <div className="flex gap-1 mt-1 flex-wrap">
          {SPEED_PRESETS.map(speed => (
            <button
              key={speed}
              onClick={() => onPlaybackRateChange(speed)}
              className={`px-2 py-0.5 rounded text-xs transition-colors ${
                Math.abs(playbackRate - speed) < 0.01
                  ? 'bg-purple-600 text-white'
                  : 'bg-white/10 text-gray-400 hover:bg-white/20 hover:text-white'
              }`}
            >
              {speed}×
            </button>
          ))}
        </div>
      </div>

      {/* ReplayGain / Loudness */}
      <div>
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Loudness (ReplayGain)
        </span>
        <div className="flex gap-1 mt-2 flex-wrap">
          {REPLAYGAIN_OPTIONS.map(({ mode, label, hint }) => (
            <button
              key={mode}
              onClick={() => onReplayGainModeChange(mode)}
              className={`px-2 py-1 rounded text-xs transition-colors ${
                replayGainMode === mode
                  ? 'bg-purple-600 text-white'
                  : 'bg-white/10 text-gray-400 hover:bg-white/20 hover:text-white'
              }`}
              title={hint}
            >
              {label}
            </button>
          ))}
        </div>
        {replayGainMode !== 'off' && (
          <label className="flex items-center gap-2 mt-3 text-xs text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={replayGainLimiter}
              onChange={(e) => onReplayGainLimiterChange(e.target.checked)}
              className="accent-purple-500"
            />
            Prevent clipping (peak-aware limiter)
          </label>
        )}
        <p className="text-xs text-gray-500 mt-2">
          Applies before the master volume fader. Gain is clamped to ±12 dB.
          SDL3 applies EQ and gain in WASM on the speaker path; crossfade overlap may briefly mismatch levels.
        </p>
      </div>

      {/* AudioContext latency */}
      <div>
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Output latency
        </span>
        <div className="flex gap-1 mt-2 flex-wrap">
          {LATENCY_OPTIONS.map(({ mode, label, hint }) => (
            <button
              key={mode}
              onClick={() => onLatencyModeChange(mode)}
              className={`px-2 py-1 rounded text-xs transition-colors ${
                latencyMode === mode
                  ? 'bg-purple-600 text-white'
                  : 'bg-white/10 text-gray-400 hover:bg-white/20 hover:text-white'
              }`}
              title={hint}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Recreates the shared AudioContext. Same-rate albums stay gapless; a rate or latency
          change may produce a brief audible gap.
        </p>
        {audioOutput && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 mt-3 text-xs">
            <dt className="text-gray-500">Context rate</dt>
            <dd className="font-mono text-purple-300">
              {audioOutput.info ? `${audioOutput.info.sampleRate} Hz` : 'not open'}
            </dd>
            <dt className="text-gray-500">Base latency</dt>
            <dd className="font-mono text-purple-300">{formatMs(audioOutput.info?.baseLatency ?? null)}</dd>
            <dt className="text-gray-500">Output latency</dt>
            <dd className="font-mono text-purple-300">{formatMs(audioOutput.info?.outputLatency ?? null)}</dd>
            <dt className="text-gray-500">Channels</dt>
            <dd className="font-mono text-purple-300">{audioOutput.info?.channelCount ?? '—'}</dd>
          </dl>
        )}
      </div>

      {audioOutput && (
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Output device
          </span>
          {audioOutput.sinkSupported ? (
            <div className="flex gap-1 mt-2 flex-wrap items-center">
              {audioOutput.devices.length > 0 && (
                <select
                  value={audioOutput.deviceId}
                  onChange={(e) => {
                    const option = audioOutput.devices.find((d) => d.deviceId === e.target.value);
                    void audioOutput.onSelectOutputDevice(e.target.value, option?.label);
                  }}
                  className="flex-1 min-w-0 px-2 py-1 bg-white/10 border border-white/20 rounded text-xs text-white"
                >
                  <option value="">System default</option>
                  {audioOutput.devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                  ))}
                  {audioOutput.deviceId && !audioOutput.devices.some((d) => d.deviceId === audioOutput.deviceId) && (
                    <option value={audioOutput.deviceId}>{audioOutput.deviceLabel || 'Selected device'}</option>
                  )}
                </select>
              )}
              {audioOutput.pickerSupported && (
                <button
                  onClick={() => void audioOutput.onSelectOutputDevice()}
                  className="px-2 py-1 rounded text-xs bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white"
                >
                  Choose…
                </button>
              )}
              {audioOutput.devices.length === 0 && (
                <>
                  <span className="text-xs text-gray-300 truncate">
                    {audioOutput.deviceId ? audioOutput.deviceLabel || 'Selected device' : 'System default'}
                  </span>
                  {audioOutput.deviceId && (
                    <button
                      onClick={() => void audioOutput.onSelectOutputDevice('')}
                      className="px-2 py-1 rounded text-xs bg-white/10 text-gray-400 hover:bg-white/20 hover:text-white"
                    >
                      Reset
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-500 mt-2">
              This browser cannot route Web Audio to another device; the system default is used.
            </p>
          )}
          {audioOutput.externalPlayback && (
            <p className="text-xs text-gray-500 mt-2">
              SDL3 opens its own device; this choice applies to streaming, Web Audio, and worklet.
            </p>
          )}
        </div>
      )}

      {/* Gapless / Crossfade */}
      <div>
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          Queue transitions
        </span>
        <div className="flex gap-1 mt-2 flex-wrap">
          {GAPLESS_OPTIONS.map(({ mode, label, hint }) => (
            <button
              key={mode}
              onClick={() => onGaplessModeChange(mode)}
              className={`px-2 py-1 rounded text-xs transition-colors ${
                gaplessMode === mode
                  ? 'bg-purple-600 text-white'
                  : 'bg-white/10 text-gray-400 hover:bg-white/20 hover:text-white'
              }`}
              title={hint}
            >
              {label}
            </button>
          ))}
        </div>
        {gaplessMode === 'crossfade' && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-400">Fade duration</span>
              <span className="text-xs font-mono text-purple-300">{(crossfadeMs / 1000).toFixed(1)}s</span>
            </div>
            <input
              type="range"
              min={MIN_CROSSFADE_MS}
              max={MAX_CROSSFADE_MS}
              step={250}
              value={crossfadeMs}
              onChange={(e) => onCrossfadeMsChange(parseInt(e.target.value, 10))}
              className="w-full"
              style={{ accentColor: '#a78bfa' }}
              aria-label="Crossfade duration in milliseconds"
            />
          </div>
        )}
        <p className="text-xs text-gray-500 mt-2">
          {gaplessMode === 'gapless'
            ? 'Pre-buffers the next track for seamless playback on streaming and buffered backends.'
            : gaplessMode === 'crossfade'
              ? 'Crossfade works on native streaming; buffered backends use gapless handoff when overlap is minimal.'
              : 'Tracks stop at the end before the next loads.'}
        </p>
      </div>
    </div>
  );
};

export default EQPanel;
