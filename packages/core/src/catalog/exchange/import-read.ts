import type { FileHandle } from 'node:fs/promises';
import { openRead, type DataPath } from '@altis/platform';
import type { ImportFormat } from '@altis/shared';
import { issueCode } from '@altis/shared/api/common';
import { RecordDraft } from '@altis/shared/api/catalog/record-data';
import { createCsvReader, type CsvReader, type CsvReaderState, type CsvRow } from '../csv/reader.js';
import { csvItemHeaderErrors, csvItemRow } from '../csv/items.js';
import { csvRecordHeaderErrors, csvRecordRow } from '../csv/records.js';
import { isSlimsCsvHeader, slimsCsvItem, slimsCsvRecord } from '../csv/slims.js';
import type { CsvFieldError } from '../csv/multi.js';
import { readIso2709 } from '../../marc/iso2709.js';
import { marcToDraft } from '../../marc/map-import.js';
import { readMarcXml } from '../../marc/marcxml.js';
import type { MarcReadResult } from '../../marc/record.js';
import { XmlError } from '../../xml/reader.js';
import type { ImportIssue, ImportUnit } from './import-batch.js';

// Reading an import file into units (Phase 2 spec §5.1–§5.3; plan Task 31, S21): records (MARC 21, MARCXML, the CSV
// record layouts) or item rows (the CSV item layouts), numbered from 1 in file order, from any checkpointed position.
//
// - A position is a reader boundary: the byte after the last unit it covers, the number of units before it, and what
//   the reader needs to go on from there (the CSV state; the MARCXML namespace context of prefixes()). Each unit carries
//   the position after it when that is exactly known: after every ISO 2709 record and every CSV row; after a MARCXML
//   record only when it is the last one a chunk completed (prefixes() describes the end of the last record read, which
//   may lie past a unit still waiting in the queue). A resumed source starts at such a position and never reads the
//   bytes before it again (S21), except the CSV header row, which it reads anew from the start of the file.
// - The file is read in chunks of 64 KiB; what the source holds is bounded by the readers (S9) and the queue of units a
//   chunk completed.
// - What makes the file unreadable is an ImportFormatError (the run fails with CATALOG_IMPORT_FORMAT): malformed XML or
//   a DOCTYPE (XmlError), a CSV header without its required column, or a header row the reader could not read. One
//   broken record or row is a unit of its own (`error`), and the reading goes on (Review Focus 5).

/** Where a source starts (and a slice resumes): see the top of this file. */
export interface ImportPosition {
  byteOffset: number;
  /** The units before `byteOffset`. */
  recordNo: number;
  /** The CSV reader's state at `byteOffset` (the CSV layouts, once a row was read). */
  csv?: CsvReaderState;
  /** readMarcXml's prefixes() at `byteOffset` (MARCXML, once a record was read). */
  xmlPrefixes?: Record<string, string>;
}

/** A unit read, with the position after it when that is exactly known. */
export interface ReadUnit {
  unit: ImportUnit;
  boundary: ImportPosition | null;
}

/** The file cannot be read as its format (→ CATALOG_IMPORT_FORMAT); `reason` is a code for the report. */
export class ImportFormatError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`import file refused (${reason})`);
    this.name = 'ImportFormatError';
    this.reason = reason;
  }
}

/** Reads one import file from a position (see the top of this file). */
export interface ImportSource {
  /** At most `max` units, in file order; [] once the file is read. */
  next(max: number): Promise<ReadUnit[]>;
  /** The CSV header's problems, when this source read the header for the first time (from the file's start). */
  headerIssues(): ImportIssue[];
  /** The file's warnings found so far (`encoding_cp1252`). */
  warnings(): string[];
  /** The bytes this source read from its start position on (the header re-read of a resumed CSV excluded). */
  bytesRead(): number;
  close(): Promise<void>;
}

/** Bytes read per chunk. */
const CHUNK_BYTES = 64 * 1024;
/** The longest namespace context (readMarcXml's prefixes() as JSON) a checkpoint carries. */
const XML_CONTEXT_MAX = 8_192;
/** The longest CSV header this source re-reads on a resume (the reader's row cap, S9). */
const HEADER_READ_MAX = 2 * 1024 * 1024;

/** `errors` of a CSV codec as error issues. */
function csvIssues(errors: readonly CsvFieldError[]): ImportIssue[] {
  return errors.map((e) => ({ level: 'error', code: e.code, ...(e.column === '' ? {} : { field: e.column }) }));
}

/** A row whose cells are all blank (Excel's `;;;;` at the end of a sheet): not a unit. */
function blankRow(row: CsvRow): boolean {
  return row.error === undefined && row.cells.every((c) => c.trim() === '');
}

