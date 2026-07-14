/** React-facing playback state; distinct from backend implementation state. */
export interface PlayerUIState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  isLoading: boolean;
}
