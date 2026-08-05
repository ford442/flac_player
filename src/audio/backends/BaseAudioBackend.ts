import type { AudioPlaybackState } from '../../types/audio';
import type { TrackTransitionEvent } from '../../types/gapless';

/**
 * Shared lifecycle guards and callback wiring for audio backends.
 * Subclasses implement playback; the base handles destroyed checks and state notifications.
 */
export abstract class BaseAudioBackend {
  protected destroyed = false;
  protected onStateChange?: (state: AudioPlaybackState) => void;
  protected onEndedCallback?: (event?: TrackTransitionEvent) => void;
  protected lastVolume = 1;
  protected replayGainLinear = 1;

  setStateChangeCallback(callback: (state: AudioPlaybackState) => void): void {
    this.onStateChange = callback;
  }

  setOnEndedCallback(callback?: (event?: TrackTransitionEvent) => void): void {
    this.onEndedCallback = callback;
  }

  protected notifyStateChange(override?: AudioPlaybackState): void {
    if (this.destroyed || !this.onStateChange) return;
    this.onStateChange(override ?? this.getState());
  }

  protected guardDestroyed(): boolean {
    return this.destroyed;
  }

  protected effectiveVolume(volume: number): number {
    return volume * this.replayGainLinear;
  }

  protected applyReplayGainLinear(linear: number, reapplyVolume: () => void): void {
    this.replayGainLinear = Math.max(0, linear);
    reapplyVolume();
  }

  protected setVolumeBase(volume: number, apply: (effective: number) => void): void {
    this.lastVolume = volume;
    if (!this.destroyed) {
      apply(this.effectiveVolume(volume));
    }
  }

  abstract getState(): AudioPlaybackState;
}
