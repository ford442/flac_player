import { createContext, useContext } from 'react';
import { DEFAULT_AUDIO_BACKEND_CAPABILITIES, type AudioBackendCapabilities } from '../types/audio';

/**
 * Capabilities of the live audio backend. Provided by Player so settings and
 * transport controls can disable what the backend cannot honor without
 * threading another prop through PlayerFallbackView.
 */
export const AudioCapabilitiesContext = createContext<AudioBackendCapabilities>(
  DEFAULT_AUDIO_BACKEND_CAPABILITIES
);

export function useAudioCapabilities(): AudioBackendCapabilities {
  return useContext(AudioCapabilitiesContext);
}
