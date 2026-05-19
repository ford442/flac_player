// src/components/FileDropZone.tsx
// Drag-and-drop zone + file picker for local audio files (FLAC, WAV, MP3).
import React, { useCallback, useRef, useState } from 'react';

interface FileDropZoneProps {
  onFiles: (files: File[]) => void;
}

export const FileDropZone: React.FC<FileDropZoneProps> = ({ onFiles }) => {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(
      f => f.name.endsWith('.flac') || f.name.endsWith('.wav') || f.name.endsWith('.mp3') || f.type.includes('audio')
    );
    if (files.length > 0) onFiles(files);
  }, [onFiles]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(
      f => f.name.endsWith('.flac') || f.name.endsWith('.wav') || f.name.endsWith('.mp3') || f.type.includes('audio')
    );
    if (files.length > 0) onFiles(files);
    e.target.value = '';
  }, [onFiles]);

  const handleButtonClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  return (
    <div
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={`p-4 border-2 border-dashed rounded-lg transition-colors cursor-pointer ${
        isDragging
          ? 'border-purple-400 bg-purple-500/10'
          : 'border-white/20 bg-white/5 hover:border-white/40 hover:bg-white/10'
      }`}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      aria-label="Drag and drop FLAC, WAV, or MP3 files here, or click to browse"
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
    >
      <p className="text-sm text-gray-400">Drop FLAC/WAV/MP3 files here</p>
      <p className="text-xs text-gray-500 mt-1">or click to browse</p>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".flac,.wav,.mp3,audio/flac,audio/wav,audio/x-wav,audio/mpeg,audio/mp3"
        onChange={handleFileInput}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  );
};

export default FileDropZone;
