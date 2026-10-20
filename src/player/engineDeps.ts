// Browser wiring for the PlaybackEngine (tests pass fakes instead).

import { createAudioBackend } from '../audio/createAudioBackend';
import { sharedAudioContextManager } from '../audio/AudioContextManager';
import { recordPlay } from '../api/songApi';
import { fetchTrackBytes } from '../api/trackBytes';
import { enrichTrackReplayGain } from '../hooks/useReplayGainApplication';
import { getPreferredStorageUrls } from '../utils/audioUtils';
import { createProjectMPCMFeed, notifyInAppProjectMTrackChange } from '../utils/projectMBridge';
import { probeRemoteAudio } from '../utils/rangeFetch';
import type { EngineDeps } from './PlaybackEngine';
import { readLocalTrack } from './localTracks';
import { readSavedPosition } from './persistence';

export function browserEngineDeps(): EngineDeps {
  return {
    createBackend: (mode) => createAudioBackend(mode, sharedAudioContextManager),
    subscribeGraphRecreated: (listener) => sharedAudioContextManager.subscribeGraphRecreated(listener),
    candidateUrls: getPreferredStorageUrls,
    fetchTrackBytes,
    probeContentLength: async (url, signal) => (await probeRemoteAudio(url, signal)).contentLength,
    recordPlay: (id) => { void recordPlay(id); },
    enrichReplayGain: enrichTrackReplayGain,
    readLocalFile: readLocalTrack,
    readSavedPosition: (id) => readSavedPosition(id),
    attachVisualizerFeed: createProjectMPCMFeed,
    onTrackChange: notifyInAppProjectMTrackChange,
    now: () => performance.now(),
  };
}
