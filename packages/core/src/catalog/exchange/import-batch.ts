import type { DB } from '@altis/db';
import { isDomainError, type ImportFormat } from '@altis/shared';
import { RECORD_LIST_MAX, type DraftItem, type IdentifierInput, type RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { RecordCreateBody, RecordPatchBody } from '@altis/shared/api/catalog/records';
import type { ItemCreateBody, ItemPatchBody } from '@altis/shared/api/catalog/items';
import type { Selectable } from 'kysely';
import { can, type Grants } from '../../authz/grants.js';
import type { TxCtx } from '../../context.js';
import { coerceCustomValues, type CustomFieldDef } from '../data/custom-fields.js';
import { mapLegacy, lookupLegacy, type LegacyMapping } from '../data/legacy-map.js';
import type { ItemCsvRow } from '../csv/items.js';
import type { SlimsItemCsvRow } from '../csv/slims.js';
import { createItem, updateItem } from '../items/service.js';
import { normalizeBarcode } from '../lib/barcode.js';
import { titleKey } from '../lib/title-key.js';
import { checkDuplicates } from '../records/duplicates.js';
import { recordBodyFromDraft } from '../records/draft.js';
import { identifierRows } from '../records/identifiers.js';
import { createRecord, updateRecord } from '../records/service.js';
import { BatchDuplicates, MasterLookup, duplicateProbe, matchRecords, recordsByIsbn, type ImportMatchOn } from './match.js';

// One batch of an import (Phase 2 spec §5.3; plan Task 31): up to about 200 records (or item rows) read from the file,
// processed in ONE transaction by importBatch. For each unit, in file order:
//
// - a unit the reader could not read (a broken MARC record, a CSV row too long) is one `error` row of the report;
// - a record: its draft becomes a create body (recordBodyFromDraft; SLiMS names looked up; CSV custom strings coerced,
//   S19), then it is matched (`matchOn`) and, when it matches, `onMatch` applies (`skip`, `update`, or `create` anyway);
//   a record that matched nothing is checked for duplicates (the in-batch check, then checkDuplicates ≥ the threshold
//   over the records the batch did not create, M7) and `onDuplicate` applies (`skip`, or `report` and create). It is
//   saved in bulk mode (no audit entry, no event of its own) with `source = import:<runId>`; with `createItems`, its
//   items (952/852, or a SLiMS row's item codes) are created as `imported` in the branch of the options, or else of
//   the item's own branch code;
// - an item row (`csv-items`, `csv-slims-items`): upserted by barcode; a new one finds its record by `record_id`, then
//   by ISBN (`csv-items`), or by its exact title (`csv-slims-items`; more than one → `record_ambiguous`).
// - Branch scope (S11): an item written in, or updated in, a branch where the run's creator lacks
//   `catalog.items.manage` is not written and is reported `branch_denied`, whatever the format and whether or not the
//   options name a branch.
// - Every unit processed is mapped in `migration_map` (`import:<runId>`, entity `record` or `item`, legacy key = its
//   number in the file) to the row it became (or matched); a unit already mapped is passed over: a batch replayed after
//   a crash writes nothing twice.
// - Refusals are report rows and the batch goes on, but only those the services decide in code before any statement
//   failed (REFUSAL_CODES: VALIDATION_FAILED, a record or item gone or changed meanwhile, a status transition): on
//   PostgreSQL a failed statement aborts the whole transaction, so a database error of one unit must never be caught
//   here. TX_CONFLICT (a barcode met at the unique index after its check, Task 17) is thrown so the batch runs again;
//   anything else is thrown too (the job then retries the batch one unit per transaction, import-job.ts).
// - `errors` counts the refusals: a unit refused, and each item of a record unit refused (the record itself stored).
//
// The report rows are `[record_no, line, level, code, field, record_id, title]`: `level` is `error`, `warning`,
// `skipped` or `duplicate`; `code` a code, never a value; `title` the draft's title cut to 200 characters.

/** The columns of an import report. */
export const IMPORT_REPORT_HEADER: readonly string[] = Object.freeze(['record_no', 'line', 'level', 'code', 'field', 'record_id', 'title']);

/** A report row (the columns of {@link IMPORT_REPORT_HEADER}). */
export type ImportReportRow = readonly [string, string, string, string, string, string, string];

/** What the report says about one unit. */
export interface ImportIssue {
  level: 'error' | 'warning' | 'skipped' | 'duplicate';
  code: string;
  field?: string;
  recordId?: string | null;
}

/** One record or item row read from the file, numbered from 1 (`line`: the CSV row, null for MARC). */
export type ImportUnit =
  | {
      kind: 'record';
      recordNo: number;
      line: number | null;
      draft: RecordDraft;
      /** The CSV's `record_id`. */
      recordId: string | null;
      /** The CSV's `opac_visible`. */
      opacVisible: boolean | null;
      /** `draft.custom` holds the raw strings of a CSV (coerced here, S19). */
      rawCustom: boolean;
      /** What reading and mapping found: errors refuse the record, warnings are reported. */
      issues: ImportIssue[];
      /** A SLiMS row's names (GMD, language) and item codes. */
      slims?: { gmdName: string | null; languageName: string | null; itemCodes: string[] };
    }
  | { kind: 'item'; recordNo: number; line: number | null; item: ItemCsvRow; issues: ImportIssue[] }
  | { kind: 'slims_item'; recordNo: number; line: number | null; item: SlimsItemCsvRow; issues: ImportIssue[] }
  | { kind: 'error'; recordNo: number; line: number | null; code: string; field?: string };

/** The counters one batch adds. */
export interface ImportCounts {
  read: number;
  created: number;
  updated: number;
  skipped: Record<string, number>;
  duplicates: number;
  itemsCreated: number;
  /** Refusals: units refused, and items of a stored record refused. */
  errors: number;
}

export function emptyCounts(): ImportCounts {
  return { read: 0, created: 0, updated: 0, skipped: {}, duplicates: 0, itemsCreated: 0, errors: 0 };
}

/** What a batch is processed with (fixed for a slice). */
export interface BatchSettings {
  runId: string;
  format: ImportFormat;
  matchOn: ImportMatchOn;
  onMatch: 'skip' | 'update' | 'create';
  onDuplicate: 'report' | 'skip';
  createItems: boolean;
  /** The options' branch; null: each item's own branch code. */
  branchId: string | null;
  defaultMaterialTypeId: string;
  defaultCollectionTypeId: string;
  /** `catalog.dedupe.threshold`. */
  threshold: number;
  /** The grants of the run's creator, read once per slice (S11); null: none. */
  grants: Grants | null;
  recordDefs: readonly CustomFieldDef[];
  itemDefs: readonly CustomFieldDef[];
}

/** What a batch did: its counters, its report rows, and the mappings it wrote. */
export interface BatchOutcome {
  counts: ImportCounts;
  rows: ImportReportRow[];
  /** Whether it wrote catalog data (for `catalog.bulk.changed`). */
  wrote: boolean;
  /**
   * The records it wrote, directly or through one of their items (C14): the job moves the datestamp of those its
   * writes stamped to the clock read right before the batch's COMMIT.
   */
  recordIds: string[];
}

const TITLE_MAX = 200;
const ITEM_PERMISSION = 'catalog.items.manage';

/**
 * The codes of a refusal the services decide in code, before any statement of theirs failed: the batch may go on in
 * the same transaction. Everything else (a database error above all) is thrown.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set(['VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT_STALE', 'CATALOG_MERGE_INVALID', 'ITEM_STATUS_TRANSITION']);

type ItemRow = Pick<Selectable<DB['items']>, 'id' | 'record_id' | 'branch_id' | 'version'>;

function cut(s: string): string {
  const points = Array.from(s);
  return points.length <= TITLE_MAX ? s : points.slice(0, TITLE_MAX).join('');
}

/** The field errors of a refusal (`[{path, code}]`), or its code as one row; null for an error to throw. */
export function refusalIssues(error: unknown): ImportIssue[] | null {
  if (!isDomainError(error) || !REFUSAL_CODES.has(error.code)) return null;
  if (error.code === 'VALIDATION_FAILED') {
    const errors = (error.meta as { errors?: unknown } | undefined)?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((e: { path?: unknown; code?: unknown }) => ({
        level: 'error' as const,
        code: typeof e.code === 'string' ? e.code : 'invalid',
        field: typeof e.path === 'string' ? e.path : '',
      }));
    }
  }
  return [{ level: 'error', code: error.code }];
}

