import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, auditAppend, runMigrations, withTx, type AuditEntry } from '@altis/db';
import { purgeAudit } from '@altis/core';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor } from '../support-auth.js';

// The audit API of Task 23 (spec §7.4, §7.8, §13.5 "Audit") on the engine picked by ALTIS_TEST_DB:
// - `GET audit`: filters, newest first, keyset paging on `seq` (`nextBefore`);
// - `GET audit/export`: the `audit.export` entry committed before the first byte, then a UTF-8 BOM, a header row and
//   the rows through the one CSV exporter (every cell quoted, a formula start prefixed with `'`: B6), streamed in
//   batches of at most 1000 rows read by `seq` (M16), as `audit-<from>-<to>.csv` (M33);
// - `GET audit/verify`: the hash chain's state;
// - `system.audit.read` alone cannot export; the export holds staff names and IP addresses, so it also needs a
//   re-authentication within 5 minutes.

/** Every batch auditBatches yields (its row count), through a wrapper around the real generator. */
/** The batches auditBatches yielded; `hold`, when set, is awaited before each batch is yielded. */
const spy = vi.hoisted(() => ({ batches: [] as number[], hold: undefined as Promise<void> | undefined }));

vi.mock('@altis/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/core')>();
  return {
    ...actual,
    auditBatches: async function* (...args: Parameters<typeof actual.auditBatches>) {
      for await (const batch of actual.auditBatches(...args)) {
        if (spy.hold !== undefined) await spy.hold;
        spy.batches.push(batch.length);
        yield batch;
      }
    },
  };
});

const ctx = testDbContext();
let h: TestDbHandle;

const SEC = 1000;
/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const CONFIG = sampleConfig();
const IP = '203.0.113.9';
/** baseUrl is https: the session cookie is `__Host-altis_sid`. */
const SID = '__Host-altis_sid';
const AUDIT = '/api/v1/audit';
const EXPORT = '/api/v1/audit/export';
const VERIFY = '/api/v1/audit/verify';
const BOM = '﻿';
const HEADER = ['seq', 'at', 'actorType', 'actorId', 'actorName', 'action', 'entity', 'entityId', 'branchId', 'ip', 'meta'];

function appAt(log = recordingLogger()) {
  return createApp({
    state: { phase: 'ready', db: h, config: CONFIG },
    version: '1.4.2',
    buildId: 'build-x',
    log,
    clock: () => NOW,
  });
}

/**
 * A signed-in staff user holding exactly `permissions` (one custom global role), whose session confirmed its password
 * at NOW unless `reauth` is false.
 */
async function staffWith(username: string, permissions: ('system.audit.read' | 'system.audit.export')[], o: { reauth?: boolean } = {}) {
  const user = await seedStaff(h, { username, roles: [{ permissions }], now: NOW });
  const token = await sessionCookieFor(h, user.id, { now: NOW, reauthAt: o.reauth === false ? null : NOW });
  return { id: user.id, cookie: `${SID}=${token}` };
}

/** One request through the app with the raw Response (its body not read yet). */
function rawGet(app: ReturnType<typeof appAt>, urlPath: string, cookie: string): Promise<Response> {
  return Promise.resolve(app.request(urlPath, { headers: { cookie } }, { incoming: { socket: { remoteAddress: IP } } }));
}

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  at: NOW - 3600 * SEC,
  actorType: 'cli',
  actorId: null,
  action: 'users.update',
  entity: 'staff_users',
  entityId: null,
  branchId: null,
  ip: null,
  meta: {},
  ...over,
});

/** Appends `entries` to the chain (auditAppend, one transaction). */
async function append(entries: AuditEntry[]): Promise<void> {
  await withTx(h, async (trx) => {
    for (const e of entries) await auditAppend(trx, e);
  });
}

/**
 * `count` rows written straight into audit_log (seq 1..count, placeholder hashes: no chain), and audit_head moved
 * past them, for the large export: auditAppend would take four statements per row.
 */
async function bulkRows(count: number): Promise<void> {
  const hash = 'a'.repeat(64);
  for (let start = 1; start <= count; start += 500) {
    const rows = [];
    for (let seq = start; seq < Math.min(start + 500, count + 1); seq += 1) {
      rows.push({
        id: newId(),
        seq,
        at: NOW - 86_400 * SEC + seq,
        actor_type: 'cli',
        actor_id: null,
        action: 'users.update',
        entity: 'staff_users',
        entity_id: `u-${seq}`,
        branch_id: null,
        ip: null,
        meta: `{"n":${seq}}`,
        prev_hash: hash,
        hash,
      });
    }
    await h.db.insertInto('audit_log').values(rows).execute();
  }
  await h.db.updateTable('audit_head').set({ last_seq: count, last_hash: hash }).where('id', '=', 1).execute();
}

