/**
 * The import and export API vocabulary (Phase 2 spec §5, §12.2; plan Tasks 29, 31). Files arrive only through the
 * `catalog.import` upload context (a JSON body is ≤ 1 MB); exports are written to `DATA_DIR/exports/` and downloaded
 * from the run.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/exchange`.
 */
import { z } from 'zod';
import { EXPORT_FORMATS, IMPORT_FORMATS } from '../../catalog-vocab.js';
import { ulidField } from '../common.js';
import { epochMsField, shortText } from './common.js';
import type { RecordDraft } from './record-data.js';

/** How an imported record is matched with a stored one. */
export const IMPORT_MATCH_ON = Object.freeze(['isbn', 'control', 'record_id', 'none'] as const);

/** What happens to a matched record. */
export const IMPORT_ON_MATCH = Object.freeze(['skip', 'update', 'create'] as const);

/** What happens to a likely duplicate (§3.3 score ≥ the threshold) that matched nothing. */
export const IMPORT_ON_DUPLICATE = Object.freeze(['report', 'skip'] as const);

/**
 * `POST catalog/imports` (§5.3). The file is **exactly one of** (S3):
 * - `uploadId`: a completed `catalog.import` upload;
 * - `fromRunId`: a succeeded dry import run of the same user, finished less than 7 days ago and not adopted yet (else
 *   `{path: 'fromRunId', code: 'not_found'}`, the handler's); the real run reads that run's `import.bin`.
 * Both: `{path: 'fromRunId', code: 'exclusive'}`; neither: `{path: 'uploadId', code: 'required'}`.
 *
 * `format` is detected when absent. `createItems` (or a `csv-items` file) also needs `catalog.items.manage` at
 * `branchId` (S11).
 */
export const ImportBody = z
  .strictObject({
    uploadId: ulidField.optional(),
    fromRunId: ulidField.optional(),
    format: z.enum(IMPORT_FORMATS).optional(),
    matchOn: z.enum(IMPORT_MATCH_ON),
    onMatch: z.enum(IMPORT_ON_MATCH),
    onDuplicate: z.enum(IMPORT_ON_DUPLICATE),
    createItems: z.boolean(),
    branchId: ulidField.optional(),
    defaultMaterialTypeId: ulidField.optional(),
    defaultCollectionTypeId: ulidField.optional(),
    dryRun: z.boolean(),
  })
  .check((ctx) => {
    const { uploadId, fromRunId } = ctx.value;
    if (uploadId !== undefined && fromRunId !== undefined) {
      ctx.issues.push({ code: 'custom', path: ['fromRunId'], params: { code: 'exclusive' }, message: 'exclusive', input: fromRunId });
    } else if (uploadId === undefined && fromRunId === undefined) {
      ctx.issues.push({ code: 'custom', path: ['uploadId'], params: { code: 'required' }, message: 'required', input: uploadId });
    }
  });

export type ImportBody = z.infer<typeof ImportBody>;

/** The most drafts an import summary shows. */
export const IMPORT_SAMPLE_MAX = 20;

/**
 * The summary of an import run (`catalog_runs.summary`): the counts of §5.3, the reader's warnings (`encoding_cp1252`),
 * and on a dry run the first {@link IMPORT_SAMPLE_MAX} mapped drafts. `skipped` counts by reason code.
 *
 * The summary is stored as JSON in a TEXT column, so its encoding stays ≤ 60 000 UTF-8 bytes (Review Focus 3): the
 * writer bounds `warnings` and drops drafts from the end of `sample` (a draft's summary alone may hold 60 000 bytes)
 * until it fits. The report CSV keeps the full detail.
 */
export interface ImportSummary {
  read: number;
  created: number;
  updated: number;
  skipped: Record<string, number>;
  duplicates: number;
  itemsCreated: number;
  errors: number;
  warnings: string[];
  sample?: RecordDraft[];
}

/** The most record ids an export (or "Ekspor terpilih", M2) names. */
export const EXPORT_RECORD_IDS_MAX = 1000;

/**
 * `POST catalog/exports` (§5.4): the records of `filter.recordIds`, or of the search `q` (≤ 10 000), or every record
 * the other filters keep. `changedSince` is epoch ms.
 */
export const ExportBody = z.strictObject({
  format: z.enum(EXPORT_FORMATS),
  filter: z.strictObject({
    q: shortText(500).optional(),
    recordIds: z.array(ulidField).min(1).max(EXPORT_RECORD_IDS_MAX).optional(),
    materialTypeId: ulidField.optional(),
    collectionTypeId: ulidField.optional(),
    branchId: ulidField.optional(),
    changedSince: epochMsField.optional(),
    includeArchived: z.boolean().optional(),
    includeItems: z.boolean().optional(),
  }),
});

export type ExportBody = z.infer<typeof ExportBody>;

/** `GET catalog/records/:id/marc?format=`: ISO 2709, MARCXML, or one {@link MarcJsonRecord}. */
export const MarcFormatQuery = z.strictObject({ format: z.enum(['mrc', 'xml', 'json']) });

export type MarcFormatQuery = z.infer<typeof MarcFormatQuery>;

/** A data field in MARC-in-JSON: its indicators and its subfields in order, each `{<code>: value}`. */
export interface MarcJsonDataField {
  ind1: string;
  ind2: string;
  subfields: { [code: string]: string }[];
}

/**
 * One record in MARC-in-JSON (M9): the `format=json` answer of `GET catalog/records/:id/marc` (`application/json`, one
 * object) and each line of a `marcjson` export. A control field is `{<tag>: value}`, a data field
 * `{<tag>: MarcJsonDataField}`, in tag order.
 */
export interface MarcJsonRecord {
  leader: string;
  fields: ({ [tag: string]: string } | { [tag: string]: MarcJsonDataField })[];
}
