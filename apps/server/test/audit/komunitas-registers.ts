import { newId } from '@altis/shared';
import { expect } from 'vitest';
import type { AreaAuditScript } from './catalog.js';

// The audit script of the registers, the staff trainings and the evidence files, as the admin SPA's Register tab and
// evidence upload drive them: a super admin records an activity, corrects it and archives it, then uploads a
// screenshot of the catalogue as evidence of a period's indicator and removes it again. Each route appends exactly one
// entry of its action, whose `meta` names the row's table, its id and the fields, never a value (titles and captions
// stay out of the log). The period is seeded straight into its table (the periods are another area's).

const API = '/api/v1/accreditation';
/** A tiny PDF: what the upload context's content check accepts. */
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');

const OWNED = ['accreditation.register.create', 'accreditation.register.update', 'accreditation.register.archive', 'accreditation.evidence.create', 'accreditation.evidence.archive'] as const;

export const AUDIT: AreaAuditScript = {
  actions: OWNED,
  run: async (s) => {
    const db = s.db.db;
    const periodId = newId(s.clock.now);
    await db
      .insertInto('accred_periods')
      .values({
        id: periodId,
        name: 'Tahun ajaran 2025/2026',
        instrument_id: 'test-sch',
        kind: 'school_year',
        starts_on: '2025-07-01',
        ends_on: '2026-06-30',
        branch_id: null,
        profile: '{}',
        all_registered_confirmed: 0,
        status: 'open',
        frozen_at: null,
        frozen_by: null,
        archived_at: null,
        version: 0,
        created_at: s.clock.now,
        created_by: null,
        updated_at: s.clock.now,
        updated_by: null,
      })
      .execute();
    const seqOf = async (): Promise<number> => Number((await db.selectFrom('audit_head').select('last_seq').where('id', '=', 1).executeTakeFirstOrThrow()).last_seq);
    const before = await seqOf();

    const created = await s.admin.send('post', `${API}/activities`, {
      kind: 'writing_guidance',
      title: 'Kelas Menulis Cerpen Bersama Penulis Tamu',
      heldOn: '2025-11-08',
      participants: 28,
      usesLibraryFacility: true,
      externalSpeaker: true,
    });
    expect(created.status, created.text).toBe(201);
    const activityId = (created.json as { id: string }).id;
    const patched = await s.admin.send('patch', `${API}/activities/${activityId}`, { version: 0, participants: 31 });
    expect(patched.status, patched.text).toBe(200);
    const archived = await s.admin.send('delete', `${API}/activities/${activityId}`);
    expect(archived.status, archived.text).toBe(200);

    const uploaded = (await s.admin.upload('accreditation.evidence', PDF, 'katalog-daring.pdf')) as { fileId: string };
    const evidence = await s.admin.send('post', `${API}/evidence`, {
      uploadId: uploaded.fileId,
      periodId,
      indicatorCode: 'SCH-K1',
      evidenceCode: 'catalogue_screenshot',
      caption: 'Tangkapan layar katalog daring sekolah',
    });
    expect(evidence.status, evidence.text).toBe(201);
    const evidenceId = (evidence.json as { id: string }).id;
    const removed = await s.admin.send('delete', `${API}/evidence/${evidenceId}`);
    expect(removed.status, removed.text).toBe(200);

    const rows = await db
      .selectFrom('audit_log')
      .select(['action', 'entity', 'entity_id', 'meta'])
      .where('seq', '>', before)
      .where('action', 'in', [...OWNED])
      .orderBy('seq')
      .execute();
    expect(rows.map((r) => [r.action, r.entity, r.entity_id])).toEqual([
      ['accreditation.register.create', 'library_activities', activityId],
      ['accreditation.register.update', 'library_activities', activityId],
      ['accreditation.register.archive', 'library_activities', activityId],
      ['accreditation.evidence.create', 'accred_evidence', evidenceId],
      ['accreditation.evidence.archive', 'accred_evidence', evidenceId],
    ]);
    const metas = rows.map((r) => JSON.parse(r.meta) as Record<string, unknown>);
    expect(metas.slice(0, 3)).toEqual([
      { entity: 'library_activities', id: activityId, fields: ['kind', 'title', 'heldOn', 'participants', 'usesLibraryFacility', 'externalSpeaker'] },
      { entity: 'library_activities', id: activityId, fields: ['participants'] },
      { entity: 'library_activities', id: activityId, fields: [] },
    ]);
    expect(metas[3]).toMatchObject({ entity: 'accred_evidence', id: evidenceId, periodId, indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot' });
    expect(metas[4]).toMatchObject({ entity: 'accred_evidence', id: evidenceId, fields: [], periodId });
    // Names only: no title or caption reaches the audit log.
    const text = rows.map((r) => r.meta).join('\n');
    expect(text).not.toContain('Cerpen');
    expect(text).not.toContain('katalog daring');
  },
};
