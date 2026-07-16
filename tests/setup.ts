/** Reset visualizer module singletons between tests. */
import { beforeEach } from 'vitest';

beforeEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* jsdom may block in some environments */
  }
  delete (window as unknown as { DEBUG_VISUALIZER?: string }).DEBUG_VISUALIZER;
});
