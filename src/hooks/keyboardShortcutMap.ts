/**
 * The global keyboard map. `useKeyboardShortcuts` dispatches from it and
 * `KeyboardHelpModal` renders it, so the help only lists keys that are wired.
 */

export interface ShortcutHandlers {
  onPlayPause?: () => void;
  onSeekForward?: () => void;
  onSeekBackward?: () => void;
  onVolumeUp?: () => void;
  onVolumeDown?: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onSearchFocus?: () => void;
  onToggleQueue?: () => void;
  onMute?: () => void;
  onShowHelp?: () => void;
}

export type ShortcutAction = keyof ShortcutHandlers;

export interface ShortcutDef {
  action: ShortcutAction;
  /** `KeyboardEvent.key`, compared case-insensitively. */
  key: string;
  /** Needs Ctrl or ⌘; every other shortcut needs neither (nor Alt). */
  mod?: boolean;
  /** Key caps shown in the help dialog. */
  caps: readonly string[];
  description: string;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { action: 'onPlayPause', key: ' ', caps: ['Space'], description: 'Play / Pause' },
  { action: 'onSeekBackward', key: 'ArrowLeft', caps: ['←'], description: 'Seek back 10 s' },
  { action: 'onSeekForward', key: 'ArrowRight', caps: ['→'], description: 'Seek forward 10 s' },
  { action: 'onVolumeUp', key: 'ArrowUp', caps: ['↑'], description: 'Volume up 10%' },
  { action: 'onVolumeDown', key: 'ArrowDown', caps: ['↓'], description: 'Volume down 10%' },
  { action: 'onNext', key: 'n', caps: ['N'], description: 'Next track' },
  { action: 'onPrevious', key: 'p', caps: ['P'], description: 'Previous track' },
  { action: 'onMute', key: 'm', caps: ['M'], description: 'Mute / Unmute' },
  { action: 'onToggleQueue', key: 'q', caps: ['Q'], description: 'Toggle queue panel' },
  { action: 'onShowHelp', key: '?', caps: ['?'], description: 'Show keyboard shortcuts' },
  { action: 'onSearchFocus', key: 'k', mod: true, caps: ['Ctrl/⌘', 'K'], description: 'Focus search box' },
];

/** Shortcuts that have a handler, in map order. */
export function listShortcuts(handlers: ShortcutHandlers): ShortcutDef[] {
  return SHORTCUTS.filter((def) => handlers[def.action] !== undefined);
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>;

export function matchShortcut(e: KeyLike): ShortcutDef | undefined {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return SHORTCUTS.find((def) => def.key === key && (def.mod ? mod : !mod && !e.altKey));
}

const TEXT_ENTRY = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** Controls where Space / Enter activate the control itself. */
const ACTIVATES = 'button, a[href], summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], ' +
  '[role="radio"], [role="tab"], [role="menuitem"], [role="option"]';
/** Widgets whose arrow keys move a value or selection. */
const ARROWS = '[role="slider"], [role="spinbutton"], [role="radiogroup"], [role="radio"], [role="tablist"], ' +
  '[role="listbox"], [role="menu"], [role="menubar"], [role="tree"], [role="grid"]';

/** True when the focused element uses this key itself, so the global shortcut must not fire. */
export function focusOwnsKey(target: EventTarget | null, def: ShortcutDef): boolean {
  if (!(target instanceof Element)) return false;
  if (def.mod) return false;
  if (target.closest(TEXT_ENTRY)) return true;
  if (def.key === ' ') return target.closest(ACTIVATES) !== null;
  if (def.key.startsWith('Arrow')) return target.closest(ARROWS) !== null;
  return false;
}
