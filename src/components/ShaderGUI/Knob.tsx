import React, { useState } from 'react';
import { useKnob } from '../../hooks/useKnob';
import './ShaderGUI.css';

interface KnobProps {
  label: string;
  initialValue?: number;
  onChange?: (value: number) => void;
}

export const Knob: React.FC<KnobProps> = ({ label, initialValue = 0.5, onChange }) => {
  const { valueRef, bindDrag, isDragging, tooltipValue } = useKnob(initialValue);
  const [isHovered, setIsHovered] = useState(false);

  // Convert 0-1 to angle: 0 -> -135deg, 0.5 -> 0deg, 1 -> 135deg
  const angle = (tooltipValue - 0.5) * 270;

  const handleMouseDown = (e: React.MouseEvent) => {
    bindDrag.onMouseDown(e);
  };

  const handleDoubleClick = () => {
    bindDrag.onDoubleClick();
    onChange?.(0.5);
  };

  // Notify parent of value changes during drag via a ref callback
  React.useEffect(() => {
    if (!isDragging) {
      onChange?.(valueRef.current);
    }
  }, [isDragging, onChange, valueRef]);

  return (
    <div
      className="knob-container"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {(isHovered || isDragging) && (
        <div className="knob-tooltip">{Math.round(tooltipValue * 100)}</div>
      )}
      <div
        className="knob-body"
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      >
        <div className="knob-glow" style={{ opacity: tooltipValue * 0.6 + 0.2 }} />
        <div
          className="knob-indicator"
          style={{ transform: `translate(-50%, 0) rotate(${angle}deg)` }}
        />
      </div>
      <span className="knob-label">{label}</span>
    </div>
  );
};

export default Knob;
