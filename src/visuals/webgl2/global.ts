import type { CurrentVisualizer } from '../types';

export function setCurrentVisualizer(handle: CurrentVisualizer | null): void {
  if (typeof window !== 'undefined') {
    window.currentVisualizer = handle;
  }
}
