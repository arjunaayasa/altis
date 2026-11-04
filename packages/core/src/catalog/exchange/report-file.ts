import { openAppend, readBytes, runWorkPath, statOrNull, truncateFile } from '@altis/platform';
import { RUN_REPORT_MAX_ROWS } from '../data/runs.js';

// The report rows of an import or export run while it runs (Phase 2 spec §5.3 "galat per baris (≤ 10.000 baris
// pertama)"; plan Task 31): appended to the run's work file `tmp/<runId>/report.csv`, one JSON array of strings per
// line (a line break inside a value never splits a row). At the end the rows are read back into the report file that
// writeRunReport stores (CSV through csvRow), followed by its `# truncated,<n>` line for the rows past the first
// 10 000, which this file never holds: the caller counts them (`reportDropped`) instead.
//
// The caller saves the file's length with the counters that cover its rows (the import: in the batch's transaction;
// the export: in its checkpoint), and cuts the file back to that length when a slice starts, so the rows of a slice that
// died before saving are written once, by its re-run.

/** One report row's cells, as written: at most this many characters each (codes, numbers and a cut title). */
const CELL_MAX = 1_000;
/** The work file holds at most the first RUN_REPORT_MAX_ROWS rows, each well below 8 KiB. */
const FILE_MAX_BYTES = RUN_REPORT_MAX_ROWS * 8 * 1024;

/** `row` as a line of the work file (with its line feed). */
export function reportLine(row: readonly string[]): string {
  return `${JSON.stringify(row.map((c) => (c.length > CELL_MAX ? c.slice(0, CELL_MAX) : c)))}\n`;
}

/**
 * Appends `lines` (from reportLine) to the run's work file, creating it and its folder when missing, and flushes it.
 *
 * @returns the file's length afterwards
 * @throws DomainError `DISK_QUOTA` (P21)
 */
export async function appendReportLines(dataDir: string, runId: string, lines: readonly string[]): Promise<number> {
  const handle = await openAppend(runWorkPath(dataDir, runId, 'report.csv'));
  try {
    if (lines.length > 0) {
      const bytes = Buffer.from(lines.join(''), 'utf8');
      let written = 0;
      while (written < bytes.byteLength) written += (await handle.write(bytes, written, bytes.byteLength - written)).bytesWritten;
      await handle.sync();
    }
    return (await handle.stat()).size;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Cuts the run's work file back to `bytes` (what the saved counters cover).
 *
 * @returns false when the file is shorter than that (its folder was lost): the rows it held are gone
 */
export async function truncateReportLines(dataDir: string, runId: string, bytes: number): Promise<boolean> {
  const p = runWorkPath(dataDir, runId, 'report.csv');
  const info = await statOrNull(p);
  if (info === null) return bytes === 0;
  if (info.kind !== 'file' || info.size < bytes) return false;
  if (info.size > bytes) await truncateFile(p, bytes);
  return true;
}

/**
 * The rows of the run's work file in order (none when it is missing), then `dropped` empty rows: writeRunReport counts
 * every row past its first 10 000 into its `# truncated,<n>` line, and the work file never holds them.
 */
export async function* reportRowsOf(dataDir: string, runId: string, dropped: number): AsyncGenerator<readonly string[]> {
  const p = runWorkPath(dataDir, runId, 'report.csv');
  if ((await statOrNull(p))?.kind === 'file') {
    const content = await readBytes(p, FILE_MAX_BYTES);
    if (content !== null) {
      for (const line of content.toString('utf8').split('\n')) {
        if (line === '') continue;
        let cells: unknown;
        try {
          cells = JSON.parse(line);
        } catch {
          continue; // a line a killed write cut short (the file is cut back before every slice)
        }
        if (Array.isArray(cells) && cells.every((c) => typeof c === 'string')) yield cells as string[];
      }
    }
  }
  const none: readonly string[] = [];
  for (let i = 0; i < dropped; i += 1) yield none;
}
