import { expect } from 'vitest';
import type { AgentReply } from '../agent.js';
import type { AreaAuditScript } from './catalog.js';

// The A10 audit script of the catalog area `masters` (Phase 2 plan, Task 2 scaffold; filled by Task 12, Masters API).
// The locations of Task 14 write the same actions (entity `locations`), and this script covers the actions for both.
// A super admin, through the API as the admin SPA does: creates a custom field of records and a material type whose
// template shows it, edits the type, creates a language and archives it. Each audited route appends exactly one entry
// of its action; the script also checks that the entries name their table.

const CATALOG = '/api/v1/catalog';

/** The `{id, version}` of a store route's answer, after checking its status. */
function stored(res: AgentReply, status = 200): { id: string; version: number } {
  expect(res.status, res.text).toBe(status);
  return res.json as { id: string; version: number };
}

export const AUDIT: AreaAuditScript = {
  actions: ['catalog.master.create', 'catalog.master.update', 'catalog.master.archive'],
  run: async (s) => {
    const field = stored(
      await s.admin.send('post', `${CATALOG}/custom-fields`, {
        entity: 'records',
        type: 'text',
        code: 'nomor_induk_lama',
        labelId: 'Nomor induk lama',
        labelEn: 'Old accession number',
        required: false,
        sortOrder: 10,
        isPublic: false,
        isSearchable: true,
      }),
      201,
    );
    const type = stored(
      await s.admin.send('post', `${CATALOG}/material-types`, {
        code: 'PARTITUR',
        nameId: 'Partitur',
        nameEn: 'Music score',
        marcType: 'c',
        marcLevel: 'm',
        contentType: 'ntm',
        mediaType: 'n',
        carrierType: 'nc',
        schemaType: 'MusicComposition',
        dcmiType: 'Text',
        template: { fields: { responsibility: 'required' }, defaults: {}, customFields: ['nomor_induk_lama'] },
        sortOrder: 90,
      }),
      201,
    );
    stored(await s.admin.send('patch', `${CATALOG}/material-types/${type.id}`, { version: type.version, nameId: 'Partitur musik' }));
    const language = stored(await s.admin.send('post', `${CATALOG}/languages`, { code: 'bjn', nameId: 'Banjar', nameEn: 'Banjarese' }), 201);
    stored(await s.admin.send('delete', `${CATALOG}/languages/${language.id}`, { version: language.version }));

    const entries = await s.db.db
      .selectFrom('audit_log')
      .select(['action', 'entity', 'entity_id'])
      .where('action', 'in', ['catalog.master.create', 'catalog.master.update', 'catalog.master.archive'])
      .where('entity_id', 'in', [field.id, type.id, language.id])
      .orderBy('seq')
      .execute();
    expect(entries).toEqual([
      { action: 'catalog.master.create', entity: 'custom_field_defs', entity_id: field.id },
      { action: 'catalog.master.create', entity: 'material_types', entity_id: type.id },
      { action: 'catalog.master.update', entity: 'material_types', entity_id: type.id },
      { action: 'catalog.master.create', entity: 'languages', entity_id: language.id },
      { action: 'catalog.master.archive', entity: 'languages', entity_id: language.id },
    ]);
  },
};
