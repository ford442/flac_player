import React, { useRef } from 'react';
import { sliderKeyValue } from '../../utils/sliderKeys';
import './ShaderGUI.layout.css';

interface VolumeSliderProps {
  value: number;
  onChange: (value: number) => void;
}

const TICK_COUNT = 11;

export const VolumeSlider: React.FC<VolumeSliderProps> = ({ value, onChange }) => {
  const isDragging = useRef(false);
  const percent = Math.round(value * 100);

  const valueAt = (track: HTMLElement, clientY: number) => {
    const rect = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (rect.bottom - clientY) / rect.height));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    isDragging.current = true;
    onChange(valueAt(e.currentTarget, e.clientY));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging.current) onChange(valueAt(e.currentTarget, e.clientY));
  };

  const endDrag = () => { isDragging.current = false; };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next = sliderKeyValue(e.key, value, { step: 0.05, page: 0.2 });
    if (next === null) return;
    e.preventDefault();
    onChange(next);
  };

  return (
    <div className="volume-slider-container">
      <span className="volume-label" aria-hidden="true">VOLUME</span>
      <div className="volume-slider-track-wrapper">
        <div
          className="volume-track-vertical"
          role="slider"
          tabIndex={0}
          aria-label="Volume"
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent}%`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={handleKeyDown}
        >
          <div
            className="volume-fill-vertical"
            style={{ height: `${value * 100}%` }}
          />
          <div
            className="volume-thumb-vertical"
            style={{ bottom: `${value * 100}%` }}
          />
        </div>
        <div className="volume-ticks" aria-hidden="true">
          {Array.from({ length: TICK_COUNT }).map((_, i) => (
            <div
              key={i}
              className="volume-tick"
              style={{
                opacity: i / (TICK_COUNT - 1) <= value ? 1 : 0.3,
              }}
            />
          ))}
        </div>
      </div>
      <span className="volume-value" aria-hidden="true">{percent}%</span>
    </div>
  );
};

export default VolumeSlider;
