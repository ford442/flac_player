/**
 * useAudioOutputInfo – read-only view of the shared graph (rate, base/output
 * latency, sink) plus enumerable output devices for the Settings panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    && a.graphGeneration === b.graphGeneration
    && a.dspEngine === b.dspEngine;
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

export interface OutputDeviceList {
  devices: OutputDeviceOption[];
  /**
   * The browser reports outputs but blanks their ids (Chromium, version-dependent,
   * until the page holds a media permission), so none can be offered yet.
   */
  hidden: boolean;
  /** Ask for that permission, release it at once, and list again. */
  reveal: () => Promise<void>;
}

/** `audiooutput` entries usable with setSinkId, plus whether some were hidden. */
export function listOutputDevices(all: readonly MediaDeviceInfo[]): Pick<OutputDeviceList, 'devices' | 'hidden'> {
  const outputs = all.filter((d) => d.kind === 'audiooutput');
  const devices = outputs
    .filter((d) => d.deviceId && d.deviceId !== 'default')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Output ${i + 1}` }));
  return { devices, hidden: outputs.some((d) => !d.deviceId) };
}

/**
 * `audiooutput` devices for the sink dropdown (Chromium, where `setSinkId` exists
 * but `selectAudioOutput` usually does not). Labels and ids may be blank until
 * the page holds a media permission; `reveal()` asks for one.
 */
export function useOutputDevices(): OutputDeviceList {
  const [list, setList] = useState<Pick<OutputDeviceList, 'devices' | 'hidden'>>({ devices: [], hidden: false });
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media?.enumerateDevices || !isAudioContextSinkSupported()) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const all = await media.enumerateDevices();
        if (!cancelled) setList(listOutputDevices(all));
      } catch {
        if (!cancelled) setList({ devices: [], hidden: false });
      }
    };
    refreshRef.current = refresh;
    void refresh();
    media.addEventListener?.('devicechange', refresh);
    return () => {
      cancelled = true;
      media.removeEventListener?.('devicechange', refresh);
    };
  }, []);

  const reveal = useCallback(async () => {
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) return;
    try {
      // Only the permission matters: the stream is stopped before anything is captured.
      const stream = await media.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      console.warn('[useOutputDevices] media permission refused; output devices stay hidden', err);
    }
    await refreshRef.current();
  }, []);

  return useMemo(() => ({ ...list, reveal }), [list, reveal]);
}
