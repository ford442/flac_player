/** Emscripten module surface for the in-app projectM host. */
import { WASM_ASSETS, loadWasmScript } from '../audio/wasmLoader';
import {
  PresetFetcher,
  PresetPlaylist,
  fetchPresetManifest,
  presetDisplayName,
  readPresetFromSearch,
  type PresetManifest,
} from './presetLibrary';

export interface ProjectMWasmModule {
  _pm_init(width: number, height: number): number;
  _pm_resize(width: number, height: number): void;
  _pm_add_pcm(ptr: number, floatCount: number, channels: number): void;
  _pm_load_preset_data(dataPtr: number, length: number, smooth: number): number;
  _pm_set_preset_locked(locked: number): void;
  _pm_set_beat_sensitivity(value: number): void;
  _pm_set_paused(paused: number): void;
  _pm_destroy(): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  wasmMemory?: WebAssembly.Memory;
  HEAPF32?: Float32Array;
  HEAPU8?: Uint8Array;
  /** Called by the host when projectM's preset timer / hard cut wants a new preset. */
  onPresetSwitchRequested?: (hardCut: boolean) => void;
}

declare global {
  function createProjectMModule(opts?: { canvas?: HTMLCanvasElement }): Promise<ProjectMWasmModule>;
}

export type ProjectMEngineStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ProjectMPresetState {
  /** 'unavailable' = the manifest could not be loaded; .milk files can still be opened. */
  library: 'idle' | 'loading' | 'ready' | 'unavailable';
  /** Pack path of the preset on screen, or null for the idle preset / a local file. */
  current: string | null;
  name: string;
  locked: boolean;
  count: number;
  error?: string;
}

export interface ProjectMEngineOptions {
  /** Instantiate the WASM module on `canvas` (tests inject a fake). */
  loadModule?: (canvas: HTMLCanvasElement) => Promise<ProjectMWasmModule>;
  loadManifest?: () => Promise<PresetManifest>;
  fetchImpl?: typeof fetch;
  createCanvas?: () => HTMLCanvasElement;
  random?: () => number;
  /** `?preset=` value to open first (default: read from location.search). */
  initialPreset?: () => string | null;
}

/** Milkdrop is fill-rate bound; past 2× the extra pixels cost more than they show. */
const MAX_DEVICE_PIXEL_RATIO = 2;
/** Consecutive presets tried before giving up on a next / random / auto switch. */
const MAX_PRESET_ATTEMPTS = 5;

async function loadProjectMModule(canvas: HTMLCanvasElement): Promise<ProjectMWasmModule> {
  if (!window.createProjectMModule) {
    await loadWasmScript(WASM_ASSETS.projectmHost);
  }
  if (!window.createProjectMModule) {
    throw new Error('projectm-host.js did not register createProjectMModule');
  }
  return window.createProjectMModule({ canvas });
}

function defaultCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'projectm-host__canvas';
  canvas.setAttribute('aria-label', 'projectM Milkdrop visualizer');
  return canvas;
}

/** Drawing-buffer size for a CSS box: CSS px × DPR, DPR capped at 2. */
export function projectMBufferSize(cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number } {
  const scale = Math.min(Math.max(dpr || 1, 1), MAX_DEVICE_PIXEL_RATIO);
  return {
    width: Math.max(1, Math.round(cssWidth * scale)),
    height: Math.max(1, Math.round(cssHeight * scale)),
  };
}

/**
 * Owns the single projectM WASM instance, its canvas and its Emscripten main
 * loop. The canvas (and with it the WebGL2 context) lives as long as the
 * engine: ProjectMHost mounts {@link attach} it into its container, so moving
 * between the projectM and split layouts re-parents the same canvas instead of
 * leaving the main loop drawing into a detached one. With no host attached the
 * main loop is paused.
 */
export class ProjectMEngine {
  private module: ProjectMWasmModule | null = null;
  private status: ProjectMEngineStatus = 'idle';
  private statusListeners = new Set<(status: ProjectMEngineStatus, error?: string) => void>();
  private lastError = '';
  private loadPromise: Promise<boolean> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private attachments = 0;
  private paused = false;
  private pcmPtr = 0;
  private pcmCapacity = 0;
  private presetState: ProjectMPresetState = { library: 'idle', current: null, name: '', locked: false, count: 0 };
  private presetListeners = new Set<(state: ProjectMPresetState) => void>();
  private playlist: PresetPlaylist | null = null;
  private fetcher: PresetFetcher | null = null;
  private presetRequest = 0;
  private readonly options: Required<ProjectMEngineOptions>;

