import { useRef, useState, useCallback } from 'react';
import { sliderKeyValue } from '../utils/sliderKeys';

const DRAG_SENSITIVITY = 0.005; // value per pixel of vertical drag
const RESET_VALUE = 0.5;

export interface KnobState {
  value: number;
  /** Latest value without waiting for a render (render loops read this). */
  valueRef: React.MutableRefObject<number>;
  isDragging: boolean;
  /** Spread onto the element with role="slider". */
  bind: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
    onDoubleClick: () => void;
  };
}

/**
 * A 0–1 rotary control: vertical pointer drag, arrow / Page / Home / End keys,
 * double-click to centre. `onChange` fires on every change, drags included.
 */
export function useKnob(initialValue = 0.5, onChange?: (value: number) => void): KnobState {
  const valueRef = useRef(initialValue);
  const [value, setValueState] = useState(initialValue);
  const [isDragging, setIsDragging] = useState(false);
  const drag = useRef<{ startY: number; startValue: number } | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setValue = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(1, next));
    if (clamped === valueRef.current) return;
    valueRef.current = clamped;
    setValueState(clamped);
    onChangeRef.current?.(clamped);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { startY: e.clientY, startValue: valueRef.current };
    setIsDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    setValue(drag.current.startValue + (drag.current.startY - e.clientY) * DRAG_SENSITIVITY);
  }, [setValue]);

  const endDrag = useCallback(() => {
    drag.current = null;
    setIsDragging(false);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    const next = sliderKeyValue(e.key, valueRef.current, { step: 0.01, page: 0.1 });
    if (next === null) return;
    e.preventDefault();
    setValue(next);
  }, [setValue]);

  const onDoubleClick = useCallback(() => setValue(RESET_VALUE), [setValue]);

  return {
    value,
    valueRef,
    isDragging,
    bind: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onKeyDown, onDoubleClick },
  };
}

export default useKnob;
