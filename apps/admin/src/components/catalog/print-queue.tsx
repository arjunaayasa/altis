import { isUlid } from '@altis/shared';
import { Link } from '@tanstack/react-router';
import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useLocale, useT } from '@/i18n';
import { meId } from '@/lib/access';
import { useMe } from '@/lib/me';

/**
 * The label print queue (Phase 2 spec §7, §13 "Cetak Label", decision D2-17; plan Task 30): the items and records
 * waiting for their labels, kept on the client only (no table).
 *
 * - **Where:** `localStorage['altis.printQueue.<userId>']` ({@link printQueueKey}), a JSON array of entries, oldest
 *   first. Each user of a shared browser has a queue of their own.
 * - **How many:** at most {@link PRINT_QUEUE_MAX}. Adding past it drops the oldest entries, and `add` says how many, so
 *   the caller can tell the user. A label is cut to {@link LABEL_MAX} characters, so a full queue stays far below the
 *   storage quota.
 * - **Without storage:** every access is wrapped in try/catch. A browser that refuses storage (a private window, a
 *   policy, a full quota) keeps the queue in this page's memory instead, shared by every component of the page; a
 *   write that fails keeps the newer queue in memory until a later write succeeds.
 * - **Live:** every component that uses the queue sees each change at once (one store, `useSyncExternalStore`), and
 *   another tab's change arrives through the `storage` event.
 * - **Untrusted storage:** a stored value is read back through a strict check: anything that is not an entry (an
 *   unknown kind, an id that is not a ULID, a label that is not text) is dropped, a duplicate is kept once, and a value
 *   that is not JSON reads as an empty queue.
 */

/** One queued label source: an item, or a record (all its items). `label` is what the queue shows. */
export interface QueueEntry {
  kind: 'item' | 'record';
  id: string;
  label: string;
}

/** What one `add` did: the entries that were new, and the oldest entries a full queue dropped to make room. */
export interface QueueAddResult {
  added: number;
  dropped: number;
}

export interface PrintQueue {
  entries: QueueEntry[];
  /** Appends the entries not queued yet (an entry is its kind and id); past {@link PRINT_QUEUE_MAX} the oldest go. */
  add(e: QueueEntry[]): QueueAddResult;
  /** Removes the entries with these ids. */
  remove(ids: string[]): void;
  clear(): void;
}

/** The most entries the queue keeps (spec §7: ≤ 1 000). */
export const PRINT_QUEUE_MAX = 1000;
/** A queued label is cut to this many characters (a title may be 60 000 bytes; the queue only shows it). */
export const LABEL_MAX = 200;

/** The storage key of `userId`'s queue. */
export function printQueueKey(userId: string): string {
  return `altis.printQueue.${userId}`;
}

const KEY_PREFIX = 'altis.printQueue.';
const NO_ENTRIES: QueueEntry[] = [];

const identity = (e: QueueEntry): string => `${e.kind}:${e.id}`;

/** `label` cut to {@link LABEL_MAX} characters, never splitting a surrogate pair. */
function cutLabel(label: string): string {
  if (label.length <= LABEL_MAX) return label;
  const last = label.charCodeAt(LABEL_MAX - 1);
  // A high surrogate last would leave half a character.
  return label.slice(0, last >= 0xd800 && last <= 0xdbff ? LABEL_MAX - 1 : LABEL_MAX);
}

/** `value` as a queue entry, or null when it is not one. */
function entryOf(value: unknown): QueueEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { kind, id, label } = value as Record<string, unknown>;
  if ((kind !== 'item' && kind !== 'record') || typeof id !== 'string' || !isUlid(id) || typeof label !== 'string') return null;
  return { kind, id, label: cutLabel(label) };
}

/** The entries of a stored value: the valid ones, each once, the newest {@link PRINT_QUEUE_MAX}. */
function parseQueue(raw: string): QueueEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return NO_ENTRIES;
  }
  if (!Array.isArray(value)) return NO_ENTRIES;
  const seen = new Set<string>();
  const out: QueueEntry[] = [];
  for (const v of value) {
    const entry = entryOf(v);
    if (entry === null || seen.has(identity(entry))) continue;
    seen.add(identity(entry));
    out.push(entry);
  }
  return out.length > PRINT_QUEUE_MAX ? out.slice(out.length - PRINT_QUEUE_MAX) : out;
}

