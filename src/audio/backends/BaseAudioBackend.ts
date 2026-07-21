import { AudioContextManager, sharedAudioContextManager } from '../AudioContextManager';
import type { AudioBackend, AudioPlaybackState } from '../../types/audio';

/**
 * Shared lifecycle for the five playback backends.
 *
 * Deliberately thin: only the members that are genuinely identical across every
 * backend live here. Volume, the gain node and the graph wiring are *not* shared —
 * the SDL backends drive volume through their WASM module and own no gain node,
 * and the worklet backend creates its gain node lazily in initialize().
 */
export abstract class BaseAudioBackend implements Partial<AudioBackend> {
  protected onStateChange?: (state: AudioPlaybackState) => void;
  protected onEndedCallback?: () => void;

  constructor(protected contextManager: AudioContextManager = sharedAudioContextManager) {}

  setStateChangeCallback(callback: (state: AudioPlaybackState) => void): void {
    this.onStateChange = callback;
  }

  setOnEndedCallback(callback?: () => void): void {
    this.onEndedCallback = callback;
  }

  protected notifyStateChange(): void {
    this.onStateChange?.(this.getState());
  }

  /** Invoke the end-of-track callback without letting a throwing handler break playback. */
  protected notifyEnded(): void {
    if (!this.onEndedCallback) return;
    try {
      this.onEndedCallback();
    } catch (err) {
      console.warn('onEnded handler threw', err);
    }
  }

  setEQGains(gains: number[]): void {
    this.contextManager.setEQGains(gains);
  }

  getAnalyser(): AnalyserNode {
    return this.contextManager.getAnalyser();
  }

  abstract getState(): AudioPlaybackState;
}
