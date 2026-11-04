import { systemRolePermissions } from '@altis/shared';
import type { EventsResponse } from '@altis/shared/api/events';
import type { NotificationItem, NotificationListResponse } from '@altis/shared/api/notifications';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signedIn, startApp, type FakeRequest } from './fake-api';

// The notification centre of the shell (spec §10.9, §13.3; Task 28): the bell with the caller's unread count
// (`GET notifications`), refetched when the realtime client hears a `notification` event, and its panel (list, mark
// one read and open its link, mark all read).

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT = 1_760_000_000_000;

const JOB_DEAD: NotificationItem = {
  id: '01JZ0000000000000000000001',
  type: 'job.dead',
  titleKey: 'notification.job_dead.title',
  params: { name: 'mail.password_reset' },
  link: '/admin/about',
  createdAt: AT,
  read: false,
};

const BACKUP_DONE: NotificationItem = {
  id: '01JZ0000000000000000000002',
  type: 'backup.done',
  titleKey: 'notification.backup_done.title',
  params: { name: 'harian' },
  link: null,
  createdAt: AT - 60_000,
  read: false,
};

const DISK_LOW: NotificationItem = {
  id: '01JZ0000000000000000000003',
  type: 'disk.low',
  titleKey: 'notification.disk_low.title',
  params: { free: '1 GB' },
  link: null,
  createdAt: AT - 120_000,
  read: true,
};

/** A fake notifications API over `items` (newest first), and an events poll answered by `events`. */
function notificationsApi(items: NotificationItem[], events: (req: FakeRequest) => EventsResponse | Promise<EventsResponse> = () => ({ cursor: '1.0', events: [] })) {
  const state = { items: items.map((i) => ({ ...i })) };
  const unread = (): number => state.items.filter((i) => !i.read).length;
  const routes = {
    'GET notifications': (req: FakeRequest): NotificationListResponse => {
      const limit = Number(req.query.get('limit') ?? 20);
      return { items: state.items.slice(0, limit), unread: unread(), nextBefore: null };
    },
    'POST notifications/read-all': () => {
      const marked = unread();
      for (const i of state.items) i.read = true;
      return { marked, unread: 0 };
    },
    'POST notifications/:id/read': (req: FakeRequest) => {
      const item = state.items.find((i) => i.id === req.params['id']);
      if (item === undefined) return undefined;
      item.read = true;
      return { item, unread: unread() };
    },
    'GET events': events,
  };
  return { state, routes };
}

const bell = (name: RegExp | string) => screen.findByRole('button', { name });

