/**
 * In-app projectM host registry + PCM routing.
 *
 * External embed/popup transport (postMessage / BroadcastChannel) remains available
 * via sendProjectMPCM / startProjectMBridge. When an in-app ProjectMEngine is
 * registered, PCM is fed there first — no duplicate decode.
 */

export interface InAppProjectMHost {
  addPCM(buffer: Float32Array, channels: number): void;
  onTrackChange?: () => void;
}

let inAppHost: InAppProjectMHost | null = null;

export function registerInAppProjectMHost(host: InAppProjectMHost): void {
  inAppHost = host;
}

export function unregisterInAppProjectMHost(host: InAppProjectMHost): void {
  if (inAppHost === host) {
    inAppHost = null;
  }
}

export function getInAppProjectMHost(): InAppProjectMHost | null {
  return inAppHost;
}

export function feedInAppProjectMPCM(buffer: Float32Array, channels: number): boolean {
  if (!inAppHost) return false;
  inAppHost.addPCM(buffer, channels);
  return true;
}

export function notifyInAppProjectMTrackChange(): void {
  inAppHost?.onTrackChange?.();
}

// Module-level BroadcastChannel used by sendProjectMPCM.
let _pcmChannel: BroadcastChannel | null | undefined;

function getPCMChannel(): BroadcastChannel | null {
  if (_pcmChannel === undefined) {
    try {
      _pcmChannel = new BroadcastChannel('projectm-audio');
    } catch {
      _pcmChannel = null;
    }
  }
  return _pcmChannel;
}

/** Close the module-level BroadcastChannel created by sendProjectMPCM. */
export function closeProjectMBridgeChannel(): void {
  if (_pcmChannel) {
    _pcmChannel.close();
  }
  _pcmChannel = undefined;
}

/** Send PCM to external projectM hosts (popup / iframe / BroadcastChannel). */
export function sendProjectMPCM(float32Array: Float32Array, channels = 1): void {
  if (feedInAppProjectMPCM(float32Array, channels)) {
    return;
  }

  const msg = { type: 'pcm', buffer: float32Array, channels };

  try {
    if (window.opener) {
      window.opener.postMessage(msg, '*');
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, '*');
    }
  } catch (ex) {
    console.debug('[projectMBridge] postMessage failed (non-fatal):', ex);
  }

  const ch = getPCMChannel();
  if (ch) {
    try {
      ch.postMessage(msg);
    } catch (ex) {
      console.debug('[projectMBridge] BroadcastChannel.postMessage failed (non-fatal):', ex);
    }
  }
}

(window as unknown as Record<string, unknown>)['__projectM_sendPCM'] = sendProjectMPCM;

export function startProjectMBridge(analyser: AnalyserNode): () => void {
  const hasParent = !!(window.opener || (window.parent && window.parent !== window));
  const hasInApp = !!inAppHost;

  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel('projectm-audio');
  } catch (err) {
    console.debug('[projectMBridge] BroadcastChannel not available:', err);
  }

  if (!hasParent && !channel && !hasInApp) {
    return () => {};
  }

  const buf = new Float32Array(analyser.fftSize);
  let rafId: number | undefined;

  const send = () => {
    analyser.getFloatTimeDomainData(buf);
    const slice = buf.slice();
    feedInAppProjectMPCM(slice, 1);
    if (!inAppHost) {
      try {
        if (window.opener) {
          window.opener.postMessage({ type: 'pcm', buffer: slice, channels: 1 }, '*');
        } else if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'pcm', buffer: slice, channels: 1 }, '*');
        }
      } catch (ex) {
        console.debug('[projectMBridge] postMessage failed (non-fatal):', ex);
      }
      if (channel) {
        try {
          channel.postMessage({ type: 'pcm', buffer: slice, channels: 1 });
        } catch (ex) {
          console.debug('[projectMBridge] BroadcastChannel.postMessage failed (non-fatal):', ex);
        }
      }
    }
    rafId = requestAnimationFrame(send);
  };

  rafId = requestAnimationFrame(send);

  return () => {
    if (rafId !== undefined) cancelAnimationFrame(rafId);
    if (channel) {
      channel.close();
      channel = null;
    }
  };
}

/** Preferred PCM wiring for Player — worklet tap or analyser bridge. */
export function createProjectMPCMFeed(
  player: {
    setPCMCallback?: (
      cb?: (buffer: Float32Array, channels: number, sampleRate: number) => void
    ) => void;
    getAnalyser(): AnalyserNode | null;
  }
): () => void {
  const setPCMCallback = player.setPCMCallback?.bind(player);
  if (setPCMCallback) {
    setPCMCallback((buffer, channels) => sendProjectMPCM(buffer, channels));
    return () => {
      setPCMCallback(undefined);
      closeProjectMBridgeChannel();
    };
  }
  const analyser = player.getAnalyser();
  return analyser ? startProjectMBridge(analyser) : () => {};
}
