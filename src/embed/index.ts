/** Public entry of the embeddable mini player: `import { FlacMiniPlayer } from 'flac-player/embed'`. */
export { FlacMiniPlayer, formatTime } from './FlacMiniPlayer';
export { MINI_EQ_PRESETS } from './eqPresets';
export { mountMiniPlayer, type MountedMiniPlayer } from './mount';
export type {
  FlacMiniPlayerProps,
  MiniEqPreset,
  MiniPlayerHandle,
  MiniPlayerLayout,
  MiniPlayerState,
  MiniTrack,
} from './types';
