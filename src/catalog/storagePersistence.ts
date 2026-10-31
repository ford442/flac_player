// Persistent storage for the catalog and offline audio: asked for once, after the
// first import, so eviction under storage pressure doesn't take the library with it.

import { readState, writeState, type CatalogDb } from './db';

const PERSIST_ASKED_KEY = 'storagePersistAsked';

export interface StorageStatus {
  usage?: number;
  quota?: number;
  /** Undefined where the browser has no StorageManager. */
  persisted?: boolean;
}

const storageManager = (): StorageManager | undefined =>
  typeof navigator !== 'undefined' ? navigator.storage : undefined;

export async function requestPersistentStorage(): Promise<boolean> {
  const storage = storageManager();
  if (!storage?.persist) return false;
  try {
    return (await storage.persisted?.()) || await storage.persist();
  } catch {
    return false;
  }
}

/** Ask once per profile; Firefox shows a prompt, so never on every load. */
export async function requestPersistentStorageOnce(db: CatalogDb): Promise<void> {
  if (await readState<boolean>(db, PERSIST_ASKED_KEY)) return;
  await writeState(db, PERSIST_ASKED_KEY, true);
  await requestPersistentStorage();
}

export async function readStorageStatus(): Promise<StorageStatus> {
  const storage = storageManager();
  if (!storage) return {};
  const [estimate, persisted] = await Promise.all([
    storage.estimate?.().catch(() => undefined),
    storage.persisted?.().catch(() => undefined),
  ]);
  return { usage: estimate?.usage, quota: estimate?.quota, persisted };
}
