import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Keyboard shortcuts (spec §4.8). A key is a chord (`k`, `mod+k`, `shift+?`) or a sequence of chords separated by
 * spaces (`g u`: g, then u within a second). `mod` is Ctrl or ⌘, whichever the user presses, so `mod+k` works on
 * every system. While the user types in a field (input, textarea, select, contenteditable) only chords with `mod`
 * fire. A matching key's default action is prevented.
 */

const SEQUENCE_TIMEOUT_MS = 1000;

interface Chord {
  key: string;
  mod: boolean;
  alt: boolean;
  shift: boolean;
}

function parseChord(text: string): Chord {
  const parts = text.toLowerCase().split('+');
  const key = parts.pop() ?? '';
  return { key, mod: parts.includes('mod'), alt: parts.includes('alt'), shift: parts.includes('shift') };
}

function matches(chord: Chord, e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  if (chord.mod !== mod || chord.alt !== e.altKey) return false;
  // Shift is only compared when the chord names it: `?` already implies it on most layouts.
  if (chord.shift && !e.shiftKey) return false;
  return e.key.toLowerCase() === chord.key;
}

/** Whether keys typed at `target` are text for a field (an input, textarea, select or contenteditable element). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(target.type);
  }
  return target instanceof HTMLElement && (target.isContentEditable || target.closest('[contenteditable="true"],[contenteditable=""]') !== null);
}

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'CapsLock', 'AltGraph']);

/** Registers `map` (key → handler) on the window while the calling component is mounted. */
export function useShortcuts(map: Record<string, (e: KeyboardEvent) => void>): void {
  const latest = useRef(map);
  useLayoutEffect(() => {
    latest.current = map;
  });
  const signature = Object.keys(map).sort().join('\n');

  useEffect(() => {
    const bindings = signature
      .split('\n')
      .filter((key) => key !== '')
      .map((key) => ({ key, chords: key.trim().split(/\s+/).map(parseChord) }));
    let history: KeyboardEvent[] = [];
    let last = 0;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || MODIFIER_KEYS.has(e.key)) return;
      const now = Date.now();
      if (now - last > SEQUENCE_TIMEOUT_MS) history = [];
      last = now;
      const typing = isTypingTarget(e.target);
      history = [...history, e].slice(-8);
      for (const { key, chords } of bindings) {
        const chord = chords[chords.length - 1]!;
        if (typing && !chord.mod) continue;
        if (chords.length > history.length) continue;
        const tail = history.slice(history.length - chords.length);
        if (!chords.every((c, i) => matches(c, tail[i]!))) continue;
        if (chords.length > 1 && tail.some((event) => isTypingTarget(event.target))) continue;
        e.preventDefault();
        history = [];
        latest.current[key]?.(e);
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [signature]);
}
