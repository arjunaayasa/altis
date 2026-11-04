import type { DB } from '@altis/db';
import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { RecordCreateBody } from '@altis/shared/api/catalog/records';
import type { Kysely, Transaction } from 'kysely';
import { codeKey } from '../data/keys.js';
import { parseTemplate } from './template.js';

// From a draft to a create body (Phase 2 plan Task 16): what an importer reads (MARC, MARCXML, CSV, an SRU or ISBN
// copy, the SLiMS migration; `RecordDraft`, masters by code and authorities by name) becomes the body createRecord
// (or updateRecord) takes, so that every path saves through the same checks.
//
// - The material type's code → its id; none → `o.defaultMaterialTypeId`; an unknown or archived one → the default
//   and the warning `material_type_unknown`.
// - The language code → its id; an unknown or archived one → the material type's default language (its template's
//   `defaults.languageId`) when it has one, else none, and the warning `language_unknown`.
// - Agents, subjects and the publisher become text refs (createRecord finds or creates them by key).
// - `draft.links` → `body.links` (S4): createRecord stores the http(s) ones as public URL attachments.
// - `items` stay with the caller (Task 17 creates them); `custom` passes as it is (a CSV caller coerces it first, S19).
// - The warnings are codes, never values (they go into run reports as they are).

type Db = Kysely<DB> | Transaction<DB>;

/** A live row of `table` with the code `code`, or undefined. */
async function liveIdByCode(db: Db, table: 'material_types' | 'languages', code: string): Promise<string | undefined> {
  const row = await db
    .selectFrom(table as 'material_types')
    .select('id')
    .where('code_key', '=', codeKey(code))
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  return row?.id;
}

/** The default language of the material type `id`'s template, when it is live. */
async function templateLanguage(db: Db, materialTypeId: string): Promise<string | undefined> {
  const type = await db.selectFrom('material_types').select('template').where('id', '=', materialTypeId).executeTakeFirst();
  const languageId = type === undefined ? undefined : parseTemplate(type.template).defaults.languageId;
  if (languageId === undefined) return undefined;
  const row = await db.selectFrom('languages').select('id').where('id', '=', languageId).where('archived_at', 'is', null).executeTakeFirst();
  return row?.id;
}

/** `v` when it is a non-blank text, else undefined (a draft's optional fields). */
const text = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v);

/**
 * The create body of `draft` and the warnings of what was replaced by a default (`material_type_unknown`,
 * `language_unknown`), see the top of this file.
 */
export async function recordBodyFromDraft(
  db: Db,
  draft: RecordDraft,
  o: { defaultMaterialTypeId: string },
): Promise<{ body: RecordCreateBody; warnings: string[] }> {
  const warnings: string[] = [];
  let materialTypeId = o.defaultMaterialTypeId;
  if (draft.materialTypeCode !== null && draft.materialTypeCode.trim() !== '') {
    const found = await liveIdByCode(db, 'material_types', draft.materialTypeCode);
    if (found === undefined) warnings.push('material_type_unknown');
    else materialTypeId = found;
  }
  let languageId: string | undefined;
  if (draft.languageCode !== undefined && draft.languageCode.trim() !== '') {
    languageId = await liveIdByCode(db, 'languages', draft.languageCode);
    if (languageId === undefined) {
      warnings.push('language_unknown');
      languageId = await templateLanguage(db, materialTypeId);
    }
  }

  const body: RecordCreateBody = {
    materialTypeId,
    title: draft.title,
    subtitle: text(draft.subtitle),
    responsibility: text(draft.responsibility),
    edition: text(draft.edition),
    materialDetail: text(draft.materialDetail),
    publisher: draft.publisher === null ? undefined : { name: draft.publisher.name, ...(text(draft.publisher.place) === undefined ? {} : { place: draft.publisher.place }) },
    publicationPlace: text(draft.publicationPlace),
    publicationYear: draft.publicationYear,
    publicationDateText: text(draft.publicationDateText),
    physicalDesc: text(draft.physicalDesc),
    series: text(draft.series),
    classification: text(draft.classification),
    callNumber: text(draft.callNumber),
    languageId,
    contentType: draft.contentType,
    mediaType: draft.mediaType,
    carrierType: draft.carrierType,
    summary: text(draft.summary),
    notes: text(draft.notes),
    identifiers: draft.identifiers.map((i) => ({ type: i.type, value: i.value, ...(i.qualifier === undefined || i.qualifier === null ? {} : { qualifier: i.qualifier }) })),
    agents: draft.agents.map((a) => ({
      ref: {
        type: a.type,
        name: a.name,
        ...(a.dates === undefined ? {} : { dates: a.dates }),
        ...(a.authoritySource === undefined ? {} : { authoritySource: a.authoritySource }),
      },
      role: a.role,
      isMain: a.isMain,
    })),
    subjects: draft.subjects.map((s) => ({
      ref: {
        type: s.type,
        term: s.term,
        ...(s.classification === undefined ? {} : { classification: s.classification }),
        ...(s.authoritySource === undefined ? {} : { authoritySource: s.authoritySource }),
      },
      isPrimary: s.isPrimary,
    })),
    links: draft.links.map((l) => ({ url: l.url, ...(l.title === undefined ? {} : { title: l.title }) })),
    marcExtra: draft.marcExtra.map((f) => ({ tag: f.tag, ind1: f.ind1, ind2: f.ind2, data: f.data })),
    custom: draft.custom,
  };
  // Leave out what the draft does not have, so the body reads as one a client would send.
  for (const key of Object.keys(body) as (keyof RecordCreateBody)[]) if (body[key] === undefined) delete body[key];
  return { body, warnings };
}