/**
 * The body as text with its BOM kept: `Response.text()` and a default TextDecoder drop a leading U+FEFF (the Encoding
 * standard's "UTF-8 decode").
 */
async function bodyText(res: Response): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
}

const auditRows = (action: string) =>
  h.db.selectFrom('audit_log').select(['seq', 'actor_type', 'actor_id', 'entity', 'entity_id', 'meta']).where('action', '=', action).execute();

/** RFC 4180 records of `text` (no BOM); throws on any cell that is not quoted. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') throw new Error(`an unquoted cell at ${i}`);
    let cell = '';
    i += 1;
    for (;;) {
      const q = text.indexOf('"', i);
      if (q < 0) throw new Error('an unterminated cell');
      cell += text.slice(i, q);
      if (text[q + 1] === '"') {
        cell += '"';
        i = q + 2;
        continue;
      }
      i = q + 1;
      break;
    }
    row.push(cell);
    if (text.startsWith(delimiter, i)) {
      i += delimiter.length;
    } else if (text.startsWith('\r\n', i)) {
      rows.push(row);
      row = [];
      i += 2;
    } else {
      throw new Error(`${JSON.stringify(text[i])} after a cell at ${i}`);
    }
  }
  if (row.length > 0) throw new Error('the last record has no CRLF');
  return rows;
}

interface ListBody {
  items: { seq: number; at: number; actorType: string; actorId: string | null; actorName: string | null; action: string; entity: string | null; entityId: string | null; branchId: string | null; ip: string | null; meta: Record<string, unknown> }[];
  nextBefore: number | null;
}

describe.skipIf(!ctx.available)(`audit API [${engineLabel()}]`, () => {
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-audit-api-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    spy.batches.length = 0;
    spy.hold = undefined;
    await h.db.deleteFrom('sessions').execute();
    await h.db.deleteFrom('rate_limits').execute();
    await h.db.deleteFrom('staff_users').execute(); // user_roles cascade
    await h.db.deleteFrom('role_permissions').execute();
    await h.db.deleteFrom('roles').execute();
    await h.db.deleteFrom('audit_log').execute();
    await h.db.updateTable('audit_head').set({ last_seq: 0, last_hash: '0'.repeat(64) }).where('id', '=', 1).execute();
  });

  describe('GET audit', () => {
    /** 120 entries by the auditor, every 4th a `users.create`, one second apart (seq n at NOW - (121 - n) s). */
    async function seed120(actorId: string): Promise<void> {
      await append(
        Array.from({ length: 120 }, (_, i) =>
          entry({
            at: NOW - (120 - i) * SEC,
            actorType: 'staff',
            actorId,
            action: i % 4 === 0 ? 'users.create' : 'users.update',
            entityId: `user-${i + 1}`,
            ip: IP,
            meta: { n: i + 1 },
          }),
        ),
      );
    }

    it('gives 50 items newest first; nextBefore leads to the next 50, then to the last 20', async () => {
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.read']);
      await seed120(auditor.id);
      const agent = createAgent(app, { peer: IP, headers: { cookie: auditor.cookie } });

      const first = await agent.get(`${AUDIT}?limit=50`);
      expect(first.status).toBe(200);
      const page1 = first.json as ListBody;
      expect(page1.items.map((i) => i.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 120 - i));
      expect(page1.nextBefore).toBe(71);
      expect(page1.items[0]).toEqual({
        seq: 120,
        at: NOW - SEC,
        actorType: 'staff',
        actorId: auditor.id,
        actorName: 'auditor',
        action: 'users.update',
        entity: 'staff_users',
        entityId: 'user-120',
        branchId: null,
        ip: IP,
        meta: { n: 120 },
      });

      const second = (await agent.get(`${AUDIT}?limit=50&before=${page1.nextBefore}`)).json as ListBody;
      expect(second.items.map((i) => i.seq)).toEqual(Array.from({ length: 50 }, (_, i) => 70 - i));
      expect(second.nextBefore).toBe(21);

      const third = (await agent.get(`${AUDIT}?limit=50&before=${second.nextBefore}`)).json as ListBody;
      expect(third.items.map((i) => i.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 20 - i));
      expect(third.nextBefore).toBeNull();

      // Without a limit: 50.
      expect(((await agent.get(AUDIT)).json as ListBody).items).toHaveLength(50);
    });

    it('?action=users.create gives only those entries', async () => {
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.read']);
      await seed120(auditor.id);
      const agent = createAgent(app, { peer: IP, headers: { cookie: auditor.cookie } });

      const res = await agent.get(`${AUDIT}?action=users.create&limit=200`);
      expect(res.status).toBe(200);
      const body = res.json as ListBody;
      expect(body.items).toHaveLength(30);
      expect(new Set(body.items.map((i) => i.action))).toEqual(new Set(['users.create']));
      expect(body.items.map((i) => i.seq)).toEqual(Array.from({ length: 30 }, (_, i) => 117 - 4 * i));
      expect(body.nextBefore).toBeNull();

      const paged = (await agent.get(`${AUDIT}?action=users.create&limit=10&before=50`)).json as ListBody;
      expect(paged.items.map((i) => i.seq)).toEqual([49, 45, 41, 37, 33, 29, 25, 21, 17, 13]);
      expect(paged.nextBefore).toBe(13);
    });

    it('filters by actor, entity, entity id and the time range (both bounds included)', async () => {
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.read']);
      await seed120(auditor.id);
      const other = newId();
      await append([
        entry({ at: NOW, actorType: 'staff', actorId: other, entity: 'roles', entityId: 'R1' }),
        entry({ at: NOW, entity: 'branches', entityId: 'user-7' }),
      ]);
      const agent = createAgent(app, { peer: IP, headers: { cookie: auditor.cookie } });
      const seqs = async (query: string) => ((await agent.get(`${AUDIT}?limit=200&${query}`)).json as ListBody).items.map((i) => i.seq);

      expect(await seqs(`actorId=${other}`)).toEqual([121]);
      const unknown = ((await agent.get(`${AUDIT}?actorId=${other}`)).json as ListBody).items[0]!;
      expect(unknown.actorName).toBeNull(); // no staff user of that id
      expect(await seqs('entity=roles')).toEqual([121]);
      expect(await seqs('entityId=user-7')).toEqual([122, 7]);
      expect(await seqs('entity=staff_users&entityId=user-7')).toEqual([7]);
      expect(await seqs(`from=${NOW - 3 * SEC}&to=${NOW - SEC}`)).toEqual([120, 119, 118]);
      expect(await seqs(`from=${NOW}`)).toEqual([122, 121]);
      expect(await seqs(`to=${NOW - 119 * SEC}`)).toEqual([2, 1]);
    });

    it('refuses a query outside the schema with 422 VALIDATION_FAILED', async () => {
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.read']);
      const agent = createAgent(app, { peer: IP, headers: { cookie: auditor.cookie } });
      for (const query of [
        'limit=0',
        'limit=201',
        'limit=1.5',
        'limit=x',
        'before=0',
        'action=users.nope',
        'actorId=not-a-ulid',
        `entity=${'e'.repeat(65)}`,
        `entityId=${'e'.repeat(192)}`,
        'from=2&to=1',
        'other=1',
        'limit=1&limit=2',
      ]) {
        const res = await agent.get(`${AUDIT}?${query}`);
        expect(res.status, query).toBe(422);
        expect((res.json as { code: string }).code, query).toBe('VALIDATION_FAILED');
      }
    });

    it('needs system.audit.read', async () => {
      const app = appAt();
      const exporter = await staffWith('exporter', ['system.audit.export']);
      const res = await createAgent(app, { peer: IP, headers: { cookie: exporter.cookie } }).get(AUDIT);
      expect(res.status).toBe(403);
      expect((res.json as { code: string }).code).toBe('AUTHZ_DENIED');
      expect((await createAgent(app, { peer: IP }).get(AUDIT)).status).toBe(401);
    });
  });

  describe('GET audit/export', () => {
    it('commits exactly one audit.export entry before the body, which starts with the BOM; formula cells prefixed (B6)', async () => {
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.read', 'system.audit.export']);
      await append([
        entry({ actorType: 'staff', actorId: auditor.id, entityId: '=HYPERLINK(1)', ip: IP }),
        entry({
          actorType: 'anonymous',
          action: 'auth.login.failed',
          entity: null,
          ip: IP,
          meta: { stage: 'password', usernameKey: '=HYPERLINK(1)' },
        }),
      ]);

      const res = await rawGet(app, EXPORT, auditor.cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="audit-all-now.csv"');
      expect(res.headers.get('cache-control')).toBe('no-store');

      // Committed before a byte of the body is read.
      const exports = await auditRows('audit.export');
      expect(exports).toHaveLength(1);
      expect(exports[0]).toMatchObject({ seq: 3, actor_type: 'staff', actor_id: auditor.id, entity: 'audit_log', entity_id: null });
      expect(JSON.parse(exports[0]!.meta)).toEqual({});

      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
      expect(text.startsWith(BOM)).toBe(true);
      expect(text.startsWith(BOM + BOM)).toBe(false);
      const rows = parseCsv(text.slice(1), ',');
      expect(rows[0]).toEqual(HEADER);
      expect(rows).toHaveLength(4); // the header, both entries, and the export's own entry (committed first)

      // The user-typed entity id: a formula start, prefixed inside the quotes.
      expect(text).toContain(`,"'=HYPERLINK(1)",`);
      expect(rows[1]).toEqual([
        '1',
        new Date(NOW - 3600 * SEC).toISOString(),
        'staff',
        auditor.id,
        'auditor',
        'users.update',
        'staff_users',
        "'=HYPERLINK(1)",
        '',
        IP,
        '{}',
      ]);
      // meta is a JSON object: its cell starts with `"{`, every inner `"` doubled; no prefix inside.
      const failedLine = text.split('\r\n')[2]!;
      expect(failedLine.endsWith(`,"{""stage"":""password"",""usernameKey"":""=HYPERLINK(1)""}"`)).toBe(true);
      expect(rows[2]![10]).toBe('{"stage":"password","usernameKey":"=HYPERLINK(1)"}');
      expect(rows[2]!.slice(2, 6)).toEqual(['anonymous', '', '', 'auth.login.failed']);
      expect(rows[3]!.slice(0, 1).concat(rows[3]!.slice(5, 7))).toEqual(['3', 'audit.export', 'audit_log']);
      expect(await auditRows('audit.export')).toHaveLength(1);
    });

    it('delimiter=semicolon separates with `;`; the filters narrow the rows, name the file and go into meta', async () => {
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.read', 'system.audit.export']);
      const from = Date.UTC(2026, 9, 19);
      const to = Date.UTC(2026, 9, 20, 23, 59, 59, 999);
      await append([
        entry({ at: from - 1, entityId: 'early' }),
        entry({ at: from, entityId: 'first' }),
        entry({ at: NOW, action: 'users.create', entityId: 'a;b' }),
      ]);

      const res = await rawGet(app, `${EXPORT}?delimiter=semicolon&from=${from}&to=${to}&entity=staff_users`, auditor.cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="audit-20261019-20261020.csv"');
      const text = await bodyText(res);
      expect(text.startsWith(`${BOM}"seq";"at";"actorType";`)).toBe(true);
      const rows = parseCsv(text.slice(1), ';');
      expect(rows.slice(1).map((r) => r[7])).toEqual(['first', 'a;b']);
      const exports = await auditRows('audit.export');
      expect(exports).toHaveLength(1);
      expect(JSON.parse(exports[0]!.meta)).toEqual({ from, to, entity: 'staff_users' });

      // One bound only: the other is `all` or `now` (M33).
      const onlyFrom = await rawGet(app, `${EXPORT}?from=${from}`, auditor.cookie);
      expect(onlyFrom.headers.get('content-disposition')).toBe('attachment; filename="audit-20261019-now.csv"');
      await onlyFrom.body?.cancel();
      const onlyTo = await rawGet(app, `${EXPORT}?to=${to}&action=users.create`, auditor.cookie);
      expect(onlyTo.headers.get('content-disposition')).toBe('attachment; filename="audit-all-20261020.csv"');
      expect(parseCsv((await bodyText(onlyTo)).slice(1), ',').slice(1).map((r) => r[7])).toEqual(['a;b']);
    });

    it('T23: a download the client cancels while a batch is being read ends quietly: no error is logged', async () => {
      const log = recordingLogger();
      const app = appAt(log);
      const auditor = await staffWith('auditor', ['system.audit.export']);
      await bulkRows(2500);
      let release!: () => void;
      spy.hold = new Promise<void>((resolve) => (release = resolve));

      const res = await rawGet(app, EXPORT, auditor.cookie);
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      expect((await reader.read()).done).toBe(false); // the BOM and the header; the next pull now waits for a batch
      const pending = reader.read();
      // The cancel waits for the batch being read (the generator finishes it before it can return).
      const cancelling = reader.cancel();
      release();
      await cancelling;
      await pending;
      await vi.waitFor(() => expect(spy.batches.length).toBeGreaterThanOrEqual(1));
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(log.lines.filter((l) => l.level === 'error')).toEqual([]);
      expect(log.lines.filter((l) => l.msg === 'audit export cancelled')).toHaveLength(1);
    });

    it('streams 20000 rows in batches of at most 1000, the first byte before the last batch is read (M16)', async () => {
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.export']);
      await bulkRows(20_000);

      const res = await rawGet(app, EXPORT, auditor.cookie);
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
      const first = await reader.read();
      expect(first.done).toBe(false);
      const batchesAtFirstByte = spy.batches.length;
      let text = decoder.decode(first.value, { stream: true });
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();

      expect(spy.batches.length).toBeGreaterThanOrEqual(20);
      expect(Math.max(...spy.batches)).toBeLessThanOrEqual(1000);
      expect(spy.batches.reduce((a, b) => a + b, 0)).toBe(20_001); // the rows and the export's own entry
      expect(batchesAtFirstByte).toBeLessThanOrEqual(1); // the header, and at most the batch its read asked for
      expect(batchesAtFirstByte).toBeLessThan(spy.batches.length);
      const rows = parseCsv(text.slice(1), ',');
      expect(rows).toHaveLength(20_002);
      expect(rows[1]!.slice(0, 1)).toEqual(['1']);
      expect(rows[20_000]![0]).toBe('20000');
      expect(rows[20_001]![5]).toBe('audit.export');
    });

    it('system.audit.read alone cannot export (403), and nothing is exported or audited as an export', async () => {
      const app = appAt();
      const reader = await staffWith('reader', ['system.audit.read']);
      const res = await createAgent(app, { peer: IP, headers: { cookie: reader.cookie } }).get(EXPORT);
      expect(res.status).toBe(403);
      expect((res.json as { code: string }).code).toBe('AUTHZ_DENIED');
      expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
      expect(await auditRows('audit.export')).toEqual([]);
      expect(await auditRows('authz.denied')).toHaveLength(1);
    });

    it('the file holds staff names: without a password confirmation in the last 5 minutes → 401 AUTH_REAUTH_REQUIRED, nothing read or audited', async () => {
      const app = appAt();
      await append([entry({ actorType: 'cli' })]);
      const stale = await staffWith('auditor_lama', ['system.audit.read', 'system.audit.export'], { reauth: false });
      const res = await createAgent(app, { peer: IP, headers: { cookie: stale.cookie } }).get(EXPORT);
      expect([res.status, (res.json as { code: string }).code]).toEqual([401, 'AUTH_REAUTH_REQUIRED']);
      expect(spy.batches).toEqual([]);
      expect(await auditRows('audit.export')).toEqual([]);

      // A confirmation 5 minutes and 1 second ago no longer counts; one made now does.
      const old = await sessionCookieFor(h, stale.id, { now: NOW, reauthAt: NOW - 301 * SEC });
      const late = await createAgent(app, { peer: IP, headers: { cookie: `${SID}=${old}` } }).get(EXPORT);
      expect([late.status, (late.json as { code: string }).code]).toEqual([401, 'AUTH_REAUTH_REQUIRED']);
      const fresh = await sessionCookieFor(h, stale.id, { now: NOW, reauthAt: NOW });
      const ok = await rawGet(app, EXPORT, `${SID}=${fresh}`);
      expect(ok.status).toBe(200);
      await bodyText(ok);
      expect(await auditRows('audit.export')).toHaveLength(1);
    });

    it('T23: HEAD is not answered (404) and writes no audit.export entry; nothing is read', async () => {
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.export']);
      const res = await app.request(EXPORT, { method: 'HEAD', headers: { cookie: auditor.cookie } }, { incoming: { socket: { remoteAddress: IP } } });
      expect(res.status).toBe(404);
      expect(await auditRows('audit.export')).toEqual([]);
    });

    it('T23: a cross-site request (a link on another site: Sec-Fetch-Site cross-site, or a foreign Referer/Origin) → 403 ORIGIN_DENIED, no entry', async () => {
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.export']);
      const agent = createAgent(app, { peer: IP, headers: { cookie: auditor.cookie } });
      const refused: Record<string, string>[] = [
        { 'sec-fetch-site': 'cross-site' },
        { 'sec-fetch-site': 'same-site' },
        { referer: 'https://evil.example/page' },
        { origin: 'https://evil.example' },
        { origin: 'null' },
      ];
      for (const headers of refused) {
        const res = await agent.get(EXPORT, undefined, headers);
        expect(res.status, JSON.stringify(headers)).toBe(403);
        expect((res.json as { code: string }).code).toBe('ORIGIN_DENIED');
      }
      expect(await auditRows('audit.export')).toEqual([]);

      // The SPA's own link (same-origin), a typed or bookmarked URL (none), and a client that sends neither header.
      const allowed: Record<string, string>[] = [
        { 'sec-fetch-site': 'same-origin', referer: `${CONFIG.baseUrl}/admin/audit` },
        { 'sec-fetch-site': 'none' },
        {},
      ];
      for (const headers of allowed) {
        const res = await agent.get(EXPORT, undefined, headers);
        expect(res.status, JSON.stringify(headers)).toBe(200);
      }
      expect(await auditRows('audit.export')).toHaveLength(3);
    });

    it('T23: the reads of the log (GET audit, audit/verify) are not side-effect routes: a cross-site GET and HEAD still answer', async () => {
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.read']);
      const agent = createAgent(app, { peer: IP, headers: { cookie: auditor.cookie } });
      expect((await agent.get(AUDIT, undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
      const head = await app.request(VERIFY, { method: 'HEAD', headers: { cookie: auditor.cookie } }, { incoming: { socket: { remoteAddress: IP } } });
      expect(head.status).toBe(200);
    });

    it('refuses an unknown delimiter or query key with 422 and writes no audit.export entry', async () => {
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.export']);
      const agent = createAgent(app, { peer: IP, headers: { cookie: auditor.cookie } });
      for (const query of ['delimiter=tab', 'limit=5', 'before=3']) {
        expect((await agent.get(`${EXPORT}?${query}`)).status, query).toBe(422);
      }
      expect(await auditRows('audit.export')).toEqual([]);
    });
  });

  describe('GET audit/verify', () => {
    it('{ok: true, head} for an intact chain; {ok: false, brokenAt} at a row whose meta was changed', async () => {
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.read']);
      await append(Array.from({ length: 30 }, (_, i) => entry({ entityId: `e-${i + 1}`, meta: { n: i + 1 } })));
      const agent = createAgent(app, { peer: IP, headers: { cookie: auditor.cookie } });

      const ok = await agent.get(VERIFY);
      expect(ok.status).toBe(200);
      expect(ok.json).toEqual({ ok: true, head: 30 });

      await h.db.updateTable('audit_log').set({ meta: '{"n":999}' }).where('seq', '=', 17).execute();
      const broken = await agent.get(VERIFY);
      expect(broken.status).toBe(200);
      expect(broken.json).toEqual({ ok: false, brokenAt: 17 });
    });

    it('1c Task 18: after a retention purge it verifies from audit.anchor (§7.8: the API keeps verifying after a purge)', async () => {
      await h.db.deleteFrom('settings').where('key', '=', 'audit.anchor').execute();
      const app = appAt();
      const auditor = await staffWith('auditor', ['system.audit.read']);
      const old = NOW - 3 * 365 * 86_400 * SEC;
      await append(Array.from({ length: 30 }, (_, i) => entry({ at: old, entityId: `e-${i + 1}`, meta: { n: i + 1 } })));
      // 10 % of the 30 entries: 1-3 go, audit.anchor = entry 3, and the purge is audited as entry 31.
      expect(await purgeAudit(h, { now: NOW, from: null })).toMatchObject({ deleted: 3, anchorSeq: 3, next: null });
      const agent = createAgent(app, { peer: IP, headers: { cookie: auditor.cookie } });
      const ok = await agent.get(VERIFY);
      expect(ok.status).toBe(200);
      expect(ok.json).toEqual({ ok: true, head: 31 });
      // Without the anchor the purged start would read as a break.
      await h.db.deleteFrom('settings').where('key', '=', 'audit.anchor').execute();
      expect((await agent.get(VERIFY)).json).toEqual({ ok: false, brokenAt: 1 });
    });

    it('needs system.audit.read', async () => {
      const app = appAt();
      const exporter = await staffWith('exporter', ['system.audit.export']);
      expect((await createAgent(app, { peer: IP, headers: { cookie: exporter.cookie } }).get(VERIFY)).status).toBe(403);
    });
  });
});
