import type { FileHandle } from 'node:fs/promises';
import { openAppend, statOrNull, truncateFile } from '@altis/platform';
import { t, type MessageKey } from '@altis/shared';
import { CSV_BOM, csvRow } from '../../export/csv.js';
import { ROWS_BATCH, readEntries, runColumns, writeAll } from './rows-phase.js';
import { workFile, type ExportRun, type WriteState } from './state.js';

// The write phase of a CSV export (spec §4.15, main spec §7.4: the one CSV exporter): `output.part` starts with the
// byte order mark and the header (the column labels in the run's language), then the rows of `rows.ndjson` are
// appended 500 at a time through csvRow (every cell quoted, formula-like text guarded; money stays a plain number),
// the totals row last. The checkpoint holds how far `rows.ndjson` was read and the length of `output.part`; the next
// slice cuts `output.part` back to that length.

/** The CSV delimiter of every export of the product. */
const DELIMITER = ',';

/** The CSV write phase of one slice. */
export class CsvPhase {
  private handle: FileHandle | null = null;

  private constructor(
    private readonly run: ExportRun,
    private state: WriteState,
  ) {}

  /**
   * The CSV write at `state`: `output.part` cut back to the checkpoint's length, or written from its start again when
   * it is shorter than that (it was lost).
   */
  static async open(run: ExportRun, state: WriteState): Promise<CsvPhase> {
    const part = workFile(run, 'output.part');
    const info = await statOrNull(part);
    let at = state;
    if (info === null || info.kind !== 'file' || info.size < state.outBytes) at = { ...state, offset: 0, outBytes: 0 };
    if (info !== null && info.kind === 'file' && info.size > at.outBytes) await truncateFile(part, at.outBytes);
    return new CsvPhase(run, { ...at });
  }

  get current(): WriteState {
    return { ...this.state };
  }

  /** Appends the next rows (the header first); true once every line of `rows.ndjson` is in `output.part`. */
  async step(): Promise<boolean> {
    const { entries, next } = await readEntries(workFile(this.run, 'rows.ndjson'), this.state.offset, this.state.ndjsonBytes, ROWS_BATCH);
    let text = '';
    if (this.state.outBytes === 0) {
      const header = runColumns(this.run).map((c) => t(this.run.locale, c.labelKey as MessageKey));
      text += CSV_BOM + csvRow(header, DELIMITER);
    }
    for (const entry of entries) text += csvRow(entry.cells, DELIMITER);
    if (text !== '') {
      const bytes = Buffer.from(text, 'utf8');
      this.handle ??= await openAppend(workFile(this.run, 'output.part'));
      await writeAll(this.handle, bytes);
      this.state = { ...this.state, outBytes: this.state.outBytes + bytes.byteLength };
    }
    this.state = { ...this.state, offset: next };
    return next >= this.state.ndjsonBytes;
  }

  /** Flushes `output.part` and closes it: its length is then the state's. */
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
}
