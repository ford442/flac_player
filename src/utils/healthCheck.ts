import { AudioLoader } from '../audioLoader';

export const checkBackendHealth = async (loader: AudioLoader): Promise<boolean> => {
  try {
    const health = await loader.healthCheck();
    return health.isHealthy;
  } catch {
    return false;
  }
};
