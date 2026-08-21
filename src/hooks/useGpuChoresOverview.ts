import { useEffect, useRef, useState } from 'react';
import { runChore } from '../gpu-chores';
import type { DecodedPcmView, GpuChoreBackend, GpuChoreBreadcrumb } from '../gpu-chores';
import { getLastGpuChoreBreadcrumb } from '../gpu-chores';

export interface GpuChoresOverviewState {
  minmax: Float32Array | null;
  rms: number | null;
  peak: number | null;
  backend: GpuChoreBackend | null;
  reason: string | null;
  ready: boolean;
  breadcrumb: GpuChoreBreadcrumb | null;
}

const EMPTY: GpuChoresOverviewState = {
  minmax: null,
  rms: null,
  peak: null,
  backend: null,
  reason: null,
  ready: false,
  breadcrumb: null,
};

/**
 * Build a scrubber peak pyramid after decode, off the audio callback.
 * Streaming backends without a decoded PCM buffer keep the empty overview.
 */
export function useGpuChoresOverview(args: {
  trackKey: string | null;
  isLoading: boolean;
  getDecodedPcm: () => DecodedPcmView | null;
}): GpuChoresOverviewState {
  const { trackKey, isLoading, getDecodedPcm } = args;
  const [state, setState] = useState<GpuChoresOverviewState>(EMPTY);
  const getPcmRef = useRef(getDecodedPcm);
  getPcmRef.current = getDecodedPcm;

  useEffect(() => {
    if (!trackKey || isLoading) {
      setState(EMPTY);
      return;
    }

    const pcmView = getPcmRef.current();
    if (!pcmView || pcmView.pcm.length === 0) {
      setState(EMPTY);
      return;
    }

    const controller = new AbortController();
    const pcm = pcmView.pcm;
    const channels = pcmView.channels;

    void (async () => {
      try {
        const result = await runChore({
          kind: 'peak_pyramid',
          pcm,
          channels,
          prefer: 'auto',
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setState({
          minmax: result.minmax ?? result.levels?.[0] ?? null,
          rms: result.rms ?? null,
          peak: result.peak ?? null,
          backend: result.backend,
          reason: result.reason,
          ready: true,
          breadcrumb: getLastGpuChoreBreadcrumb(),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState(EMPTY);
      }
    })();

    return () => controller.abort();
  }, [trackKey, isLoading]);

  return state;
}
