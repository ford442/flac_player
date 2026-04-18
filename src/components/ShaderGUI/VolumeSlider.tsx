import React, { useRef, useCallback } from 'react';
import './ShaderGUI.css';

interface VolumeSliderProps {
  value: number;
  onChange: (value: number) => void;
}

export const VolumeSlider: React.FC<VolumeSliderProps> = ({ value, onChange }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);

  const computeValueFromMouse = useCallback((clientX: number) => {
    if (!trackRef.current) return value;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, ratio));
  }, [value]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;
    onChange(computeValueFromMouse(e.clientX));
  }, [computeValueFromMouse, onChange]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    onChange(computeValueFromMouse(e.clientX));
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [computeValueFromMouse, handleMouseMove, handleMouseUp, onChange]);

  return (
    <div className="volume-slider-container">
      <span className="volume-label">VOLUME</span>
      <div
        ref={trackRef}
        className="volume-track"
        onMouseDown={handleMouseDown}
      >
        <div
          className="volume-fill"
          style={{ width: `${value * 100}%` }}
        />
        <div
          className="volume-thumb"
          style={{ left: `${value * 100}%` }}
        />
      </div>
      <span style={{ fontSize: 10, color: '#6B7280' }}>{Math.round(value * 100)}%</span>
    </div>
  );
};

export default VolumeSlider;
