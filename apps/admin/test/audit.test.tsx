import type { AuditItem, AuditListResponse, AuditVerifyResponse } from '@altis/shared/api/audit';
import { focusManager } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from '@/lib/page';
import { adminMe, signedIn, startApp, type FakeHandler, type FakeRequest } from './fake-api';

// Spec §13.3 "Log audit", §7.8 (Task 30): filters, cursor paging ("Muat lagi"), the chain status of
// `GET audit/verify`, and the CSV export link, which asks for the password before the file loads (it holds staff
// names). The server is faked (fake-api.tsx).

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function item(seq: number, o: Partial<AuditItem> = {}): AuditItem {
  return {
    seq,
    at: 1_760_000_000_000 + seq * 60_000,
    actorType: 'staff',
    actorId: 'U1',
    actorName: 'Ani',
    action: 'users.create',
    entity: 'staff_users',
    entityId: `U${seq + 100}`,
    branchId: null,
    ip: '203.0.113.7',
    meta: { username: `user${seq}` },
    ...o,
  };
}

function auditRoutes(o: { verify?: AuditVerifyResponse; pages?: (req: FakeRequest) => AuditListResponse } = {}): Record<string, FakeHandler> {
  return {
    'GET audit/verify': () => o.verify ?? { ok: true, head: 120 },
    'GET audit': o.pages ?? (() => ({ items: [item(3), item(2), item(1)], nextBefore: null })),
    'GET users': () => ({ items: [], total: 0, page: 1, pageSize: 100 }),
  };
}

/** Local midnight and the last millisecond of a `YYYY-MM-DD` day (the browser's time zone). */
const dayStart = (d: string): number => new Date(`${d}T00:00:00`).getTime();
const dayEnd = (d: string): number => new Date(`${d}T23:59:59.999`).getTime();

