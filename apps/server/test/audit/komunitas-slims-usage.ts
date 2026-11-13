import { newId } from '@altis/shared';
import { expect } from 'vitest';
import { slimsFixtureBytes } from '../../../../packages/core/test/support/slims-fixture/index.js';
import type { AreaAuditScript, AuditScriptContext } from './catalog.js';

// The audit script of the SLiMS usage import. A super admin, through the API as the Penggunaan Bulanan wizard does,
// uploads the synthetic SLiMS dump with its usage rows (context `accreditation.slims_dump`) and starts an import from a
// period (`accreditation.slims_usage.start`, after a re-authentication); the job runs through the runtime's drive path
// with the real readers, writes the usage rows and ends the run with `accreditation.slims_usage.finish` by the system
// actor.

const PERIOD = { startsOn: '2025-07-01', endsOn: '2026-06-30' };

/** Drives job `jobId` until it stops continuing. */
async function drive(s: AuditScriptContext, jobId: string): Promise<void> {
  for (let slices = 0; slices < 500; slices += 1) {
    const r = await s.jobs.drive(jobId, { budgetMs: 20_000 });
    if (r === null || r.outcome !== 'continued') return;
  }
  throw new Error(`usage import job ${jobId} did not end within 500 slices`);
}

/** A period of the accreditation workspace, written straight into its table. */
async function seedPeriod(s: AuditScriptContext): Promise<string> {
  const id = newId(s.clock.now);
  await s.db.db
    .insertInto('accred_periods')
    .values({
      id,
      branch_id: null,
      name: 'Periode impor penggunaan',
      kind: 'school_year',
      starts_on: PERIOD.startsOn,
      ends_on: PERIOD.endsOn,
      instrument_id: 'test-sch',
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      profile: '{}',
      students: null,
      teachers: null,
      edu_staff: null,
      classes: null,
      population_served: null,
      teachers_using: null,
      user_pcs: null,
      staff_pcs: null,
      ict_devices: null,
      scanners: null,
      floor_m2: null,
      bandwidth_mbps: null,
      hours_per_week: null,
      services: null,
      external_website_url: null,
      created_at: s.clock.now,
      updated_at: s.clock.now,
      created_by: null,
      updated_by: null,
      archived_at: null,
    })
    .execute();
  return id;
}

export const AUDIT: AreaAuditScript = {
  actions: ['accreditation.slims_usage.start', 'accreditation.slims_usage.finish'],
  run: async (s) => {
    const fixture = slimsFixtureBytes(undefined, { usage: { period: PERIOD } });
    const periodId = await seedPeriod(s);
    // The start needs a re-authentication within 5 minutes; an earlier script may have moved the clock on.
    const reauth = await s.admin.send('post', '/api/v1/auth/reauth', { password: s.admin.password });
    expect(reauth.status, reauth.text).toBeLessThan(300);
    const dump = await s.admin.upload('accreditation.slims_dump', fixture.dump, 'slims-backup.sql');
    expect('uploadId' in dump).toBe(true);

    const start = await s.admin.send('post', `/api/v1/accreditation/periods/${periodId}/slims-usage`, {
      source: { kind: 'dump', uploadId: (dump as { uploadId: string }).uploadId },
      memberTypeGroups: { '1': 'student', '2': 'teacher' },
      unknownMemberGroup: 'student',
    });
    expect(start.status, start.text).toBe(201);
    const { runId, jobId } = start.json as { runId: string; jobId: string };
    await drive(s, jobId);

    const run = await s.db.db.selectFrom('catalog_runs').select(['status', 'summary']).where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run.status, run.summary).toBe('succeeded');
    const rows = await s.db.db.selectFrom('usage_stats').select('metric').where('source', '=', 'slims').where('run_id', '=', runId).execute();
    expect(rows.length).toBeGreaterThan(0);

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'actor_type', 'actor_id', 'meta'])
      .where('action', 'in', ['accreditation.slims_usage.start', 'accreditation.slims_usage.finish'])
      .where('entity_id', '=', runId)
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => ({ action: e.action, actor: e.actor_type, actorId: e.actor_id, meta: JSON.parse(e.meta ?? 'null') as unknown }))).toEqual([
      { action: 'accreditation.slims_usage.start', actor: 'staff', actorId: s.admin.userId, meta: { sourceKind: 'dump', cutoverOn: null } },
      {
        action: 'accreditation.slims_usage.finish',
        actor: 'system',
        actorId: null,
        meta: { status: 'succeeded', months: fixture.hooks.usage!.months.length, rows: rows.length },
      },
    ]);
  },
};
