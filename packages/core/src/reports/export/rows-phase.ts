import type { FileHandle } from 'node:fs/promises';
import { openAppend, openRead, statOrNull, truncateFile, type DataPath } from '@altis/platform';
import { REPORT_EXPORT_CURSOR_MAX, REPORT_PDF_MAX_ROWS, REPORT_XLSX_MAX_ROWS, type ReportCell } from '@altis/shared/api/reports';
import { columnsOf } from '../personal.js';
import type { ReportColumn, ReportRow, TableReport } from '../types.js';
import { ExportRunFailure, internalFailure, workFile, type ExportFormat, type ExportRun, type RowsState } from './state.js';

// The rows phase of a table report (spec §4.15): the definition's `rows()` is asked for 500 rows at a time from its
// cursor, and each row is appended to the run's work file `rows.ndjson` as one JSON line (an array of cells). A report
// that scans the stock may answer no rows and a cursor while its scan runs: that only moves the cursor, which the job
// keeps in its checkpoint. When the cursor ends, the totals row (if the report has one) is the last line,
// `{"totals": [...]}`. The running count of data rows is held to the format's limit (XLSX 100 000, PDF 10 000): above it
// the run fails with REPORT_TOO_LARGE, its job message naming the rows, the limit and the format.
//
// The file is fsynced at the end of every slice, before the checkpoint that records its length is returned; the next
// slice cuts off whatever a slice that died later appended. The write phases read the same file back line by line.

/** Rows asked of a definition at a time. */
export const ROWS_BATCH = 500;

/** The most data rows each format holds (CSV and document formats: no limit). */
const ROW_LIMITS: Readonly<Partial<Record<ExportFormat, number>>> = Object.freeze({ xlsx: REPORT_XLSX_MAX_ROWS, pdf: REPORT_PDF_MAX_ROWS });

/** One line of `rows.ndjson`: a data row, or the totals row (the last line, when there is one). */
export type NdjsonEntry = { kind: 'row'; cells: ReportCell[] } | { kind: 'totals'; cells: ReportCell[] };

/** The bytes read from `rows.ndjson` at a time. */
const READ_CHUNK = 256 * 1024;

/** The columns of the run's table report, for its stored parameters. */
export function runColumns(run: ExportRun): readonly ReportColumn[] {
  return columnsOf(run.def, run.stored.def);
}

/** The cells of `row`, checked: an array of at most `width` strings, numbers or nulls (a non-finite number is null). */
function checkedRow(row: unknown, width: number): ReportCell[] {
  if (!Array.isArray(row) || row.length > width) throw internalFailure();
  return row.map((cell: unknown) => {
    if (cell === null || cell === undefined) return null;
    if (typeof cell === 'string') return cell;
    if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
    throw internalFailure();
  });
}

/** One parsed line of `rows.ndjson`. */
function parseLine(text: string): NdjsonEntry {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw internalFailure();
  }
  if (Array.isArray(value)) return { kind: 'row', cells: value as ReportCell[] };
  if (typeof value === 'object' && value !== null && Array.isArray((value as { totals?: unknown }).totals)) {
    return { kind: 'totals', cells: (value as { totals: ReportCell[] }).totals };
  }
  throw internalFailure();
}

/**
 * Up to `max` lines of `rows.ndjson` from byte `from`, never past byte `end` (the length the rows phase recorded), and
 * the offset after the last one read.
 *
 * @throws ExportRunFailure `internal` when the file is shorter than `end` or a line is not one the rows phase wrote
 */
