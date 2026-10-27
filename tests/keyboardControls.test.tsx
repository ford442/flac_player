import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { SHORTCUTS, focusOwnsKey, listShortcuts, matchShortcut } from '../src/hooks/keyboardShortcutMap';
import { useKeyboardShortcuts } from '../src/hooks/useKeyboardShortcuts';
import { sliderKeyValue } from '../src/utils/sliderKeys';
import { placeholderBars } from '../src/components/library/trackFormat';
import { Knob } from '../src/components/ShaderGUI/Knob';
import { KeyboardHelpModal } from '../src/components/KeyboardHelpModal';

const key = (k: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

afterEach(cleanup);

describe('keyboard shortcut map', () => {
  it('matches keys case-insensitively and keeps modifiers apart', () => {
    expect(matchShortcut(key('N'))?.action).toBe('onNext');
    expect(matchShortcut(key('n', { ctrlKey: true }))).toBeUndefined();
    expect(matchShortcut(key('ArrowLeft', { altKey: true }))).toBeUndefined();
    expect(matchShortcut(key('k'))).toBeUndefined();
    expect(matchShortcut(key('k', { metaKey: true }))?.action).toBe('onSearchFocus');
  });

  it('lists only the shortcuts that have handlers', () => {
    const listed = listShortcuts({ onPlayPause: () => {}, onMute: () => {} }).map(s => s.action);
    expect(listed).toEqual(['onPlayPause', 'onMute']);
    expect(SHORTCUTS.map(s => s.key)).not.toContain('s');
  });

  it('leaves keys to the focused control that uses them', () => {
    const space = SHORTCUTS.find(s => s.key === ' ')!;
    const left = SHORTCUTS.find(s => s.key === 'ArrowLeft')!;
    const search = SHORTCUTS.find(s => s.action === 'onSearchFocus')!;
    const el = (html: string) => {
      document.body.innerHTML = html;
      return document.body.firstElementChild!;
    };
    expect(focusOwnsKey(el('<button>Go</button>'), space)).toBe(true);
    expect(focusOwnsKey(el('<button>Go</button>'), left)).toBe(false);
    expect(focusOwnsKey(el('<select><option>a</option></select>'), left)).toBe(true);
    expect(focusOwnsKey(el('<div role="slider" tabindex="0"></div>'), left)).toBe(true);
    expect(focusOwnsKey(el('<div role="radiogroup"><span>x</span></div>').firstElementChild, left)).toBe(true);
    expect(focusOwnsKey(el('<input>'), search)).toBe(false);
    expect(focusOwnsKey(document.body, space)).toBe(false);
  });

  it('the hook skips keys a control already handled', () => {
    const onPlayPause = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onPlayPause }));
    const handled = new KeyboardEvent('keydown', { key: ' ', cancelable: true, bubbles: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(onPlayPause).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', cancelable: true }));
    expect(onPlayPause).toHaveBeenCalledTimes(1);
  });

  it('the help dialog renders exactly the shortcuts it is given', () => {
    render(<KeyboardHelpModal shortcuts={listShortcuts({ onNext: () => {} })} onClose={() => {}} />);
    expect(screen.getByText('Next track')).toBeTruthy();
    expect(screen.queryByText('Play / Pause')).toBeNull();
  });
});

describe('sliderKeyValue', () => {
  it('follows the APG slider keys and clamps', () => {
    const opts = { step: 0.1, page: 0.25 };
    expect(sliderKeyValue('ArrowUp', 0.5, opts)).toBeCloseTo(0.6);
    expect(sliderKeyValue('ArrowLeft', 0.5, opts)).toBeCloseTo(0.4);
    expect(sliderKeyValue('PageDown', 0.1, opts)).toBe(0);
    expect(sliderKeyValue('End', 0.1, { ...opts, max: 300 })).toBe(300);
    expect(sliderKeyValue('Home', 0.7, opts)).toBe(0);
    expect(sliderKeyValue('Enter', 0.7, opts)).toBeNull();
  });
});

describe('Knob', () => {
  it('is a keyboard slider that reports every change', () => {
    const onChange = vi.fn();
    render(<Knob label="PULSE" initialValue={0} onChange={onChange} />);
    const knob = screen.getByRole('slider', { name: 'PULSE' });
    expect(knob.getAttribute('tabindex')).toBe('0');
    act(() => { fireEvent.keyDown(knob, { key: 'PageUp' }); });
    expect(knob.getAttribute('aria-valuenow')).toBe('10');
    expect(onChange).toHaveBeenLastCalledWith(0.1);
    act(() => { fireEvent.keyDown(knob, { key: 'End' }); });
    expect(onChange).toHaveBeenLastCalledWith(1);
    act(() => { fireEvent.doubleClick(knob); });
    expect(onChange).toHaveBeenLastCalledWith(0.5);
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe('placeholderBars', () => {
  it('is stable per track id', () => {
    expect(placeholderBars('track-1')).toEqual(placeholderBars('track-1'));
    expect(placeholderBars('track-1')).not.toEqual(placeholderBars('track-2'));
    expect(placeholderBars('x').every(h => h >= 30 && h < 90)).toBe(true);
  });
});
