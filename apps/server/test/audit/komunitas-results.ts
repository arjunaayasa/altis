import { lastChangeOf } from '@altis/core';
import { newId } from '@altis/shared';
import { expect } from 'vitest';
import type { AreaAuditScript } from './catalog.js';

// The audit script of the freeze of a period and its reopening. A super admin freezes, through the API as the
// workspace's history tab does, a period of the test profile's school instrument whose results were computed after its
// last change (both seeded straight into the tables), then reopens it after a re-authentication. Each call writes
// exactly one entry; the freeze's `meta` names the snapshot and whether a note was given, never the note.

const PERIODS = '/api/v1/accreditation/periods';

export const AUDIT: AreaAuditScript = {
  actions: ['accreditation.period.freeze', 'accreditation.period.unfreeze'],
  run: async (s) => {
    const periodId = newId(s.clock.now);
    await s.db.db
      .insertInto('accred_periods')
      .values({
        id: periodId,
        branch_id: null,
        name: 'Tahun pelajaran 2025/2026',
        kind: 'school_year',
        starts_on: '2025-07-01',
        ends_on: '2026-06-30',
        instrument_id: 'test-sch',
        status: 'open',
        frozen_at: null,
        frozen_by: null,
        profile: '{"schoolLevel":"sma_smk_ma"}',
        all_registered_confirmed: 0,
        archived_at: null,
        version: 0,
        created_at: s.clock.now,
        created_by: null,
        updated_at: s.clock.now,
        updated_by: null,
      })
      .execute();
    // Results computed after everything the period depends on (an earlier script may have changed a register).
    const computedAt = ((await lastChangeOf(s.db.db, periodId)) ?? s.clock.now) + 1;
    const prerequisites = { titles: { pass: false, count: 0, asOf: '2026-06-30' }, npp: { pass: false }, foundingDecree: { pass: false }, met: false };
    await s.db.db
      .insertInto('accred_results')
      .values({
        period_id: periodId,
        indicator_code: '_meta',
        payload: JSON.stringify({ status: 'ready', startedAt: computedAt, jobId: newId(computedAt), computedAt, durationMs: 1, prerequisites }),
        computed_at: computedAt,
      })
      .execute();

    const frozen = await s.admin.send('post', `${PERIODS}/${periodId}/freeze`, { note: 'Diserahkan ke asesor' });
    expect(frozen.status, frozen.text).toBe(201);
    const snapshotId = (frozen.json as { id: string }).id;
    expect(frozen.json).toEqual({ id: snapshotId, version: 1 });

    // Reopening needs a re-authentication within 5 minutes; an earlier script may have moved the clock on.
    const reauth = await s.admin.send('post', '/api/v1/auth/reauth', { password: s.admin.password });
    expect(reauth.status, reauth.text).toBeLessThan(300);
    const opened = await s.admin.send('post', `${PERIODS}/${periodId}/unfreeze`);
    expect([opened.status, opened.json]).toEqual([200, { id: periodId, version: 2 }]);

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'actor_id', 'entity', 'entity_id', 'meta'])
      .where('action', 'in', ['accreditation.period.freeze', 'accreditation.period.unfreeze'])
      .where('entity_id', '=', periodId)
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => ({ action: e.action, actor: e.actor_id, entity: e.entity, meta: JSON.parse(e.meta) as unknown }))).toEqual([
      { action: 'accreditation.period.freeze', actor: s.admin.userId, entity: 'accred_periods', meta: { snapshotId, hasNote: true } },
      { action: 'accreditation.period.unfreeze', actor: s.admin.userId, entity: 'accred_periods', meta: {} },
    ]);
  },
};
