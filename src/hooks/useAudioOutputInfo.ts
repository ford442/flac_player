/**
 * useAudioOutputInfo – read-only view of the shared graph (rate, base/output
 * latency, sink) plus enumerable output devices for the Settings panel.
 */

import { useEffect, useState } from 'react';
import {
  isAudioContextSinkSupported,
  sharedAudioContextManager,
  type AudioContextManager,
  type AudioOutputInfo,
} from '../audio/AudioContextManager';

export interface OutputDeviceOption {
  deviceId: string;
  label: string;
}

function sameInfo(a: AudioOutputInfo | null, b: AudioOutputInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.sampleRate === b.sampleRate
    && a.baseLatency === b.baseLatency
    && a.outputLatency === b.outputLatency
    && a.latencyHint === b.latencyHint
    && a.channelCount === b.channelCount
    && a.sinkId === b.sinkId
    && a.state === b.state
    && a.graphGeneration === b.graphGeneration;
}

/** Polls the manager; `outputLatency` drifts with the device so a subscription is not enough. */
export function useAudioOutputInfo(
  manager: AudioContextManager = sharedAudioContextManager,
  intervalMs = 1000
): AudioOutputInfo | null {
  const [info, setInfo] = useState<AudioOutputInfo | null>(() => manager.getOutputInfo());

  useEffect(() => {
    const refresh = () => {
      const next = manager.getOutputInfo();
      setInfo((prev) => (sameInfo(prev, next) ? prev : next));
    };
    refresh();
    const id = window.setInterval(refresh, intervalMs);
    const unsubscribe = manager.subscribeGraphRecreated(refresh);
    return () => {
      window.clearInterval(id);
      unsubscribe();
    };
  }, [manager, intervalMs]);

  return info;
}

/**
 * `audiooutput` devices for the sink dropdown (Chromium, where `setSinkId` exists
 * but `selectAudioOutput` usually does not). Labels may be blank until the page
 * holds a media permission.
 */
export function useOutputDevices(): OutputDeviceOption[] {
  const [devices, setDevices] = useState<OutputDeviceOption[]>([]);

  useEffect(() => {
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media?.enumerateDevices || !isAudioContextSinkSupported()) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const all = await media.enumerateDevices();
        if (cancelled) return;
        const outputs = all
          .filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default')
          .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Output ${i + 1}` }));
        setDevices(outputs);
      } catch {
        if (!cancelled) setDevices([]);
      }
    };
    void refresh();
    media.addEventListener?.('devicechange', refresh);
    return () => {
      cancelled = true;
      media.removeEventListener?.('devicechange', refresh);
    };
  }, []);

  return devices;
}
