import React, { createContext, useContext } from 'react';
import { getDefaultPlayer, type PlayerInstance } from './instance';

const PlayerContext = createContext<PlayerInstance | null>(null);

/** Overrides the app player (tests render components against their own engine). */
export const PlayerProvider: React.FC<{ player: PlayerInstance; children?: React.ReactNode }> = ({ player, children }) => (
  <PlayerContext.Provider value={player}>{children}</PlayerContext.Provider>
);

export function usePlayer(): PlayerInstance {
  return useContext(PlayerContext) ?? getDefaultPlayer();
}
