import { useState, useCallback } from 'react';
import type React from 'react';

/** HTML5 drag-and-drop row reordering (same pattern as QueuePanel) for lists that call `onMove(from, to)`. */
export function useDragReorder(onMove: (from: number, to: number) => void) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const reset = useCallback(() => { setDragIndex(null); setOverIndex(null); }, []);

  const rowProps = useCallback((index: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      setDragIndex(index);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOverIndex(index);
    },
    onDragLeave: () => setOverIndex(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const from = dragIndex ?? parseInt(e.dataTransfer.getData('text/plain'), 10);
      if (!Number.isNaN(from) && from !== index) onMove(from, index);
      reset();
    },
    onDragEnd: reset,
  }), [dragIndex, onMove, reset]);

  return { dragIndex, overIndex, rowProps };
}
