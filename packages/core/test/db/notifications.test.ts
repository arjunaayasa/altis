import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx, type DB } from '@altis/db';
import { isDomainError, newId, type MessageKey, type Permission } from '@altis/shared';
import type { Transaction } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { ActorAuthz } from '../../src/authz/escalation.js';
import { loadGrants } from '../../src/authz/grants.js';
import { ensureSystemRoles } from '../../src/authz/system-roles.js';
import {
  NOTIFICATION_MARK_BATCH,
  NOTIFICATION_TTL_MS,
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  notify,
  type NotificationInput,
} from '../../src/notifications/service.js';

// Notifications (spec §10.9; L38, decision C24, M44, S17) on the engine picked by ALTIS_TEST_DB: a notification is
// addressed to one staff user or to the holders of a permission, kept 90 days (`expires_at`), read per user
// (`notification_reads`), and announced by one `notification` event as the last statement of its transaction, whose
// payload carries no personal data.

const ctx = testDbContext();

/** A fixed `now`. */
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
/** The staff user's display name: no event payload may carry it. */
const ADMIN_NAME = 'Siti Rahayu Pustakawati';

const BACKUP_DONE: MessageKey = 'notification.backup_done.title';
const JOB_DEAD: MessageKey = 'notification.job_dead.title';

