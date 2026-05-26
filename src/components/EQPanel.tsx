import React from 'react';
import { DEFAULT_EQ_BANDS } from '../audio/EQChain';

interface EQPanelProps {
  eqGains: number[];
  onBandChange: (index: number, gainDb: number) => void;
  onReset: () => void;
  playbackRate: number;
  onPlaybackRateChange: (rate: number) => void;
  crossfadeEnabled: boolean;
  onCrossfadeChange: (enabled: boolean) => void;
}

const SPEED_PRESETS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

export const EQPanel: React.FC<EQPanelProps> = ({
  eqGains,
  onBandChange,
  onReset,
  playbackRate,
  onPlaybackRateChange,
  crossfadeEnabled,
  onCrossfadeChange,
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
                {/* Vertical slider */}
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

      {/* Crossfade Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Crossfade / Gapless
          </span>
          <p className="text-xs text-gray-500 mt-0.5">Smoothly fade between tracks (streaming mode)</p>
        </div>
        <button
          role="switch"
          aria-checked={crossfadeEnabled}
          onClick={() => onCrossfadeChange(!crossfadeEnabled)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            crossfadeEnabled ? 'bg-purple-600' : 'bg-white/20'
          }`}
          title={crossfadeEnabled ? 'Crossfade on' : 'Crossfade off'}
        >
          <span
            className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
              crossfadeEnabled ? 'translate-x-5' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
    </div>
  );
};

export default EQPanel;
