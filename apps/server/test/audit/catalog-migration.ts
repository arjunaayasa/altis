import { __setSlimsSourceFactory, __setSlimsStages, readSettings } from '@altis/core';
import { newId } from '@altis/shared';
import type { MigrationSummary } from '@altis/shared/api/catalog/migration';
import { expect } from 'vitest';
import { slimsFixtureBytes } from '../../../../packages/core/test/support/slims-fixture/index.js';
import type { AreaAuditScript, AuditScriptContext } from './catalog.js';

// The A10 audit script of the catalog area `migration` (Phase 2 plan, Task 2 scaffold; filled by Task 23, the SLiMS
// migration framework; B1 rerun by Task 39 on the real sources and stages). A super admin, through the API as the
// Migrasi SLiMS wizard does:
//
// 1. uploads the synthetic SLiMS fixture (Task 10: the mysqldump-style dump and the files zip) through the upload
//    contexts `slims.dump` and `slims.files`;
// 2. starts a dry run of it (`catalog.migration.start`); the job runs through the runtime's drive path with the real
//    dump source and the real stages of Tasks 37 and 38 (no factory seam), and its report stage appends
//    `catalog.migration.finish` (system actor). The dry run reconciles, reads every biblio row of the fixture and
//    writes no catalog row;
// 3. starts the real run adopting the dry run's work (`fromRunId`, S3; `allowNonEmpty` with the library's name typed
//    out, since the earlier scripts left records), which appends a second start and finish and migrates the fixture's
//    records.

const API = '/api/v1/catalog/migrations/slims';

/** Drives job `jobId` until it stops continuing. */
async function drive(s: AuditScriptContext, jobId: string): Promise<void> {
  for (let slices = 0; slices < 200; slices += 1) {
    const r = await s.jobs.drive(jobId, { budgetMs: 20_000 });
    if (r === null || r.outcome !== 'continued') return;
  }
  throw new Error(`migration job ${jobId} did not end within 200 slices`);
}

/** The run's status, report file and summary. */
async function runOf(s: AuditScriptContext, runId: string): Promise<{ status: string; reportFileId: string | null; summary: MigrationSummary }> {
  const row = await s.db.db.selectFrom('catalog_runs').select(['status', 'report_file_id', 'summary']).where('id', '=', runId).executeTakeFirstOrThrow();
  return { status: row.status, reportFileId: row.report_file_id, summary: JSON.parse(row.summary) as MigrationSummary };
}

