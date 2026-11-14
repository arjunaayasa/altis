import { statOrNull } from '@altis/platform';
import { REPORT_XLSX_MAX_ROWS } from '@altis/shared/api/reports';
import { t, type MessageKey } from '@altis/shared';
import { XlsxTooManyRowsError, openXlsxWriter, type XlsxWriter } from '../../export/xlsx.js';
import { ROWS_BATCH, readEntries, runColumns } from './rows-phase.js';
import { ExportRunFailure, workFile, type ExportRun, type WriteState } from './state.js';

// The write phase of an XLSX export (spec §4.15): the workbook is written by the resumable XLSX writer into
// `output.part` (its central directory in `output.central`), the rows of `rows.ndjson` appended 500 at a time to the
// one sheet (named after the report, the header in the run's language; numbers of `int`, `money` and `percent` columns
// as numbers, text as inline strings), the totals row last, and the archive closed once every line is in. The
// checkpoint holds how far `rows.ndjson` was read and the writer's own checkpoint; the next slice reopens the writer
// there, which cuts both files back to it.

/** The XLSX write phase of one slice. */
export class XlsxPhase {
  private writer: XlsxWriter | null = null;
  private finished = false;

  private constructor(
    private readonly run: ExportRun,
    private state: WriteState,
  ) {}

  /**
   * The XLSX write at `state`: the workbook reopened at the writer's checkpoint, or begun again when a file is shorter
   * than the checkpoint says (it was lost).
   */
  static async open(run: ExportRun, state: WriteState): Promise<XlsxPhase> {
    let at = state;
    if (state.xlsx !== null) {
      const part = await statOrNull(workFile(run, 'output.part'));
      const central = await statOrNull(workFile(run, 'output.central'));
      const lost = (info: typeof part, length: number) => (info === null ? length > 0 : info.kind !== 'file' || info.size < length);
      if (lost(part, state.xlsx.zip.offset) || lost(central, state.xlsx.zip.centralBytes)) at = { ...state, offset: 0, xlsx: null };
    } else {
      at = { ...state, offset: 0 };
    }
    return new XlsxPhase(run, { ...at });
  }

  get current(): WriteState {
    return { ...this.state };
  }

  /**
   * Appends the next rows; once every line of `rows.ndjson` is in, closes the workbook and answers its size.
   *
   * @throws ExportRunFailure `REPORT_TOO_LARGE` when the sheet would pass its limit
   */
  async step(): Promise<{ done: false } | { done: true; size: number }> {
    const writer = await this.open();
    const { entries, next } = await readEntries(workFile(this.run, 'rows.ndjson'), this.state.offset, this.state.ndjsonBytes, ROWS_BATCH);
    try {
      await writer.appendRows(entries.map((e) => e.cells));
    } catch (error) {
      if (error instanceof XlsxTooManyRowsError) {
        throw new ExportRunFailure('REPORT_TOO_LARGE', `REPORT_TOO_LARGE rows=${error.rows} max=${REPORT_XLSX_MAX_ROWS} format=xlsx`);
      }
      throw error;
    }
    this.state = { ...this.state, offset: next };
    if (next < this.state.ndjsonBytes) return { done: false };
    const { size } = await writer.finish();
    this.finished = true;
    return { done: true, size };
  }

  /** The writer's checkpoint (after fsync) in the state, unless the workbook is finished. */
  async close(): Promise<void> {
    const writer = this.writer;
    this.writer = null;
    if (writer === null || this.finished) return;
    this.state = { ...this.state, xlsx: await writer.checkpoint() };
  }

  private async open(): Promise<XlsxWriter> {
    if (this.writer !== null) return this.writer;
    const columns = runColumns(this.run).map((c) => ({
      header: t(this.run.locale, c.labelKey as MessageKey),
      type: c.type,
      ...(c.widthChars === undefined ? {} : { widthChars: c.widthChars }),
    }));
    this.writer = await openXlsxWriter(workFile(this.run, 'output.part'), workFile(this.run, 'output.central'), {
      columns,
      sheetName: t(this.run.locale, this.run.def.titleKey as MessageKey),
      checkpoint: this.state.xlsx,
      // The data rows were held to the limit in the rows phase; the totals row comes on top of them.
      maxRows: REPORT_XLSX_MAX_ROWS + 1,
    });
    return this.writer;
  }
}
