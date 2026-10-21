import React, { useState } from 'react';
import { useKnob } from '../../hooks/useKnob';
import './ShaderGUI.layout.css';
import './ShaderGUI.overlays.css';

interface KnobProps {
  label: string;
  initialValue?: number;
  /** Fires on every change (drag, keys, double-click reset). */
  onChange?: (value: number) => void;
}

export const Knob: React.FC<KnobProps> = ({ label, initialValue = 0.5, onChange }) => {
  const { value, isDragging, bind } = useKnob(initialValue, onChange);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const percent = Math.round(value * 100);

  // Convert 0-1 to angle: 0 -> -135deg, 0.5 -> 0deg, 1 -> 135deg
  const angle = (value - 0.5) * 270;

  return (
    <div
      className="knob-container"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {(isHovered || isFocused || isDragging) && (
        <div className="knob-tooltip" aria-hidden="true">{percent}</div>
      )}
      <div
        className="knob-body"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        {...bind}
      >
        <div className="knob-glow" style={{ opacity: value * 0.6 + 0.2 }} />
        <div
          className="knob-indicator"
          style={{ transform: `translate(-50%, 0) rotate(${angle}deg)` }}
        />
      </div>
      <span className="knob-label" aria-hidden="true">{label}</span>
    </div>
  );
};

export default Knob;
