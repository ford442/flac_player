import {
  isSWServerMessage,
  type SWClientMessage,
  type SWServerMessage,
} from './swMessages';

type MessageHandler = (message: SWServerMessage) => void;

let registration: ServiceWorkerRegistration | null = null;
const messageHandlers = new Set<MessageHandler>();

function dispatchMessage(data: unknown): void {
  if (!isSWServerMessage(data)) return;
  messageHandlers.forEach(handler => handler(data));
}

/** Subscribe to service worker messages (download progress, completion, errors). */
export function onServiceWorkerMessage(handler: MessageHandler): () => void {
  messageHandlers.add(handler);
  return () => messageHandlers.delete(handler);
}

export function isServiceWorkerSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

export function getServiceWorkerRegistration(): ServiceWorkerRegistration | null {
  return registration;
}

/**
 * Register the production service worker. No-op in development (SW is not emitted).
 * Returns the registration when successful.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isServiceWorkerSupported() || process.env.NODE_ENV !== 'production') {
    return null;
  }

  try {
    registration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });

    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      dispatchMessage(event.data);
    });

    // Reload once when an updated worker takes over (not on first install).
    let pendingReload = false;
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!pendingReload || refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    registration.addEventListener('updatefound', () => {
      const installing = registration?.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          pendingReload = true;
          postToServiceWorker({ type: 'SKIP_WAITING' });
        }
      });
    });

    return registration;
  } catch (err) {
    console.warn('[SW] Registration failed:', err);
    return null;
  }
}

/** Post a message to the active service worker. */
export function postToServiceWorker(message: SWClientMessage): void {
  const target = registration?.active ?? navigator.serviceWorker.controller;
  target?.postMessage(message);
}

/** True when a service worker controls this page and accepts background downloads. */
export function canUseBackgroundDownloads(): boolean {
  return Boolean(navigator.serviceWorker?.controller);
}

/**
 * Download a track via the service worker (continues while the app is backgrounded).
 * Falls back to null when no controller is available – caller should use direct download.
 */
export function downloadTrackViaSW(
  url: string,
  onProgress?: (progress: number) => void
): { requestId: string; promise: Promise<void> } {
  const requestId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const promise = new Promise<void>((resolve, reject) => {
    if (!canUseBackgroundDownloads()) {
      reject(new Error('Service worker not controlling page'));
      return;
    }

    const unsubscribe = onServiceWorkerMessage((msg) => {
      if (msg.requestId !== requestId) return;

      if (msg.type === 'DOWNLOAD_PROGRESS') {
        onProgress?.(msg.progress);
      } else if (msg.type === 'DOWNLOAD_COMPLETE') {
        unsubscribe();
        onProgress?.(1);
        resolve();
      } else if (msg.type === 'DOWNLOAD_ERROR') {
        unsubscribe();
        reject(new Error(msg.error));
      }
    });

    postToServiceWorker({ type: 'DOWNLOAD_TRACK', url, requestId });
  });

  return { requestId, promise };
}

export function cancelBackgroundDownload(requestId: string): void {
  postToServiceWorker({ type: 'CANCEL_DOWNLOAD', requestId });
}