// ---- the store ---------------------------------------------------------------------------------------------------

/** Per key: the stored text last read and its entries (a snapshot keeps its identity while nothing changed). */
const parsed = new Map<string, { raw: string; entries: QueueEntry[] }>();
/** Per key: the queue of this page while the storage refuses it, newer than whatever the storage holds. */
const held = new Map<string, QueueEntry[]>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** The queue under `key`: this page's own while the storage refused the last write, else the stored one. */
function readQueue(key: string): QueueEntry[] {
  const own = held.get(key);
  if (own !== undefined) return own;
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return NO_ENTRIES;
  }
  if (raw === null) return NO_ENTRIES;
  const cached = parsed.get(key);
  if (cached !== undefined && cached.raw === raw) return cached.entries;
  const entries = parseQueue(raw);
  parsed.set(key, { raw, entries });
  return entries;
}

/** Stores `entries` under `key` (in this page's memory when the storage refuses), then tells every subscriber. */
function writeQueue(key: string, entries: QueueEntry[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(entries));
    held.delete(key);
  } catch {
    held.set(key, entries);
  }
  notify();
}

/** Another tab changed a queue (or cleared the storage): its value wins over what this page held. */
function onStorage(e: StorageEvent): void {
  if (e.key === null) held.clear();
  else if (e.key.startsWith(KEY_PREFIX)) held.delete(e.key);
  else return;
  notify();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

/**
 * The signed-in user's print queue. Before `auth/me` answered (never inside the shell) it is empty and changes
 * nothing.
 */
export function usePrintQueue(): PrintQueue {
  const userId = meId(useMe());
  const key = userId === null ? null : printQueueKey(userId);
  const entries = useSyncExternalStore(
    subscribe,
    () => (key === null ? NO_ENTRIES : readQueue(key)),
    () => NO_ENTRIES,
  );

  const add = useCallback(
    (e: QueueEntry[]): QueueAddResult => {
      if (key === null) return { added: 0, dropped: 0 };
      const next = [...readQueue(key)];
      const seen = new Set(next.map(identity));
      let added = 0;
      for (const candidate of e) {
        const entry = entryOf(candidate);
        if (entry === null || seen.has(identity(entry))) continue;
        seen.add(identity(entry));
        next.push(entry);
        added += 1;
      }
      if (added === 0) return { added: 0, dropped: 0 };
      const dropped = Math.max(0, next.length - PRINT_QUEUE_MAX);
      writeQueue(key, dropped === 0 ? next : next.slice(dropped));
      return { added, dropped };
    },
    [key],
  );
  const remove = useCallback(
    (ids: string[]) => {
      if (key === null) return;
      const gone = new Set(ids);
      const old = readQueue(key);
      const next = old.filter((x) => !gone.has(x.id));
      if (next.length !== old.length) writeQueue(key, next);
    },
    [key],
  );
  const clear = useCallback(() => {
    if (key !== null) writeQueue(key, []);
  }, [key]);
  return useMemo(() => ({ entries, add, remove, clear }), [entries, add, remove, clear]);
}

export interface AddToPrintQueueProps {
  entries: QueueEntry[];
}

/**
 * "Tambah ke antrean cetak" for the selected rows of a list: adds them, then says how many were new (and how many of
 * the oldest a full queue dropped), with a link to Cetak Label. Disabled without a selection.
 */
export function AddToPrintQueue({ entries }: AddToPrintQueueProps): ReactNode {
  const t = useT();
  const number = new Intl.NumberFormat(useLocale() === 'en' ? 'en' : 'id');
  const queue = usePrintQueue();
  const [outcome, setOutcome] = useState<QueueAddResult | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="ghost" disabled={entries.length === 0} onClick={() => setOutcome(queue.add(entries))}>
        {t('catalog.labels.queue.add')}
      </Button>
      {outcome !== null && (
        <span role="status" className="text-meta">
          {outcome.added === 0
            ? t('catalog.labels.queue.added_none')
            : t('catalog.labels.queue.added', { count: number.format(outcome.added) })}
          {outcome.dropped > 0 && <> {t('catalog.labels.queue.dropped', { count: number.format(outcome.dropped) })}</>}{' '}
          <Link to="/admin/catalog/labels" className="font-semibold text-accent-text underline-offset-4 hover:underline">
            {t('catalog.labels.queue.open')}
          </Link>
        </span>
      )}
    </span>
  );
}
