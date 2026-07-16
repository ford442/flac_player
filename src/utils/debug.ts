/**
 * Centralized debug logging for the FLAC player frontend.
 * Enable with REACT_APP_DEBUG=true (webpack DefinePlugin injects at build time).
 */
const DEBUG = process.env.REACT_APP_DEBUG === 'true';

export const debug = {
  log: (label: string, data?: unknown) => {
    if (DEBUG) console.log(`[FLAC:${label}]`, data);
  },
  error: (label: string, data?: unknown) => {
    if (DEBUG) console.error(`[FLAC:${label}]`, data);
  },
  warn: (label: string, data?: unknown) => {
    if (DEBUG) console.warn(`[FLAC:${label}]`, data);
  },
};

export default debug;
