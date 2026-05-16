import { useEffect, useCallback, useRef } from 'react';

interface KeyboardShortcutsOptions {
  onPlayPause?: () => void;
  onSeekForward?: () => void;
  onSeekBackward?: () => void;
  onVolumeUp?: () => void;
  onVolumeDown?: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onRate?: () => void;
  onSearchFocus?: () => void;
  onToggleQueue?: () => void;
  onTogglePile?: () => void;
  onMute?: () => void;
  onShowHelp?: () => void;
  isEnabled?: boolean;
}

export function useKeyboardShortcuts({
  onPlayPause,
  onSeekForward,
  onSeekBackward,
  onVolumeUp,
  onVolumeDown,
  onNext,
  onPrevious,
  onRate,
  onSearchFocus,
  onToggleQueue,
  onTogglePile,
  onMute,
  onShowHelp,
  isEnabled = true
}: KeyboardShortcutsOptions) {
  const callbacksRef = useRef({
    onPlayPause,
    onSeekForward,
    onSeekBackward,
    onVolumeUp,
    onVolumeDown,
    onNext,
    onPrevious,
    onRate,
    onSearchFocus,
    onToggleQueue,
    onTogglePile,
    onMute,
    onShowHelp,
  });
  
  // Update callbacks ref when they change
  useEffect(() => {
    callbacksRef.current = {
      onPlayPause,
      onSeekForward,
      onSeekBackward,
      onVolumeUp,
      onVolumeDown,
      onNext,
      onPrevious,
      onRate,
      onSearchFocus,
      onToggleQueue,
      onTogglePile,
      onMute,
      onShowHelp,
    };
  }, [
    onPlayPause,
    onSeekForward,
    onSeekBackward,
    onVolumeUp,
    onVolumeDown,
    onNext,
    onPrevious,
    onRate,
    onSearchFocus,
    onToggleQueue,
    onTogglePile,
    onMute,
    onShowHelp,
  ]);
  
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isEnabled) return;
    
    // Don't trigger shortcuts when typing in input fields
    const target = e.target as HTMLElement;
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.contentEditable === 'true'
    ) {
      // Allow Escape even in inputs
      if (e.key !== 'Escape') return;
    }
    
    const { current: callbacks } = callbacksRef;
    
    switch (e.key) {
      case ' ':
        e.preventDefault();
        callbacks.onPlayPause?.();
        break;
        
      case 'ArrowRight':
        e.preventDefault();
        callbacks.onSeekForward?.();
        break;
        
      case 'ArrowLeft':
        e.preventDefault();
        callbacks.onSeekBackward?.();
        break;
        
      case 'ArrowUp':
        e.preventDefault();
        callbacks.onVolumeUp?.();
        break;
        
      case 'ArrowDown':
        e.preventDefault();
        callbacks.onVolumeDown?.();
        break;
        
      case 'n':
      case 'N':
        if (!e.ctrlKey && !e.metaKey) {
          callbacks.onNext?.();
        }
        break;
        
      case 'p':
      case 'P':
        if (!e.ctrlKey && !e.metaKey) {
          callbacks.onPrevious?.();
        }
        break;
        
      case 'r':
      case 'R':
        if (!e.ctrlKey && !e.metaKey) {
          callbacks.onRate?.();
        }
        break;
        
      case 'q':
      case 'Q':
        if (!e.ctrlKey && !e.metaKey) {
          callbacks.onToggleQueue?.();
        }
        break;
        
      case 's':
      case 'S':
        if (!e.ctrlKey && !e.metaKey) {
          callbacks.onTogglePile?.();
        }
        break;
        
      case 'm':
      case 'M':
        if (!e.ctrlKey && !e.metaKey) {
          callbacks.onMute?.();
        }
        break;

      case '?':
        if (!e.ctrlKey && !e.metaKey) {
          callbacks.onShowHelp?.();
        }
        break;
        
      case 'k':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          callbacks.onSearchFocus?.();
        }
        break;
    }
  }, [isEnabled]);
  
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

export default useKeyboardShortcuts;
