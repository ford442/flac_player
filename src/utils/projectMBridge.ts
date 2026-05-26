/**
 * PCM bridge for project-M popup / iframe integration
 *
 * Sends PCM audio data to a parent projectM visualizer using two transports:
 *   1. Primary: window.opener.postMessage / window.parent.postMessage
 *      – works cross-origin for popups and iframes.
 *   2. Fallback: BroadcastChannel('projectm-audio')
 *      – kept for same-origin usage.
 *
 * Usage:
 *   const stopBridge = startProjectMBridge(analyser);
 *   // ... later when cleaning up:
 *   stopBridge();
 */

/** Send a Float32Array of PCM samples to the projectM visualizer. */
export function sendProjectMPCM(float32Array: Float32Array, channels = 1): void {
  const msg = { type: 'pcm', buffer: float32Array, channels };

  // Primary: cross-origin safe postMessage.
  // '*' is intentional: the projectM visualizer may live on a different
  // origin/subdomain and PCM waveform data is not sensitive.
  try {
    if (window.opener) {
      window.opener.postMessage(msg, '*');
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, '*');
    }
  } catch (ex) {
    console.debug('[projectMBridge] postMessage failed (non-fatal):', ex);
  }
}

// Expose a global helper so external scripts can send PCM directly.
(window as unknown as Record<string, unknown>)['__projectM_sendPCM'] = sendProjectMPCM;

export function startProjectMBridge(analyser: AnalyserNode): () => void {
  // Activate whenever there is a parent context (popup or iframe) or a same-origin channel.
  const hasParent = !!(window.opener || (window.parent && window.parent !== window));

  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel('projectm-audio');
  } catch (err) {
    console.debug('[projectMBridge] BroadcastChannel not available:', err);
  }

  if (!hasParent && !channel) {
    return () => {};
  }

  // Use fftSize for time-domain data (not frequencyBinCount, which is for frequency data)
  const buf = new Float32Array(analyser.fftSize);
  let rafId: number | undefined;

  const send = () => {
    analyser.getFloatTimeDomainData(buf);
    // Use buf.slice() to copy data before posting so the original buffer stays intact.
    const slice = buf.slice();

    // Primary: cross-origin safe postMessage.
    // '*' is intentional: the projectM visualizer may live on a different
    // origin/subdomain and PCM waveform data is not sensitive.
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'pcm', buffer: slice, channels: 1 }, '*');
      } else if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'pcm', buffer: slice, channels: 1 }, '*');
      }
    } catch (ex) {
      console.debug('[projectMBridge] postMessage failed (non-fatal):', ex);
    }

    // Fallback: BroadcastChannel for same-origin usage
    if (channel) {
      try {
        channel.postMessage({ type: 'pcm', buffer: slice, channels: 1 });
      } catch (ex) {
        console.debug('[projectMBridge] BroadcastChannel.postMessage failed (non-fatal):', ex);
      }
    }

    rafId = requestAnimationFrame(send);
  };

  // Start the animation frame loop
  rafId = requestAnimationFrame(send);

  // Return cleanup function
  return () => {
    if (rafId !== undefined) {
      cancelAnimationFrame(rafId);
    }
    if (channel) {
      channel.close();
      channel = null;
    }
  };
}
