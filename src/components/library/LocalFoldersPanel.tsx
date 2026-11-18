import React, { useEffect, useId, useRef } from 'react';
import { useLocalFolders, type LocalFolderView, type LocalFoldersController } from '../../hooks/useLocalFolders';
import { useNotify } from '../../player/selectors';

/** Sidebar section for local folders (#284): add, scan progress, reconnect, remove. */
export const LocalFoldersPanel: React.FC = () => {
  const notify = useNotify();
  return <LocalFoldersPanelView controller={useLocalFolders(notify)} />;
};

export const LocalFoldersPanelView: React.FC<{ controller: LocalFoldersController }> = ({ controller }) => {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const { folders, persistent, unavailable } = controller;

  // React has no typed `webkitdirectory` prop; set it on the element.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  const pickFiles = () => inputRef.current?.click();
  const add = async () => {
    if (!(await controller.addFolder())) pickFiles();
  };

  return (
    <section aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="text-xs text-gray-400 uppercase mb-2">Local Folders</h3>
      {folders.length > 0 && (
        <ul className="space-y-2 mb-2" aria-label="Local folders">
          {folders.map((folder) => (
            <FolderItem key={folder.id} folder={folder} controller={controller} onPickFiles={pickFiles} />
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => { void add(); }}
        disabled={unavailable}
        className="w-full px-3 py-2 text-sm bg-white/10 rounded-lg hover:bg-white/20 disabled:opacity-40"
      >
        📁 Add folder
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        aria-label="Choose a folder"
        tabIndex={-1}
        data-testid="local-folder-input"
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0) void controller.addFromFiles(files);
          e.target.value = '';
        }}
      />
      {unavailable ? (
        <p className="text-xs text-red-300 mt-2">Browser storage is blocked, so folders cannot be added.</p>
      ) : !persistent && (
        <p className="text-xs text-gray-400 mt-2">
          This browser cannot remember folders: after a reload, pick the folder again to play its tracks.
        </p>
      )}
    </section>
  );
};

function describe(folder: LocalFolderView): string {
  if (folder.scanning !== null) return `Scanning… ${folder.scanning} files`;
  switch (folder.access) {
    case 'checking': return `${folder.trackCount} tracks`;
    case 'granted': return `${folder.trackCount} tracks`;
    case 'unavailable': return 'Pick this folder again to play it';
    case 'denied': return 'Access denied';
    case 'prompt': return 'Access needs to be granted again';
  }
}

const FolderItem: React.FC<{
  folder: LocalFolderView;
  controller: LocalFoldersController;
  onPickFiles: () => void;
}> = ({ folder, controller, onPickFiles }) => {
  const needsAccess = folder.access === 'prompt' || folder.access === 'denied' || folder.access === 'unavailable';
  const scanning = folder.scanning !== null;
  return (
    <li className="text-sm" data-testid="local-folder" data-access={folder.access}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-gray-200" title={folder.label}>📁 {folder.label}</span>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Remove "${folder.label}" from the library? Files on disk are not touched.`)) void controller.remove(folder.id);
          }}
          className="text-xs text-gray-400 hover:text-red-400"
          aria-label={`Remove ${folder.label}`}
          title="Remove from library"
        >
          ✕
        </button>
      </div>
      <p className={`text-xs ${needsAccess ? 'text-amber-300' : 'text-gray-400'}`} role={needsAccess ? 'status' : undefined}>
        {describe(folder)}
      </p>
      <div className="flex gap-2 mt-1">
        {needsAccess ? (
          <button
            type="button"
            onClick={() => { if (folder.kind === 'files') onPickFiles(); else void controller.reconnect(folder.id); }}
            className="px-2 py-1 text-xs bg-purple-500/30 text-purple-200 rounded hover:bg-purple-500/50"
          >
            {folder.kind === 'files' ? 'Pick folder again' : 'Reconnect'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => { void controller.rescan(folder.id); }}
            disabled={scanning || folder.access === 'checking'}
            className="px-2 py-1 text-xs bg-white/10 rounded hover:bg-white/20 disabled:opacity-40"
          >
            Rescan
          </button>
        )}
      </div>
    </li>
  );
};