/** The processing of one batch in `tx` (see the top of this file). */
class Batch {
  readonly counts = emptyCounts();
  readonly rows: ImportReportRow[] = [];
  readonly mappings: LegacyMapping[] = [];
  readonly dups = new BatchDuplicates();
  readonly masters: MasterLookup;
  wrote = false;
  /** The records this batch wrote, directly or through an item (BatchOutcome.recordIds). */
  readonly written = new Set<string>();
  private readonly source: string;
  /** updateItem has no bulk mode (Task 17): the run is audited once (`catalog.import.finish`), not per item. */
  private readonly quiet: TxCtx;

  constructor(
    readonly tx: TxCtx,
    readonly s: BatchSettings,
  ) {
    this.masters = new MasterLookup(tx.trx);
    this.source = `import:${s.runId}`;
    this.quiet = { ...tx, audit: async () => undefined };
  }

  report(u: { recordNo: number; line: number | null }, i: ImportIssue, title: string): void {
    this.rows.push([String(u.recordNo), u.line === null ? '' : String(u.line), i.level, i.code, i.field ?? '', i.recordId ?? '', cut(title)]);
  }

  skip(reason: string): void {
    this.counts.skipped[reason] = (this.counts.skipped[reason] ?? 0) + 1;
  }

  map(u: { recordNo: number }, entity: 'record' | 'item', targetId: string): void {
    this.mappings.push({ source: this.source, entity, legacyKey: String(u.recordNo), targetId, runId: this.s.runId });
  }

