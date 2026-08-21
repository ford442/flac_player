import { debug } from '../utils/debug';
import type { GpuChoreBreadcrumb } from './types';

const HISTORY_LIMIT = 16;
const history: GpuChoreBreadcrumb[] = [];
const listeners = new Set<(crumb: GpuChoreBreadcrumb) => void>();

export interface GpuChoreTelemetry {
  last: GpuChoreBreadcrumb | null;
  history: GpuChoreBreadcrumb[];
}

declare global {
  interface Window {
    __gpuChores?: GpuChoreTelemetry;
  }
}

function publish(): void {
  if (typeof window === 'undefined') return;
  window.__gpuChores = {
    last: history[history.length - 1] ?? null,
    history: history.slice(),
  };
}

export function recordGpuChoreBreadcrumb(crumb: GpuChoreBreadcrumb): GpuChoreBreadcrumb {
  history.push(crumb);
  if (history.length > HISTORY_LIMIT) history.shift();
  publish();
  debug.log('gpu-chores', crumb);
  listeners.forEach((fn) => {
    try { fn(crumb); } catch { /* ignore subscriber errors */ }
  });
  return crumb;
}

export function getLastGpuChoreBreadcrumb(): GpuChoreBreadcrumb | null {
  return history[history.length - 1] ?? null;
}

export function getGpuChoreHistory(): GpuChoreBreadcrumb[] {
  return history.slice();
}

export function clearGpuChoreBreadcrumbs(): void {
  history.length = 0;
  publish();
}

export function subscribeGpuChoreBreadcrumbs(
  onChange: (crumb: GpuChoreBreadcrumb) => void,
): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}