const count = async (s: AuditScriptContext, table: 'records' | 'items' | 'migration_map'): Promise<number> =>
  Number((await s.db.db.selectFrom(table).select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);

export const AUDIT: AreaAuditScript = {
  actions: ['catalog.migration.start', 'catalog.migration.finish', 'catalog.migration.cutover'],
  run: async (s) => {
    // B1: the real sources and stages. An earlier test of this process may have left the seams set; clear them.
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
    const fixture = slimsFixtureBytes();
    // The route needs a re-authentication within 5 minutes; an earlier script may have moved the clock on.
    const reauth = await s.admin.send('post', '/api/v1/auth/reauth', { password: s.admin.password });
    expect(reauth.status, reauth.text).toBeLessThan(300);
    let branchId = (await s.db.db.selectFrom('branches').select('id').where('archived_at', 'is', null).orderBy('id').executeTakeFirst())?.id;
    if (branchId === undefined) {
      branchId = newId(s.clock.now);
      await s.db.db
        .insertInto('branches')
        .values({ id: branchId, code_key: 'MIGRASI', code_display: 'MIGRASI', name: 'Cabang Migrasi', timezone: 'Asia/Jakarta', created_at: s.clock.now, updated_at: s.clock.now })
        .execute();
    }
    const dump = await s.admin.upload('slims.dump', fixture.dump, 'slims-backup.sql');
    const files = await s.admin.upload('slims.files', fixture.filesZip, 'slims-files.zip');
    expect('uploadId' in dump && 'uploadId' in files).toBe(true);
    const before = { records: await count(s, 'records'), items: await count(s, 'items'), map: await count(s, 'migration_map') };

    // 2. The dry run.
    const dry = await s.admin.send('post', API, {
      source: { kind: 'dump', uploadId: (dump as { uploadId: string }).uploadId },
      filesUploadId: (files as { uploadId: string }).uploadId,
      branchId,
      allowNonEmpty: false,
      dryRun: true,
    });
    expect(dry.status, dry.text).toBe(201);
    const dryRun = dry.json as { runId: string; jobId: string };
    await drive(s, dryRun.jobId);
    const dryEnd = await runOf(s, dryRun.runId);
    expect(dryEnd.status, JSON.stringify(dryEnd.summary.warnings)).toBe('succeeded');
    expect(dryEnd.reportFileId).not.toBeNull();
    expect(dryEnd.summary.version).toBe('9');
    expect(dryEnd.summary.tables['biblio']?.source).toBe(fixture.expected.tables['biblio']?.source);
    expect(dryEnd.summary.tables['item']?.source).toBe(fixture.expected.tables['item']?.source);
    expect(dryEnd.summary.reconciliation?.ok, JSON.stringify(dryEnd.summary.reconciliation?.tables.filter((t) => t.diff !== 0))).toBe(true);
    expect({ records: await count(s, 'records'), items: await count(s, 'items'), map: await count(s, 'migration_map') }).toEqual(before);

    // 3. The real run, adopting the dry run's staging and files zip (no new upload, no split).
    const reauthAgain = await s.admin.send('post', '/api/v1/auth/reauth', { password: s.admin.password });
    expect(reauthAgain.status, reauthAgain.text).toBeLessThan(300);
    const libraryName = String((await readSettings(s.db.db, ['library.name'], s.config.keyring))['library.name']);
    const real = await s.admin.send('post', API, {
      fromRunId: dryRun.runId,
      branchId,
      allowNonEmpty: true,
      confirmLibraryName: libraryName,
      dryRun: false,
    });
    expect(real.status, real.text).toBe(201);
    const realRun = real.json as { runId: string; jobId: string };
    await drive(s, realRun.jobId);
    const realEnd = await runOf(s, realRun.runId);
    expect(realEnd.status, JSON.stringify(realEnd.summary.warnings)).toBe('succeeded');
    expect(realEnd.summary.reconciliation?.ok, JSON.stringify(realEnd.summary.reconciliation?.tables.filter((t) => t.diff !== 0))).toBe(true);
    const migrated = realEnd.summary.tables['biblio']?.migrated ?? 0;
    expect(migrated).toBeGreaterThan(0);
    const mapped = await s.db.db
      .selectFrom('migration_map')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('source', '=', 'slims')
      .where('entity', '=', 'biblio')
      .where('run_id', '=', realRun.runId)
      .executeTakeFirstOrThrow();
    expect(Number(mapped.n)).toBe(migrated);
    // Each migrated biblio row is a record; an orphan item adds a hidden placeholder record besides (§11.4).
    expect(await count(s, 'records')).toBeGreaterThanOrEqual(before.records + migrated);
    expect(await count(s, 'items')).toBeGreaterThan(before.items);

    // Each run: one start by the admin, one finish by the system actor.
    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'actor_type', 'entity_id'])
      .where('action', 'in', ['catalog.migration.start', 'catalog.migration.finish'])
      .where('entity_id', 'in', [dryRun.runId, realRun.runId])
      .orderBy('seq')
      .execute();
    expect(entries).toEqual([
      { action: 'catalog.migration.start', actor_type: 'staff', entity_id: dryRun.runId },
      { action: 'catalog.migration.finish', actor_type: 'system', entity_id: dryRun.runId },
      { action: 'catalog.migration.start', actor_type: 'staff', entity_id: realRun.runId },
      { action: 'catalog.migration.finish', actor_type: 'system', entity_id: realRun.runId },
    ]);

    // 4. The cut-over checklist (Komunitas, SLiMS members and circulation): the reprint list marked opened; serving
    // is held back (no desk staff, no guestbook station yet), 422 without an entry.
    const view = await s.admin.send('get', `${API}/cutover`);
    expect(view.status, view.text).toBe(200);
    expect(view.json).toMatchObject({ runId: realRun.runId, ready: false, reprintOpenedAt: null });
    const reauthCutover = await s.admin.send('post', '/api/v1/auth/reauth', { password: s.admin.password });
    expect(reauthCutover.status, reauthCutover.text).toBeLessThan(300);
    const reprint = await s.admin.send('post', `${API}/cutover/steps`, { step: 'reprint_opened' });
    expect(reprint.status, reprint.text).toBe(200);
    expect((reprint.json as { reprintOpenedAt: number | null }).reprintOpenedAt).not.toBeNull();
    const serve = await s.admin.send('post', `${API}/cutover/steps`, { step: 'serve' });
    expect(serve.status, serve.text).toBe(422);
    const cutover = await s.db.db.selectFrom('audit_log').select(['entity_id', 'actor_type']).where('action', '=', 'catalog.migration.cutover').execute();
    expect(cutover).toEqual([{ entity_id: 'reprint_opened', actor_type: 'staff' }]);
  },
};