  constructor(options: ProjectMEngineOptions = {}) {
    this.options = {
      loadModule: options.loadModule ?? loadProjectMModule,
      loadManifest: options.loadManifest ?? (() => fetchPresetManifest(options.fetchImpl)),
      fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
      createCanvas: options.createCanvas ?? defaultCanvas,
      random: options.random ?? Math.random,
      initialPreset: options.initialPreset ?? (() => readPresetFromSearch()),
    };
  }

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

  /** The engine's canvas, created on first use. */
  getCanvas(): HTMLCanvasElement {
    this.canvas ??= this.options.createCanvas();
    return this.canvas;
  }

  /**
   * Move the canvas into `container` and run the main loop. Returns the detach
   * function; the loop pauses once no container holds the canvas.
   */
  attach(container: HTMLElement): () => void {
    const canvas = this.getCanvas();
    if (canvas.parentNode !== container) container.appendChild(canvas);
    this.attachments += 1;
    this.setPaused(false);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.attachments -= 1;
      if (canvas.parentNode === container) container.removeChild(canvas);
      if (this.attachments === 0) this.setPaused(true);
    };
  }

  private setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (this.module && this.status === 'ready') this.module._pm_set_paused(paused ? 1 : 0);
  }

  /** Instantiate the module once; concurrent and later calls share the result. */
  load(): Promise<boolean> {
    if (this.status === 'ready' && this.module) return Promise.resolve(true);
    this.loadPromise ??= this.instantiate();
    return this.loadPromise;
  }

  private async instantiate(): Promise<boolean> {
    this.setStatus('loading');
    const canvas = this.getCanvas();
    try {
      const mod = await this.options.loadModule(canvas);
      const { width, height } = this.measure(canvas);
      canvas.width = width;
      canvas.height = height;
      if (!mod._pm_init(width, height)) {
        throw new Error('_pm_init returned 0');
      }
      mod.onPresetSwitchRequested = () => {
        // Called from inside projectM's render; never re-enter it synchronously.
        setTimeout(() => {
          if (!this.presetState.locked) void this.randomPreset();
        }, 0);
      };
      this.module = mod;
      if (this.paused) mod._pm_set_paused(1);
      this.setStatus('ready');
      void this.initPresets();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'projectM WASM failed to load';
      console.warn('[ProjectMEngine]', message);
      this.module = null;
      this.loadPromise = null;
      this.setStatus('error', message);
      return false;
    }
  }

  private measure(canvas: HTMLCanvasElement): { width: number; height: number } {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    return projectMBufferSize(canvas.clientWidth || 640, canvas.clientHeight || 360, dpr);
  }

  /** Size the drawing buffer for a CSS box (the host's ResizeObserver). */
  resize(cssWidth: number, cssHeight: number, dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1): void {
    if (!this.module || this.status !== 'ready' || cssWidth <= 0 || cssHeight <= 0) return;
    const canvas = this.getCanvas();
    const { width, height } = projectMBufferSize(cssWidth, cssHeight, dpr);
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    this.module._pm_resize(width, height);
  }

  private heap(mod: ProjectMWasmModule): ArrayBuffer | null {
    return (mod.wasmMemory?.buffer ?? mod.HEAPU8?.buffer ?? null) as ArrayBuffer | null;
  }

  /** Feed interleaved PCM through one persistent staging allocation (grown, never per block). */
  addPCM(buffer: Float32Array, channels: number): void {
    const mod = this.module;
    if (!mod || this.status !== 'ready' || buffer.length === 0) return;

    if (buffer.length > this.pcmCapacity) {
      if (this.pcmPtr) mod._free(this.pcmPtr);
      const capacity = Math.max(buffer.length, 4096);
      this.pcmPtr = mod._malloc(capacity * Float32Array.BYTES_PER_ELEMENT);
      this.pcmCapacity = this.pcmPtr ? capacity : 0;
      if (!this.pcmPtr) return;
    }
    // Re-read the heap each call: memory growth detaches earlier views.
    const memory = this.heap(mod);
    if (!memory) return;
    new Float32Array(memory, this.pcmPtr, buffer.length).set(buffer);
    mod._pm_add_pcm(this.pcmPtr, buffer.length, channels);
  }

  /** Parse and show .milk text. False when projectM rejected it (current preset stays). */
  loadPresetMilk(content: string, smooth = true): boolean {
    const mod = this.module;
    if (!mod || this.status !== 'ready') return false;

    const encoded = new TextEncoder().encode(content);
    const ptr = mod._malloc(encoded.length + 1);
    if (!ptr) return false;

    try {
      const memory = this.heap(mod);
      if (!memory) return false;
      const view = new Uint8Array(memory, ptr, encoded.length + 1);
      view.set(encoded);
      view[encoded.length] = 0;
      return mod._pm_load_preset_data(ptr, encoded.length, smooth ? 1 : 0) !== 0;
    } finally {
      mod._free(ptr);
    }
  }

  /** A local .milk file (not part of the pack); returns projectM's parse result. */
  loadLocalPreset(name: string, content: string): boolean {
    this.presetRequest += 1;
    const ok = this.loadPresetMilk(content, true);
    if (ok) this.updatePresetState({ current: null, name: presetDisplayName(name), error: undefined });
    else this.updatePresetState({ error: `${name} could not be parsed` });
    return ok;
  }

  // ─── Preset pack ──────────────────────────────────────────────────────────

  getPresetState(): ProjectMPresetState {
    return this.presetState;
  }

  onPresetChange(listener: (state: ProjectMPresetState) => void): () => void {
    this.presetListeners.add(listener);
    listener(this.presetState);
    return () => this.presetListeners.delete(listener);
  }

  private updatePresetState(patch: Partial<ProjectMPresetState>): void {
    this.presetState = { ...this.presetState, ...patch };
    this.presetListeners.forEach((l) => l(this.presetState));
  }

  private async initPresets(): Promise<void> {
    if (this.playlist || this.presetState.library === 'loading') return;
    this.updatePresetState({ library: 'loading' });
    let manifest: PresetManifest;
    try {
      manifest = await this.options.loadManifest();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[ProjectMEngine] preset pack unavailable; idle preset only', message);
      this.updatePresetState({ library: 'unavailable', error: message });
      return;
    }
    this.playlist = new PresetPlaylist(manifest.presets, this.options.random);
    this.fetcher = new PresetFetcher(manifest.bases, this.options.fetchImpl);
    this.updatePresetState({ library: 'ready', count: manifest.presets.length, error: undefined });

    const linked = this.options.initialPreset();
    if (linked) {
      const request = this.presetRequest + 1;
      if (await this.showPreset(linked, false)) return;
      // A user pick that superseded the link wins over the random fallback.
      if (request !== this.presetRequest) return;
    }
    await this.randomPreset();
  }

  /**
   * Fetch and show a pack preset. Resolves false when the fetch failed, the
   * preset was rejected, or a newer request superseded this one.
   */
  async showPreset(path: string, smooth = true): Promise<boolean> {
    const fetcher = this.fetcher;
    const playlist = this.playlist;
    if (!fetcher || !playlist) return false;
    const request = ++this.presetRequest;
    let text: string;
    try {
      text = await fetcher.fetch(path);
    } catch (err) {
      if (request !== this.presetRequest) return false;
      playlist.markRejected(path);
      this.updatePresetState({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    if (request !== this.presetRequest) return false;
    if (!this.loadPresetMilk(text, smooth)) {
      playlist.markRejected(path);
      this.updatePresetState({ error: `${presetDisplayName(path)} could not be parsed` });
      return false;
    }
    playlist.markShown(path);
    this.updatePresetState({ current: path, name: presetDisplayName(path), error: undefined });
    return true;
  }

  private async tryPresets(pick: () => string | null, smooth: boolean): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_PRESET_ATTEMPTS; attempt++) {
      const path = pick();
      if (!path) return false;
      const request = this.presetRequest + 1;
      if (await this.showPreset(path, smooth)) return true;
      if (request !== this.presetRequest) return false; // superseded, not failed
    }
    return false;
  }

  nextPreset(): Promise<boolean> {
    return this.tryPresets(() => this.playlist?.next() ?? null, true);
  }

  /** Back through the history, then backwards through the list. */
  prevPreset(): Promise<boolean> {
    return this.tryPresets(() => this.playlist?.back() ?? null, true);
  }

  randomPreset(): Promise<boolean> {
    return this.tryPresets(() => this.playlist?.randomPick() ?? null, true);
  }

  /** Locked: projectM's timer / beat hard cuts no longer change the preset. */
  setPresetLocked(locked: boolean): void {
    this.module?._pm_set_preset_locked(locked ? 1 : 0);
    this.updatePresetState({ locked });
  }

  setBeatSensitivity(value: number): void {
    this.module?._pm_set_beat_sensitivity(Math.max(0, Math.min(3, value)));
  }

  destroy(): void {
    if (this.module) {
      try {
        if (this.pcmPtr) this.module._free(this.pcmPtr);
        this.module.onPresetSwitchRequested = undefined;
        this.module._pm_destroy();
      } catch {
        // ignore teardown errors
      }
      this.module = null;
    }
    this.pcmPtr = 0;
    this.pcmCapacity = 0;
    this.loadPromise = null;
    this.playlist = null;
    this.fetcher = null;
    this.presetRequest += 1;
    this.canvas?.remove();
    this.canvas = null;
    this.attachments = 0;
    this.paused = false;
    this.presetState = { library: 'idle', current: null, name: '', locked: false, count: 0 };
    this.setStatus('idle');
  }
}

export const sharedProjectMEngine = new ProjectMEngine();
