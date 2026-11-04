import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { notify, type NotificationInput } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type {
  NotificationItem,
  NotificationListResponse,
  NotificationReadAllResponse,
  NotificationReadResponse,
} from '@altis/shared/api/notifications';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The notifications API of Task 7 (spec §10.9, §13.5 "Event & notifikasi"; route catalog `notifications.*`) on the
// engine picked by ALTIS_TEST_DB: every signed-in staff user reads their own notifications and those of the
// permissions they hold (`mode: system`, so it keeps working in read-only), marks one read or all of them; an id the
// caller may not see is 404, an anonymous caller 401.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const DAY = 86_400_000;
const CONFIG = sampleConfig();
/** baseUrl is https: the cookies carry the `__Host-` prefix. */
const SID = '__Host-altis_sid';
const NOTIFICATIONS = '/api/v1/notifications';

/** A browser signed in as one staff user. */
interface Client {
  userId: string;
  get(path: string): Promise<AgentReply>;
  post(path: string, headers?: Record<string, string>): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const listOf = (res: AgentReply): NotificationListResponse => res.json as NotificationListResponse;

describe.skipIf(!ctx.available)(`notifications API [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  /** Holds `system.backup.read`. */
  let backupReader: Client;
  /** Holds `system.backup.read` too. */
  let otherReader: Client;
  /** Holds no role. */
  let norole: Client;
  let anonymous: ReturnType<typeof createAgent>;

  async function signedIn(username: string, roles: Parameters<typeof seedStaff>[1]['roles']): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, ...(roles === undefined ? {} : { roles }) });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return {
      userId: user.id,
      get: (p) => agent.get(p),
      post: (p, headers = csrf) => agent.post(p, undefined, headers),
    };
  }

  const send = (n: NotificationInput, now = NOW): Promise<string> => withTx(h, (trx) => notify(trx, n, now));
  const toUser = (userId: string): NotificationInput => ({
    audience: { userId },
    type: 'job.dead',
    titleKey: 'notification.job_dead.title',
    params: { name: 'mail.password_reset' },
    link: '/admin/jobs',
  });
  const toBackupReaders = (): NotificationInput => ({
    audience: { permission: 'system.backup.read' },
    type: 'backup.done',
    titleKey: 'notification.backup_done.title',
    params: { name: 'harian' },
  });

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-notifications-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'b',
      log: recordingLogger(),
      clock: () => NOW,
    });
    backupReader = await signedIn('baca_cadangan', [{ permissions: ['system.backup.read'] }]);
    otherReader = await signedIn('baca_cadangan_2', [{ permissions: ['system.backup.read'] }]);
    norole = await signedIn('tanpa_peran', []);
    anonymous = createAgent(app);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('notification_reads').execute();
    await h.db.deleteFrom('notifications').execute();
  });

  describe('GET notifications', () => {
    it('answers the items and the unread count, newest first, not cached', async () => {
      const own = await send(toUser(backupReader.userId), NOW - 2000);
      const shared = await send(toBackupReaders(), NOW - 1000);
      await send(toUser(norole.userId), NOW - 500);
      const res = await backupReader.get(NOTIFICATIONS);
      expect(res.status, res.text).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = listOf(res);
      expect(body.unread).toBe(2);
      expect(body.nextBefore).toBeNull();
      expect(body.items).toEqual([
        {
          id: shared,
          type: 'backup.done',
          titleKey: 'notification.backup_done.title',
          params: { name: 'harian' },
          link: null,
          createdAt: NOW - 1000,
          read: false,
        },
        {
          id: own,
          type: 'job.dead',
          titleKey: 'notification.job_dead.title',
          params: { name: 'mail.password_reset' },
          link: '/admin/jobs',
          createdAt: NOW - 2000,
          read: false,
        },
      ] satisfies NotificationItem[]);
      // A staff user without the permission sees only their own.
      const mine = listOf(await norole.get(NOTIFICATIONS));
      expect(mine.items.map((i) => i.id)).not.toContain(shared);
      expect(mine.unread).toBe(1);
    });

    it('pages with limit and before', async () => {
      const sent: string[] = [];
      for (let i = 0; i < 3; i += 1) sent.push(await send(toUser(norole.userId), NOW - 3000 + i * 1000));
      const first = listOf(await norole.get(`${NOTIFICATIONS}?limit=2`));
      expect(first.items.map((i) => i.id)).toEqual([sent[2], sent[1]]);
      expect(first.nextBefore).toBe(sent[1]);
      const second = listOf(await norole.get(`${NOTIFICATIONS}?limit=2&before=${first.nextBefore!}`));
      expect(second.items.map((i) => i.id)).toEqual([sent[0]]);
      expect(second.nextBefore).toBeNull();
    });

    it('does not list an expired notification', async () => {
      await send({ ...toUser(norole.userId), ttlMs: DAY }, NOW - 2 * DAY);
      expect(listOf(await norole.get(NOTIFICATIONS))).toEqual({ items: [], unread: 0, nextBefore: null });
    });

    it('refuses a malformed or unknown query with 422', async () => {
      for (const query of ['limit=0', 'limit=51', 'limit=x', 'before=nope', 'page=2']) {
        const res = await norole.get(`${NOTIFICATIONS}?${query}`);
        expect(res.status, query).toBe(422);
        expect(code(res), query).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('POST notifications/:id/read', () => {
    it('marks it read for the caller only: read: true afterwards, the unread count drops', async () => {
      const id = await send(toBackupReaders());
      const res = await backupReader.post(`${NOTIFICATIONS}/${id}/read`);
      expect(res.status, res.text).toBe(200);
      const body = res.json as NotificationReadResponse;
      expect(body.item).toMatchObject({ id, read: true });
      expect(body.unread).toBe(0);
      const after = listOf(await backupReader.get(NOTIFICATIONS));
      expect(after.items.find((i) => i.id === id)?.read).toBe(true);
      expect(after.unread).toBe(0);
      // Another holder still has it unread.
      const other = listOf(await otherReader.get(NOTIFICATIONS));
      expect(other.items.find((i) => i.id === id)?.read).toBe(false);
      expect(other.unread).toBe(1);
      // Marking it again is harmless.
      expect((await backupReader.post(`${NOTIFICATIONS}/${id}/read`)).status).toBe(200);
      expect(await h.db.selectFrom('notification_reads').select('user_id').execute()).toEqual([{ user_id: backupReader.userId }]);
    });

    it('an id the caller may not see → 404 NOT_FOUND, nothing written', async () => {
      const others = await send(toUser(backupReader.userId));
      const forReaders = await send(toBackupReaders());
      for (const id of [others, forReaders, newId()]) {
        const res = await norole.post(`${NOTIFICATIONS}/${id}/read`);
        expect(res.status, id).toBe(404);
        expect(code(res), id).toBe('NOT_FOUND');
      }
      expect(await h.db.selectFrom('notification_reads').select('user_id').execute()).toEqual([]);
    });

    it('a malformed id → 422', async () => {
      const res = await norole.post(`${NOTIFICATIONS}/nope/read`);
      expect(res.status).toBe(422);
    });

    it('without the CSRF token → 403, nothing written', async () => {
      const id = await send(toUser(norole.userId));
      const res = await norole.post(`${NOTIFICATIONS}/${id}/read`, {});
      expect(res.status).toBe(403);
      expect(await h.db.selectFrom('notification_reads').select('user_id').execute()).toEqual([]);
    });
  });

  describe('POST notifications/read-all', () => {
    it('marks every notification of the caller read: unread: 0', async () => {
      await send(toUser(backupReader.userId));
      await send(toBackupReaders());
      await send(toBackupReaders());
      expect(listOf(await backupReader.get(NOTIFICATIONS)).unread).toBe(3);
      const res = await backupReader.post(`${NOTIFICATIONS}/read-all`);
      expect(res.status, res.text).toBe(200);
      expect(res.json).toEqual({ marked: 3, unread: 0 } satisfies NotificationReadAllResponse);
      const after = listOf(await backupReader.get(NOTIFICATIONS));
      expect(after.unread).toBe(0);
      expect(after.items.every((i) => i.read)).toBe(true);
      // The other holder's markers are their own.
      expect(listOf(await otherReader.get(NOTIFICATIONS)).unread).toBe(2);
      expect((await backupReader.post(`${NOTIFICATIONS}/read-all`)).json).toEqual({ marked: 0, unread: 0 });
    });
  });

  describe('anonymous', () => {
    it('→ 401 AUTH_REQUIRED on every route', async () => {
      const id = await send(toBackupReaders());
      // The pre-session CSRF token (what the SPA holds before signing in), so the writes reach the session check.
      const me = await anonymous.get('/api/v1/auth/me');
      const csrf = { 'x-csrf-token': (me.json as { csrfToken: string }).csrfToken };
      for (const res of [
        await anonymous.get(NOTIFICATIONS),
        await anonymous.post(`${NOTIFICATIONS}/${id}/read`, undefined, csrf),
        await anonymous.post(`${NOTIFICATIONS}/read-all`, undefined, csrf),
      ]) {
        expect(res.status).toBe(401);
        expect(code(res)).toBe('AUTH_REQUIRED');
      }
      expect(await h.db.selectFrom('notification_reads').select('user_id').execute()).toEqual([]);
    });
  });
});
