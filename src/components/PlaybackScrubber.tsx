// The scrubber is one of the two places that subscribe to the clock (#258): it
// re-renders at most 4×/s, its parents not at all.

import React, { createContext, useContext } from 'react';
import { useGpuChoresOverview, type GpuChoresOverviewState } from '../hooks/useGpuChoresOverview';
import { selectIsLoading, useAnalyser, useClock, usePlaybackEngine, useTransport } from '../player/selectors';
import { useActions } from './PlayerActionsContext';
import { WaveformOverview } from './WaveformOverview';

/** Scrubber peaks from gpu-chores (empty while streaming / not yet reduced). */
export type OverviewData = Pick<GpuChoresOverviewState, 'minmax' | 'rms' | 'peak' | 'backend' | 'reason'>;

const EMPTY_OVERVIEW: OverviewData = { minmax: null, rms: null, peak: null, backend: null, reason: null };
const TrackOverviewContext = createContext<OverviewData>(EMPTY_OVERVIEW);

/** Reduces the decoded track to scrubber peaks once per track and shares them. */
export const TrackOverviewProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const engine = usePlaybackEngine();
  const trackKey = useTransport((t) => t.currentTrack?.id ?? t.currentTrack?.url ?? null);
  const isLoading = useTransport(selectIsLoading);
  const overview = useGpuChoresOverview({ trackKey, isLoading, getDecodedPcm: () => engine.getDecodedPcm() });
  return <TrackOverviewContext.Provider value={overview}>{children}</TrackOverviewContext.Provider>;
};

export function useTrackOverview(): OverviewData {
  return useContext(TrackOverviewContext);
}

export const PlaybackScrubber: React.FC<{ className?: string }> = ({ className }) => {
  const { position, duration } = useClock();
  const overview = useTrackOverview();
  const analyser = useAnalyser();
  const { seek } = useActions();
  return (
    <WaveformOverview
      className={className}
      minmax={overview.minmax}
      currentTime={position}
      duration={duration}
      onSeek={seek}
      analyser={analyser}
      rms={overview.rms}
      peak={overview.peak}
      backend={overview.backend}
      reason={overview.reason}
    />
  );
};