  /** The unit is refused: one refusal, its issues reported. */
  fail(u: { recordNo: number; line: number | null }, issues: readonly ImportIssue[], title: string): void {
    this.counts.errors += 1;
    for (const i of issues) this.report(u, i, title);
  }

  // ---- records ---------------------------------------------------------------------------------------------------------

  /** The create body of a record unit, with its warnings, or null when it is refused (reported). */
  async bodyOf(u: Extract<ImportUnit, { kind: 'record' }>): Promise<RecordCreateBody | null> {
    const { draft } = u;
    const title = draft.title;
    if (title.trim() === '') {
      this.fail(u, [{ level: 'error', code: 'title_missing', field: 'title' }], '');
      return null;
    }
    const built = await recordBodyFromDraft(this.tx.trx, draft, { defaultMaterialTypeId: this.s.defaultMaterialTypeId });
    const body = built.body;
    const warnings: ImportIssue[] = built.warnings.map((code) => ({ level: 'warning', code }));
    if (u.slims !== undefined) {
      if (u.slims.gmdName !== null) {
        const type = await this.masters.byName('material_types', u.slims.gmdName);
        if (type === null) warnings.push({ level: 'warning', code: 'material_type_unknown', field: 'gmd_name' });
        else body.materialTypeId = type;
      }
      if (u.slims.languageName !== null) {
        const language = await this.masters.byName('languages', u.slims.languageName);
        if (language === null) warnings.push({ level: 'warning', code: 'language_unknown', field: 'language_name' });
        else body.languageId = language;
      }
    }
    if (u.opacVisible !== null) body.opacVisible = u.opacVisible;
    if (u.rawCustom && draft.custom !== undefined) {
      const raw = Object.fromEntries(Object.entries(draft.custom).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]));
      const coerced = coerceCustomValues(this.s.recordDefs, raw);
      if (coerced.errors.length > 0) {
        this.fail(u, [...warnings, ...coerced.errors.map((e): ImportIssue => ({ level: 'error', code: e.code, field: e.path }))], title);
        return null;
      }
      body.custom = coerced.values;
    }
    for (const w of warnings) this.report(u, w, title);
    return body;
  }

  /** The patch an update by `body` makes: what the file says, nothing it left empty (a CSV's empty cell keeps a value). */
  patchOf(u: Extract<ImportUnit, { kind: 'record' }>, body: RecordCreateBody, version: number): RecordPatchBody {
    const { links, materialTypeId, ...rest } = body;
    void links; // links are added on create only (S4); later changes go through the attachments API
    const patch: RecordPatchBody = { version, ...rest };
    if (u.draft.materialTypeCode !== null || u.slims?.gmdName != null) patch.materialTypeId = materialTypeId;
    for (const key of ['identifiers', 'agents', 'subjects', 'marcExtra'] as const) {
      if (Array.isArray(patch[key]) && patch[key].length === 0) delete patch[key];
    }
    if (patch.custom !== undefined && Object.keys(patch.custom).length === 0) delete patch.custom;
    return patch;
  }

  /**
   * The identifiers an update by a CSV row sends (review C12). A CSV carries only a record's ISBNs and ISSNs (and an
   * `other` its cells hold that is neither), and an update replaces the whole list, so the stored identifiers it has no
   * column for (`doi`, `control`, `other`) are kept where they stand; the places of the stored ISBNs and ISSNs (and of
   * an `other` the file holds too) take the file's identifiers in its order, and the rest of them follow. The same
   * ISBNs give the stored list back unchanged.
   */
  async csvIdentifiers(recordId: string, file: readonly IdentifierInput[]): Promise<IdentifierInput[]> {
    const stored = await this.tx.trx
      .selectFrom('record_identifiers')
      .select(['type', 'value_display', 'value_key', 'qualifier'])
      .where('record_id', '=', recordId)
      .orderBy('sort_order')
      .orderBy('id')
      .execute();
    const inFile = new Set(identifierRows(file).rows.map((r) => `${r.type} ${r.value_key}`));
    const next = [...file];
    const out: IdentifierInput[] = [];
    for (const s of stored) {
      const type = s.type as IdentifierInput['type'];
      if (type === 'doi' || type === 'control' || (type === 'other' && !inFile.has(`other ${s.value_key}`))) {
        out.push(s.qualifier === null ? { type, value: s.value_display } : { type, value: s.value_display, qualifier: s.qualifier });
      } else if (next.length > 0) out.push(next.shift()!);
    }
    return [...out, ...next].slice(0, RECORD_LIST_MAX.identifiers);
  }

  async record(u: Extract<ImportUnit, { kind: 'record' }>): Promise<void> {
    const title = u.draft.title;
    if (u.issues.some((i) => i.level === 'error')) {
      this.fail(u, u.issues, title);
      return;
    }
    for (const i of u.issues) this.report(u, i, title);
    const body = await this.bodyOf(u);
    if (body === null) return;

    const matches = await matchRecords(this.tx.trx, this.s.matchOn, u.draft, u.recordId);
    if (matches.length > 0 && this.s.onMatch !== 'create') {
      if (this.s.onMatch === 'skip') {
        this.skip('matched');
        this.report(u, { level: 'skipped', code: 'matched', recordId: matches[0]! }, title);
        this.map(u, 'record', matches[0]!);
        return;
      }
      if (matches.length > 1) {
        this.fail(u, [{ level: 'error', code: 'match_ambiguous', recordId: matches[0]! }], title);
        return;
      }
      const id = matches[0]!;
      const row = await this.tx.trx.selectFrom('records').select('version').where('id', '=', id).executeTakeFirstOrThrow();
      const patch = this.patchOf(u, body, Number(row.version));
      if (patch.identifiers !== undefined && (this.s.format === 'csv-records' || this.s.format === 'csv-slims')) {
        patch.identifiers = await this.csvIdentifiers(id, patch.identifiers);
      }
      try {
        const saved = await updateRecord(this.tx, id, patch, { mode: 'bulk' });
        for (const w of saved.warnings) this.report(u, { level: 'warning', code: w.code, field: w.path }, title);
      } catch (error) {
        const issues = refusalIssues(error);
        if (issues === null) throw error;
        this.fail(u, issues, title);
        return;
      }
      this.wrote = true;
      this.written.add(id);
      this.counts.updated += 1;
      this.map(u, 'record', id);
      await this.recordItems(u, id);
      return;
    }

    const duplicate = this.dups.find(u.draft) ?? (await this.scoredDuplicate(u.draft));
    if (duplicate !== null) {
      this.counts.duplicates += 1;
      this.report(u, { level: 'duplicate', code: 'duplicate', recordId: duplicate }, title);
      if (this.s.onDuplicate === 'skip') {
        this.skip('duplicate');
        this.map(u, 'record', duplicate);
        return;
      }
    }
    let id: string;
    try {
      const saved = await createRecord(this.tx, body, { mode: 'bulk', source: this.source });
      id = saved.id;
      for (const w of saved.warnings) this.report(u, { level: 'warning', code: w.code, field: w.path, recordId: id }, title);
    } catch (error) {
      const issues = refusalIssues(error);
      if (issues === null) throw error;
      this.fail(u, issues, title);
      return;
    }
    this.wrote = true;
    this.written.add(id);
    this.counts.created += 1;
    this.dups.accept(u.draft, id);
    this.map(u, 'record', id);
    await this.recordItems(u, id);
  }

  /** The best scored duplicate of `draft` ≥ the threshold among the records this batch did not create, or null. */
  async scoredDuplicate(draft: RecordDraft): Promise<string | null> {
    const found = await checkDuplicates(this.tx.trx, duplicateProbe(draft), this.s.threshold);
    return found.find((c) => !this.dups.created.has(c.recordId))?.recordId ?? null;
  }

  // ---- items -----------------------------------------------------------------------------------------------------------

  /** The branch of an item: the options' branch, else its own code; an issue when there is none or it is denied. */
  async branchOf(code: string | undefined, field: string): Promise<{ id: string } | ImportIssue> {
    let id = this.s.branchId;
    if (id === null) {
      if (code === undefined || code.trim() === '') return { level: 'error', code: 'branch_missing', field };
      id = await this.masters.byCode('branches', code);
      if (id === null) return { level: 'error', code: 'not_found', field };
    }
    return this.allowed(id, field);
  }

  /** Whether an item may be written in (or updated in) `branchId`: the creator's grant (S11). */
  allowed(branchId: string, field: string): { id: string } | ImportIssue {
    if (this.s.grants === null || !can(this.s.grants, ITEM_PERMISSION, branchId)) return { level: 'error', code: 'branch_denied', field };
    return { id: branchId };
  }

  /** The item whose barcode key is `key`, or undefined. */
  async itemByKey(key: string): Promise<ItemRow | undefined> {
    return this.tx.trx.selectFrom('items').select(['id', 'record_id', 'branch_id', 'version']).where('barcode_key', '=', key).executeTakeFirst();
  }

  /** The collection type of code `code` (or name), else the default with a warning. */
  async collectionType(code: string | undefined, byName: boolean, field: string, warn: (i: ImportIssue) => void): Promise<string> {
    if (code === undefined || code.trim() === '') return this.s.defaultCollectionTypeId;
    const id = byName ? await this.masters.byName('collection_types', code) : await this.masters.byCode('collection_types', code);
    if (id !== null) return id;
    warn({ level: 'warning', code: 'collection_type_unknown', field });
    return this.s.defaultCollectionTypeId;
  }

  /** The location of `branchId` with code (or name) `code`, else none with a warning. */
  async location(branchId: string, code: string | undefined, field: string, warn: (i: ImportIssue) => void): Promise<string | null> {
    if (code === undefined || code.trim() === '') return null;
    const id = await this.masters.location(branchId, code);
    if (id === null) warn({ level: 'warning', code: 'location_unknown', field });
    return id;
  }

  /** Creates one item as `imported`; its id, or null when it is refused (reported, and counted when `count`). */
  async newItem(
    u: { recordNo: number; line: number | null },
    branchId: string,
    body: ItemCreateBody,
    prefix: string,
    title: string,
    count: boolean,
  ): Promise<string | null> {
    try {
      const made = await createItem(this.tx, branchId, body, { mode: 'bulk', eventType: 'imported' });
      this.wrote = true;
      this.written.add(body.recordId);
      this.counts.itemsCreated += 1;
      return made.id;
    } catch (error) {
      const issues = refusalIssues(error);
      if (issues === null) throw error;
      if (count) this.counts.errors += 1;
      for (const i of issues) this.report(u, { ...i, field: i.field === undefined || i.field === '' ? prefix.replace(/\.$/, '') : `${prefix}${i.field}` }, title);
      return null;
    }
  }

  /** The items of a record unit (createItems): its draft's items, or a SLiMS row's item codes. */
  async recordItems(u: Extract<ImportUnit, { kind: 'record' }>, recordId: string): Promise<void> {
    if (!this.s.createItems) return;
    const title = u.draft.title;
    const items: DraftItem[] = u.slims !== undefined ? u.slims.itemCodes.map((barcode) => ({ barcode })) : u.draft.items;
    for (const [i, item] of items.entries()) {
      const prefix = `items.${i}.`;
      const warn = (w: ImportIssue) => this.report(u, w, title);
      const existing = await this.itemByKey(normalizeBarcode(item.barcode));
      // Already there (the same file imported again with `update`): nothing to do.
      if (existing !== undefined && existing.record_id === recordId) continue;
      const branch = await this.branchOf(item.branchCode, `${prefix}branch`);
      if ('code' in branch) {
        this.counts.errors += 1;
        this.report(u, branch, title);
        continue;
      }
      const body: ItemCreateBody = {
        recordId,
        barcode: item.barcode,
        collectionTypeId: await this.collectionType(item.collectionTypeCode, false, `${prefix}collectionType`, warn),
        status: 'available',
        partsTotal: 1,
      };
      const location = await this.location(branch.id, item.locationCode, `${prefix}location`, warn);
      if (location !== null) body.locationId = location;
      if (item.callNumber !== undefined) body.callNumber = item.callNumber;
      await this.newItem(u, branch.id, body, prefix, title, true);
    }
  }

  /** The live record of an item row: by `record_id`, then by ISBN key (exactly one). */
  async parentOf(row: ItemCsvRow): Promise<{ id: string } | ImportIssue> {
    if (row.recordId !== undefined) {
      const r = await this.tx.trx.selectFrom('records').select('id').where('id', '=', row.recordId).where('archived_at', 'is', null).where('merged_into', 'is', null).executeTakeFirst();
      if (r !== undefined) return { id: r.id };
    }
    if (row.isbn !== undefined) {
      const found = await recordsByIsbn(this.tx.trx, row.isbn);
      if (found.length === 1) return { id: found[0]! };
      if (found.length > 1) return { level: 'error', code: 'record_ambiguous', field: 'isbn' };
    }
    return { level: 'error', code: 'record_not_found', field: row.recordId !== undefined ? 'record_id' : 'isbn' };
  }

  async item(u: Extract<ImportUnit, { kind: 'item' }>): Promise<void> {
    const row = u.item;
    const title = row.barcode;
    if (u.issues.some((i) => i.level === 'error')) {
      this.fail(u, u.issues, title);
      return;
    }
    for (const i of u.issues) this.report(u, i, title);
    const warn = (w: ImportIssue) => this.report(u, w, title);
    const custom = Object.keys(row.custom).length === 0 ? null : coerceCustomValues(this.s.itemDefs, row.custom);
    if (custom !== null && custom.errors.length > 0) {
      this.fail(u, custom.errors.map((e) => ({ level: 'error', code: e.code, field: e.path })), title);
      return;
    }
    const existing = await this.itemByKey(normalizeBarcode(row.barcode));
    if (existing !== undefined) {
      await this.updateItemRow(u, existing, title, warn, custom?.values);
      return;
    }
    const parent = await this.parentOf(row);
    if ('code' in parent) {
      this.fail(u, [parent], title);
      return;
    }
    const branch = await this.branchOf(row.branchCode, 'branch');
    if ('code' in branch) {
      this.fail(u, [branch], title);
      return;
    }
    const body: ItemCreateBody = {
      recordId: parent.id,
      barcode: row.barcode,
      collectionTypeId: await this.collectionType(row.collectionTypeCode, false, 'collection_type', warn),
      status: row.status ?? 'available',
      partsTotal: row.partsTotal ?? 1,
      ...(await this.itemFields(row, branch.id, warn)),
    };
    if (custom !== null) body.custom = custom.values;
    const id = await this.newItem(u, branch.id, body, '', title, true);
    if (id === null) return;
    this.counts.created += 1;
    this.map(u, 'item', id);
  }

  /** The optional fields of an item row as the API names them (codes looked up, unknown ones warned and left out). */
  async itemFields(row: ItemCsvRow, branchId: string, warn: (i: ImportIssue) => void): Promise<Partial<ItemCreateBody>> {
    const out: Partial<ItemCreateBody> = {};
    if (row.callNumber !== undefined) out.callNumber = row.callNumber;
    if (row.inventoryNo !== undefined) out.inventoryNo = row.inventoryNo;
    if (row.acqSource !== undefined) out.acqSource = row.acqSource;
    if (row.orderNo !== undefined) out.orderNo = row.orderNo;
    if (row.orderDate !== undefined) out.orderDate = row.orderDate;
    if (row.receivedDate !== undefined) out.receivedDate = row.receivedDate;
    if (row.invoiceNo !== undefined) out.invoiceNo = row.invoiceNo;
    if (row.invoiceDate !== undefined) out.invoiceDate = row.invoiceDate;
    if (row.price !== undefined) out.price = row.price;
    if (row.currency !== undefined) out.currency = row.currency;
    if (row.note !== undefined) out.note = row.note;
    const location = await this.location(branchId, row.locationCode, 'location', warn);
    if (location !== null) out.locationId = location;
    if (row.supplierCode !== undefined) {
      const supplier = await this.masters.byCode('suppliers', row.supplierCode);
      if (supplier === null) warn({ level: 'warning', code: 'supplier_unknown', field: 'supplier' });
      else out.supplierId = supplier;
    }
    return out;
  }

  /** `onMatch` for an item row whose barcode is stored: skip, update in its own branch, or `taken`. */
  async updateItemRow(
    u: Extract<ImportUnit, { kind: 'item' }>,
    existing: ItemRow,
    title: string,
    warn: (i: ImportIssue) => void,
    custom: Record<string, unknown> | undefined,
  ): Promise<void> {
    const row = u.item;
    if (this.s.onMatch === 'skip') {
      this.skip('matched');
      this.report(u, { level: 'skipped', code: 'matched', recordId: existing.record_id }, title);
      this.map(u, 'item', existing.id);
      return;
    }
    if (this.s.onMatch === 'create') {
      this.fail(u, [{ level: 'error', code: 'taken', field: 'barcode', recordId: existing.record_id }], title);
      return;
    }
    const branch = this.allowed(existing.branch_id, 'branch');
    if ('code' in branch) {
      this.fail(u, [branch], title);
      return;
    }
    if (row.branchCode !== undefined && (await this.masters.byCode('branches', row.branchCode)) !== existing.branch_id) {
      this.fail(u, [{ level: 'error', code: 'branch_mismatch', field: 'branch' }], title);
      return;
    }
    const fields = await this.itemFields(row, existing.branch_id, warn);
    const patch: ItemPatchBody = { version: Number(existing.version), ...fields };
    if (row.status !== undefined) patch.status = row.status;
    if (row.partsTotal !== undefined) patch.partsTotal = row.partsTotal;
    if (row.collectionTypeCode !== undefined) {
      const ct = await this.masters.byCode('collection_types', row.collectionTypeCode);
      if (ct === null) warn({ level: 'warning', code: 'collection_type_unknown', field: 'collection_type' });
      else patch.collectionTypeId = ct;
    }
    if (custom !== undefined && Object.keys(custom).length > 0) patch.custom = custom;
    try {
      await updateItem(this.quiet, existing.branch_id, existing.id, patch);
    } catch (error) {
      const issues = refusalIssues(error);
      if (issues === null) throw error;
      this.fail(u, issues, title);
      return;
    }
    this.wrote = true;
    this.written.add(existing.record_id);
    this.counts.updated += 1;
    this.map(u, 'item', existing.id);
  }

  /**
   * The live records whose title is exactly `title` (at most 2: one is the parent, two are `record_ambiguous`). The
   * indexed `title_key` narrows them (`titleKey(title)`, or followed by a blank and the subtitle's key), and the title
   * is compared here: `title = ?` alone scans the records, and ignores case (and accents) on MySQL/MariaDB only.
   */
  async recordsTitled(title: string): Promise<{ id: string }[]> {
    const key = titleKey(title);
    let query = this.tx.trx.selectFrom('records').select(['id', 'title']).where('title', '=', title).where('archived_at', 'is', null).where('merged_into', 'is', null);
    // A title of punctuation only has an empty key: its records' keys are their subtitles'.
    if (key !== '') query = query.where((eb) => eb.or([eb('title_key', '=', key), eb.and([eb('title_key', '>=', `${key} `), eb('title_key', '<', `${key} \u{10FFFF}`)])]));
    const rows = await query.orderBy('id').execute();
    return rows.filter((r) => r.title === title).slice(0, 2).map((r) => ({ id: r.id }));
  }

  /** A SLiMS item row: new items only (an existing barcode is `matched`/`taken`), parent by its exact title. */
  async slimsItem(u: Extract<ImportUnit, { kind: 'slims_item' }>): Promise<void> {
    const row = u.item;
    const title = row.title;
    if (u.issues.some((i) => i.level === 'error')) {
      this.fail(u, u.issues, title);
      return;
    }
    for (const i of u.issues) this.report(u, i, title);
    const warn = (w: ImportIssue) => this.report(u, w, title);
    const existing = await this.itemByKey(normalizeBarcode(row.itemCode));
    if (existing !== undefined) {
      if (this.s.onMatch === 'create') this.fail(u, [{ level: 'error', code: 'taken', field: 'item_code', recordId: existing.record_id }], title);
      else {
        this.skip('matched');
        this.report(u, { level: 'skipped', code: 'matched', recordId: existing.record_id }, title);
        this.map(u, 'item', existing.id);
      }
      return;
    }
    const parents = row.title === '' ? [] : await this.recordsTitled(row.title);
    if (parents.length !== 1) {
      this.fail(u, [{ level: 'error', code: parents.length === 0 ? 'record_not_found' : 'record_ambiguous', field: 'title' }], title);
      return;
    }
    if (this.s.branchId === null) {
      this.fail(u, [{ level: 'error', code: 'branch_missing', field: 'site' }], title);
      return;
    }
    const branch = this.allowed(this.s.branchId, 'site');
    if ('code' in branch) {
      this.fail(u, [branch], title);
      return;
    }
    const body: ItemCreateBody = {
      recordId: parents[0]!.id,
      barcode: row.itemCode,
      collectionTypeId: await this.collectionType(row.collTypeName, true, 'coll_type_name', warn),
      status: 'available',
      partsTotal: 1,
    };
    const location = await this.location(branch.id, row.locationName, 'location_name', warn);
    if (location !== null) body.locationId = location;
    if (row.callNumber !== undefined) body.callNumber = row.callNumber;
    if (row.inventoryCode !== undefined) body.inventoryNo = row.inventoryCode;
    if (row.source !== undefined) body.acqSource = row.source;
    if (row.orderNo !== undefined) body.orderNo = row.orderNo;
    if (row.orderDate !== undefined) body.orderDate = row.orderDate;
    if (row.receivedDate !== undefined) body.receivedDate = row.receivedDate;
    if (row.invoice !== undefined) body.invoiceNo = row.invoice;
    if (row.invoiceDate !== undefined) body.invoiceDate = row.invoiceDate;
    if (row.price !== undefined) body.price = row.price;
    if (row.priceCurrency !== undefined) body.currency = row.priceCurrency;
    if (row.supplierName !== undefined) {
      const supplier = await this.masters.byName('suppliers', row.supplierName);
      if (supplier === null) warn({ level: 'warning', code: 'supplier_unknown', field: 'supplier_name' });
      else body.supplierId = supplier;
    }
    const id = await this.newItem(u, branch.id, body, '', title, true);
    if (id === null) return;
    this.counts.created += 1;
    this.map(u, 'item', id);
  }
}

