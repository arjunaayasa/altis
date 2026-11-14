import { newId } from '@altis/shared';
import { expect } from 'vitest';
import type { AreaAuditScript } from './catalog.js';

// The audit script of the monthly usage table and the member-type mapping: a super admin writes two manual cells of a
// statistics period seeded straight into the table and removes one of them, as the workspace grid does, and changes
// the group of the members the source system no longer has. Each route call writes exactly one entry, whose `meta`
// holds counts only (never a value).

const PERIODS = '/api/v1/accreditation/periods';

export const AUDIT: AreaAuditScript = {
  actions: ['accreditation.usage.update', 'accreditation.usage_groups.update'],
  run: async (s) => {
    const id = newId(s.clock.now);
    await s.db.db
      .insertInto('accred_periods')
      .values({
        id,
        branch_id: null,
        name: 'Statistik penggunaan 2025',
        kind: 'calendar_year',
        starts_on: '2025-01-01',
        ends_on: '2025-12-31',
        instrument_id: 'general-stats',
        status: 'open',
        frozen_at: null,
        frozen_by: null,
        profile: '{}',
        all_registered_confirmed: 0,
        archived_at: null,
        version: 0,
        created_at: s.clock.now,
        created_by: null,
        updated_at: s.clock.now,
        updated_by: null,
      })
      .execute();

    const written = await s.admin.send('put', `${PERIODS}/${id}/usage`, {
      cells: [
        { metric: 'visits', month: '2025-02', groupKey: 'guest', value: 14 },
        { metric: 'loans', month: '2025-02', groupKey: '', value: 31 },
      ],
    });
    expect([written.status, written.json]).toEqual([200, { id, version: 0 }]);
    const removed = await s.admin.send('put', `${PERIODS}/${id}/usage`, { cells: [{ metric: 'loans', month: '2025-02', groupKey: '', value: null }] });
    expect([removed.status, removed.json]).toEqual([200, { id, version: 0 }]);

    const mapped = await s.admin.send('put', '/api/v1/accreditation/usage-groups', { groups: [{ groupKey: 'member_unknown', accredGroup: 'student' }] });
    expect([mapped.status, mapped.json]).toEqual([200, { count: 1 }]);

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'entity', 'entity_id', 'meta'])
      .where('action', 'in', ['accreditation.usage.update', 'accreditation.usage_groups.update'])
      .where('actor_id', '=', s.admin.userId)
      .orderBy('seq')
      .execute();
    expect(entries.map((e) => ({ action: e.action, entity: e.entity, entityId: e.entity_id, meta: JSON.parse(e.meta) as unknown })).slice(-3)).toEqual([
      { action: 'accreditation.usage.update', entity: 'accred_periods', entityId: id, meta: { cells: 2 } },
      { action: 'accreditation.usage.update', entity: 'accred_periods', entityId: id, meta: { cells: 1 } },
      { action: 'accreditation.usage_groups.update', entity: 'usage_group_map', entityId: null, meta: { count: 1 } },
    ]);
  },
};
