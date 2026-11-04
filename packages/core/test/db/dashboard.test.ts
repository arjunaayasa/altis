import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FeedEntry, VerifiedFeed } from '@altis/crypto/feed';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { PERMISSIONS, newId, type OpKind, type Permission } from '@altis/shared';
import { ALERT_KINDS, type AlertKind, type DashboardResponse } from '@altis/shared/api/dashboard';
import type { ScheduleView } from '@altis/shared/api/jobs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { Grants } from '../../src/authz/grants.js';
import type { CoreLogger } from '../../src/context.js';
import { ALERT_LINK, ALERT_PERMISSION, ALERT_SEVERITY, dashboardSummary, type DashboardOptions } from '../../src/dashboard/summary.js';
import { COMMUNITY_EDITION, type EditionCheck } from '../../src/edition/edition.js';
import { notify } from '../../src/notifications/service.js';
import type { OpFile } from '../../src/ops/files.js';
import type { OpStatus } from '../../src/ops/machine.js';
import { SCHEDULES } from '../../src/scheduler/registry.js';
import { seedSchedules } from '../../src/scheduler/tick.js';
import { writeSettings } from '../../src/settings/service.js';
import { runUpdateCheck } from '../../src/updates/check-job.js';

/** The backup ids whose manifest.json was read (the dashboard's reads must stay cheap). */
const manifestReads = vi.hoisted((): string[] => []);
vi.mock('../../src/backup/manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/backup/manifest.js')>();
  const readManifest: typeof actual.readManifest = async (dir, id) => {
    manifestReads.push(id);
    return actual.readManifest(dir, id);
  };
  return { ...actual, readManifest };
});

/**
 * Phase 2 (B2): the catalog alerts hook (Task 2 wired it, Task 15 gave it its causes, see catalog-alerts.test.ts). The mock
 * counts the calls, runs the real hook, then raises what a test lists (to reach both kinds whatever the data).
 */
const catalogHook = vi.hoisted(() => ({ calls: 0, raise: [] as ('search_index_mismatch' | 'oai_misconfigured')[] }));
vi.mock('../../src/dashboard/catalog-alerts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/dashboard/catalog-alerts.js')>();
  const catalogAlerts: typeof actual.catalogAlerts = async (db, raise) => {
    catalogHook.calls += 1;
    await actual.catalogAlerts(db, raise);
    for (const kind of catalogHook.raise) raise(kind);
  };
  return { ...actual, catalogAlerts };
});

// The system dashboard (plan Task 26, spec §13.3 "Dasbor sistem", decision C33) on the engine picked by
// ALTIS_TEST_DB: every section and every alert is filtered by the permission that guards its data; each alert
// appears exactly under its rule and disappears when its cause goes (Review Focus 1: a missing runner shows).

const ctx = testDbContext();
/** In the past: an event row (a notification's hint) may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 27, 9, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** An installation older than the 48 h of `backup_missing`. */
const INSTALLED = '2026-10-01';

const grantsOf = (permissions: readonly Permission[], superAdmin = false): Grants => ({
  global: new Set(permissions),
  branches: new Map(),
  superAdmin,
  roleMfaRequired: false,
});
const SUPER: Grants = grantsOf(PERMISSIONS, true);
const NOBODY: Grants = grantsOf([]);

/** What the jobs API would list (the dashboard takes its schedules from the caller: the server's listScheduleViews). */
const SCHEDULE_VIEWS: ScheduleView[] = [
  {
    name: 'backup.daily',
    expr: '0 1 * * *',
    enabled: true,
    nextRunAt: NOW + HOUR,
    lastRunAt: null,
    jobType: 'backup.schedule',
    exprEditable: true,
    permission: 'system.backup.create',
  },
];

// ---- the edition the dashboard reads: the community one, unless a test fakes another edition through the seam ----

/** The community edition as the dashboard shows it. */
const COMMUNITY_VIEW = { edition: 'community', status: 'active' };

/** A fake edition (the seam, ruling R1) that does not cover a release dated after `until`. */
const coveringUntil = (until: string): EditionCheck => ({
  edition: 'fake',
  status: 'limited',
  notEntitled: (releasedAt: string) => (releasedAt > until ? 'released_after' : null),
});

