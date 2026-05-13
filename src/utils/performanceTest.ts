// src/utils/performanceTest.ts
// Lightweight performance profiling helpers for the FLAC player.

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface PerformanceSnapshot {
  memory?: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
  timing: {
    decodeTimeMs: number;
    renderTimeMs: number;
    domNodes: number;
  };
}

export class PerformanceProfiler {
  private marks = new Map<string, number>();
  private snapshots: PerformanceSnapshot[] = [];

  /** Start a timed mark. */
  mark(label: string): void {
    this.marks.set(label, performance.now());
  }

  /** End a timed mark and return duration in ms. */
  measure(label: string): number {
    const start = this.marks.get(label);
    if (start === undefined) {
      console.warn(`[PerformanceProfiler] No mark found for "${label}"`);
      return 0;
    }
    const duration = performance.now() - start;
    this.marks.delete(label);
    return duration;
  }

  /** Capture a snapshot of current performance metrics. */
  capture(decodeTimeMs = 0, renderTimeMs = 0): PerformanceSnapshot {
    const memory = (performance as unknown as { memory?: PerformanceMemory }).memory;
    const snapshot: PerformanceSnapshot = {
      memory: memory
        ? {
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
            jsHeapSizeLimit: memory.jsHeapSizeLimit,
          }
        : undefined,
      timing: {
        decodeTimeMs,
        renderTimeMs,
        domNodes: document.querySelectorAll('*').length,
      },
    };
    this.snapshots.push(snapshot);
    return snapshot;
  }

  /** Get all captured snapshots. */
  getSnapshots(): PerformanceSnapshot[] {
    return this.snapshots;
  }

  /** Log a summary of the last N snapshots. */
  logSummary(lastN = 5): void {
    const recent = this.snapshots.slice(-lastN);
    if (recent.length === 0) {
      console.log('[PerformanceProfiler] No snapshots captured yet.');
      return;
    }
    const avgDecode = recent.reduce((s, r) => s + r.timing.decodeTimeMs, 0) / recent.length;
    const avgRender = recent.reduce((s, r) => s + r.timing.renderTimeMs, 0) / recent.length;
    console.log(
      `[PerformanceProfiler] Last ${recent.length} snapshots — ` +
      `Avg decode: ${avgDecode.toFixed(2)}ms, ` +
      `Avg render: ${avgRender.toFixed(2)}ms, ` +
      `DOM nodes: ${recent[recent.length - 1].timing.domNodes}`
    );
  }

  /** Clear all snapshots and marks. */
  reset(): void {
    this.marks.clear();
    this.snapshots = [];
  }
}

/** Singleton profiler instance for app-wide use. */
export const profiler = new PerformanceProfiler();

/** Simple FPS counter. */
export class FPSCounter {
  private frames = 0;
  private lastTime = performance.now();
  private callback: (fps: number) => void;

  constructor(callback: (fps: number) => void) {
    this.callback = callback;
  }

  tick(): void {
    this.frames++;
    const now = performance.now();
    if (now - this.lastTime >= 1000) {
      const fps = Math.round((this.frames * 1000) / (now - this.lastTime));
      this.callback(fps);
      this.frames = 0;
      this.lastTime = now;
    }
  }

  reset(): void {
    this.frames = 0;
    this.lastTime = performance.now();
  }
}
