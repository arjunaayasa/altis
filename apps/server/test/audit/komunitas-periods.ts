import { newId } from '@altis/shared';
import { expect } from 'vitest';
import type { AreaAuditScript } from './catalog.js';

// The audit script of the accreditation periods and their answers: a super admin creates a statistics period through the
// API (it fits every library type), changes it and archives it, as the workspace does; and answers an indicator of a
// period of the test profile's school instrument, seeded straight into the table (a school period needs the library
// type `sekolah`, which this shared installation does not set). Each route call writes exactly one entry, whose `meta`
// holds codes and field names only.

const PERIODS = '/api/v1/accreditation/periods';

export const AUDIT: AreaAuditScript = {
  actions: ['accreditation.period.create', 'accreditation.period.update', 'accreditation.period.archive', 'accreditation.answer.update'],
  run: async (s) => {
    const created = await s.admin.send('post', PERIODS, { name: 'Statistik 2025', instrumentId: 'general-stats', kind: 'calendar_year', startYear: 2025 });
    expect(created.status, created.text).toBe(201);
    const id = (created.json as { id: string }).id;

    const updated = await s.admin.send('patch', `${PERIODS}/${id}`, { version: 0, populationServed: 1200, profile: { npp: '3201010D1000004' } });
    expect([updated.status, updated.json]).toEqual([200, { id, version: 1 }]);

    const school = newId(s.clock.now);
    await s.db.db
      .insertInto('accred_periods')
      .values({
        id: school,
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
    const answered = await s.admin.send('put', `${PERIODS}/${school}/answers/SCH-SP1`, { answer: 'b', mode: 'override', note: 'Denah diperbarui' });
    expect([answered.status, answered.json]).toEqual([200, { id: school, version: 0 }]);

    const archived = await s.admin.send('delete', `${PERIODS}/${id}`);
    expect([archived.status, archived.json]).toEqual([200, { id, version: 2 }]);

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'actor_id', 'entity', 'entity_id', 'meta'])
      .where('entity_id', 'in', [id, school])
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => ({ action: e.action, actor: e.actor_id, entity: e.entity, entityId: e.entity_id, meta: JSON.parse(e.meta) as unknown }))).toEqual([
      {
        action: 'accreditation.period.create',
        actor: s.admin.userId,
        entity: 'accred_periods',
        entityId: id,
        // `copiedFrom` names the latest live period another script may have left, or null.
        meta: expect.objectContaining({ instrumentId: 'general-stats', kind: 'calendar_year', startsOn: '2025-01-01', endsOn: '2025-12-31' }),
      },
      { action: 'accreditation.period.update', actor: s.admin.userId, entity: 'accred_periods', entityId: id, meta: { fields: ['profile', 'populationServed'] } },
      {
        action: 'accreditation.answer.update',
        actor: s.admin.userId,
        entity: 'accred_periods',
        entityId: school,
        meta: { code: 'SCH-SP1', mode: 'override', answer: 'b', hasNote: true },
      },
      { action: 'accreditation.period.archive', actor: s.admin.userId, entity: 'accred_periods', entityId: id, meta: {} },
    ]);
  },
};