/** A feed entry of `version`, released on 2026-10-20 (the package is never downloaded here). */
function entryOf(version: string): FeedEntry {
  return {
    version,
    channel: 'stable',
    releasedAt: '2026-10-20',
    bootProtocol: 1,
    minUpgradeFrom: '0.0.0',
    minCodeVersionAfter: '0.0.0',
    minNode: '22.16.0',
    minDb: { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' },
    size: 1024,
    sha256: 'a'.repeat(64),
    url: `https://updates.example.test/packages/altis-${version}.zip`,
    notesUrl: 'https://updates.example.test/notes/0.2.0-test',
  };
}

const silent: CoreLogger = { info() {}, warn() {}, error() {} };

/** An op that needs attention (`kind` null: an unreadable op.json under a manual flag). */
const attention = (kind: OpKind | null): OpStatus => ({
  opId: kind === null ? null : newId(),
  kind,
  state: 'needs_attention',
  terminal: false,
  needsAttention: true,
  startedAt: NOW - HOUR,
  heartbeatAt: NOW - HOUR,
  finishedAt: null,
  progress: 10,
  message: null,
  error: null,
  pointOfNoReturn: false,
  backupId: null,
  actor: null,
});

describe.skipIf(!ctx.available)(`the system dashboard [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let appRoot: string;
  let op: OpStatus | null;
  let opReads: number;
  let scheduleReads: number;
  let check: EditionCheck;
  let editionReads: number;
  const sessionKey = randomBytes(32);

  const options = (o: Partial<DashboardOptions> = {}): DashboardOptions => ({
    db: h.db,
    dataDir,
    appRoot,
    sessionKey,
    grants: SUPER,
    now: NOW,
    version: '0.1.0',
    appJsVersion: '0.1.0',
    runtime: 'passenger',
    env: {},
    trialStartedAt: INSTALLED,
    ops: {
      current: async () => {
        opReads += 1;
        return op;
      },
    },
    edition: {
      check: async () => {
        editionReads += 1;
        return check;
      },
    },
    listSchedules: async () => {
      scheduleReads += 1;
      return SCHEDULE_VIEWS;
    },
    ...o,
  });

  /** 1d Task 29: DATA_DIR/releases/current.json. */
  const writeCurrent = async (state: Record<string, unknown>): Promise<void> => {
    await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
    const full = { schema: 1, previous: null, pending: null, pendingSince: null, pinned: null, ...state };
    await fsp.writeFile(path.join(dataDir, 'releases', 'current.json'), JSON.stringify(full));
  };

  /** 1d Task 29: DATA_DIR/ops/op.json holding an `update` op of `source` in `state` (as the update kind leaves it). */
  async function updateOpFile(state: string, source: 'self' | 'feed', o: { finishedAt?: number | null } = {}): Promise<void> {
    const terminal = ['done', 'aborted', 'rolled_back', 'restored', 'restore_failed'].includes(state);
    const file: OpFile = {
      opSchema: 1,
      opId: newId(NOW - HOUR),
      kind: 'update',
      actor: { type: 'system', id: null },
      state,
      version: '0.2.0',
      backupId: null,
      heartbeatAt: NOW - 30 * MIN,
      startedAt: NOW - HOUR,
      finishedAt: o.finishedAt !== undefined ? o.finishedAt : terminal ? NOW - 30 * MIN : null,
      error: state === 'restore_failed' ? { code: 'UPDATE_SCHEMA_HOLD_FAILED', detail: 'x' } : null,
      opsTokenHash: null,
      pointOfNoReturn: true,
      params: { source, target: '0.2.0', from: '0.1.0', entry: null, staging: null, needsBackup: true },
      progress: 50,
      message: null,
    };
    await fsp.mkdir(path.join(dataDir, 'ops'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'ops', 'op.json'), JSON.stringify(file));
  }
  const summary = (o: Partial<DashboardOptions> = {}): Promise<DashboardResponse> => dashboardSummary(options(o));
  const kinds = (r: DashboardResponse): AlertKind[] => r.alerts.map((a) => a.kind);
  const alertOf = (r: DashboardResponse, kind: AlertKind) => r.alerts.find((a) => a.kind === kind);

  const set = (values: Parameters<typeof writeSettings>[1]) =>
    withTx(h, (trx) => writeSettings(trx, values, { keyring: [], now: NOW, actorId: null }));

  async function job(status: string, o: { runAt?: number; finishedAt?: number | null } = {}): Promise<void> {
    const runAt = o.runAt ?? NOW - HOUR;
    await h.db
      .insertInto('jobs')
      .values({
        id: newId(),
        type: 'test.slices',
        payload: '{}',
        secret_param: null,
        status,
        run_at: runAt,
        max_attempts: 5,
        unique_key: null,
        lock_token: null,
        locked_by: null,
        locked_until: null,
        progress_message: null,
        last_error: status === 'dead' ? 'LEASE_EXPIRED_MAX_ATTEMPTS' : null,
        created_by: null,
        created_at: runAt,
        updated_at: runAt,
        finished_at: o.finishedAt ?? null,
      })
      .execute();
  }

  async function backup(status: string, createdAt: number, kind = 'scheduled'): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('backups')
      .values({
        id,
        kind,
        size: status === 'ok' ? 1000 : null,
        sha256: null,
        schema_version: '0.1.0',
        app_version: '0.1.0',
        dialect: h.dialect,
        consistency: 'snapshot',
        status,
        created_at: createdAt,
      })
      .execute();
    return id;
  }

  const diskLow = (at: number, titleKey: 'notification.disk_low.title' | 'notification.backup_skipped.title' = 'notification.disk_low.title') =>
    withTx(h, (trx) => notify(trx, { audience: { permission: 'system.diagnostics.read' }, type: 'disk.low', titleKey }, at));

  const dailyEnabled = (enabled: boolean) => h.db.updateTable('schedules').set({ enabled: enabled ? 1 : 0 }).where('name', '=', 'backup.daily').execute();

  /** The cause of every alert at once. */
  async function everyCause(): Promise<void> {
    await set({
      'system.clock_anomaly': { detectedAt: NOW - 8 * MIN, maxSeen: NOW + HOUR },
      'system.exposure': { at: NOW - 5 * MIN, ok: false, url: 'https://perpus.example.test/altis-data/tmp/x' },
      'system.ip_trust': 'spoofable',
      'system.probe': {
        at: NOW - 2 * MIN,
        polling: true,
        sse: false,
        methods: { put: true, patch: true, delete: true },
        chunkBytes: null,
        xff: { spoofable: true, suggestedHops: 2 },
      },
      'audit.verified': { at: NOW - 7 * MIN, ok: false, head: 99, headHash: 'a'.repeat(64), brokenAt: 57 },
    });
    await job('dead', { finishedAt: NOW - DAY });
    await backup('failed', NOW - DAY);
    await diskLow(NOW - HOUR);
    op = attention('backup');
    // 1d Task 29: the keyset store is full, a bundled 0.3.0 failed its prechecks, a pinned bundled 0.2.0 is not
    // installed, a schemaHold update failed.
    await set({
      'system.keyset_full': { at: NOW - HOUR, refused: 2 },
      'update.bundled_blocked': { version: '0.3.0', at: NOW - HOUR, failures: ['min_node'] },
    });
    await writeCurrent({ active: { version: '0.1.0', source: 'data' }, pinned: '0.2.0' });
    await fsp.mkdir(path.join(appRoot, 'bundled-release', '0.2.0'), { recursive: true });
    await updateOpFile('restore_failed', 'self');
  }

  /** 1d Task 29: everyCause's options: app.js 0.2.0 beside its bundled release. */
  const causes = (o: Partial<DashboardOptions> = {}): Partial<DashboardOptions> => ({ appJsVersion: '0.2.0', ...o });

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-dashboard-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataDir = path.join(root, `data-${newId()}`);
    appRoot = path.join(root, `app-${newId()}`);
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
    await fsp.mkdir(appRoot, { recursive: true });
    for (const table of ['jobs', 'backups', 'notifications', 'settings', 'schedules', 'events', 'releases_log'] as const) {
      await h.db.deleteFrom(table).execute();
    }
    await withTx(h, (trx) => seedSchedules(trx, NOW, 'Asia/Jakarta', SCHEDULES));
    op = null;
    opReads = 0;
    scheduleReads = 0;
    catalogHook.calls = 0;
    catalogHook.raise = [];
    check = COMMUNITY_EDITION;
    editionReads = 0;
  });

  describe('sections by permission (C33)', () => {
    it('a staff user without permissions: the version and the edition only, every other section null and no alert, whatever is wrong', async () => {
      await everyCause();
      const r = await summary(causes({ grants: NOBODY }));
      expect(r).toEqual({
        version: { current: '0.1.0', appJs: '0.2.0', bootProtocol: 1, update: null },
        edition: COMMUNITY_VIEW,
        lastBackup: null,
        nextBackupAt: null,
        queue: null,
        scheduler: null,
        alerts: [],
      });
      // Nothing it may not see was even read.
      expect(opReads).toBe(0);
      expect(scheduleReads).toBe(0);
      // The edition is everyone's: asked once (the community edition reads nothing).
      expect(editionReads).toBe(1);
    });

    it('a super admin: every section, and every alert whose cause is present, errors first', async () => {
      await everyCause();
      const failed = (await h.db.selectFrom('backups').select('id').executeTakeFirstOrThrow()).id;
      const daily = await h.db.selectFrom('schedules').select('next_run_at').where('name', '=', 'backup.daily').executeTakeFirstOrThrow();
      const r = await summary(causes());
      // The community edition: nothing it could fail to cover (entitled); the pin of a rollback.
      expect(r.version).toEqual({
        current: '0.1.0',
        appJs: '0.2.0',
        bootProtocol: 1,
        update: { available: null, checkedAt: null, entitled: true, oneClick: true, pinned: '0.2.0' },
      });
      expect(r.edition).toEqual(COMMUNITY_VIEW);
      expect(r.lastBackup).toMatchObject({ id: failed, status: 'failed', kind: 'scheduled', createdAt: NOW - DAY });
      expect(r.nextBackupAt).toBe(Number(daily.next_run_at));
      expect(r.queue).toEqual({ queued: 0, running: 0, dead: 1, oldestQueuedMs: null });
      expect(r.scheduler).toEqual({ runner: { mode: 'external', lastRuns: {} }, schedules: SCHEDULE_VIEWS });
      expect(kinds(r)).toEqual([
        'runner_stale',
        'exposure_failed',
        'ops_attention',
        'audit_broken',
        'schema_hold',
        'clock_anomaly',
        'backup_missing',
        'backup_failed',
        'jobs_dead',
        'disk_low',
        'ip_trust',
        'keyset_full',
        'update_blocked',
        'oai_misconfigured', // Phase 2 (Task 15): OAI is on and its admin e-mail empty by default
        'bundled_ignored',
      ]);
      for (const a of r.alerts) expect(a.messageKey).toBe(`alert.${a.kind}`);
      expect(r.alerts.map((a) => [a.kind, a.severity, a.link])).toEqual([
        ['runner_stale', 'error', '/admin/diagnostics'],
        ['exposure_failed', 'error', '/admin/diagnostics'],
        ['ops_attention', 'error', '/admin/_update'],
        ['audit_broken', 'error', '/admin/audit'],
        ['schema_hold', 'error', '/admin/updates'],
        ['clock_anomaly', 'warning', '/admin/diagnostics'],
        ['backup_missing', 'warning', '/admin/backups'],
        ['backup_failed', 'warning', '/admin/backups'],
        ['jobs_dead', 'warning', '/admin/jobs'],
        ['disk_low', 'warning', '/admin/diagnostics'],
        ['ip_trust', 'warning', '/admin/diagnostics'],
        ['keyset_full', 'warning', '/admin/diagnostics'],
        ['update_blocked', 'warning', '/admin/updates'],
        ['oai_misconfigured', 'warning', '/admin/diagnostics'],
        ['bundled_ignored', 'info', '/admin/updates'],
      ]);
      expect(alertOf(r, 'jobs_dead')?.params).toEqual({ count: 1 });
      expect(alertOf(r, 'ip_trust')?.params).toEqual({ suggestedHops: 2 });
    });

    it('each permission opens exactly its sections and its alerts', async () => {
      await everyCause();
      catalogHook.raise = ['search_index_mismatch', 'oai_misconfigured']; // Phase 2: their causes are Task 15's
      const guarded = [...new Set(Object.values(ALERT_PERMISSION))];
      for (const permission of [...guarded, 'system.backup.restore'] as Permission[]) {
        const r = await summary(causes({ grants: grantsOf([permission]) }));
        const want = (Object.entries(ALERT_PERMISSION) as [AlertKind, Permission][]).filter(([, p]) => p === permission).map(([k]) => k);
        expect(kinds(r).sort(), permission).toEqual(want.sort());
        expect(r.edition, permission).toEqual(COMMUNITY_VIEW);
        expect(r.version.update !== null, permission).toBe(permission === 'system.update.read');
        expect(r.queue !== null && r.scheduler !== null, permission).toBe(permission === 'system.jobs.read');
        expect(r.lastBackup !== null && r.nextBackupAt !== null, permission).toBe(permission === 'system.backup.read');
      }
      // Every 1d kind is guarded by the permission of its data (preflight S13).
      for (const p of ['system.update.read', 'system.diagnostics.read'] as Permission[]) expect(guarded, p).toContain(p);
    });

    it('ALERT_KINDS matches the exhaustive permission, severity and link tables (no kind without its row, no row without its kind)', () => {
      expect(Object.keys(ALERT_SEVERITY).sort()).toEqual([...ALERT_KINDS].sort());
      expect(Object.keys(ALERT_LINK).sort()).toEqual([...ALERT_KINDS].sort());
      expect([...Object.keys(ALERT_PERMISSION), 'ops_attention'].sort()).toEqual([...ALERT_KINDS].sort());
      expect(Object.isFrozen(ALERT_SEVERITY) && Object.isFrozen(ALERT_LINK) && Object.isFrozen(ALERT_PERMISSION)).toBe(true);
      for (const kind of ALERT_KINDS) expect(ALERT_LINK[kind], kind).toMatch(/^\/admin\//);
    });

    it('nextBackupAt is the backup.daily row’s next_run_at, null while it is off; lastBackup the newest backup not deleted', async () => {
      const reader = grantsOf(['system.backup.read']);
      await h.db.updateTable('schedules').set({ next_run_at: NOW + 7 * HOUR }).where('name', '=', 'backup.daily').execute();
      expect((await summary({ grants: reader })).nextBackupAt).toBe(NOW + 7 * HOUR);
      expect((await summary({ grants: reader })).lastBackup).toBeNull();
      await dailyEnabled(false);
      expect((await summary({ grants: reader })).nextBackupAt).toBeNull();
      const ok = await backup('ok', NOW - 2 * DAY);
      await backup('deleted', NOW - DAY);
      expect((await summary({ grants: reader })).lastBackup).toMatchObject({ id: ok, status: 'ok', size: 1000 });
    });

    it('cheap reads: of every kept backup only the newest one’s manifest is read, however many there are', async () => {
      for (let i = 0; i < 6; i += 1) await backup('ok', NOW - (i + 1) * DAY);
      const newest = await backup('ok', NOW - HOUR);
      await backup('deleted', NOW - MIN);
      manifestReads.length = 0;
      const r = await summary();
      expect(r.lastBackup).toMatchObject({ id: newest, status: 'ok' });
      expect(manifestReads).toEqual([newest]);
    });

    it('the queue: counts and how long the oldest due job has waited', async () => {
      await job('queued', { runAt: NOW - 10 * MIN });
      await job('queued', { runAt: NOW - 2 * MIN });
      await job('queued', { runAt: NOW + 10 * MIN }); // not due yet
      await job('running', { runAt: NOW - MIN });
      await job('dead', { finishedAt: NOW - 9 * DAY });
      await job('succeeded', { finishedAt: NOW - MIN });
      expect((await summary({ grants: grantsOf(['system.jobs.read']) })).queue).toEqual({
        queued: 3,
        running: 1,
        dead: 1,
        oldestQueuedMs: 10 * MIN,
      });
    });

    // backup_missing counts from the install date (`trialStartedAt`, the name config.json keeps): its case below.
  });

  // ---- Phase 2 (catalog): Task 2 (B2) ----
  describe('Phase 2 (B2): the catalog alerts', () => {
    it('ALERT_KINDS ends with search_index_mismatch and oai_misconfigured, both guarded by system.diagnostics.read', () => {
      expect(ALERT_KINDS.slice(-2)).toEqual(['search_index_mismatch', 'oai_misconfigured']);
      expect(ALERT_PERMISSION.search_index_mismatch).toBe('system.diagnostics.read');
      expect(ALERT_PERMISSION.oai_misconfigured).toBe('system.diagnostics.read');
    });

    it('the real hook (Task 15) on these settings: OAI on without an admin e-mail raises oai_misconfigured', async () => {
      const { catalogAlerts } = await vi.importActual<typeof import('../../src/dashboard/catalog-alerts.js')>(
        '../../src/dashboard/catalog-alerts.js',
      );
      const raise = vi.fn();
      await catalogAlerts(h.db, raise);
      // Its causes are tested in catalog-alerts.test.ts; here only that the defaults raise the OAI one.
      expect(raise.mock.calls.map((c) => c[0] as string)).toContain('oai_misconfigured');
    });

    it('dashboardSummary asks the hook once for a holder of system.diagnostics.read, never for anyone else', async () => {
      await summary({ grants: grantsOf(['system.diagnostics.read']) });
      expect(catalogHook.calls).toBe(1);
      await summary({ grants: SUPER });
      expect(catalogHook.calls).toBe(2);
      for (const p of ['system.jobs.read', 'system.backup.read', 'system.audit.read', 'catalog.records.read'] as Permission[]) {
        await summary({ grants: grantsOf([p]) });
      }
      await summary({ grants: NOBODY });
      expect(catalogHook.calls).toBe(2);
    });

    it('what the hook raises is a warning linking Diagnostik, after the 1c warnings', async () => {
      catalogHook.raise = ['oai_misconfigured', 'search_index_mismatch'];
      await set({ 'system.ip_trust': 'spoofable' });
      const r = await summary({ grants: grantsOf(['system.diagnostics.read']) });
      expect(r.alerts).toEqual([
        { kind: 'ip_trust', severity: 'warning', messageKey: 'alert.ip_trust', link: '/admin/diagnostics' },
        { kind: 'search_index_mismatch', severity: 'warning', messageKey: 'alert.search_index_mismatch', link: '/admin/diagnostics' },
        { kind: 'oai_misconfigured', severity: 'warning', messageKey: 'alert.oai_misconfigured', link: '/admin/diagnostics' },
      ]);
    });
  });

  describe('each alert appears exactly under its rule and goes with its cause', () => {
    it('runner_stale (Review Focus 1): external mode without a worker or cron run within 10 minutes', async () => {
      const jobsReader = grantsOf(['system.jobs.read']);
      const stale = async (o: Partial<DashboardOptions> = {}) => alertOf(await summary({ grants: jobsReader, ...o }), 'runner_stale');
      expect(await stale()).toEqual({ kind: 'runner_stale', severity: 'error', messageKey: 'alert.runner_stale', link: '/admin/diagnostics' });
      // Drive and piggyback run only because of traffic: they are no runner.
      await set({ 'system.run.drive': NOW, 'system.run.piggyback': NOW });
      expect(await stale()).toBeDefined();
      await set({ 'system.run.cron_http': NOW - 11 * MIN });
      expect(await stale()).toBeDefined();
      await set({ 'system.run.cron_http': NOW - 9 * MIN });
      expect(await stale()).toBeUndefined();
      await set({ 'system.run.cron_http': null, 'system.run.cron_cli': NOW - MIN });
      expect(await stale()).toBeUndefined();
      await set({ 'system.run.cron_cli': null, 'system.run.worker': NOW - 5 * MIN });
      expect(await stale()).toBeUndefined();
      await set({ 'system.run.worker': null });
      expect(await stale()).toBeDefined();
      // Worker mode runs its own loop: no alert; ALTIS_RUNNER=off makes a pm2 process external again.
      expect(await stale({ runtime: 'pm2' })).toBeUndefined();
      expect(await stale({ runtime: 'litespeed' })).toBeDefined();
      expect(await stale({ runtime: 'pm2', env: { ALTIS_RUNNER: 'off' } })).toBeDefined();
      const r = await summary({ grants: jobsReader, runtime: 'pm2', env: { ALTIS_RUNNER: 'off' } });
      expect(r.scheduler?.runner.mode).toBe('external');
      expect(r.scheduler?.runner.lastRuns).toEqual({ drive: NOW, piggyback: NOW });
    });

    it('clock_anomaly: while system.clock_anomaly is set', async () => {
      const reader = grantsOf(['system.diagnostics.read']);
      expect(alertOf(await summary({ grants: reader }), 'clock_anomaly')).toBeUndefined();
      await set({ 'system.clock_anomaly': { detectedAt: NOW - MIN, maxSeen: NOW + HOUR } });
      expect(alertOf(await summary({ grants: reader }), 'clock_anomaly')).toEqual({
        kind: 'clock_anomaly',
        severity: 'warning',
        messageKey: 'alert.clock_anomaly',
        link: '/admin/diagnostics',
      });
      await set({ 'system.clock_anomaly': null });
      expect(alertOf(await summary({ grants: reader }), 'clock_anomaly')).toBeUndefined();
    });

    it('exposure_failed (the red alert of §11): while the last exposure check failed', async () => {
      const reader = grantsOf(['system.diagnostics.read']);
      expect(alertOf(await summary({ grants: reader }), 'exposure_failed')).toBeUndefined();
      await set({ 'system.exposure': { at: NOW - HOUR, ok: false, url: 'https://perpus.example.test/app.js' } });
      expect(alertOf(await summary({ grants: reader }), 'exposure_failed')).toEqual({
        kind: 'exposure_failed',
        severity: 'error',
        messageKey: 'alert.exposure_failed',
        link: '/admin/diagnostics',
      });
      await set({ 'system.exposure': { at: NOW, ok: true, url: null } });
      expect(alertOf(await summary({ grants: reader }), 'exposure_failed')).toBeUndefined();
    });

    it('backup_missing: backup.daily on and no ok backup of this installation within 48 h (an installation of 48 h at least)', async () => {
      const reader = grantsOf(['system.backup.read']);
      const missing = async (o: Partial<DashboardOptions> = {}) => alertOf(await summary({ grants: reader, ...o }), 'backup_missing');
      expect(await missing()).toEqual({ kind: 'backup_missing', severity: 'warning', messageKey: 'alert.backup_missing', link: '/admin/backups' });
      // A fresh installation has had no night to back up in yet.
      expect(await missing({ trialStartedAt: '2026-10-26' })).toBeUndefined();
      expect(await missing({ trialStartedAt: '2026-10-25' })).toBeDefined();
      await backup('ok', NOW - 49 * HOUR);
      await backup('uploaded', NOW - HOUR, 'external'); // an archive from elsewhere backs nothing of this one up
      await backup('failed', NOW - 2 * HOUR);
      expect(await missing()).toBeDefined();
      const recent = await backup('ok', NOW - 47 * HOUR, 'manual');
      expect(await missing()).toBeUndefined();
      await h.db.updateTable('backups').set({ status: 'deleted' }).where('id', '=', recent).execute();
      expect(await missing()).toBeDefined();
      await dailyEnabled(false);
      expect(await missing()).toBeUndefined();
    });

    it('backup_failed: while the newest finished backup failed', async () => {
      const reader = grantsOf(['system.backup.read']);
      const failed = async () => alertOf(await summary({ grants: reader }), 'backup_failed');
      await backup('ok', NOW - 3 * DAY);
      expect(await failed()).toBeUndefined();
      await backup('failed', NOW - 2 * DAY);
      expect(await failed()).toEqual({ kind: 'backup_failed', severity: 'warning', messageKey: 'alert.backup_failed', link: '/admin/backups' });
      // A backup still running (or stuck) has not made up for it yet, nor has an uploaded archive.
      await backup('running', NOW - DAY);
      await backup('uploaded', NOW - HOUR, 'external');
      expect(await failed()).toBeDefined();
      await backup('ok', NOW - MIN, 'manual');
      expect(await failed()).toBeUndefined();
    });

    it('jobs_dead: dead jobs that finished within 7 days, with their count', async () => {
      const reader = grantsOf(['system.jobs.read']);
      const dead = async () => alertOf(await summary({ grants: reader }), 'jobs_dead');
      await job('dead', { finishedAt: NOW - 8 * DAY });
      await job('succeeded', { finishedAt: NOW - MIN });
      await job('cancelled', { finishedAt: NOW - MIN });
      expect(await dead()).toBeUndefined();
      await job('dead', { finishedAt: NOW - 6 * DAY });
      expect(await dead()).toEqual({ kind: 'jobs_dead', severity: 'warning', messageKey: 'alert.jobs_dead', params: { count: 1 }, link: '/admin/jobs' });
      await job('dead', { finishedAt: NOW - MIN });
      expect((await dead())?.params).toEqual({ count: 2 });
      await h.db.deleteFrom('jobs').where('status', '=', 'dead').where('finished_at', '>', NOW - 7 * DAY).execute();
      expect(await dead()).toBeUndefined();
    });

    it('disk_low: a disk_low notification within 24 h', async () => {
      const reader = grantsOf(['system.diagnostics.read']);
      const low = async () => alertOf(await summary({ grants: reader }), 'disk_low');
      await diskLow(NOW - 25 * HOUR);
      await diskLow(NOW - HOUR, 'notification.backup_skipped.title');
      expect(await low()).toBeUndefined();
      await diskLow(NOW - 23 * HOUR);
      expect(await low()).toEqual({ kind: 'disk_low', severity: 'warning', messageKey: 'alert.disk_low', link: '/admin/diagnostics' });
    });

    it('ops_attention: while the op needs attention, for the holders of its kind’s permission', async () => {
      const creator = grantsOf(['system.backup.create']);
      const restorer = grantsOf(['system.backup.restore']);
      const ops = async (grants: Grants) => alertOf(await summary({ grants }), 'ops_attention');
      expect(await ops(creator)).toBeUndefined();
      op = { ...attention('backup'), state: 'exporting', needsAttention: false };
      expect(await ops(creator)).toBeUndefined();
      op = attention('backup');
      expect(await ops(creator)).toEqual({ kind: 'ops_attention', severity: 'error', messageKey: 'alert.ops_attention', link: '/admin/_update' });
      expect(await ops(restorer)).toBeUndefined();
      op = attention('restore');
      expect(await ops(restorer)).toBeDefined();
      expect(await ops(creator)).toBeUndefined();
      op = attention('migrate');
      expect(await ops(grantsOf(['system.config.manage']))).toBeDefined();
      // An unreadable op.json under a manual flag (no kind): any op permission.
      op = attention(null);
      for (const p of ['system.update.run', 'system.backup.restore', 'system.backup.create', 'system.config.manage'] as const) {
        expect(await ops(grantsOf([p])), p).toBeDefined();
      }
      expect(await ops(grantsOf(['system.backup.read', 'system.jobs.manage']))).toBeUndefined();
      op = null;
      expect(await ops(SUPER)).toBeUndefined();
    });

    it('ip_trust: while system.ip_trust is not ok, with the hops the browser test suggested', async () => {
      const reader = grantsOf(['system.diagnostics.read']);
      const trust = async () => alertOf(await summary({ grants: reader }), 'ip_trust');
      expect(await trust()).toBeUndefined();
      await set({ 'system.ip_trust': 'collapsed' });
      expect(await trust()).toEqual({ kind: 'ip_trust', severity: 'warning', messageKey: 'alert.ip_trust', link: '/admin/diagnostics' });
      await set({
        'system.ip_trust': 'spoofable',
        'system.probe': {
          at: NOW,
          polling: true,
          sse: true,
          methods: { put: true, patch: true, delete: true },
          chunkBytes: null,
          xff: { spoofable: true, suggestedHops: 0 },
        },
      });
      expect((await trust())?.params).toEqual({ suggestedHops: 0 });
      await set({ 'system.ip_trust': 'ok' });
      expect(await trust()).toBeUndefined();
    });

    it('audit_broken: while the last chain verification failed', async () => {
      const reader = grantsOf(['system.audit.read']);
      const broken = async () => alertOf(await summary({ grants: reader }), 'audit_broken');
      expect(await broken()).toBeUndefined();
      await set({ 'audit.verified': { at: NOW - HOUR, ok: false, head: 10, headHash: 'b'.repeat(64), brokenAt: 4 } });
      expect(await broken()).toEqual({ kind: 'audit_broken', severity: 'error', messageKey: 'alert.audit_broken', link: '/admin/audit' });
      await set({ 'audit.verified': { at: NOW, ok: true, head: 12, headHash: 'c'.repeat(64), brokenAt: null } });
      expect(await broken()).toBeUndefined();
    });
  });

  // ---- 1d Task 29 (preflight S13): the edition and update sections, the alert kinds of 1d -------------------------
  describe('1d Task 29: the edition, the update card and the alerts of 1d', () => {
    const reader = (p: Permission): Grants => grantsOf([p]);

    it('after an update check: version.update.available 0.2.0-test, when it was checked, entitled, one click; null without system.update.read', async () => {
      const feed: VerifiedFeed = {
        channel: 'stable',
        seq: 1,
        issuedAt: NOW - MIN,
        expiresAt: NOW + 7 * DAY,
        entries: [entryOf('0.2.0-test')],
        keyset: [],
        revokedKids: [],
        trusted: [],
        timestampKid: 'dev-ts-1',
      };
      await runUpdateCheck(h, { source: { fetchFeed: async () => feed }, appVersion: '0.1.0', dataDir }, { now: () => NOW, log: silent });
      const r = await summary({ grants: reader('system.update.read') });
      expect(r.version.update).toEqual({
        available: { version: '0.2.0-test', releasedAt: '2026-10-20', notesUrl: 'https://updates.example.test/notes/0.2.0-test', steppingStone: false },
        checkedAt: NOW,
        entitled: true, // the community edition covers every release
        oneClick: true,
        pinned: null,
      });
      // Review C07 (§9.6): once the feed that offered it has expired, nothing is offered from it.
      expect((await summary({ grants: reader('system.update.read'), now: NOW + 7 * DAY })).version.update?.available).toMatchObject({ version: '0.2.0-test' });
      expect((await summary({ grants: reader('system.update.read'), now: NOW + 7 * DAY + 1 })).version.update?.available).toBeNull();
      // The seam: an edition that does not cover a release dated 2026-10-20 makes the card say so.
      check = coveringUntil('2026-10-19');
      expect((await summary({ grants: reader('system.update.read') })).version.update?.entitled).toBe(false);
      check = coveringUntil('2026-10-20');
      expect((await summary({ grants: reader('system.update.read') })).version.update?.entitled).toBe(true);
      check = coveringUntil('2026-10-19');
      // Image mode (§9.8): no one-click update.
      expect((await summary({ grants: reader('system.update.read'), env: { ALTIS_RELEASE_SOURCE: 'image' } })).version.update?.oneClick).toBe(false);
      // The running release is that version already: nothing to install.
      expect((await summary({ grants: reader('system.update.read'), version: '0.2.0-test' })).version.update?.available).toBeNull();
      // Another channel's entry is not offered, nor is the stable check said to be beta's (1d review L14: no "checked,
      // nothing newer" for a channel nobody checked).
      // With no release to install there is nothing to cover: entitled, whatever the edition.
      await set({ 'update.channel': 'beta' });
      expect((await summary({ grants: reader('system.update.read') })).version.update).toMatchObject({ available: null, checkedAt: null, entitled: true });
      // Without system.update.read: no update card.
      expect((await summary({ grants: reader('system.jobs.read') })).version.update).toBeNull();
    });

    it('the edition: the community edition for every caller, from one check per dashboard; another edition passes through as plain data', async () => {
      for (const grants of [NOBODY, reader('system.backup.read'), SUPER]) {
        editionReads = 0;
        expect((await summary({ grants })).edition).toEqual(COMMUNITY_VIEW);
        expect(editionReads).toBe(1);
      }
      check = coveringUntil('2026-10-19');
      const r = await summary({ grants: NOBODY });
      expect(r.edition).toEqual({ edition: 'fake', status: 'limited' });
      expect(Object.keys(r.edition).sort()).toEqual(['edition', 'status']);
    });

    it('the community edition raises no licence alert, even over the licence rows a commercial database left behind (ruling R11)', async () => {
      await everyCause();
      // A stale row of a commercial edition: an unknown key is never read.
      await h.db
        .insertInto('settings')
        .values({
          key: 'license.clock_rollback',
          value: JSON.stringify({ detectedAt: NOW - DAY, active: true, elapsedMs: 31 * DAY, lastObservedAt: NOW - MIN }),
          scope: 'instance',
          updated_at: NOW,
          updated_by: null,
        })
        .execute();
      const r = await summary(causes());
      expect(r.edition).toEqual(COMMUNITY_VIEW);
      expect(kinds(r).filter((kind) => /licen|rollback|read_only|grace/.test(kind))).toEqual([]);
      expect(ALERT_KINDS.filter((kind) => /licen|rollback|read_only|grace/.test(kind))).toEqual([]);
      for (const link of Object.values(ALERT_LINK)) expect(link).not.toMatch(/license/);
    });

    it('keyset_full: while system.keyset_full is set, for system.diagnostics.read only', async () => {
      const full = async (grants: Grants) => alertOf(await summary({ grants }), 'keyset_full');
      expect(await full(reader('system.diagnostics.read'))).toBeUndefined();
      await set({ 'system.keyset_full': { at: NOW, refused: 1 } });
      expect(await full(reader('system.diagnostics.read'))).toEqual({
        kind: 'keyset_full',
        severity: 'warning',
        messageKey: 'alert.keyset_full',
        link: '/admin/diagnostics',
      });
      expect(await full(reader('system.update.read'))).toBeUndefined();
      await set({ 'system.keyset_full': null });
      expect(await full(SUPER)).toBeUndefined();
    });

    it('update_blocked: while update.bundled_blocked names a release newer than the running one, for system.update.read only', async () => {
      const blocked = async (o: Partial<DashboardOptions> = {}) => alertOf(await summary({ grants: reader('system.update.read'), ...o }), 'update_blocked');
      expect(await blocked()).toBeUndefined();
      await set({ 'update.bundled_blocked': { version: '0.2.0', at: NOW, failures: ['min_node'] } });
      expect(await blocked()).toEqual({ kind: 'update_blocked', severity: 'warning', messageKey: 'alert.update_blocked', link: '/admin/updates' });
      expect(alertOf(await summary({ grants: reader('system.diagnostics.read') }), 'update_blocked')).toBeUndefined();
      // Installed meanwhile (by the feed, say): the record is stale and says nothing any more.
      expect(await blocked({ version: '0.2.0' })).toBeUndefined();
      expect(await blocked({ version: '0.3.0' })).toBeUndefined();
    });

    it('bundled_ignored: a newer bundled release not installed because it is pinned or failed before (info), for system.update.read only', async () => {
      const ignored = async (o: Partial<DashboardOptions> = {}) =>
        alertOf(await summary({ grants: reader('system.update.read'), appJsVersion: '0.2.0', ...o }), 'bundled_ignored');
      await fsp.mkdir(path.join(appRoot, 'bundled-release', '0.2.0'), { recursive: true });
      await writeCurrent({ active: { version: '0.1.0', source: 'data' } });
      // Offered (begun at boot as an update): nothing to say.
      expect(await ignored()).toBeUndefined();
      await writeCurrent({ active: { version: '0.1.0', source: 'data' }, pinned: '0.2.0' });
      expect(await ignored()).toEqual({ kind: 'bundled_ignored', severity: 'info', messageKey: 'alert.bundled_ignored', link: '/admin/updates' });
      expect(alertOf(await summary({ grants: reader('system.backup.read'), appJsVersion: '0.2.0' }), 'bundled_ignored')).toBeUndefined();
      // An older bundled release (the original zip after a feed update) is the normal state: no alert, Diagnostik shows it.
      await writeCurrent({ active: { version: '0.3.0', source: 'data' } });
      expect(await ignored()).toBeUndefined();
      // A failed update of it (releases_log, D1d-24).
      await writeCurrent({ active: { version: '0.1.0', source: 'data' } });
      await h.db
        .insertInto('releases_log')
        .values({
          id: newId(NOW - HOUR),
          version: '0.2.0',
          action: 'update',
          from_version: '0.1.0',
          status: 'rolled_back',
          started_at: NOW - HOUR,
          finished_at: NOW - 30 * MIN,
          backup_id: null,
          detail: null,
        })
        .execute();
      expect(await ignored()).toBeDefined();
      expect(await ignored({ appRoot: undefined })).toBeUndefined();
    });

    it('schema_hold: a schemaHold update (source self) that runs or failed within the hour (error), for system.update.read only', async () => {
      const hold = async (grants: Grants = reader('system.update.read')) => alertOf(await summary({ grants }), 'schema_hold');
      expect(await hold()).toBeUndefined();
      await updateOpFile('migrating', 'self');
      expect(await hold()).toEqual({ kind: 'schema_hold', severity: 'error', messageKey: 'alert.schema_hold', link: '/admin/updates' });
      expect(await hold(reader('system.backup.create'))).toBeUndefined();
      await updateOpFile('restore_failed', 'self');
      expect(await hold()).toBeDefined();
      // Done, an update of another source, an op that ended more than an hour ago: no alert.
      await updateOpFile('done', 'self');
      expect(await hold()).toBeUndefined();
      await updateOpFile('migrating', 'feed');
      expect(await hold()).toBeUndefined();
      await updateOpFile('restore_failed', 'self', { finishedAt: NOW - 2 * HOUR });
      expect(await hold()).toBeUndefined();
      // An op.json nobody can read says nothing of a schemaHold (ops_attention covers it).
      await fsp.writeFile(path.join(dataDir, 'ops', 'op.json'), 'bukan json');
      expect(await hold(SUPER)).toBeUndefined();
    });
  });
});
