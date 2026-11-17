import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EQPanel, type AudioOutputControls } from '../src/components/EQPanel';
import { AudioCapabilitiesContext } from '../src/components/AudioCapabilitiesContext';
import type { AudioOutputInfo, PitchHoldInfo } from '../src/audio/AudioContextManager';
import { DEFAULT_AUDIO_BACKEND_CAPABILITIES } from '../src/types/audio';

// #283: the speed control reads "Speed" while pitch is held and "Varispeed" when
// it is not (toggle off, or no dsp-chain worklet to hold it).

function outputControls(pitch: PitchHoldInfo): AudioOutputControls {
  const info = {
    sampleRate: 48000, baseLatency: 0.01, outputLatency: 0.02, latencyHint: 'playback', channelCount: 2,
    sinkId: '', state: 'running', graphGeneration: 1, dspEngine: 'wasm', renderQuantumSize: null,
    pitch, loudness: null,
  } as unknown as AudioOutputInfo;
  return {
    deviceId: '', deviceLabel: '', sinkSupported: false, pickerSupported: false, devices: [],
    onSelectOutputDevice: async () => {}, info, externalPlayback: false,
  };
}

function renderPanel(props: {
  preservePitch: boolean;
  pitchHold?: boolean;
  pitch?: PitchHoldInfo;
  onPreservePitchChange?: (v: boolean) => void;
}) {
  const capabilities = { ...DEFAULT_AUDIO_BACKEND_CAPABILITIES, pitchHold: props.pitchHold ?? true };
  return render(
    <AudioCapabilitiesContext.Provider value={capabilities}>
      <EQPanel
        eqGains={[0, 0, 0, 0, 0]} onBandChange={() => {}} onReset={() => {}}
        playbackRate={1.25} onPlaybackRateChange={() => {}}
        preservePitch={props.preservePitch} onPreservePitchChange={props.onPreservePitchChange ?? (() => {})}
        gaplessMode="gapless" onGaplessModeChange={() => {}}
        crossfadeMs={3000} onCrossfadeMsChange={() => {}}
        replayGainMode="off" onReplayGainModeChange={() => {}}
        replayGainLimiter={false} onReplayGainLimiterChange={() => {}}
        latencyMode="playback" onLatencyModeChange={() => {}}
        audioOutput={outputControls(props.pitch ?? { by: 'dsp-chain', unavailable: false, latency: 0.15 })}
      />
    </AudioCapabilitiesContext.Provider>,
  );
}

describe('EQPanel speed / varispeed (#283)', () => {
  afterEach(cleanup);

  it('labels the slider Speed while pitch is held and shows who holds it', () => {
    renderPanel({ preservePitch: true });
    expect(screen.getByTestId('speed-label').textContent).toBe('Speed');
    expect(screen.getByRole('slider', { name: 'Playback speed' })).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Worklet WASM (+150 ms)')).toBeTruthy();
  });

  it('the toggle switches to varispeed', () => {
    const onChange = vi.fn();
    renderPanel({ preservePitch: false, pitch: { by: 'none', unavailable: false, latency: 0 }, onPreservePitchChange: onChange });
    expect(screen.getByTestId('speed-label').textContent).toBe('Varispeed');
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('says so when the dsp-chain worklet is missing and the rate falls back to varispeed', () => {
    renderPanel({ preservePitch: true, pitch: { by: 'none', unavailable: true, latency: 0 } });
    expect(screen.getByTestId('speed-label').textContent).toBe('Varispeed');
    expect(screen.getByRole('status').textContent).toMatch(/Pitch hold needs the DSP worklet/);
    expect(screen.getByText('Unavailable (varispeed)')).toBeTruthy();
  });

  it('reads Varispeed for a backend that cannot hold pitch', () => {
    renderPanel({ preservePitch: true, pitchHold: false, pitch: { by: 'none', unavailable: false, latency: 0 } });
    expect(screen.getByTestId('speed-label').textContent).toBe('Varispeed');
  });

  it('shows the loudness rows (empty until the meter reads the ring)', () => {
    renderPanel({ preservePitch: true });
    expect(screen.getByTestId('lufs-momentary').textContent).toBe('—');
    expect(screen.getByTestId('lufs-short-term').textContent).toBe('—');
  });
});