/** The issues of a draft the strict contract refuses (a MARC record without a 245 title: `title_missing`). */
function draftIssues(draft: RecordDraft): ImportIssue[] {
  const parsed = RecordDraft.safeParse(draft);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const field = issue.path.map(String).join('.');
    return field === 'title' ? { level: 'error', code: 'title_missing', field } : { level: 'error', code: issueCode(issue), field };
  });
}

/** A mapping warning (`field_skipped:505`) as an issue (`field_skipped` at `505`). */
function warningIssue(w: string): ImportIssue {
  const colon = w.indexOf(':');
  return colon < 0 ? { level: 'warning', code: w } : { level: 'warning', code: w.slice(0, colon), field: w.slice(colon + 1) };
}

/** The unit of a MARC reader's result, numbered `recordNo`. */
function marcUnit(r: MarcReadResult, recordNo: number, leader: (l06: string, l07: string) => string | null): ImportUnit {
  if (!r.ok) return { kind: 'error', recordNo, line: null, code: r.error };
  const { draft, warnings } = marcToDraft(r.record, { materialTypeCodeFor: leader });
  const issues: ImportIssue[] = [...r.warnings.map((w): ImportIssue => ({ level: 'warning', code: w })), ...warnings.map(warningIssue)];
  issues.push(...draftIssues(draft));
  return { kind: 'record', recordNo, line: null, draft, recordId: null, opacVisible: null, rawCustom: false, issues };
}

/** The unit of a CSV data row of `format` under `header`, numbered `recordNo`. */
function csvUnit(format: ImportFormat, row: CsvRow, header: readonly string[] | null, recordNo: number): ImportUnit {
  const line = row.line;
  if (row.error !== undefined) return { kind: 'error', recordNo, line, code: row.error };
  const rowWarning: ImportIssue[] = row.warning === undefined ? [] : [{ level: 'warning', code: row.warning }];
  switch (format) {
    case 'csv-records': {
      const r = csvRecordRow(header!, row.cells);
      const issues = [...rowWarning, ...csvIssues(r.errors)];
      if (r.errors.length === 0) issues.push(...draftIssues(r.draft));
      return { kind: 'record', recordNo, line, draft: r.draft, recordId: r.recordId, opacVisible: r.opacVisible, rawCustom: true, issues };
    }
    case 'csv-items': {
      const r = csvItemRow(header!, row.cells);
      return { kind: 'item', recordNo, line, item: r.row, issues: [...rowWarning, ...csvIssues(r.errors)] };
    }
    case 'csv-slims': {
      const r = slimsCsvRecord(row.cells);
      const issues = [...rowWarning, ...csvIssues(r.errors)];
      if (r.errors.length === 0) issues.push(...draftIssues(r.draft));
      return {
        kind: 'record',
        recordNo,
        line,
        draft: r.draft,
        recordId: null,
        opacVisible: null,
        rawCustom: false,
        issues,
        slims: { gmdName: r.gmdName, languageName: r.languageName, itemCodes: r.itemCodes },
      };
    }
    case 'csv-slims-items': {
      const r = slimsCsvItem(row.cells);
      return { kind: 'slims_item', recordNo, line, item: r.row, issues: [...rowWarning, ...csvIssues(r.errors)] };
    }
    default:
      throw new TypeError(`csvUnit(): ${format} is not a CSV format`);
  }
}

/** Whether `format` starts with a header row (the ALTIS layouts; a SLiMS file may, and its header is skipped). */
function headerFormat(format: ImportFormat): format is 'csv-records' | 'csv-items' {
  return format === 'csv-records' || format === 'csv-items';
}

/** The header row of a CSV file of `format` and the position after it (reading from the start of `handle`). */
async function readHeader(handle: FileHandle): Promise<CsvRow> {
  const reader = createCsvReader();
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let at = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, at);
    const rows = bytesRead === 0 ? reader.end() : reader.push(buffer.subarray(0, bytesRead));
    at += bytesRead;
    const first = rows.find((r) => !blankRow(r));
    if (first !== undefined) return first;
    if (bytesRead === 0 || at > HEADER_READ_MAX) throw new ImportFormatError('header_missing');
  }
}

/**
 * The source of the import file `file` of `format` from `position` (see the top of this file). `leader` maps a MARC
 * leader's /06 and /07 to a material type code.
 *
 * @throws ImportFormatError when the CSV header cannot be read or lacks its required column
 */
