/** Emscripten module surface for the in-app projectM host. */
import { WASM_ASSETS, loadWasmScript } from '../audio/wasmLoader';
import { loseCanvasGlContext } from '../visuals/webgl2/glContext';
import { publicUrl } from '../utils/publicUrl';
export interface ProjectMWasmModule {
  _pm_init(width: number, height: number): number;
  _pm_resize(width: number, height: number): void;
  _pm_add_pcm(ptr: number, floatCount: number, channels: number): void;
  _pm_next_preset(hardCut: number): void;
  _pm_prev_preset(hardCut: number): void;
  _pm_load_preset_data(dataPtr: number, length: number, smooth: number): number;
  _pm_set_beat_sensitivity(value: number): void;
  _pm_destroy(): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  wasmMemory?: WebAssembly.Memory;
  HEAPF32?: Float32Array;
  HEAPU8?: Uint8Array;
}

declare global {
  function createProjectMModule(opts?: {
    canvas?: HTMLCanvasElement;
    locateFile?: (path: string, prefix: string) => string;
  }): Promise<ProjectMWasmModule>;
}

/**
 * The file packager fetches `projectm-host.data` relative to the page, not the
 * script, so without this the presets 404 at the site root. Every host file
 * lives next to projectm-host.js under the public path.
 */
const locateProjectMFile = (path: string) => publicUrl(`projectm/${path}`);

export type ProjectMEngineStatus = 'idle' | 'loading' | 'ready' | 'error';

export class ProjectMEngine {
  private module: ProjectMWasmModule | null = null;
  private canvas: HTMLCanvasElement | null = null;
  /** Bumped by load() and destroy(): an older load that resumes afterwards drops what it made. */
  private loadSeq = 0;
  private status: ProjectMEngineStatus = 'idle';
  private statusListeners = new Set<(status: ProjectMEngineStatus, error?: string) => void>();
  private lastError = '';

  getStatus(): ProjectMEngineStatus {
    return this.status;
  }

  onStatusChange(listener: (status: ProjectMEngineStatus, error?: string) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status, this.lastError || undefined);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(next: ProjectMEngineStatus, error?: string) {
    this.status = next;
    if (error) this.lastError = error;
    this.statusListeners.forEach(l => l(next, error));
  }

  async load(canvas: HTMLCanvasElement): Promise<boolean> {
    if (this.status === 'ready' && this.module && this.canvas === canvas) return true;
    // A module is bound to the canvas it was created on; another canvas needs a fresh one.
    if (this.module || this.canvas) this.destroy();
    const seq = ++this.loadSeq;
    this.canvas = canvas;
    this.setStatus('loading');

    try {
      if (!window.createProjectMModule) {
        await loadWasmScript(WASM_ASSETS.projectmHost);
      }
      if (!window.createProjectMModule) {
        throw new Error('projectm-host.js did not register createProjectMModule');
      }
      if (seq !== this.loadSeq) return false;

      const module = await window.createProjectMModule({ canvas, locateFile: locateProjectMFile });
      // Superseded before _pm_init: nothing was created on the canvas, so just drop it.
      if (seq !== this.loadSeq) return false;

      this.module = module;
      const ok = module._pm_init(canvas.clientWidth || 640, canvas.clientHeight || 360);
      if (!ok) {
        throw new Error('_pm_init returned 0');
      }
      this.setStatus('ready');
      return true;
    } catch (err) {
      if (seq !== this.loadSeq) return false;
      const message = err instanceof Error ? err.message : 'projectM WASM failed to load';
      console.warn('[ProjectMEngine]', message);
      this.disposeModule();
      this.setStatus('error', message);
      return false;
    }
  }

  resize(width: number, height: number): void {
    if (!this.module || this.status !== 'ready') return;
    this.module._pm_resize(width, height);
  }

  addPCM(buffer: Float32Array, channels: number): void {
    const mod = this.module;
    if (!mod || this.status !== 'ready') return;

    const byteLength = buffer.byteLength;
    const ptr = mod._malloc(byteLength);
    if (!ptr) return;

    try {
      const memory = mod.wasmMemory?.buffer ?? mod.HEAPU8?.buffer;
      if (!memory) return;
      new Float32Array(memory, ptr, buffer.length).set(buffer);
      mod._pm_add_pcm(ptr, buffer.length, channels);
    } finally {
      mod._free(ptr);
    }
  }

  nextPreset(hardCut = false): void {
    this.module?._pm_next_preset(hardCut ? 1 : 0);
  }

  prevPreset(hardCut = false): void {
    this.module?._pm_prev_preset(hardCut ? 1 : 0);
  }

  loadPresetMilk(content: string, smooth = true): boolean {
    const mod = this.module;
    if (!mod || this.status !== 'ready') return false;

    const encoded = new TextEncoder().encode(content);
    const ptr = mod._malloc(encoded.length + 1);
    if (!ptr) return false;

    try {
      const memory = mod.wasmMemory?.buffer ?? mod.HEAPU8?.buffer;
      if (!memory) return false;
      const view = new Uint8Array(memory, ptr, encoded.length + 1);
      view.set(encoded);
      view[encoded.length] = 0;
      return mod._pm_load_preset_data(ptr, encoded.length, smooth ? 1 : 0) !== 0;
    } finally {
      mod._free(ptr);
    }
  }

  setBeatSensitivity(value: number): void {
    this.module?._pm_set_beat_sensitivity(Math.max(0, Math.min(3, value)));
  }

  /**
   * Stop the host: `_pm_destroy` (cancels the main loop, tears down SDL), then lose the GL
   * context on the canvas so a hidden canvas cannot keep presenting. Safe mid-load. Pass the
   * canvas you loaded to leave a newer owner's module alone.
   *
   * The context is only lost once the canvas has left the document: StrictMode and fast refresh
   * re-run the effect on the same canvas, and a context lost there cannot be re-created.
   */
  destroy(owner?: HTMLCanvasElement): void {
    if (owner && this.canvas !== owner) return;
    this.loadSeq += 1;
    this.disposeModule();
    this.setStatus('idle');
  }

  private disposeModule(): void {
    const { module, canvas } = this;
    this.module = null;
    this.canvas = null;
    if (!module) return;
    try {
      module._pm_destroy();
    } catch {
      // ignore teardown errors
    }
    if (canvas && !canvas.isConnected) loseCanvasGlContext(canvas);
  }
}

export const sharedProjectMEngine = new ProjectMEngine();
