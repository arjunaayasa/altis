import type { DB } from '@altis/db';
import { isUlid, normalizeKey } from '@altis/shared';
import type { RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { DuplicateCheckBody } from '@altis/shared/api/catalog/records';
import type { Kysely, Transaction } from 'kysely';
import { codeKey } from '../data/keys.js';
import { titleKey } from '../lib/title-key.js';
import { identifierKey } from '../records/identifiers.js';

// Matching an imported record with a stored one, the in-batch duplicate check, and the lookups of masters by code or
// name (Phase 2 spec §5.3; plan Task 31, M7).
//
// - `matchOn` (§5.3): `isbn` (a live record holding one of the draft's ISBN keys in `record_identifiers`), `control`
//   (the `control` identifier `<003>:<001>`), `record_id` (the CSV's `record_id`, or a MARC 001 that is a ULID: what an
//   ALTIS export writes), `none`. Only live records (not archived, not merged) match. Plain reads: a record the batch
//   created in its own transaction is seen on every dialect.
// - In-batch duplicates (M7): InnoDB FULLTEXT does not see the rows its own transaction has not committed, while FTS5
//   and GIN do, so the duplicate check cannot lean on the index for drafts of the same batch. Each draft to be created
//   is first compared with the drafts the batch already accepted, by ISBN key and by `title_key` + year; the scored
//   check then leaves out the records the batch created, so every dialect gives the same answer.
// - MasterLookup reads a master once per code (or name) and keeps it for the slice: a slice is at most 20 s, and a
//   master changed meanwhile is read again by the next slice.

type Db = Kysely<DB> | Transaction<DB>;

/** How an imported record is matched (ImportBody.matchOn). */
export type ImportMatchOn = 'isbn' | 'control' | 'record_id' | 'none';

/** The valid ISBN keys of a draft (13 digits). */
export function draftIsbnKeys(draft: RecordDraft): string[] {
  const keys: string[] = [];
  for (const i of draft.identifiers) {
    if (i.type !== 'isbn') continue;
    const k = identifierKey('isbn', i.value);
    if (k.valid && !keys.includes(k.key)) keys.push(k.key);
  }
  return keys;
}

/** The key of the draft's `control` identifier, or null. */
export function draftControlKey(draft: RecordDraft): string | null {
  const c = draft.identifiers.find((i) => i.type === 'control');
  if (c === undefined) return null;
  const k = identifierKey('control', c.value).key;
  return k === '' ? null : k;
}

/** A MARC record's own id when its 001 is a ULID (`<003>:<001>` or `<001>` in the control identifier), else null. */
export function draftControlRecordId(draft: RecordDraft): string | null {
  const c = draft.identifiers.find((i) => i.type === 'control');
  if (c === undefined) return null;
  const id = c.value.slice(c.value.lastIndexOf(':') + 1).trim().toUpperCase();
  return isUlid(id) ? id : null;
}

/** The ids of the live records holding an identifier of `type` whose key is one of `keys`, in id order. */
async function byIdentifier(db: Db, type: 'isbn' | 'control', keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await db
    .selectFrom('record_identifiers as ri')
    .innerJoin('records as r', 'r.id', 'ri.record_id')
    .select('r.id')
    .where('ri.type', '=', type)
    .where('ri.value_key', 'in', [...keys])
    .where('r.archived_at', 'is', null)
    .where('r.merged_into', 'is', null)
    .orderBy('r.id')
    .execute();
  return [...new Set(rows.map((r) => r.id))];
}

/** The live records holding the ISBN written `isbn` (a CSV item row's parent), in id order. */
export async function recordsByIsbn(db: Db, isbn: string): Promise<string[]> {
  const k = identifierKey('isbn', isbn);
  return k.valid ? byIdentifier(db, 'isbn', [k.key]) : [];
}

/**
 * The live records `draft` matches by `matchOn` (see the top of this file), in id order; `recordId` is the CSV's
 * `record_id` (null for MARC, which uses its 001).
 */
export async function matchRecords(db: Db, matchOn: ImportMatchOn, draft: RecordDraft, recordId: string | null): Promise<string[]> {
  switch (matchOn) {
    case 'none':
      return [];
    case 'isbn':
      return byIdentifier(db, 'isbn', draftIsbnKeys(draft));
    case 'control': {
      const key = draftControlKey(draft);
      return key === null ? [] : byIdentifier(db, 'control', [key]);
    }
    case 'record_id': {
      const id = recordId ?? draftControlRecordId(draft);
      if (id === null) return [];
      const row = await db.selectFrom('records').select('id').where('id', '=', id).where('archived_at', 'is', null).where('merged_into', 'is', null).executeTakeFirst();
      return row === undefined ? [] : [row.id];
    }
  }
}

/** The `title_key` + year key of a draft for the in-batch check, or null without a year or a title key. */
function titleYearKey(draft: RecordDraft): string | null {
  if (draft.publicationYear === undefined) return null;
  const key = titleKey(draft.title, draft.subtitle);
  return key === '' ? null : `${key}\u0000${draft.publicationYear}`;
}

/** The drafts a batch accepted so far (M7), by ISBN key and by title key + year. */
export class BatchDuplicates {
  private readonly isbn = new Map<string, string>();
  private readonly titleYear = new Map<string, string>();
  /** The records this batch created (left out of the scored check). */
  readonly created = new Set<string>();

  /** The record of an accepted draft `draft` duplicates, or null. */
  find(draft: RecordDraft): string | null {
    for (const key of draftIsbnKeys(draft)) {
      const hit = this.isbn.get(key);
      if (hit !== undefined) return hit;
    }
    const ty = titleYearKey(draft);
    return ty === null ? null : (this.titleYear.get(ty) ?? null);
  }

  /** Records `draft`, stored as `recordId` by this batch. */
  accept(draft: RecordDraft, recordId: string): void {
    this.created.add(recordId);
    for (const key of draftIsbnKeys(draft)) if (!this.isbn.has(key)) this.isbn.set(key, recordId);
    const ty = titleYearKey(draft);
    if (ty !== null && !this.titleYear.has(ty)) this.titleYear.set(ty, recordId);
  }
}

/** What the scored duplicate check (checkDuplicates) compares for `draft`. */
export function duplicateProbe(draft: RecordDraft): DuplicateCheckBody {
  const main = draft.agents.find((a) => a.isMain) ?? draft.agents[0];
  const probe: DuplicateCheckBody = { title: draft.title, identifiers: draft.identifiers.filter((i) => i.type === 'isbn' || i.type === 'issn') };
  if (draft.subtitle !== undefined && draft.subtitle.trim() !== '') probe.subtitle = draft.subtitle;
  if (draft.publicationYear !== undefined) probe.year = draft.publicationYear;
  if (main !== undefined) probe.mainAgentName = main.name;
  if (draft.publisher !== null) probe.publisherName = draft.publisher.name;
  return probe;
}

// ---- masters ---------------------------------------------------------------------------------------------------------

type CodeTable = 'material_types' | 'languages' | 'collection_types' | 'suppliers' | 'branches';

/** The lookups of masters, branches and locations by code (or name), cached for one slice. */
export class MasterLookup {
  private readonly cache = new Map<string, Promise<string | null>>();
  private leaderTypes: Promise<{ code: string; type: string; level: string }[]> | null = null;

  constructor(private readonly db: Db) {}

  private once(key: string, load: () => Promise<string | null>): Promise<string | null> {
    let hit = this.cache.get(key);
    if (hit === undefined) {
      hit = load();
      this.cache.set(key, hit);
    }
    return hit;
  }

  /** The live row of `table` with the code `code`, or null. */
  byCode(table: CodeTable, code: string): Promise<string | null> {
    const key = codeKey(code);
    if (key === '') return Promise.resolve(null);
    return this.once(`${table}\u0000code\u0000${key}`, async () => {
      const row = await this.db
        .selectFrom(table as 'material_types')
        .select('id')
        .where('code_key', '=', key)
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      return row?.id ?? null;
    });
  }

  /**
   * The live row of `table` named `name` (its code, or its Indonesian or English name, compared by normalizeKey): what
   * a SLiMS export writes (a GMD, a language, a collection type, a supplier by name). The first by code order.
   */
  byName(table: 'material_types' | 'languages' | 'collection_types' | 'suppliers', name: string): Promise<string | null> {
    const key = normalizeKey(name);
    if (key === '') return Promise.resolve(null);
    return this.once(`${table}\u0000name\u0000${key}`, async () => {
      const byCode = await this.byCode(table, name);
      if (byCode !== null) return byCode;
      if (table === 'suppliers') {
        const rows = await this.db.selectFrom('suppliers').select(['id', 'name']).where('archived_at', 'is', null).orderBy('code_key').execute();
        return rows.find((r) => normalizeKey(r.name) === key)?.id ?? null;
      }
      const rows = await this.db
        .selectFrom(table as 'material_types')
        .select(['id', 'name_id', 'name_en'])
        .where('archived_at', 'is', null)
        .orderBy('code_key')
        .execute();
      return rows.find((r) => normalizeKey(r.name_id) === key || normalizeKey(r.name_en) === key)?.id ?? null;
    });
  }

  /** The live location of `branchId` with the code (or else the name) `codeOrName`, or null. */
  location(branchId: string, codeOrName: string): Promise<string | null> {
    const key = normalizeKey(codeOrName);
    if (key === '') return Promise.resolve(null);
    return this.once(`locations\u0000${branchId}\u0000${key}`, async () => {
      const row = await this.db
        .selectFrom('locations')
        .select('id')
        .where('branch_id', '=', branchId)
        .where('code_key', '=', codeKey(codeOrName))
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (row !== undefined) return row.id;
      const named = await this.db.selectFrom('locations').select(['id', 'name']).where('branch_id', '=', branchId).where('archived_at', 'is', null).orderBy('code_key').execute();
      return named.find((r) => normalizeKey(r.name) === key)?.id ?? null;
    });
  }

  /**
   * The material type code for a MARC leader's /06 and /07 (marcToDraft takes a synchronous function, so the live
   * types are loaded first): the live type with both, else the first with /06 (by sort order), else null (the
   * default type).
   */
  async leaderResolver(): Promise<(leader06: string, leader07: string) => string | null> {
    this.leaderTypes ??= this.db
      .selectFrom('material_types')
      .select(['code_display as code', 'marc_type as type', 'marc_level as level'])
      .where('archived_at', 'is', null)
      .orderBy('sort_order')
      .orderBy('code_key')
      .execute();
    const types = await this.leaderTypes;
    return (l06, l07) => (types.find((t) => t.type === l06 && t.level === l07) ?? types.find((t) => t.type === l06))?.code ?? null;
  }
}
