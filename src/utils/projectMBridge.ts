/**
 * BroadcastChannel PCM bridge for project-M popup integration
 * 
 * When flac_player is opened as a popup by project-M (via window.opener),
 * this module automatically broadcasts PCM audio data over BroadcastChannel('projectm-audio')
 * at ~60fps using requestAnimationFrame.
 * 
 * Usage:
 *   const stopBridge = startProjectMBridge(analyser);
 *   // ... later when cleaning up:
 *   stopBridge();
 */

export function startProjectMBridge(analyser: AnalyserNode): () => void {
  // Only activate if opened as a popup (window.opener is truthy)
  if (!window.opener) {
    return () => {};
  }

  try {
    const channel = new BroadcastChannel('projectm-audio');
    // Use fftSize for time-domain data (not frequencyBinCount, which is for frequency data)
    const buf = new Float32Array(analyser.fftSize);
    let rafId: number | undefined;

    const send = () => {
      analyser.getFloatTimeDomainData(buf);
      // Use buf.slice() to copy data before posting
      // This prevents detaching the original buffer and breaking the next frame's read
      channel.postMessage({ type: 'pcm', buffer: buf.slice() });
      rafId = requestAnimationFrame(send);
    };

    // Start the animation frame loop
    rafId = requestAnimationFrame(send);

    // Return cleanup function
    return () => {
      if (rafId !== undefined) {
        cancelAnimationFrame(rafId);
      }
      channel.close();
    };
  } catch (err) {
    // If BroadcastChannel is not supported or fails, return a no-op cleanup
    console.debug('[projectMBridge] BroadcastChannel not available:', err);
    return () => {};
  }
}
