// Local folders in the library (#284): the granted folders, their access state, and
// add / reconnect / rescan / remove. Scans run in the scan worker and write the catalog,
// so the library view (a live query) fills in as they go.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { scanLocalFolder } from '../catalog/localScan';
import { walkInWorker } from '../catalog/scanWorkerClient';
import { getCatalogDb, type CatalogDb } from '../catalog/db';
import {
  addFolderFromFiles, folderAccess, listLocalFolders, pickFolder, removeFolder, requestFolderAccess,
  supportsPersistentFolders, type FolderAccess, type LocalFolderSource,
} from '../storage/localLibrary';
import type { FolderWalker } from '../catalog/localScan';

type Notify = (message: string, type: 'success' | 'error' | 'info') => void;

export interface LocalFolderView {
  id: string;
  label: string;
  /** `folder`: remembered across reloads; `files`: this page only (no File System Access). */
  kind: 'folder' | 'files';
  trackCount: number;
  lastSyncAt?: number;
  /** `checking` until the first permission query answers. */
  access: FolderAccess | 'checking';
  /** Files seen so far while a scan runs; null when idle. */
  scanning: number | null;
}

export interface LocalFoldersController {
  folders: LocalFolderView[];
  /** False on browsers without `showDirectoryPicker`: folders must be re-picked after a reload. */
  persistent: boolean;
  /** IndexedDB is unusable: folders cannot be remembered at all. */
  unavailable: boolean;
  /** Show the directory picker; false where there is none (use `addFromFiles`). */
  addFolder(): Promise<boolean>;
  addFromFiles(files: ArrayLike<File>): Promise<void>;
  /** Ask for access again (from a click) and rescan. */
  reconnect(id: string): Promise<void>;
  rescan(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

type LiveFolders = { folders: LocalFolderSource[] } | { failed: true };

export function useLocalFolders(
  notify: Notify,
  { db = getCatalogDb(), walk = walkInWorker, autoRescan = true }: { db?: CatalogDb; walk?: FolderWalker; autoRescan?: boolean } = {},
): LocalFoldersController {
  const live = useLiveQuery<LiveFolders>(async () => {
    try { return { folders: await listLocalFolders(db) }; } catch { return { failed: true }; }
  }, [db]);
  const sources = useMemo(() => (live && 'folders' in live ? live.folders : []), [live]);

  const [access, setAccess] = useState<Record<string, FolderAccess>>({});
  const [scanning, setScanning] = useState<Record<string, number>>({});
  const scans = useRef(new Map<string, AbortController>());
  const autoScanned = useRef(new Set<string>());
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const recheck = useCallback(async (list: readonly LocalFolderSource[]) => {
    const entries = await Promise.all(list.map(async (s) => [s.id, await folderAccess(s)] as const));
    setAccess((prev) => (entries.every(([id, a]) => prev[id] === a) ? prev : { ...prev, ...Object.fromEntries(entries) }));
    return Object.fromEntries(entries) as Record<string, FolderAccess>;
  }, []);

  const scan = useCallback(async (source: LocalFolderSource, { quiet = false } = {}) => {
    if (scans.current.has(source.id)) return;
    const controller = new AbortController();
    scans.current.set(source.id, controller);
    setScanning((prev) => ({ ...prev, [source.id]: 0 }));
    try {
      const result = await scanLocalFolder(source, {
        db, walk, signal: controller.signal,
        onProgress: (n) => setScanning((prev) => (source.id in prev ? { ...prev, [source.id]: n } : prev)),
      });
      if (!quiet || result.changed > 0 || result.removed > 0) {
        const changes = [
          result.changed > 0 && `${result.changed} new or changed`,
          result.removed > 0 && `${result.removed} removed`,
        ].filter(Boolean).join(', ');
        notifyRef.current(
          result.scanned === 0
            ? `No FLAC or WAV files in "${source.label}"`
            : `"${source.label}": ${result.scanned} tracks${changes ? ` (${changes})` : ''}`,
          result.scanned === 0 ? 'info' : 'success',
        );
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      // Access lost (revoked, or a fallback folder after reload): the panel shows Reconnect
      // and the rows stay. Only a scan failure with access intact is an error.
      const states = await recheck([source]);
      if (states[source.id] === 'granted') {
        notifyRef.current(`Could not scan "${source.label}": ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    } finally {
      scans.current.delete(source.id);
      setScanning((prev) => {
        const { [source.id]: _done, ...rest } = prev;
        void _done;
        return rest;
      });
    }
  }, [db, walk, recheck]);

  // Access state for every folder; granted folders are rescanned once per page load.
  useEffect(() => {
    let cancelled = false;
    void recheck(sources).then((states) => {
      if (cancelled || !autoRescan) return;
      for (const source of sources) {
        if (states[source.id] !== 'granted' || autoScanned.current.has(source.id)) continue;
        autoScanned.current.add(source.id);
        void scan(source, { quiet: true });
      }
    });
    return () => { cancelled = true; };
  }, [sources, recheck, scan, autoRescan]);

  // A grant revoked in site settings shows up when the tab comes back.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void recheck(sources); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [sources, recheck]);

  useEffect(() => () => {
    scans.current.forEach((c) => c.abort());
    scans.current.clear();
  }, []);

  const addFolder = useCallback(async () => {
    if (!supportsPersistentFolders()) return false;
    try {
      const source = await pickFolder(db);
      if (source) {
        autoScanned.current.add(source.id);
        setAccess((prev) => ({ ...prev, [source.id]: 'granted' }));
        await scan(source);
      }
    } catch (err) {
      notifyRef.current(`Could not add the folder: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    return true;
  }, [db, scan]);

  const addFromFiles = useCallback(async (files: ArrayLike<File>) => {
    try {
      const source = await addFolderFromFiles(files, db);
      if (!source) {
        notifyRef.current('That folder is empty', 'info');
        return;
      }
      autoScanned.current.add(source.id);
      setAccess((prev) => ({ ...prev, [source.id]: 'granted' }));
      await scan(source);
    } catch (err) {
      notifyRef.current(`Could not add the folder: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [db, scan]);

  const byId = useCallback((id: string) => sources.find((s) => s.id === id), [sources]);

  const reconnect = useCallback(async (id: string) => {
    const source = byId(id);
    if (!source) return;
    // First thing in the click: requestPermission needs the user activation.
    const state = await requestFolderAccess(source);
    setAccess((prev) => ({ ...prev, [id]: state }));
    if (state === 'granted') await scan(source);
    else if (state === 'denied') notifyRef.current(`Access to "${source.label}" was denied`, 'info');
  }, [byId, scan]);

  const rescan = useCallback(async (id: string) => {
    const source = byId(id);
    if (source) await scan(source);
  }, [byId, scan]);

  const remove = useCallback(async (id: string) => {
    scans.current.get(id)?.abort();
    const label = byId(id)?.label;
    try {
      await removeFolder(id, db);
      autoScanned.current.delete(id);
      if (label) notifyRef.current(`Removed "${label}" from the library (files on disk are untouched)`, 'info');
    } catch {
      notifyRef.current('Could not remove the folder', 'error');
    }
  }, [byId, db]);

  const folders = useMemo<LocalFolderView[]>(() => sources.map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    trackCount: s.trackCount,
    lastSyncAt: s.lastSyncAt,
    access: access[s.id] ?? 'checking',
    scanning: s.id in scanning ? scanning[s.id]! : null,
  })), [sources, access, scanning]);

  return {
    folders,
    persistent: supportsPersistentFolders(),
    unavailable: !!live && 'failed' in live,
    addFolder, addFromFiles, reconnect, rescan, remove,
  };
}
