type AnyGl = WebGLRenderingContext | WebGL2RenderingContext;

/** Lose a GL context now instead of whenever the GC reaches its canvas. True when it was live. */
export function loseGlContext(gl: AnyGl | null | undefined): boolean {
  if (!gl) return false;
  try {
    if (gl.isContextLost()) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * Lose the GL context a module (projectM) created on `canvas`. `getContext` hands back the
 * context the canvas already has, but creates one on a canvas that has none: call this only
 * after the module attempted its own init.
 */
export function loseCanvasGlContext(canvas: HTMLCanvasElement): boolean {
  try {
    return loseGlContext(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

export interface GlContextHost {
  getCanvas(): HTMLCanvasElement;
  releaseContext(): void;
}

/**
 * A canvas keeps its context type for life, and a context lost on it cannot be re-created
 * (`getContext` returns the same lost object), so the GL context is released when its canvas is
 * retired, not on every visualizer re-init. Returns the host to keep tracking.
 *
 * `current` is the live canvas, or null when there is none. A null `current` with the old canvas
 * still attached is StrictMode's simulated unmount, which reuses that canvas: keep its context.
 */
export function retireGlHost<H extends GlContextHost>(
  host: H | null,
  current: HTMLCanvasElement | null,
): H | null {
  if (!host) return null;
  const canvas = host.getCanvas();
  if (canvas === current) return host;
  if (current === null && canvas.isConnected) return host;
  host.releaseContext();
  return null;
}
