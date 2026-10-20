import React from 'react';
import { QueuePanel } from '../QueuePanel';
import { useActions } from '../PlayerActionsContext';
import { useQueue, useTransport } from '../../player/selectors';

/** QueuePanel bound to the player store; used by the queue drawer and the queue tab. */
export const PlayerQueuePanel: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const queue = useQueue((q) => q.tracks);
  const currentIndex = useQueue((q) => q.currentIndex);
  const shuffle = useQueue((q) => q.shuffle);
  const repeatMode = useQueue((q) => q.repeatMode);
  const loadingTrackId = useTransport((t) => t.loadingTrackId);
  const prebufferingNext = useTransport((t) => t.prebufferingNext);
  const actions = useActions();
  return (
    <QueuePanel
      queue={queue} currentIndex={currentIndex} loadingTrackId={loadingTrackId} prebufferingNext={prebufferingNext}
      isOpen={isOpen} onClose={onClose}
      onTrackClick={actions.playQueueIndex} onRemoveTrack={actions.removeFromQueue} onClearQueue={actions.clearQueue}
      onShuffle={actions.toggleShuffle} onSmartMix={actions.smartMix} onShareQueue={actions.shareQueue}
      onListenTogether={actions.listenTogether} onDownloadQueue={actions.downloadQueue}
      onReorderQueue={actions.reorderQueue}
      shuffle={shuffle} repeatMode={repeatMode} onToggleRepeat={actions.cycleRepeat}
    />
  );
};