describe('notification bell', () => {
  it('shows the unread count of GET notifications, read in the background', async () => {
    const api = notificationsApi([JOB_DEAD, BACKUP_DONE, DISK_LOW]);
    const app = startApp({ me: signedIn(), path: '/admin', routes: api.routes });
    expect(await bell('Notifikasi, 2 belum dibaca')).toBeTruthy();
    const call = app.fetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/v1/notifications'));
    expect((call?.[1]?.headers as Record<string, string>)['X-Altis-Background']).toBe('1');
  });

  it('reads the notification events of the user and every staff member, and refetches the count on one', async () => {
    let answered!: () => void;
    const firstCount = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const api = notificationsApi([BACKUP_DONE], async () => {
      await firstCount;
      api.state.items.unshift({ ...JOB_DEAD });
      return { cursor: '3.9', events: [{ seq: 9, channel: 'user.U1', type: 'notification', payload: {}, at: AT }] };
    });
    const count = api.routes['GET notifications'];
    api.routes['GET notifications'] = (req) => {
      const answer = count(req);
      answered();
      return answer;
    };
    const app = startApp({
      me: signedIn({ permissions: ['system.backup.read'] }),
      path: '/admin',
      routes: api.routes,
    });
    expect(await bell('Notifikasi, 2 belum dibaca')).toBeTruthy();
    const poll = app.requests.find((r) => r.path === 'events');
    expect(poll?.query.get('channels')?.split(',')).toEqual(['user.U1', 'system.status', 'system.backup']);
    expect(poll?.query.has('cursor')).toBe(false);
    expect(app.requests.filter((r) => r.path === 'notifications').length).toBeGreaterThanOrEqual(2);
  });

  it('a batch of 5 notification events refetches the count once', async () => {
    let answered!: () => void;
    const firstCount = new Promise<void>((resolve) => {
      answered = resolve;
    });
    let polls = 0;
    const api = notificationsApi([BACKUP_DONE], async () => {
      polls += 1;
      if (polls > 1) return { cursor: '3.5', events: [] };
      await firstCount;
      api.state.items.unshift({ ...JOB_DEAD });
      const events = [1, 2, 3, 4, 5].map((seq) => ({ seq, channel: seq % 2 === 0 ? 'system.status' : 'user.U1', type: 'notification', payload: {}, at: AT }));
      return { cursor: '3.5', events };
    });
    const count = api.routes['GET notifications'];
    api.routes['GET notifications'] = (req) => {
      const answer = count(req);
      answered();
      return answer;
    };
    const app = startApp({ me: signedIn(), path: '/admin', routes: api.routes });
    expect(await bell('Notifikasi, 2 belum dibaca')).toBeTruthy();
    // Every request the batch causes has gone out by the time its answer is shown; give stragglers a moment anyway.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const counts = app.requests.filter((r) => r.path === 'notifications' && r.query.get('limit') === '1');
    expect(counts).toHaveLength(2);
    expect(polls).toBe(1);
  });

  it('"Tandai semua dibaca" posts read-all and shows 0', async () => {
    const api = notificationsApi([JOB_DEAD, BACKUP_DONE, DISK_LOW]);
    const app = startApp({ me: signedIn({ permissions: systemRolePermissions('admin') }), path: '/admin', routes: api.routes });
    fireEvent.click(await bell('Notifikasi, 2 belum dibaca'));
    const panel = await screen.findByRole('dialog', { name: 'Notifikasi' });
    expect(await within(panel).findByText('Tugas latar belakang gagal')).toBeTruthy();
    expect(within(panel).getByText('Cadangan selesai')).toBeTruthy();
    expect(within(panel).getByText('Cadangan harian berhasil dibuat dan siap dipakai.')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Tandai semua dibaca' }));
    expect(await bell('Notifikasi')).toBeTruthy();
    expect(app.writes()).toEqual(['POST notifications/read-all']);
    await waitFor(() => expect((within(panel).getByRole('button', { name: 'Tandai semua dibaca' }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('opening a notification marks it read and follows its link', async () => {
    const api = notificationsApi([JOB_DEAD, BACKUP_DONE]);
    const app = startApp({ me: signedIn(), path: '/admin', routes: api.routes });
    fireEvent.click(await bell('Notifikasi, 2 belum dibaca'));
    const panel = await screen.findByRole('dialog', { name: 'Notifikasi' });
    fireEvent.click(await within(panel).findByRole('button', { name: /Tugas latar belakang gagal/ }));
    await waitFor(() => expect(app.router.state.location.pathname).toBe('/admin/about'));
    expect(app.writes()).toEqual([`POST notifications/${JOB_DEAD.id}/read`]);
    expect(await bell('Notifikasi, 1 belum dibaca')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Notifikasi' })).toBeNull();
  });

  it('a link to the operations page (/admin/_update, a server page) is loaded as a page, not routed (1c Task 19)', async () => {
    const { page } = await import('@/lib/page');
    const assign = vi.spyOn(page, 'assign').mockImplementation(() => {});
    const attention: NotificationItem = {
      ...JOB_DEAD,
      id: '01JZ0000000000000000000004',
      type: 'ops.attention',
      titleKey: 'notification.ops_attention.title',
      params: { name: 'restore' },
      link: '/admin/_update',
    };
    const api = notificationsApi([attention]);
    const app = startApp({ me: signedIn(), path: '/admin', routes: api.routes });
    fireEvent.click(await bell('Notifikasi, 1 belum dibaca'));
    const panel = await screen.findByRole('dialog', { name: 'Notifikasi' });
    fireEvent.click(await within(panel).findByRole('button', { name: /Operasi sistem perlu ditangani/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/admin/_update'));
    expect(app.router.state.location.pathname).toBe('/admin');
  });

  it('says so when there is no notification', async () => {
    const api = notificationsApi([]);
    startApp({ me: signedIn(), path: '/admin', routes: api.routes });
    fireEvent.click(await bell('Notifikasi'));
    const panel = await screen.findByRole('dialog', { name: 'Notifikasi' });
    expect(await within(panel).findByText('Belum ada notifikasi.')).toBeTruthy();
  });
});
