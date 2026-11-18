// Runs a folder walk in `workers/libraryScanWorker.ts` (#284), one worker per scan. Falls
// back to the main-thread walk where workers (or cloning a directory handle into one)
// are unavailable.

import { sessionFolderEntries, type LocalFolderSource } from '../storage/localLibrary';
import { walkInline, type FolderWalker } from './localScan';
import type { ScanWorkerRequest, ScanWorkerResponse } from './scanWorkerProtocol';

let nextId = 1;

export const walkInWorker: FolderWalker = async (source, known, callbacks, signal) => {
  if (typeof Worker === 'undefined') return walkInline(source, known, callbacks, signal);

  let request: ScanWorkerRequest;
  if (source.handle) {
    request = { type: 'scan', id: nextId++, handle: source.handle, known: [...known] };
  } else {
    const entries = sessionFolderEntries(source.id);
    if (!entries) return walkInline(source, known, callbacks, signal); // throws "pick again"
    const files = await Promise.all(entries.map(async (e) => ({ path: e.path, file: await e.getFile() })));
    request = { type: 'scan', id: nextId++, files, known: [...known] };
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL('../workers/libraryScanWorker.ts', import.meta.url));
  } catch {
    return walkInline(source, known, callbacks, signal);
  }

  return new Promise((resolve, reject) => {
    // `files` batches write to IndexedDB in order; `done` resolves after the last write.
    let writes: Promise<void> = Promise.resolve();
    const finish = (settle: () => void) => {
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      settle();
    };
    const onAbort = () => finish(() => reject(new DOMException('Scan aborted', 'AbortError')));
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<ScanWorkerResponse>) => {
      const msg = event.data;
      if (msg.id !== request.id) return;
      switch (msg.type) {
        case 'files':
          writes = writes.then(() => callbacks.onFiles(msg.files));
          break;
        case 'progress':
          callbacks.onProgress?.(msg.scanned);
          break;
        case 'done':
          writes.then(
            () => finish(() => resolve({ seen: msg.seen, changed: msg.changed })),
            (err) => finish(() => reject(err)),
          );
          break;
        case 'error':
          finish(() => reject(Object.assign(new Error(msg.message), { name: msg.name })));
          break;
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(() => reject(new Error(event.message || 'Folder scan worker failed')));
    };
    try {
      worker.postMessage(request);
    } catch {
      // The handle would not clone into the worker: scan here instead.
      finish(() => resolve(walkInline(source as LocalFolderSource, known, callbacks, signal)));
    }
  });
};
