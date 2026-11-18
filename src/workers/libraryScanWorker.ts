// Local folder scan off the main thread (#284): walks a directory handle (or the fallback
// pick's files), stats every audio file and tag-reads the new / changed ones. The main
// thread writes what comes back into the catalog (`catalog/localScan.ts`).

import { scanFolderEntries } from '../catalog/folderScanCore';
import { walkDirectory, type FolderEntry } from '../storage/folderWalk';
import type { ScanWorkerRequest, ScanWorkerResponse } from '../catalog/scanWorkerProtocol';

const ctx = self as unknown as {
  postMessage(message: ScanWorkerResponse): void;
  onmessage: ((event: MessageEvent<ScanWorkerRequest>) => void) | null;
};

function fileEntries(files: { path: string; file: File }[]): FolderEntry[] {
  return files.map(({ path, file }) => ({ path, getFile: async () => file }));
}

ctx.onmessage = (event) => {
  const request = event.data;
  if (request.type !== 'scan') return;
  const { id } = request;
  const entries = request.handle ? walkDirectory(request.handle) : fileEntries(request.files ?? []);
  void scanFolderEntries(entries, new Map(request.known), {
    onFiles: (files) => ctx.postMessage({ type: 'files', id, files }),
    onProgress: (scanned) => ctx.postMessage({ type: 'progress', id, scanned }),
  }).then(
    ({ seen, changed }) => ctx.postMessage({ type: 'done', id, seen, changed }),
    (err: unknown) => ctx.postMessage({
      type: 'error',
      id,
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : String(err),
    }),
  );
};
