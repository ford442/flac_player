import React, { useRef, useCallback } from 'react';
import './ShaderGUI.css';

interface VolumeSliderProps {
  value: number;
  onChange: (value: number) => void;
}

const TICK_COUNT = 11;

export const VolumeSlider: React.FC<VolumeSliderProps> = ({ value, onChange }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const computeValueFromMouse = useCallback((clientY: number) => {
    if (!trackRef.current) return value;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = (rect.bottom - clientY) / rect.height;
    return Math.max(0, Math.min(1, ratio));
  }, [value]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;
    onChange(computeValueFromMouse(e.clientY));
  }, [computeValueFromMouse, onChange]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    onChange(computeValueFromMouse(e.clientY));
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [computeValueFromMouse, handleMouseMove, handleMouseUp, onChange]);

  return (
    <div className="volume-slider-container">
      <span className="volume-label">VOLUME</span>
      <div className="volume-slider-track-wrapper">
        <div
          ref={trackRef}
          className="volume-track-vertical"
          onMouseDown={handleMouseDown}
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
        <div className="volume-ticks">
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
      <span className="volume-value">{Math.round(value * 100)}%</span>
    </div>
  );
};

export default VolumeSlider;
