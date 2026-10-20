import { createContext, useContext } from 'react';
import type { PlayerActions } from '../hooks/usePlayerActions';
import type { QueueTools } from '../hooks/useQueueActions';

/** Everything a control can do: room-aware transport/queue actions plus queue tools. */
export interface AppActions extends PlayerActions, QueueTools {}

const PlayerActionsContext = createContext<AppActions | null>(null);

export const PlayerActionsProvider = PlayerActionsContext.Provider;

/** Actions provided by Player; components call these instead of taking callback props (#258). */
export function useActions(): AppActions {
  const actions = useContext(PlayerActionsContext);
  if (!actions) throw new Error('useActions() needs a <PlayerActionsProvider> (rendered by Player)');
  return actions;
}
