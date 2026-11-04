import type { MeResponse } from '@altis/shared/api/auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddToPrintQueue, PRINT_QUEUE_MAX, printQueueKey, usePrintQueue, type QueueEntry } from '@/components/catalog/print-queue';
import { ME_KEY } from '@/lib/me';
import { json, signedIn } from '../fake-api';

// The label print queue (Phase 2 spec §7, D2-17; plan Task 30): kept on the client only, in localStorage under
// `altis.printQueue.<userId>`, at most 1 000 entries (the oldest dropped, and the caller told how many). Every access
// to the storage is wrapped, so the queue still works (for the page's life) when the browser refuses storage.

/** A ULID-shaped id ending in `n` (5 digits of Crockford base 32 are enough for 1 000 entries). */
const idOf = (n: number): string => `01JZ0000000000000000${String(n).padStart(6, '0')}`;
const item = (n: number): QueueEntry => ({ kind: 'item', id: idOf(n), label: `B${String(n).padStart(5, '0')}` });

/** A provider whose `auth/me` is `me` (a fresh QueryClient each time: a remount of the whole page). */
function wrapperFor(me: MeResponse) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(ME_KEY, me);
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const stored = (userId: string): unknown => JSON.parse(localStorage.getItem(printQueueKey(userId)) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  // Nothing here should reach the server; `auth/me` is answered in case a query refetches it.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(signedIn())),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('usePrintQueue', () => {
  it('adds entries once each (kind and id), in order, and stores them under the user’s key', () => {
    const { result } = renderHook(() => usePrintQueue(), { wrapper: wrapperFor(signedIn()) });
    expect(result.current.entries).toEqual([]);
    let outcome: { added: number; dropped: number } | undefined;
    act(() => {
      outcome = result.current.add([item(1), item(2)]);
    });
    expect(outcome).toEqual({ added: 2, dropped: 0 });
    act(() => {
      outcome = result.current.add([item(2), { kind: 'record', id: idOf(3), label: 'Laskar Pelangi' }]);
    });
    expect(outcome).toEqual({ added: 1, dropped: 0 });
    expect(result.current.entries.map((e) => e.id)).toEqual([idOf(1), idOf(2), idOf(3)]);
    expect(printQueueKey('U1')).toBe('altis.printQueue.U1');
    expect(stored('U1')).toEqual([item(1), item(2), { kind: 'record', id: idOf(3), label: 'Laskar Pelangi' }]);

    act(() => result.current.remove([idOf(2)]));
    expect(result.current.entries.map((e) => e.id)).toEqual([idOf(1), idOf(3)]);
    act(() => result.current.clear());
    expect(result.current.entries).toEqual([]);
    expect(stored('U1')).toEqual([]);
  });

  it('keeps 1 000 entries: adding more drops the oldest and says how many', () => {
    expect(PRINT_QUEUE_MAX).toBe(1000);
    const { result } = renderHook(() => usePrintQueue(), { wrapper: wrapperFor(signedIn()) });
    act(() => {
      result.current.add(Array.from({ length: 1000 }, (_, i) => item(i)));
    });
    expect(result.current.entries).toHaveLength(1000);
    let outcome: { added: number; dropped: number } | undefined;
    act(() => {
      outcome = result.current.add([item(1000), item(1001), item(5), item(1002)]);
    });
    // item(5) is queued already: three new entries, so the three oldest (0, 1, 2) go.
    expect(outcome).toEqual({ added: 3, dropped: 3 });
    const ids = result.current.entries.map((e) => e.id);
    expect(ids).toHaveLength(1000);
    expect(ids[0]).toBe(idOf(3));
    expect(ids.slice(-3)).toEqual([idOf(1000), idOf(1001), idOf(1002)]);
    expect(ids).not.toContain(idOf(0));
    expect(stored('U1')).toHaveLength(1000);
  });

  it('survives a remount: a new page reads the stored queue, and another tab’s change shows up', () => {
    const first = renderHook(() => usePrintQueue(), { wrapper: wrapperFor(signedIn()) });
    act(() => {
      first.result.current.add([item(1), { kind: 'record', id: idOf(2), label: 'Bumi Manusia' }]);
    });
    first.unmount();

    const second = renderHook(() => usePrintQueue(), { wrapper: wrapperFor(signedIn()) });
    expect(second.result.current.entries).toEqual([item(1), { kind: 'record', id: idOf(2), label: 'Bumi Manusia' }]);

    // Another tab of the same user empties the queue: the storage event brings it here.
    act(() => {
      localStorage.setItem(printQueueKey('U1'), JSON.stringify([item(9)]));
      window.dispatchEvent(new StorageEvent('storage', { key: printQueueKey('U1') }));
    });
    expect(second.result.current.entries).toEqual([item(9)]);
  });

  it('is per user: another user on the same browser has their own queue', () => {
    const ani = renderHook(() => usePrintQueue(), { wrapper: wrapperFor(signedIn()) });
    act(() => {
      ani.result.current.add([item(1)]);
    });
    const budi = renderHook(() => usePrintQueue(), { wrapper: wrapperFor(signedIn({ id: 'U2' })) });
    expect(budi.result.current.entries).toEqual([]);
    act(() => {
      budi.result.current.add([item(2)]);
    });
    expect(stored('U1')).toEqual([item(1)]);
    expect(stored('U2')).toEqual([item(2)]);
  });

  it('drops what is not a queue entry from the stored value, and a value that is not JSON', () => {
    localStorage.setItem(
      printQueueKey('U1'),
      JSON.stringify([item(1), { kind: 'shelf', id: idOf(2), label: 'x' }, { kind: 'item', id: 'not-an-id', label: 'x' }, 'B0001', null, item(1), item(3)]),
    );
    const { result } = renderHook(() => usePrintQueue(), { wrapper: wrapperFor(signedIn()) });
    expect(result.current.entries).toEqual([item(1), item(3)]);

    localStorage.setItem(printQueueKey('U1'), '{oops');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: printQueueKey('U1') }));
    });
    expect(result.current.entries).toEqual([]);
  });

  it('cuts a long label, so 1 000 entries stay small', () => {
    const { result } = renderHook(() => usePrintQueue(), { wrapper: wrapperFor(signedIn()) });
    act(() => {
      result.current.add([{ kind: 'record', id: idOf(1), label: 'x'.repeat(5000) }]);
    });
    expect(result.current.entries[0]!.label.length).toBeLessThanOrEqual(200);
  });

  it('works when localStorage throws: the queue lives in the page meanwhile', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    // A user of its own: what this page keeps in memory stays out of the other tests.
    const me = signedIn({ id: 'U7' });
    const { result, unmount } = renderHook(() => usePrintQueue(), { wrapper: wrapperFor(me) });
    expect(result.current.entries).toEqual([]);
    act(() => {
      result.current.add([item(1), item(2), item(3)]);
    });
    expect(result.current.entries.map((e) => e.id)).toEqual([idOf(1), idOf(2), idOf(3)]);
    act(() => result.current.remove([idOf(1)]));
    expect(result.current.entries.map((e) => e.id)).toEqual([idOf(2), idOf(3)]);
    unmount();
    // Another component of the same page (the labels screen after a list) sees the same queue.
    const again = renderHook(() => usePrintQueue(), { wrapper: wrapperFor(me) });
    expect(again.result.current.entries.map((e) => e.id)).toEqual([idOf(2), idOf(3)]);
    act(() => again.result.current.clear());
    expect(again.result.current.entries).toEqual([]);
  });
});

