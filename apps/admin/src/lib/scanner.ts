import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Barcode scanners (spec §4.8; the first user is the Phase 3 service desk). A USB or Bluetooth scanner is a keyboard
 * that types a burst of characters, a few milliseconds apart, and ends with Enter; nobody types that fast.
 *
 * While the hook is mounted, every printable key (no Ctrl, ⌘ or Alt; not a key repeat or an IME composition) counts
 * towards a burst, until the next key comes within `maxGapMs` (listened to in the capture phase on the window):
 * - A key aimed at a writable text field (a textarea, or an input of type text, search, url, tel or password; not
 *   read-only or disabled) is held back before it reaches the page, because only there can it be typed back
 *   faithfully: at the caret, within `maxLength`.
 * - A key aimed at anything else (the page, a button, a select, a checkbox, a link, an email or number field, a
 *   contenteditable element) passes at once and untouched, so its native action and the page's shortcuts are kept;
 *   it is only recorded for the scan.
 * - Enter while the burst has at least `minLength` keys → `onScan(<the burst>)`; the held keys never reach the field,
 *   and the Enter is the scanner's, not the user's, so it is consumed (it does not submit a form or press the focused
 *   button or link).
 * - Otherwise (the gap ran out, or another key came) the burst is typing: each held key is sent again as a keydown to
 *   where it was aimed (React handlers see it) and, unless a handler cancels it, typed into its field, then the new
 *   key passes as usual. Typing into a text field is delayed by `maxGapMs` at most.
 */
export interface ScannerOptions {
  onScan(code: string): void;
  /** The fewest characters a scan has (default 4). */
  minLength?: number;
  /** The longest pause between two characters of one scan, in ms (default 30). */
  maxGapMs?: number;
}

interface BurstKey {
  event: KeyboardEvent;
  target: EventTarget | null;
  /** Held back (to be replayed unless it was part of a scan), or passed at once. */
  held: boolean;
}

/** Input types with a caret (the selection API), so a held key can be typed back where the user aimed it. */
const CARET_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password']);

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** Whether a key aimed at `target` can be held back and typed back faithfully: a writable text field with a caret. */
function isReplayableField(target: EventTarget | null): target is TextField {
  if (target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && CARET_INPUT_TYPES.has(target.type))) {
    return !target.readOnly && !target.disabled;
  }
  return false;
}

/**
 * Types `text` into a text field at its caret, the way the browser would have (replacing the selection, never past
 * `maxLength`), so React sees the change. A field that takes nothing more gets no `input` event, as in the browser.
 */
function typeInto(target: EventTarget | null, text: string): void {
  if (!isReplayableField(target)) return;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  let insert = text;
  if (target.maxLength >= 0) {
    const room = target.maxLength - (target.value.length - (end - start));
    if (room <= 0) return;
    insert = text.slice(0, room);
  }
  target.setRangeText(insert, start, end, 'end');
  target.dispatchEvent(new InputEvent('input', { bubbles: true, data: insert, inputType: 'insertText' }));
}

const isPrintable = (e: KeyboardEvent): boolean => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat && !e.isComposing;

/** Listens for scans while the calling component is mounted (see {@link ScannerOptions}). */
export function useScannerInput(o: ScannerOptions): void {
  const latest = useRef(o);
  useLayoutEffect(() => {
    latest.current = o;
  });

  useEffect(() => {
    let burst: BurstKey[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const replayed = new WeakSet<Event>();

    const replay = ({ event, target }: BurstKey): void => {
      if (target === null) return;
      const copy = new KeyboardEvent('keydown', {
        key: event.key,
        code: event.code,
        location: event.location,
        shiftKey: event.shiftKey,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      replayed.add(copy);
      if (target.dispatchEvent(copy)) typeInto(target, event.key);
    };

    /** Ends the burst as typing: the held keys are typed back; the others have already passed. */
    const flush = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const keys = burst;
      burst = [];
      keys.filter((k) => k.held).forEach(replay);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (replayed.has(e)) return;
      const minLength = latest.current.minLength ?? 4;
      const maxGapMs = latest.current.maxGapMs ?? 30;
      if (isPrintable(e)) {
        const held = isReplayableField(e.target);
        if (held) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        burst.push({ event: e, target: e.target, held });
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(flush, maxGapMs);
        return;
      }
      if (e.key === 'Enter' && timer !== undefined && burst.length >= minLength) {
        e.preventDefault();
        e.stopImmediatePropagation();
        clearTimeout(timer);
        timer = undefined;
        const code = burst.map((k) => k.event.key).join('');
        burst = [];
        latest.current.onScan(code);
        return;
      }
      if (burst.length > 0) flush();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      flush();
    };
  }, []);
}
