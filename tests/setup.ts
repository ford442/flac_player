/** Reset storage and visualizer module singletons between tests. */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import { closeCatalogDb } from '../src/catalog/db';

beforeEach(() => {
  // A fresh IndexedDB per test: the catalog singleton reopens on the new factory.
  closeCatalogDb();
  globalThis.indexedDB = new IDBFactory();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* jsdom may block in some environments */
  }
  delete (window as unknown as { DEBUG_VISUALIZER?: string }).DEBUG_VISUALIZER;
  delete (window as unknown as { __gpuChores?: unknown }).__gpuChores;
});