export async function openImportSource(
  file: DataPath,
  format: ImportFormat,
  position: ImportPosition,
  o: { leader: (l06: string, l07: string) => string | null },
): Promise<ImportSource> {
  const handle = await openRead(file);
  try {
    return await sourceOf(handle, format, position, o);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function sourceOf(
  handle: FileHandle,
  format: ImportFormat,
  position: ImportPosition,
  o: { leader: (l06: string, l07: string) => string | null },
): Promise<ImportSource> {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let at = position.byteOffset;
  let read = 0;
  let eof = false;
  let recordNo = position.recordNo;
  const queue: ReadUnit[] = [];
  const headerIssues: ImportIssue[] = [];
  const warnings: string[] = [];

  /** The next chunk of the file, or null at its end. */
  async function chunk(): Promise<Buffer | null> {
    if (eof) return null;
    const r = await handle.read(buffer, 0, buffer.byteLength, at);
    if (r.bytesRead === 0) {
      eof = true;
      return null;
    }
    at += r.bytesRead;
    read += r.bytesRead;
    return buffer.subarray(0, r.bytesRead);
  }

  /** Reads one more chunk into the queue; false at the end of the file. */
  let fill: () => Promise<boolean>;

  if (format === 'marc21' || format === 'marcxml') {
    const xml = format === 'marcxml';
    const iso = xml ? null : readIso2709({ baseOffset: position.byteOffset });
    const mx = xml ? readMarcXml({ baseOffset: position.byteOffset, ...(position.xmlPrefixes === undefined ? {} : { resume: { prefixes: position.xmlPrefixes } }) }) : null;
    let ended = false;
    fill = async () => {
      if (ended) return false;
      const bytes = await chunk();
      let results: (MarcReadResult & { endByte: number })[];
      try {
        if (bytes === null) {
          ended = true;
          results = iso !== null ? iso.end() : mx!.end();
        } else {
          results = iso !== null ? iso.push(bytes) : mx!.push(bytes);
        }
      } catch (error) {
        if (error instanceof XmlError) throw new ImportFormatError(`xml_${error.reason}`);
        throw error;
      }
      const prefixes = mx === null || results.length === 0 ? null : mx.prefixes();
      // A checkpoint holds the context; a file that declares the MARC namespace under huge prefix names cannot be one.
      if (prefixes !== null && JSON.stringify(prefixes).length > XML_CONTEXT_MAX) throw new ImportFormatError('xml_context');
      results.forEach((r, i) => {
        recordNo += 1;
        const unit = marcUnit(r, recordNo, o.leader);
        let boundary: ImportPosition | null = { byteOffset: r.endByte, recordNo };
        if (mx !== null) boundary = i === results.length - 1 && prefixes !== null ? { ...boundary, xmlPrefixes: prefixes } : null;
        queue.push({ unit, boundary });
      });
      return true;
    };
  } else {
    let header: readonly string[] | null = null;
    let reader: CsvReader;
    let headerPending = false;
    if (position.csv === undefined) {
      // The start of the file: the header (or a SLiMS header) is its first row that is not blank.
      if (position.byteOffset !== 0 || position.recordNo !== 0) throw new TypeError('a CSV import position past the start without its reader state');
      reader = createCsvReader();
      headerPending = true;
    } else {
      reader = createCsvReader({ resume: position.csv });
      if (headerFormat(format)) {
        const row = await readHeader(handle);
        if (row.error !== undefined) throw new ImportFormatError('header_unreadable');
        header = row.cells;
      }
    }
    let ended = false;
    fill = async () => {
      if (ended) return false;
      const bytes = await chunk();
      let rows: CsvRow[];
      if (bytes === null) {
        ended = true;
        rows = reader.end();
      } else {
        rows = reader.push(bytes);
      }
      if (rows.length > 0 && position.csv === undefined && warnings.length === 0) warnings.push(...reader.info().warnings);
      for (const row of rows) {
        if (headerPending) {
          if (blankRow(row)) continue;
          headerPending = false;
          if (headerFormat(format)) {
            if (row.error !== undefined) throw new ImportFormatError('header_unreadable');
            const errors = format === 'csv-records' ? csvRecordHeaderErrors(row.cells) : csvItemHeaderErrors(row.cells);
            if (errors.some((e) => e.code === 'required')) throw new ImportFormatError('header_required');
            header = row.cells;
            headerIssues.push(...errors.map((e): ImportIssue => ({ level: 'warning', code: e.code, ...(e.column === '' ? {} : { field: e.column }) })));
            continue;
          }
          if (row.error === undefined && isSlimsCsvHeader(row.cells, format === 'csv-slims' ? 'records' : 'items')) continue;
        }
        if (blankRow(row)) continue;
        recordNo += 1;
        const state = reader.state();
        queue.push({
          unit: csvUnit(format, row, header, recordNo),
          boundary: { byteOffset: row.endOffset, recordNo, csv: { byteOffset: row.endOffset, line: row.line, separator: state.separator, encoding: state.encoding } },
        });
      }
      return true;
    };
  }

  return {
    async next(max) {
      while (queue.length < max && (await fill()));
      return queue.splice(0, max);
    },
    headerIssues: () => headerIssues,
    warnings: () => warnings,
    bytesRead: () => read,
    close: () => handle.close(),
  };
}
