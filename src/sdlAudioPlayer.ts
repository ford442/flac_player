import { FlacDecoder } from './flacDecoder';
import { PlayerState } from './audioPlayer';

// Define the Emscripten module interface
interface SdlModule {
  _init_audio(): number;
  _set_audio_data(dataPtr: number, length: number, channels: number, sampleRate: number): void;
  _play(): void;
  _pause_audio(): void;
  _resume_audio(): void;
  _stop(): void;
  _seek(time: number): void;
  _get_current_time(): number;
  _set_volume(volume: number): void;
  _cleanup(): void;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
}

// Global function exposed by the WASM script
declare global {
  function createSdlAudioModule(): Promise<SdlModule>;
}

export class SdlAudioPlayer {
  private module: SdlModule | null = null;
  private isReady: boolean = false;
  private isPlaying: boolean = false;
  private duration: number = 0;
  private onStateChange?: (state: PlayerState) => void;
  private pollInterval: number | null = null;
  private lastVolume: number = 1.0;

  constructor() {
    this.initializeModule();
  }

  private async initializeModule() {
    // Load the ScriptProcessor->AudioWorklet shim first (best-effort). This enables environments
    // where ScriptProcessorNode is missing/deprecated to still work via AudioWorkletNode.
    if (!(window as any).__sdl_script_processor_shim_loaded) {
      const shim = document.createElement('script');
      shim.src = 'script-processor-shim.js';
      shim.async = true;
      document.head.appendChild(shim);

      await new Promise<void>((resolve) => {
        shim.onload = () => { (window as any).__sdl_script_processor_shim_loaded = true; resolve(); };
        shim.onerror = () => { console.warn('Script processor shim failed to load; continuing without shim.'); resolve(); };
      });
    }

    // Dynamically load the WASM/SDL script if not already present
    if (!window.createSdlAudioModule) {
      const script = document.createElement('script');
      script.src = 'sdl-audio.js';
      script.async = true;
      document.body.appendChild(script);

      await new Promise<void>((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load sdl-audio.js'));
      });
    }

    try {
      this.module = await window.createSdlAudioModule();
      const success = this.module._init_audio();
      if (!success) {
        console.error('Failed to initialize SDL audio');
      } else {
        this.isReady = true;
        this.startPolling();
      }
    } catch (err) {
      console.error('Error initializing SDL module:', err);
    }
  }

  setStateChangeCallback(callback: (state: PlayerState) => void): void {
    this.onStateChange = callback;
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }

  // Poll for playback position updates
  private startPolling() {
    if (this.pollInterval) window.clearInterval(this.pollInterval);
    this.pollInterval = window.setInterval(() => {
      if (this.isPlaying && this.module) {
        this.notifyStateChange();
      }
    }, 100);
  }

  async loadAudio(arrayBuffer: ArrayBuffer): Promise<void> {
    if (!this.module || !this.isReady) {
        // Retry init if not ready? or wait?
        // For simplicity, assume initialized by the time user clicks load.
        if (!this.module) throw new Error('SDL Module not initialized');
    }

    this.stop();
    this.notifyStateChange();

    try {
      const decoder = new FlacDecoder();
      const result = await decoder.decode(arrayBuffer);

      this.duration = result.duration;

      // Interleave samples
      const channels = result.channels;
      const length = result.samples[0].length;
      const interleavedLength = length * channels;
      const interleaved = new Float32Array(interleavedLength);

      for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < channels; ch++) {
          interleaved[i * channels + ch] = result.samples[ch][i];
        }
      }

      // Allocate memory in WASM
      const byteLength = interleaved.byteLength;
      let ptr = 0;
      let usedManualMalloc = false;

      // Try to find heap views
      let heapF32 = (this.module as any).HEAPF32 as Float32Array | undefined;
      if (!heapF32) {
        const heapU8 = (this.module as any).HEAPU8 || (this.module as any).HEAP8;
        if (heapU8) {
          heapF32 = new Float32Array(heapU8.buffer);
          (this.module as any).HEAPF32 = heapF32;
        }
      }

      if (heapF32) {
        // Direct heap access is available. Manually malloc and copy.
        ptr = (this.module as any)._malloc(byteLength);
        if (!ptr || ptr === 0) {
           console.warn('WASM malloc failed (returned 0). Falling back to ccall auto-allocation.');
           heapF32 = undefined; // Force fallback
        } else {
           usedManualMalloc = true;
           try {
             heapF32.set(interleaved, ptr >> 2);
             // Call C++ function with pointer
             (this.module as any)._set_audio_data(ptr, interleavedLength, channels, result.sampleRate);
           } catch (err) {
             console.warn('Direct heap write/call failed. Falling back to ccall.', err);
             // Clean up and force fallback
             (this.module as any)._free && (this.module as any)._free(ptr);
             ptr = 0;
             usedManualMalloc = false;
             heapF32 = undefined;
           }
        }
      }

      if (!heapF32) {
        // Fallback: Use ccall with 'array' type. This handles allocation, copy, and freeing internally.
        // Or at least it allocates/copies. We trust Emscripten's ccall.
        console.log('Using ccall fallback for set_audio_data (HEAP direct access unavailable).');
        try {
          (this.module as any).ccall('set_audio_data', null, ['array', 'number', 'number', 'number'], [interleaved, interleavedLength, channels, result.sampleRate]);
        } catch (ccErr) {
          console.error('Fallback ccall set_audio_data failed:', ccErr);
          throw ccErr;
        }
      }

      // Free memory if we manually allocated it
      if (usedManualMalloc && ptr !== 0 && (this.module as any)._free) {
        try { (this.module as any)._free(ptr); } catch (_) {}
      }

      this.notifyStateChange();

    } catch (error) {
      console.error('Error loading audio in SDL player:', error);
      throw error;
    }
  }

  play(): void {
    if (!this.module) return;
    this.module._play();
    this.isPlaying = true;
    this.notifyStateChange();
  }

  pause(): void {
    if (!this.module) return;
    this.module._pause_audio();
    this.isPlaying = false;
    this.notifyStateChange();
  }

  stop(): void {
    if (!this.module) return;
    this.module._stop();
    this.isPlaying = false;
    this.notifyStateChange();
  }

  seek(time: number): void {
    if (!this.module) return;
    this.module._seek(time);
    this.notifyStateChange();
  }

  getCurrentTime(): number {
    if (!this.module) return 0;
    return this.module._get_current_time();
  }

  getDuration(): number {
    return this.duration;
  }

  getState(): PlayerState {
    return {
      isPlaying: this.isPlaying,
      currentTime: this.getCurrentTime(),
      duration: this.getDuration(),
      isLoading: false
    };
  }

  setVolume(volume: number): void {
    this.lastVolume = volume;
    if (this.module) {
      this.module._set_volume(volume);
    }
  }

  getAnalyser(): AnalyserNode {
    // SDL player doesn't support Web Audio AnalyserNode integration yet
    // Return a dummy analyser to satisfy interface if needed, or throw/return null and handle in UI
    // The UI handles null but the type signature says AnalyserNode.
    // We'll cast null or create a dummy one.
    // Creating a dummy one requires AudioContext.
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    return analyser;
  }

  destroy(): void {
    this.stop();
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.module) {
      this.module._cleanup();
    }
  }
}