describe('audit log', () => {
  it('lists the entries newest first, with the action label', async () => {
    startApp({ me: adminMe(), path: '/admin/audit', routes: auditRoutes() });
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByText('Membuat pengguna')).toHaveLength(3));
    expect(within(table).getByText('#3')).toBeTruthy();
  });

  it('shows the chain status from GET audit/verify', async () => {
    startApp({ me: adminMe(), path: '/admin/audit', routes: auditRoutes() });
    expect(await screen.findByText('Rantai utuh')).toBeTruthy();
  });

  it('a broken chain names the first entry that does not verify', async () => {
    startApp({ me: adminMe(), path: '/admin/audit', routes: auditRoutes({ verify: { ok: false, brokenAt: 7 } }) });
    expect(await screen.findByText('Rantai rusak di #7')).toBeTruthy();
  });

  it('"Muat lagi" requests before=<nextBefore> and appends the page', async () => {
    const { requests } = startApp({
      me: adminMe(),
      path: '/admin/audit',
      routes: auditRoutes({
        pages: (req) =>
          req.query.get('before') === '51'
            ? { items: [item(50), item(49)], nextBefore: null }
            : { items: [item(53), item(52), item(51)], nextBefore: 51 },
      }),
    });
    await screen.findByText('#53');
    expect(requests.filter((r) => r.path === 'audit')[0]?.query.has('before')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Muat lagi' }));
    await screen.findByText('#49');
    const lists = requests.filter((r) => r.path === 'audit');
    expect(lists.at(-1)?.query.get('before')).toBe('51');
    expect(screen.getByText('#53')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Muat lagi' })).toBeNull();
  });

  it('the export link carries the active filters and the delimiter', async () => {
    const { requests } = startApp({ me: adminMe(), path: '/admin/audit', routes: auditRoutes() });
    await screen.findByText('#3');
    const link = screen.getByRole('link', { name: /Ekspor CSV/ });
    expect(link.getAttribute('href')).toBe('/api/v1/audit/export?delimiter=comma');

    fireEvent.change(screen.getByLabelText('Tindakan'), { target: { value: 'users.create' } });
    fireEvent.change(screen.getByLabelText('Jenis data'), { target: { value: 'staff_users' } });
    fireEvent.change(screen.getByLabelText('Dari tanggal'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Sampai tanggal'), { target: { value: '2026-10-27' } });
    // Not applied yet: the link still exports everything.
    expect(link.getAttribute('href')).toBe('/api/v1/audit/export?delimiter=comma');
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));

    const from = dayStart('2026-10-01');
    const to = dayEnd('2026-10-27');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Ekspor CSV/ }).getAttribute('href')).toBe(
        `/api/v1/audit/export?action=users.create&entity=staff_users&from=${from}&to=${to}&delimiter=comma`,
      ),
    );
    fireEvent.change(screen.getByLabelText('Pemisah kolom'), { target: { value: 'semicolon' } });
    expect(screen.getByRole('link', { name: /Ekspor CSV/ }).getAttribute('href')).toBe(
      `/api/v1/audit/export?action=users.create&entity=staff_users&from=${from}&to=${to}&delimiter=semicolon`,
    );
    // The list follows the same filters.
    await waitFor(() => {
      const last = requests.filter((r) => r.path === 'audit').at(-1);
      expect(last?.query.get('action')).toBe('users.create');
      expect(last?.query.get('from')).toBe(String(from));
      expect(last?.query.get('to')).toBe(String(to));
    });
  });

  it('an end date before the start date is refused before anything is asked', async () => {
    const { requests } = startApp({ me: adminMe(), path: '/admin/audit', routes: auditRoutes() });
    await screen.findByText('#3');
    const before = requests.filter((r) => r.path === 'audit').length;
    fireEvent.change(screen.getByLabelText('Dari tanggal'), { target: { value: '2026-10-27' } });
    fireEvent.change(screen.getByLabelText('Sampai tanggal'), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Terapkan' }));
    expect(await screen.findByText('Tanggal akhir tidak boleh sebelum tanggal awal.')).toBeTruthy();
    expect(requests.filter((r) => r.path === 'audit')).toHaveLength(before);
  });

  it('the export asks for the password first, then loads the file with the applied filters; a cancelled dialog loads nothing', async () => {
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => undefined);
    const { writes } = startApp({
      me: adminMe(),
      path: '/admin/audit',
      routes: { ...auditRoutes(), 'POST auth/reauth': () => ({ reauthUntil: Date.now() + 300_000 }) },
    });
    await screen.findByText('#3');
    fireEvent.change(screen.getByLabelText('Pemisah kolom'), { target: { value: 'semicolon' } });
    fireEvent.click(screen.getByRole('link', { name: /Ekspor CSV/ }));
    const cancelled = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    fireEvent.click(within(cancelled).getByRole('button', { name: 'Batal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(assign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('link', { name: /Ekspor CSV/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi kata sandi' });
    expect(assign).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Kata sandi'), { target: { value: 'kata-sandi-ani' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Konfirmasi' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/v1/audit/export?delimiter=semicolon'));
    expect(writes()).toEqual(['POST auth/reauth']);
  });

  it('without system.audit.export there is no export link', async () => {
    startApp({ me: signedIn({ permissions: ['system.audit.read'] }), path: '/admin/audit', routes: auditRoutes() });
    await screen.findByText('#3');
    expect(screen.queryByRole('link', { name: /Ekspor CSV/ })).toBeNull();
  });

  it('the chain check (a full scan) and the list are not read again when the window regains focus; "Periksa lagi" does', async () => {
    const { requests } = startApp({ me: adminMe(), path: '/admin/audit', routes: auditRoutes() });
    await screen.findByText('Rantai utuh');
    await screen.findByText('#3');
    const count = (path: string): number => requests.filter((r) => r.method === 'GET' && r.path === path).length;
    expect(count('audit/verify')).toBe(1);
    expect(count('audit')).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(count('audit/verify')).toBe(1);
    expect(count('audit')).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Periksa lagi' }));
    await waitFor(() => expect(count('audit/verify')).toBe(2));
  });

  it('an actor filter applied from a row stays chosen in the select, also when no entry of that actor shows (the export follows it)', async () => {
    // An auditor without system.users.read: the actors offered come from the entries shown.
    startApp({
      me: signedIn({ permissions: ['system.audit.read', 'system.audit.export'] }),
      path: '/admin/audit',
      routes: auditRoutes({
        pages: (req) =>
          req.query.get('actorId') === 'U2'
            ? { items: [], nextBefore: null }
            : { items: [item(3), item(2, { actorId: 'U2', actorName: 'Budi' }), item(1)], nextBefore: null },
      }),
    });
    await screen.findByText('#3');
    fireEvent.click(screen.getByRole('button', { name: 'Saring catatan oleh Budi' }));
    await screen.findByText('Tidak ada catatan yang cocok.');
    const actor = screen.getByLabelText('Pelaku') as HTMLSelectElement;
    expect(actor.value).toBe('U2');
    expect(actor.selectedOptions[0]?.textContent).toBe('Budi');
    expect(screen.getByRole('link', { name: /Ekspor CSV/ }).getAttribute('href')).toBe('/api/v1/audit/export?actorId=U2&delimiter=comma');
  });
});
