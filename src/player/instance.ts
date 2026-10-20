// The app's player: one store and one engine for the page's lifetime. Created on
// first use, so importing this module has no side effects. Code outside React
// (e.g. a future WebMIDI adapter) calls getDefaultPlayer().engine.

import { PlaybackEngine } from './PlaybackEngine';
import { browserEngineDeps } from './engineDeps';
import { readStoredVolume } from './persistence';
import { createPlayerStore, type PlayerStore } from './playerStore';

export interface PlayerInstance {
  engine: PlaybackEngine;
  store: PlayerStore;
}

let defaultPlayer: PlayerInstance | null = null;

export function getDefaultPlayer(): PlayerInstance {
  if (!defaultPlayer) {
    const store = createPlayerStore({ volume: readStoredVolume() });
    defaultPlayer = { store, engine: new PlaybackEngine(store, browserEngineDeps()) };
  }
  return defaultPlayer;
}