export async function readEntries(path: DataPath, from: number, end: number, max: number): Promise<{ entries: NdjsonEntry[]; next: number }> {
  const entries: NdjsonEntry[] = [];
  let next = from;
  if (from >= end || max <= 0) return { entries, next };
  const handle = await openRead(path);
  try {
    let position = from;
    let carry: Buffer = Buffer.alloc(0);
    while (entries.length < max && position < end) {
      const length = Math.min(READ_CHUNK, end - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) throw internalFailure();
      position += bytesRead;
      const data = carry.byteLength === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      let start = 0;
      while (entries.length < max) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        entries.push(parseLine(data.toString('utf8', start, newline)));
        start = newline + 1;
      }
      next += start;
      carry = Buffer.from(data.subarray(start));
    }
    if (entries.length < max && next < end) throw internalFailure();
    return { entries, next };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Appends every byte of `bytes` to `handle`. */
export async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) written += (await handle.write(bytes, written, bytes.byteLength - written)).bytesWritten;
}

/** The rows phase of one slice: `rows.ndjson` open for appending at the checkpoint's length. */
export class RowsPhase {
  private handle: FileHandle | null = null;

  private constructor(
    private readonly run: ExportRun,
    private readonly def: TableReport,
    private state: RowsState,
    private readonly width: number,
  ) {}

  /**
   * The rows phase at `state`: `rows.ndjson` cut back to the length the checkpoint recorded. Null when the file is
   * shorter than that (it was lost): the run starts its rows over.
   */
  static async open(run: ExportRun, state: RowsState): Promise<RowsPhase | null> {
    if (run.def.kind !== 'table') throw new TypeError('RowsPhase: a table report only');
    const path = workFile(run, 'rows.ndjson');
    const info = await statOrNull(path);
    if (state.bytes > 0 && (info === null || info.kind !== 'file' || info.size < state.bytes)) return null;
    if (info !== null && info.kind === 'file' && info.size > state.bytes) await truncateFile(path, state.bytes);
    return new RowsPhase(run, run.def, { ...state }, runColumns(run).length);
  }

  get current(): RowsState {
    return { ...this.state };
  }

  /**
   * One batch from `cursor`: its rows appended, the count held to the format's limit. Answers the next cursor, or
   * null once the report has no more rows (the totals row is then written).
   *
   * @throws ExportRunFailure `REPORT_TOO_LARGE` over the format's limit; `internal` for an answer the export cannot hold
   */
  async step(cursor: string | null): Promise<string | null> {
    const answer: unknown = await this.def.rows(this.run.report, cursor, ROWS_BATCH);
    if (typeof answer !== 'object' || answer === null) throw internalFailure();
    const { rows, nextCursor } = answer as { rows?: unknown; nextCursor?: unknown };
    if (!Array.isArray(rows) || (nextCursor !== null && typeof nextCursor !== 'string')) throw internalFailure();
    if (rows.length > 0) {
      const total = this.state.rows + rows.length;
      const max = ROW_LIMITS[this.run.format];
      if (max !== undefined && total > max) {
        throw new ExportRunFailure('REPORT_TOO_LARGE', `REPORT_TOO_LARGE rows=${total} max=${max} format=${this.run.format}`);
      }
      const text = (rows as unknown[]).map((row) => `${JSON.stringify(checkedRow(row, this.width))}\n`).join('');
      await this.append(text);
      this.state = { ...this.state, rows: total };
    }
    if (nextCursor !== null) {
      // A cursor that does not move with no rows would ask for the same page for ever.
      if (nextCursor.length > REPORT_EXPORT_CURSOR_MAX || (rows.length === 0 && nextCursor === cursor)) throw internalFailure();
      return nextCursor;
    }
    const totals: ReportRow | null | undefined = this.def.totals === undefined ? null : await this.def.totals(this.run.report);
    if (totals !== null && totals !== undefined) await this.append(`${JSON.stringify({ totals: checkedRow(totals, this.width) })}\n`);
    return null;
  }

  /** Flushes `rows.ndjson` and closes it: its length is then the state's. */
  async close(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (handle === null) return;
    try {
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async append(text: string): Promise<void> {
    const bytes = Buffer.from(text, 'utf8');
    this.handle ??= await openAppend(workFile(this.run, 'rows.ndjson'));
    await writeAll(this.handle, bytes);
    this.state = { ...this.state, bytes: this.state.bytes + bytes.byteLength };
  }
}
