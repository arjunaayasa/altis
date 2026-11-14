import { useSyncExternalStore } from 'react';
import { ApiError, api, csrfToken, setCsrfToken } from '@/lib/api';
import { buildSync } from '@/lib/build-sync';

// What the member tools share: the card queue (kept in this browser, at most 500 members) and the downloads of a
// binary or JSON answer (a card PDF, a member's data).

/** One member waiting for a card. */
export interface CardQueueEntry {
  id: string;
  memberNo: string;
  name: string;
}

/** The longest card queue. */
export const CARD_QUEUE_MAX = 500;

const QUEUE_KEY = 'altis.members.card-queue';
const listeners = new Set<() => void>();
let cached: CardQueueEntry[] | null = null;

function isEntry(v: unknown): v is CardQueueEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e['id'] === 'string' && typeof e['memberNo'] === 'string' && typeof e['name'] === 'string';
}

/** The card queue as stored ([] when storage is blocked or holds something else). */
export function readCardQueue(): CardQueueEntry[] {
  if (cached !== null) return cached;
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(QUEUE_KEY) ?? '[]');
    cached = Array.isArray(raw) ? raw.filter(isEntry).slice(0, CARD_QUEUE_MAX) : [];
  } catch {
    cached = [];
  }
  return cached;
}

/** Replaces the card queue (cut to its limit). */
export function writeCardQueue(entries: readonly CardQueueEntry[]): void {
  cached = entries.slice(0, CARD_QUEUE_MAX);
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(cached));
  } catch {
    // Storage blocked: the queue lives as long as the page.
  }
  for (const l of listeners) l();
}

/** Adds members not queued yet; answers how many were added. */
export function addToCardQueue(entries: readonly CardQueueEntry[]): number {
  const queue = readCardQueue();
  const known = new Set(queue.map((e) => e.id));
  const fresh = entries.filter((e) => !known.has(e.id));
  writeCardQueue([...queue, ...fresh]);
  return Math.min(fresh.length, Math.max(0, CARD_QUEUE_MAX - queue.length));
}

/** The card queue, kept in step with every change on this page. */
export function useCardQueue(): CardQueueEntry[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    readCardQueue,
    () => [],
  );
}

/** `POST /api/v1/<path>` with the page's CSRF token, the answer read as bytes. */
async function postRaw(path: string, body: unknown): Promise<Response> {
  const token = csrfToken();
  const res = await fetch(`/api/v1/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/pdf, application/json, application/problem+json',
      'Content-Type': 'application/json',
      ...(token === null ? {} : { 'X-CSRF-Token': token }),
    },
    body: JSON.stringify(body),
  });
  const build = res.headers.get('X-Altis-Build');
  if (build !== null) buildSync.observe(build);
  const rotated = res.headers.get('X-CSRF-Token');
  if (rotated !== null && rotated !== '') setCsrfToken(rotated);
  return res;
}

/**
 * The PDF answer of `POST <path>`. A refusal is sent once more through the JSON client, which handles it as every
 * request (a fresh CSRF token, the sign-in page, a re-authentication) and throws its ApiError; when that passed, the
 * PDF is asked for again.
 */
export async function postForPdf(path: string, body: unknown): Promise<Blob> {
  const isPdf = (res: Response): boolean => res.ok && /^application\/pdf\b/i.test(res.headers.get('Content-Type') ?? '');
  const first = await postRaw(path, body);
  if (isPdf(first)) return first.blob();
  await api<unknown>('POST', path, body);
  const again = await postRaw(path, body);
  if (isPdf(again)) return again.blob();
  throw new ApiError(again.status, 'INTERNAL', { problemJson: false });
}

/** Saves `blob` as the file `name` (an object URL clicked once). */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
