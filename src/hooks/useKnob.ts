import { useRef, useState, useCallback, useEffect } from 'react';

export interface KnobState {
  valueRef: React.MutableRefObject<number>;
  bindDrag: {
    onMouseDown: (e: React.MouseEvent) => void;
    onDoubleClick: () => void;
  };
  isDragging: boolean;
  tooltipValue: number;
}

export function useKnob(initialValue = 0.5): KnobState {
  const valueRef = useRef(initialValue);
  const [isDragging, setIsDragging] = useState(false);
  const [tooltipValue, setTooltipValue] = useState(initialValue);
  const dragStartY = useRef(0);
  const dragStartValue = useRef(initialValue);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const deltaY = dragStartY.current - e.clientY;
    const sensitivity = 0.005;
    let newValue = dragStartValue.current + deltaY * sensitivity;
    newValue = Math.max(0, Math.min(1, newValue));
    valueRef.current = newValue;
    setTooltipValue(newValue);
  }, []);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    window.removeEventListener('mousemove', handleMouseMove);
    window.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartY.current = e.clientY;
    dragStartValue.current = valueRef.current;
    setIsDragging(true);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove, handleMouseUp]);

  const handleDoubleClick = useCallback(() => {
    valueRef.current = 0.5;
    setTooltipValue(0.5);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return {
    valueRef,
    bindDrag: {
      onMouseDown: handleMouseDown,
      onDoubleClick: handleDoubleClick,
    },
    isDragging,
    tooltipValue,
  };
}

export default useKnob;
