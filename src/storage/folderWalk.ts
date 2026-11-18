// Folder enumeration shared by the main thread and the scan worker (#284). No catalog
// or DOM dependencies, so the worker bundle stays small.

/** File types a folder scan lists. Both play on the hi-fi graph (FLAC streams; WAV decodes whole). */
export const LOCAL_AUDIO_EXTENSIONS = ['.flac', '.wav', '.wave'] as const;

export function isLocalAudioName(name: string): boolean {
  const lower = name.toLowerCase();
  return !lower.startsWith('.') && LOCAL_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// --- File System Access typings (not in this TypeScript's lib.dom) -----------------

type PermissionMode = { mode: 'read' | 'readwrite' };

export interface PermissionedHandle {
  queryPermission?(descriptor: PermissionMode): Promise<PermissionState>;
  requestPermission?(descriptor: PermissionMode): Promise<PermissionState>;
}

export type DirectoryHandle = FileSystemDirectoryHandle & PermissionedHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

export interface FolderEntry {
  path: string;
  getFile(): Promise<File>;
}

/** Audio files below `dir`, depth first; dot-folders are skipped. */
export async function* walkDirectory(dir: DirectoryHandle, prefix = ''): AsyncGenerator<FolderEntry> {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') {
      if (!name.startsWith('.')) yield* walkDirectory(handle as DirectoryHandle, `${prefix}${name}/`);
    } else if (isLocalAudioName(name)) {
      const fileHandle = handle as FileSystemFileHandle;
      yield { path: `${prefix}${name}`, getFile: () => fileHandle.getFile() };
    }
  }
}