describe('AddToPrintQueue', () => {
  /** The button alone under a router (its notice links Cetak Label); resolves once it is on screen. */
  async function renderButton(entries: QueueEntry[], me: MeResponse = signedIn()): Promise<HTMLButtonElement> {
    const Wrapper = wrapperFor(me);
    const rootRoute = createRootRoute({ component: () => <AddToPrintQueue entries={entries} /> });
    const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(
      <Wrapper>
        <RouterProvider router={router} />
      </Wrapper>,
    );
    return (await screen.findByRole('button', { name: 'Tambah ke antrean cetak' })) as HTMLButtonElement;
  }

  it('adds the selected rows to the queue and says so, with the way to Cetak Label', async () => {
    await renderButton([item(1), item(2)]);
    fireEvent.click(screen.getByRole('button', { name: 'Tambah ke antrean cetak' }));
    expect(screen.getByRole('status').textContent).toContain('2 butir ditambahkan ke antrean cetak');
    expect(screen.getByRole('link', { name: 'Buka Cetak Label' }).getAttribute('href')).toBe('/admin/catalog/labels');
    expect(stored('U1')).toEqual([item(1), item(2)]);

    fireEvent.click(screen.getByRole('button', { name: 'Tambah ke antrean cetak' }));
    expect(screen.getByRole('status').textContent).toContain('Semua sudah ada di antrean cetak');
  });

  it('tells how many of the oldest entries a full queue dropped', async () => {
    localStorage.setItem(printQueueKey('U1'), JSON.stringify(Array.from({ length: 1000 }, (_, i) => item(i))));
    await renderButton([item(2000), item(2001)]);
    fireEvent.click(screen.getByRole('button', { name: 'Tambah ke antrean cetak' }));
    expect(screen.getByRole('status').textContent).toContain('2 butir terlama dikeluarkan');
    expect(stored('U1')).toHaveLength(1000);
  });

  it('is disabled without a selection', async () => {
    expect((await renderButton([])).disabled).toBe(true);
  });
});
