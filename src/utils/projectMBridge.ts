/**
 * PCM bridge for project-M popup / iframe integration
 *
 * Sends PCM audio data to a parent projectM visualizer using two transports:
 *   1. Primary: window.opener.postMessage / window.parent.postMessage
 *      – works cross-origin for popups and iframes.
 *   2. Fallback: BroadcastChannel('projectm-audio')
 *      – kept for same-origin usage.
 *
 * Two complementary approaches are provided:
 *
 *   **Worklet PCM tap (preferred, audio-clock-synchronized)**
 *   When using AudioWorkletPlayer, register a PCM callback with
 *   `player.setPCMCallback((buf, ch) => sendProjectMPCM(buf, ch))`.
 *   The worklet emits 512-sample interleaved blocks at the audio clock rate
 * (~86 blocks/s at 44,100 Hz).  Call `closeProjectMBridgeChannel()` for
 *   cleanup when the player is destroyed.
 *
 *   **AnalyserNode RAF approach (non-worklet fallback)**
 *   `const stop = startProjectMBridge(analyser)` polls the AnalyserNode at
 *   requestAnimationFrame rate (~60 fps) and forwards mono waveform data.
 *   Call `stop()` for cleanup.
 *
 * Usage (opening as a projectM popup / embedding as an iframe):
 *   Open/embed `https://<your-flac-player-url>` from a projectM window and
 *   listen for `message` events on the visualizer side:
 *
 *   ```js
 *   window.addEventListener('message', (e) => {
 *     if (e.data?.type === 'pcm') {
 *       projectM.addPCMfloat(e.data.buffer, e.data.channels);
 *     }
 *   });
 *   ```
 *
 *   The same PCM packets are also available via BroadcastChannel for
 *   same-origin consumers:
 *
 *   ```js
 *   const ch = new BroadcastChannel('projectm-audio');
 *   ch.onmessage = (e) => {
 *     if (e.data?.type === 'pcm') {
 *       projectM.addPCMfloat(e.data.buffer, e.data.channels);
 *     }
 *   };
 *   ```
 */

// Module-level BroadcastChannel used by sendProjectMPCM.
// undefined  = not yet attempted
// null       = attempted but unavailable (e.g. Safari private browsing)
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

/** Close the module-level BroadcastChannel created by sendProjectMPCM.
 *  Call this when the player is destroyed to release the channel resource. */
export function closeProjectMBridgeChannel(): void {
  if (_pcmChannel) {
    _pcmChannel.close();
  }
  _pcmChannel = undefined; // allow re-creation on next sendProjectMPCM call
}

/** Send a Float32Array of interleaved PCM samples to the projectM visualizer.
 *
 *  This forwards the data via two transports:
 *   - window.opener / window.parent postMessage (cross-origin popups/iframes)
 *   - BroadcastChannel('projectm-audio') (same-origin tabs/workers)
 */
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

  // Fallback: BroadcastChannel for same-origin usage
  const ch = getPCMChannel();
  if (ch) {
    try {
      ch.postMessage(msg);
    } catch (ex) {
      console.debug('[projectMBridge] BroadcastChannel.postMessage failed (non-fatal):', ex);
    }
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
