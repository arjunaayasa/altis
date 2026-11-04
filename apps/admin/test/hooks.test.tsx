import { render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScannerInput } from '@/lib/scanner';
import { useShortcuts } from '@/lib/shortcuts';

// Spec §4.8: `useShortcuts` (keyboard shortcuts) and `useScannerInput` (a barcode scanner types a burst of characters
// ending with Enter; the first user is the Phase 3 service desk). Both only add convenience: the server refuses
// whatever the menus hide.

function key(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('useShortcuts', () => {
  it("'mod+k' fires on Ctrl+K and on ⌘+K, and prevents the browser's own action", () => {
    const f = vi.fn();
    renderHook(() => useShortcuts({ 'mod+k': f }));
    const ctrl = key(document.body, { key: 'k', ctrlKey: true });
    const meta = key(document.body, { key: 'K', metaKey: true });
    expect(f).toHaveBeenCalledTimes(2);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(meta.defaultPrevented).toBe(true);
    key(document.body, { key: 'k' });
    key(document.body, { key: 'k', ctrlKey: true, altKey: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("'mod+k' fires while typing in an input (it has mod)", () => {
    const f = vi.fn();
    renderHook(() => useShortcuts({ 'mod+k': f }));
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    key(input, { key: 'k', ctrlKey: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("the sequence 'g u' fires on g then u, and not while an input has focus", () => {
    const f = vi.fn();
    renderHook(() => useShortcuts({ 'g u': f }));
    key(document.body, { key: 'g' });
    key(document.body, { key: 'u' });
    expect(f).toHaveBeenCalledTimes(1);

    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    key(input, { key: 'g' });
    key(input, { key: 'u' });
    expect(f).toHaveBeenCalledTimes(1);

    const area = document.createElement('textarea');
    document.body.append(area);
    key(area, { key: 'g' });
    key(area, { key: 'u' });
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(editable);
    key(editable, { key: 'g' });
    key(editable, { key: 'u' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a sequence expires after a second, and another key in between breaks it', () => {
    vi.useFakeTimers();
    const f = vi.fn();
    renderHook(() => useShortcuts({ 'g u': f }));
    key(document.body, { key: 'g' });
    vi.advanceTimersByTime(1500);
    key(document.body, { key: 'u' });
    key(document.body, { key: 'g' });
    key(document.body, { key: 'x' });
    key(document.body, { key: 'u' });
    expect(f).not.toHaveBeenCalled();
  });

  it('calls the latest handler and stops listening when unmounted', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ f }) => useShortcuts({ 'mod+k': f }), { initialProps: { f: first } });
    rerender({ f: second });
    key(document.body, { key: 'k', ctrlKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
    key(document.body, { key: 'k', ctrlKey: true });
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('useScannerInput', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  function Field({ onScan, onKey }: { onScan: (code: string) => void; onKey: (key: string) => void }) {
    useScannerInput({ onScan });
    return <input aria-label="field" onKeyDown={(e) => onKey(e.key)} />;
  }

  function typeKeys(target: HTMLElement, keys: string[], gapMs: number): void {
    for (const k of keys) {
      key(target, { key: k });
      vi.advanceTimersByTime(gapMs);
    }
  }

  it('1 2 3 4 5 6 typed 10 ms apart plus Enter → onScan("123456"), and the keys never reach the focused field', () => {
    const onScan = vi.fn();
    const onKey = vi.fn();
    const { getByLabelText } = render(<Field onScan={onScan} onKey={onKey} />);
    const input = getByLabelText('field') as HTMLInputElement;
    input.focus();
    typeKeys(input, ['1', '2', '3', '4', '5', '6'], 10);
    const enter = key(input, { key: 'Enter' });
    expect(onScan).toHaveBeenCalledExactlyOnceWith('123456');
    expect(enter.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(500);
    expect(onKey).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('the same keys 120 ms apart are typing: no scan, and each key reaches the field', () => {
    const onScan = vi.fn();
    const onKey = vi.fn();
    const { getByLabelText } = render(<Field onScan={onScan} onKey={onKey} />);
    const input = getByLabelText('field') as HTMLInputElement;
    input.focus();
    typeKeys(input, ['1', '2', '3', '4', '5', '6'], 120);
    key(input, { key: 'Enter' });
    expect(onScan).not.toHaveBeenCalled();
    expect(onKey.mock.calls.map((c) => c[0])).toEqual(['1', '2', '3', '4', '5', '6', 'Enter']);
    expect(input.value).toBe('123456');
  });

  it('a fast burst shorter than minLength is typing too', () => {
    const onScan = vi.fn();
    const onKey = vi.fn();
    const { getByLabelText } = render(<Field onScan={onScan} onKey={onKey} />);
    const input = getByLabelText('field') as HTMLInputElement;
    input.focus();
    typeKeys(input, ['1', '2', '3'], 5);
    key(input, { key: 'Enter' });
    expect(onScan).not.toHaveBeenCalled();
    expect(input.value).toBe('123');
    expect(onKey.mock.calls.map((c) => c[0])).toEqual(['1', '2', '3', 'Enter']);
  });

  it('a burst without Enter is typing: the held keys reach the field once the burst ends', () => {
    const onScan = vi.fn();
    const onKey = vi.fn();
    const { getByLabelText } = render(<Field onScan={onScan} onKey={onKey} />);
    const input = getByLabelText('field') as HTMLInputElement;
    input.focus();
    typeKeys(input, ['a', 'b', 'c', 'd', 'e'], 5);
    vi.advanceTimersByTime(100);
    expect(onScan).not.toHaveBeenCalled();
    expect(input.value).toBe('abcde');
  });

  it('keys with Ctrl, ⌘ or Alt pass straight through, after the held keys', () => {
    const onScan = vi.fn();
    const onKey = vi.fn();
    const { getByLabelText } = render(<Field onScan={onScan} onKey={onKey} />);
    const input = getByLabelText('field') as HTMLInputElement;
    input.focus();
    key(input, { key: 'x' });
    key(input, { key: 'a', ctrlKey: true });
    expect(onKey.mock.calls.map((c) => c[0])).toEqual(['x', 'a']);
  });

  it('holds back the keys of a textarea too, and replays them as typing', () => {
    const onScan = vi.fn();
    renderHook(() => useScannerInput({ onScan }));
    const area = document.createElement('textarea');
    document.body.append(area);
    area.focus();
    const first = key(area, { key: 'a' });
    expect(first.defaultPrevented).toBe(true);
    expect(area.value).toBe('');
    vi.advanceTimersByTime(100);
    expect(area.value).toBe('a');
  });

  // Only a writable text field can have a held key typed back faithfully (at its caret, with the browser's own
  // checks). Anywhere else a held key would lose its native action: Space on a button or a checkbox, type-ahead in a
  // select, a link, the page's own shortcuts. There the keys pass at once and untouched; they only count towards a scan.
  const passThrough: [string, () => HTMLElement][] = [
    ['the page', () => document.body],
    ['a button', () => Object.assign(document.createElement('button'), { textContent: 'Simpan' })],
    ['a select', () => {
      const select = document.createElement('select');
      for (const value of ['1', '2']) select.append(Object.assign(document.createElement('option'), { value, textContent: value }));
      return select;
    }],
    ['a checkbox', () => Object.assign(document.createElement('input'), { type: 'checkbox' })],
    ['a link', () => Object.assign(document.createElement('a'), { href: '/admin/users', textContent: 'Pengguna' })],
    ['a read-only text input', () => Object.assign(document.createElement('input'), { readOnly: true, value: 'tetap' })],
    ['a disabled text input', () => Object.assign(document.createElement('input'), { disabled: true })],
    ['a read-only textarea', () => Object.assign(document.createElement('textarea'), { readOnly: true })],
    ['an email input (no caret API)', () => Object.assign(document.createElement('input'), { type: 'email' })],
    ['a number input (no caret API)', () => Object.assign(document.createElement('input'), { type: 'number' })],
    ['a contenteditable element', () => {
      const div = document.createElement('div');
      div.setAttribute('contenteditable', 'true');
      return div;
    }],
  ];

  it.each(passThrough)('keys aimed at %s pass at once, untouched, and still count towards a scan', (_, make) => {
    const onScan = vi.fn();
    renderHook(() => useScannerInput({ onScan }));
    const target = make();
    if (target !== document.body) document.body.append(target);
    target.focus();
    const seen: string[] = [];
    target.addEventListener('keydown', (e) => seen.push(e.key));
    const value = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : undefined;

    const single = key(target, { key: ' ' });
    expect(single.defaultPrevented).toBe(false);
    expect(seen).toEqual([' ']);
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([' ']);

    seen.length = 0;
    const events: KeyboardEvent[] = [];
    for (const k of ['1', '2', '3', '4', '5', '6']) {
      events.push(key(target, { key: k }));
      vi.advanceTimersByTime(10);
    }
    expect(events.map((e) => e.defaultPrevented)).toEqual([false, false, false, false, false, false]);
    expect(seen).toEqual(['1', '2', '3', '4', '5', '6']);
    // The Enter that ends a scan is the scanner's, not the user's: it does not press the focused button or link.
    const enter = key(target, { key: 'Enter' });
    expect(onScan).toHaveBeenCalledExactlyOnceWith('123456');
    expect(enter.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(100);
    expect(seen).toEqual(['1', '2', '3', '4', '5', '6']);
    if (value !== undefined) expect((target as HTMLInputElement).value).toBe(value);
  });

  it('the page shortcuts keep working at once while a scanner hook is mounted', () => {
    const onScan = vi.fn();
    const f = vi.fn();
    renderHook(() => {
      useScannerInput({ onScan });
      useShortcuts({ 'g u': f });
    });
    key(document.body, { key: 'g' });
    key(document.body, { key: 'u' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('replayed typing honours maxLength, like the browser: a full field takes no more', () => {
    const onScan = vi.fn();
    renderHook(() => useScannerInput({ onScan }));
    const input = Object.assign(document.createElement('input'), { maxLength: 4 });
    document.body.append(input);
    const inputs: string[] = [];
    input.addEventListener('input', () => inputs.push(input.value));
    input.focus();
    typeKeys(input, ['1', '2', '3', '4', '5', '6'], 120);
    vi.advanceTimersByTime(100);
    expect(input.value).toBe('1234');
    expect(inputs).toEqual(['1', '12', '123', '1234']);

    // A selection is replaced, so a full field still takes a key that replaces one.
    input.setSelectionRange(1, 2);
    typeKeys(input, ['x'], 120);
    expect(input.value).toBe('1x34');

    const area = Object.assign(document.createElement('textarea'), { maxLength: 2 });
    document.body.append(area);
    area.focus();
    typeKeys(area, ['a', 'b', 'c'], 120);
    expect(area.value).toBe('ab');
  });

  it('scans with the focus outside any field too (minLength and maxGapMs are options)', () => {
    const onScan = vi.fn();
    renderHook(() => useScannerInput({ onScan, minLength: 6, maxGapMs: 50 }));
    typeKeys(document.body, ['9', '7', '8', '6', '0', '2'], 40);
    key(document.body, { key: 'Enter' });
    expect(onScan).toHaveBeenCalledExactlyOnceWith('978602');
    typeKeys(document.body, ['1', '2', '3', '4', '5'], 10);
    key(document.body, { key: 'Enter' });
    expect(onScan).toHaveBeenCalledTimes(1);
  });
});
