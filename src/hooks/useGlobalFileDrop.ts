import { useEffect, useRef, useState } from 'react';

const isAudioFile = (f: File) =>
  f.name.endsWith('.flac') || f.name.endsWith('.wav') || f.name.endsWith('.mp3') || f.type.includes('audio');

/** Audio files dropped anywhere on the page go to `onFiles`; returns whether a drag is over the page. */
export function useGlobalFileDrop(onFiles: (files: File[]) => void): boolean {
  const [isDragging, setIsDragging] = useState(false);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setIsDragging(true); }
    };
    const onDragLeave = (e: DragEvent) => { if (e.relatedTarget === null) setIsDragging(false); };
    const onDrop = (e: DragEvent) => {
      setIsDragging(false);
      if (!e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files).filter(isAudioFile);
      if (files.length > 0) { e.preventDefault(); onFilesRef.current(files); }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return isDragging;
}