describe.skipIf(!ctx.available)(`notifications [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;
  /** The system role `admin` (holds `system.backup.read`). */
  let admin: ActorAuthz;
  /** A second holder of `system.backup.read` (a custom role). */
  let reader: ActorAuthz;
  /** A staff user with a role that does not hold `system.backup.read`. */
  let staff: ActorAuthz;

  async function seedUser(name: string, permissions: readonly Permission[] | 'admin'): Promise<ActorAuthz> {
    const id = newId();
    await withTx(h, async (trx) => {
      await trx
        .insertInto('staff_users')
        .values({
          id,
          username_key: `U${id}`,
          username_display: `u${id}`,
          name,
          password_hash: '$scrypt$test',
          status: 'active',
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      let roleId: string;
      if (permissions === 'admin') {
        await ensureSystemRoles(trx, NOW);
        roleId = (await trx.selectFrom('roles').select('id').where('key', '=', 'admin').executeTakeFirstOrThrow()).id;
      } else {
        roleId = newId();
        await trx
          .insertInto('roles')
          .values({ id: roleId, key: `ROLE_${roleId}`, name: `Peran ${roleId}`, mfa_required: 0, created_at: NOW, updated_at: NOW })
          .execute();
        for (const permission of permissions) await trx.insertInto('role_permissions').values({ role_id: roleId, permission }).execute();
      }
      await trx.insertInto('user_roles').values({ id: newId(), user_id: id, role_id: roleId, branch_id: null, scope_key: '', created_at: NOW }).execute();
    });
    return { id, grants: await loadGrants(h.db, id) };
  }

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-notifications-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    admin = await seedUser(ADMIN_NAME, 'admin');
    reader = await seedUser('Pembaca Cadangan', ['system.backup.read']);
    staff = await seedUser('Staf Sirkulasi', ['system.users.read']);
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('notification_reads').execute();
    await h.db.deleteFrom('notifications').execute();
    await h.db.deleteFrom('events').execute();
  });

  const toUser = (userId: string, o: Partial<NotificationInput> = {}): NotificationInput => ({
    audience: { userId },
    type: 'job.dead',
    titleKey: JOB_DEAD,
    params: { name: 'mail.password_reset' },
    ...o,
  });
  const toBackupReaders = (o: Partial<NotificationInput> = {}): NotificationInput => ({
    audience: { permission: 'system.backup.read' },
    type: 'backup.done',
    titleKey: BACKUP_DONE,
    params: { name: 'harian' },
    link: '/admin/backups',
    ...o,
  });

  /** notify() in a transaction of its own; the new id. */
  const send = (n: NotificationInput, now = NOW): Promise<string> => withTx(h, (trx) => notify(trx, n, now));
  const list = (actor: ActorAuthz, o: { now?: number; limit?: number; before?: string } = {}) =>
    listNotifications(h.db, actor, { now: o.now ?? NOW, limit: o.limit ?? 50, ...(o.before === undefined ? {} : { before: o.before }) });
  const ids = (r: { items: { id: string }[] }): string[] => r.items.map((i) => i.id);
  const events = () => h.db.selectFrom('events').select(['channel', 'type', 'payload', 'created_at']).orderBy('seq').execute();
  const readRows = () => h.db.selectFrom('notification_reads').select(['notification_id', 'user_id', 'read_at']).execute();

  describe('notify', () => {
    it('inserts the row: expires_at = now + 90 days, the title key, the params as JSON, the link', async () => {
      expect(NOTIFICATION_TTL_MS).toBe(90 * DAY);
      const id = await send(toBackupReaders());
      const row = await h.db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        audience_permission: 'system.backup.read',
        user_id: null,
        type: 'backup.done',
        title_key: BACKUP_DONE,
        link: '/admin/backups',
      });
      expect(Number(row.created_at)).toBe(NOW);
      expect(Number(row.expires_at)).toBe(NOW + NOTIFICATION_TTL_MS);
      expect(JSON.parse(row.params)).toEqual({ name: 'harian' });
    });

    it('takes ttlMs, defaults params to {} and link to null', async () => {
      const id = await send({ audience: { userId: staff.id }, type: 'disk.low', titleKey: 'notification.disk_low.title', ttlMs: DAY });
      const row = await h.db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ user_id: staff.id, audience_permission: null, link: null });
      expect(Number(row.expires_at)).toBe(NOW + DAY);
      expect(JSON.parse(row.params)).toEqual({});
    });

    it('a user notification: one `notification` event on user.<id>, payload without personal data', async () => {
      await send(toUser(admin.id));
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ channel: `user.${admin.id}`, type: 'notification' });
      expect(JSON.parse(rows[0]!.payload)).toEqual({});
      expect(rows[0]!.payload).not.toContain(ADMIN_NAME);
    });

    it('a permission notification: one `notification` event on system.status with payload {permission}', async () => {
      await send(toBackupReaders());
      await send(toBackupReaders());
      const rows = await events();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({ channel: 'system.status', type: 'notification' });
        expect(JSON.parse(row.payload)).toEqual({ permission: 'system.backup.read' });
        expect(row.payload).not.toContain(ADMIN_NAME);
      }
    });

    it('publishes as the last statement of its transaction, reading its own clock (S17)', async () => {
      const statements: string[] = [];
      /** A caller's `now` long gone (a slice that started earlier): the event is not dated with it. */
      const callerNow = 1_000_000_000_000;
      const before = Date.now();
      await withTx(h, async (trx) => {
        const spy = new Proxy(trx, {
          get(target, prop) {
            const value: unknown = Reflect.get(target, prop, target);
            if (prop === 'insertInto' || prop === 'updateTable' || prop === 'deleteFrom' || prop === 'selectFrom') {
              return (table: string) => {
                statements.push(`${String(prop)} ${table}`);
                return (value as (t: string) => unknown).call(target, table);
              };
            }
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        }) as Transaction<DB>;
        await notify(spy, toUser(staff.id), callerNow);
      });
      expect(statements).toEqual(['insertInto notifications', 'insertInto events']);
      // The event's created_at is publish's own clock (the real time), not the `now` the caller passed.
      const [event] = await events();
      expect(Number(event!.created_at)).toBeGreaterThanOrEqual(before);
      const row = await h.db.selectFrom('notifications').select('created_at').executeTakeFirstOrThrow();
      expect(Number(row.created_at)).toBe(callerNow);
    });

    it('commits with the caller’s transaction or not at all', async () => {
      await expect(
        withTx(h, async (trx) => {
          await notify(trx, toUser(staff.id), NOW);
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      expect(await h.db.selectFrom('notifications').select('id').execute()).toEqual([]);
      expect(await events()).toEqual([]);
    });

    it('refuses a malformed notification with a TypeError and writes nothing', async () => {
      const bad: unknown[] = [
        { ...toUser(staff.id), audience: {} },
        { ...toUser(staff.id), audience: { userId: 'not-a-ulid' } },
        { ...toUser(staff.id), audience: { permission: 'system.nope' } },
        { ...toUser(staff.id), audience: { userId: staff.id, permission: 'system.backup.read' } },
        { ...toUser(staff.id), audience: null },
        toUser(staff.id, { type: '' }),
        toUser(staff.id, { type: 'Job.Dead' }),
        toUser(staff.id, { type: `a${'b'.repeat(64)}` }),
        toUser(staff.id, { titleKey: 'notification.job_dead.body' as MessageKey }),
        toUser(staff.id, { titleKey: 'banner.maintenance.title' as MessageKey }),
        toUser(staff.id, { titleKey: 'notification.nope.title' as MessageKey }),
        toUser(staff.id, { params: { n: Number.NaN } }),
        toUser(staff.id, { params: { n: { x: 1 } } as unknown as Record<string, string> }),
        toUser(staff.id, { params: { 'bad key': 'x' } }),
        toUser(staff.id, { params: JSON.parse('{"__proto__": "x"}') as Record<string, string> }),
        toUser(staff.id, { params: { name: 'x'.repeat(5000) } }),
        toUser(staff.id, { params: [] as unknown as Record<string, string> }),
        toUser(staff.id, { link: 'javascript:alert(1)' }),
        toUser(staff.id, { link: 'https://evil.example/' }),
        toUser(staff.id, { link: '//evil.example/x' }),
        toUser(staff.id, { link: '/\\evil.example' }),
        toUser(staff.id, { link: '/admin/\u0000' }),
        toUser(staff.id, { link: '' }),
        toUser(staff.id, { ttlMs: 0 }),
        toUser(staff.id, { ttlMs: -1 }),
        toUser(staff.id, { ttlMs: 1.5 }),
      ];
      for (const n of bad) {
        await expect(send(n as NotificationInput), JSON.stringify(n)).rejects.toThrow(TypeError);
      }
      await expect(send(toUser(staff.id), Number.NaN)).rejects.toThrow(TypeError);
      await expect(notify(h.db as unknown as Transaction<DB>, toUser(staff.id), NOW)).rejects.toThrow(TypeError);
      expect(await h.db.selectFrom('notifications').select('id').execute()).toEqual([]);
      expect(await events()).toEqual([]);
    });
  });

  describe('listNotifications', () => {
    it('a user notification is listed for that user only', async () => {
      const id = await send(toUser(staff.id));
      const mine = await list(staff);
      expect(ids(mine)).toEqual([id]);
      expect(mine.items[0]).toEqual({
        id,
        type: 'job.dead',
        titleKey: JOB_DEAD,
        params: { name: 'mail.password_reset' },
        link: null,
        createdAt: NOW,
        read: false,
      });
      expect(mine.unread).toBe(1);
      expect(ids(await list(admin))).toEqual([]);
      expect(ids(await list(reader))).toEqual([]);
    });

    it('a system.backup.read notification is listed for its holders, not for a staff user without it', async () => {
      const id = await send(toBackupReaders());
      expect(ids(await list(admin))).toEqual([id]);
      expect(ids(await list(reader))).toEqual([id]);
      const none = await list(staff);
      expect(none).toEqual({ items: [], unread: 0, nextBefore: null });
    });

    it('an expired notification is not listed (nor counted)', async () => {
      const expired = await send(toUser(staff.id, { ttlMs: DAY }), NOW - DAY - 1);
      const atEdge = await send(toUser(staff.id, { ttlMs: DAY }), NOW - DAY);
      const alive = await send(toUser(staff.id, { ttlMs: DAY }), NOW - DAY + 1);
      const r = await list(staff);
      expect(ids(r)).toEqual([alive]);
      expect(r.unread).toBe(1);
      expect(ids(r)).not.toContain(expired);
      expect(ids(r)).not.toContain(atEdge);
    });

    it('newest first, paged by `before`', async () => {
      const sent: string[] = [];
      for (let i = 0; i < 5; i += 1) sent.push(await send(toUser(staff.id), NOW - 5000 + i * 1000));
      const newest = [...sent].reverse();
      const first = await list(staff, { limit: 2 });
      expect(ids(first)).toEqual(newest.slice(0, 2));
      expect(first.nextBefore).toBe(newest[1]);
      expect(first.unread).toBe(5);
      const second = await list(staff, { limit: 2, before: first.nextBefore! });
      expect(ids(second)).toEqual(newest.slice(2, 4));
      const third = await list(staff, { limit: 2, before: second.nextBefore! });
      expect(ids(third)).toEqual(newest.slice(4));
      expect(third.nextBefore).toBeNull();
      expect((await list(staff, { limit: 5 })).nextBefore).toBeNull();
    });

    it('mixes the user’s own notifications with those of the permissions it holds', async () => {
      const own = await send(toUser(reader.id), NOW - 2000);
      const shared = await send(toBackupReaders(), NOW - 1000);
      await send(toUser(admin.id), NOW - 500);
      expect(ids(await list(reader))).toEqual([shared, own]);
    });

    it('refuses a limit outside 1-50 and a `before` that is not a ULID with a RangeError', async () => {
      for (const limit of [0, 51, 1.5, Number.NaN]) {
        await expect(list(staff, { limit })).rejects.toThrow(RangeError);
      }
      await expect(list(staff, { before: 'nope' })).rejects.toThrow(RangeError);
    });
  });

  describe('read markers', () => {
    it('unread counts per user: a read by A does not mark it read for B', async () => {
      const id = await send(toBackupReaders());
      const item = await withTx(h, (trx) => markRead(trx, admin, id, NOW + 1));
      expect(item).toMatchObject({ id, read: true });
      const a = await list(admin);
      expect(a.items[0]!.read).toBe(true);
      expect(a.unread).toBe(0);
      const b = await list(reader);
      expect(b.items[0]!.read).toBe(false);
      expect(b.unread).toBe(1);
      expect(await countUnread(h.db, admin, NOW)).toBe(0);
      expect(await countUnread(h.db, reader, NOW)).toBe(1);
      expect(await readRows()).toEqual([{ notification_id: id, user_id: admin.id, read_at: NOW + 1 }]);
    });

    it('markRead twice keeps one marker, with the first read time', async () => {
      const id = await send(toUser(staff.id));
      await withTx(h, (trx) => markRead(trx, staff, id, NOW + 1));
      const again = await withTx(h, (trx) => markRead(trx, staff, id, NOW + 2));
      expect(again.read).toBe(true);
      const rows = await readRows();
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.read_at)).toBe(NOW + 1);
    });

    it('markRead: NOT_FOUND for a notification the actor may not see, an expired one, an unknown or malformed id', async () => {
      const others = await send(toUser(admin.id));
      const forReaders = await send(toBackupReaders());
      const expired = await send(toUser(staff.id, { ttlMs: DAY }), NOW - 2 * DAY);
      for (const id of [others, forReaders, expired, newId(), 'nope']) {
        const error: unknown = await withTx(h, (trx) => markRead(trx, staff, id, NOW)).catch((e: unknown) => e);
        expect(isDomainError(error) && error.code, id).toBe('NOT_FOUND');
      }
      expect(await readRows()).toEqual([]);
    });

    it('markAllRead marks every visible unread notification of the actor, and only those', async () => {
      const own = await send(toUser(reader.id));
      const shared = await send(toBackupReaders());
      await send(toUser(admin.id));
      await send(toUser(reader.id, { ttlMs: DAY }), NOW - 2 * DAY);
      await withTx(h, (trx) => markRead(trx, reader, own, NOW));
      expect(await withTx(h, (trx) => markAllRead(trx, reader, NOW + 5))).toBe(1);
      expect(await countUnread(h.db, reader, NOW)).toBe(0);
      expect((await list(reader)).items.every((i) => i.read)).toBe(true);
      // The other holders are untouched.
      expect(await countUnread(h.db, admin, NOW)).toBe(2);
      const rows = await readRows();
      expect(rows.filter((r) => r.user_id !== reader.id)).toEqual([]);
      expect(rows.map((r) => r.notification_id).sort()).toEqual([own, shared].sort());
      expect(await withTx(h, (trx) => markAllRead(trx, reader, NOW + 6))).toBe(0);
    });

    it('markAllRead works through more notifications than one batch', async () => {
      const n = 2 * NOTIFICATION_MARK_BATCH + 3;
      for (let done = 0; done < n; done += 200) {
        const rows = Array.from({ length: Math.min(200, n - done) }, (_, i) => ({
          id: newId(NOW - n + done + i),
          audience_permission: null,
          user_id: staff.id,
          type: 'job.dead',
          title_key: JOB_DEAD,
          params: '{}',
          link: null,
          created_at: NOW - n + done + i,
          expires_at: NOW + DAY,
        }));
        await h.db.insertInto('notifications').values(rows).execute();
      }
      expect(await countUnread(h.db, staff, NOW)).toBe(n);
      expect(await withTx(h, (trx) => markAllRead(trx, staff, NOW))).toBe(n);
      expect(await countUnread(h.db, staff, NOW)).toBe(0);
    });
  });
});
