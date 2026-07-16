/** Emscripten module surface for the in-app projectM host. */
import { WASM_ASSETS, loadWasmScript } from '../audio/wasmLoader';
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
  function createProjectMModule(opts?: { canvas?: HTMLCanvasElement }): Promise<ProjectMWasmModule>;
}

export type ProjectMEngineStatus = 'idle' | 'loading' | 'ready' | 'error';

export class ProjectMEngine {
  private module: ProjectMWasmModule | null = null;
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
    if (this.status === 'ready' && this.module) return true;
    this.setStatus('loading');

    try {
      if (!window.createProjectMModule) {
        await loadWasmScript(WASM_ASSETS.projectmHost);
      }
      if (!window.createProjectMModule) {
        throw new Error('projectm-host.js did not register createProjectMModule');
      }

      this.module = await window.createProjectMModule({ canvas });
      const ok = this.module._pm_init(canvas.clientWidth || 640, canvas.clientHeight || 360);
      if (!ok) {
        throw new Error('_pm_init returned 0');
      }
      this.setStatus('ready');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'projectM WASM failed to load';
      console.warn('[ProjectMEngine]', message);
      this.setStatus('error', message);
      this.module = null;
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

  destroy(): void {
    if (this.module) {
      try {
        this.module._pm_destroy();
      } catch {
        // ignore teardown errors
      }
      this.module = null;
    }
    this.setStatus('idle');
  }
}

export const sharedProjectMEngine = new ProjectMEngine();
