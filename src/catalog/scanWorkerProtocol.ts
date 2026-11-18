// Messages between `catalog/scanWorkerClient.ts` and `workers/libraryScanWorker.ts`.

import type { DirectoryHandle } from '../storage/folderWalk';
import type { KnownFile, ScannedFile } from './folderScanCore';

export type ScanWorkerRequest = {
  type: 'scan';
  id: number;
  /** Picker folders: the handle is structured-cloned into the worker. */
  handle?: DirectoryHandle;
  /** `webkitdirectory` folders: this page's files. */
  files?: { path: string; file: File }[];
  known: [string, KnownFile][];
};

export type ScanWorkerResponse =
  | { type: 'files'; id: number; files: ScannedFile[] }
  | { type: 'progress'; id: number; scanned: number }
  | { type: 'done'; id: number; seen: string[]; changed: number }
  | { type: 'error'; id: number; name: string; message: string };
