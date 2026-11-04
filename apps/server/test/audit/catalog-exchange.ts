import { expect } from 'vitest';
import type { AreaAuditScript } from './catalog.js';

// The A10 audit script of the catalog area `exchange` (Phase 2 plan, Task 2 scaffold; filled by Task 31, Import and
// export jobs): a super admin uploads a small `csv-records` file through the `catalog.import` upload context (its magic
// bytes read as text, Task 2's detection, S1), starts a dry run of it through the API (`catalog.import.start`) and the
// job runs to its end through the runtime's drive path (`catalog.import.finish`, by the system actor); then the admin
// starts an export of the records it can see (`catalog.export.start`).

const CSV = 'title;year;authors\r\nAudit Impor Katalog;2026;Penulis, Audit\r\n';

/** Drives job `jobId` until it stops continuing. */
async function drive(s: Parameters<NonNullable<AreaAuditScript['run']>>[0], jobId: string): Promise<void> {
  for (let slices = 0; slices < 50; slices += 1) {
    const r = await s.jobs.drive(jobId, { budgetMs: 20_000 });
    if (r === null || r.outcome !== 'continued') return;
  }
}

export const AUDIT: AreaAuditScript = {
  actions: ['catalog.import.start', 'catalog.import.finish', 'catalog.export.start'],
  run: async (s) => {
    const staged = await s.admin.upload('catalog.import', Buffer.from(CSV, 'utf8'), 'audit.csv');
    expect('uploadId' in staged).toBe(true);
    const uploadId = (staged as { uploadId: string }).uploadId;
    const started = await s.admin.send('post', '/api/v1/catalog/imports', {
      uploadId,
      matchOn: 'none',
      onMatch: 'skip',
      onDuplicate: 'report',
      createItems: false,
      dryRun: true,
    });
    expect(started.status, started.text).toBe(202);
    const imp = started.json as { runId: string; jobId: string };
    await drive(s, imp.jobId);
    const run = await s.db.db.selectFrom('catalog_runs').select(['status', 'format', 'summary', 'report_file_id']).where('id', '=', imp.runId).executeTakeFirstOrThrow();
    expect([run.status, run.format]).toEqual(['succeeded', 'csv-records']);
    expect(JSON.parse(run.summary)).toMatchObject({ read: 1, created: 1, errors: 0 });
    expect(run.report_file_id).not.toBeNull();
    const finish = await s.db.db.selectFrom('audit_log').select(['actor_type', 'meta']).where('action', '=', 'catalog.import.finish').where('entity_id', '=', imp.runId).execute();
    expect(finish.map((e) => e.actor_type)).toEqual(['system']);

    const exp = await s.admin.send('post', '/api/v1/catalog/exports', { format: 'marcxml', filter: { q: 'audit' } });
    expect(exp.status, exp.text).toBe(202);
    await drive(s, (exp.json as { jobId: string }).jobId);
  },
};