/** The legacy-map entity of a unit. */
function entityOf(u: ImportUnit): 'record' | 'item' {
  return u.kind === 'item' || u.kind === 'slims_item' ? 'item' : 'record';
}

/**
 * Processes `units` in `tx` (see the top of this file) and writes their mappings; the caller saves the counters and
 * the checkpoint in the same transaction. Units already mapped (a replayed batch) are passed over, not counted.
 *
 * @throws DomainError TX_CONFLICT (withTx runs the batch again); any error that is not one record's refusal
 */
export async function importBatch(tx: TxCtx, s: BatchSettings, units: readonly ImportUnit[]): Promise<BatchOutcome> {
  const b = new Batch(tx, s);
  const source = `import:${s.runId}`;
  const done = new Set<string>();
  for (const entity of ['record', 'item'] as const) {
    const keys = units.filter((u) => entityOf(u) === entity && u.kind !== 'error').map((u) => String(u.recordNo));
    if (keys.length === 0) continue;
    for (const key of (await lookupLegacy(tx.trx, source, entity, keys)).keys()) done.add(`${entity}:${key}`);
  }
  for (const u of units) {
    if (u.kind !== 'error' && done.has(`${entityOf(u)}:${u.recordNo}`)) continue;
    b.counts.read += 1;
    switch (u.kind) {
      case 'error':
        b.fail(u, [{ level: 'error', code: u.code, ...(u.field === undefined ? {} : { field: u.field }) }], '');
        break;
      case 'record':
        await b.record(u);
        break;
      case 'item':
        await b.item(u);
        break;
      case 'slims_item':
        await b.slimsItem(u);
        break;
    }
  }
  if (b.mappings.length > 0) await mapLegacy(tx.trx, b.mappings);
  return { counts: b.counts, rows: b.rows, wrote: b.wrote, recordIds: [...b.written] };
}

/** `into` + `add`, counter by counter. */
export function addCounts(into: ImportCounts, add: ImportCounts): ImportCounts {
  const skipped = { ...into.skipped };
  for (const [k, n] of Object.entries(add.skipped)) skipped[k] = (skipped[k] ?? 0) + n;
  return {
    read: into.read + add.read,
    created: into.created + add.created,
    updated: into.updated + add.updated,
    skipped,
    duplicates: into.duplicates + add.duplicates,
    itemsCreated: into.itemsCreated + add.itemsCreated,
    errors: into.errors + add.errors,
  };
}
