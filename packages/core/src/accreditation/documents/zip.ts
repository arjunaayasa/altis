import { crc32 } from 'node:zlib';
import type { DB } from '@altis/db';
import { openRead, removeFile, reportWorkPath, statOrNull, writeBytesAtomic, type DataPath } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { REPORT_PDF_MAX_ROWS, REPORT_ZIP_MAX_BYTES, REPORT_ZIP_MAX_ENTRIES } from '@altis/shared/api/reports';
import type { FileHandle } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { openZipWriter, ZipLimitError, zipWriterCheckpointSchema, type ZipWriter, type ZipWriterCheckpoint } from '../../archive/zip-writer.js';
import { ExportRunFailure } from '../../reports/export/state.js';
import type { DocumentCtx, DocumentStep } from '../../reports/types.js';
import { evidenceReportParams } from '../instruments/shared.js';
import { catalogueCode } from '../scoring/score.js';
import { PREREQUISITES_CODE, PROFILE_CODE, PROFILE_PHOTO_SLOTS } from '../evidence/checklist.js';
import { annexHeading, annexPlan } from './annex-sections.js';
import { COLLECT_START, collectRows, columnsOf, documentLayout, msg, printReportTable, readCollected, tableReport, type DocPeriod } from './data.js';
import { reportTitle, sheetItems } from './ik-sheets.js';
import {
  annexEntryName,
  componentZipName,
  counterText,
  DOSSIER_ENTRY,
  extensionOf,
  sheetEntryName,
  slugOf,
  ZIP_FOLDERS,
  type ZipFolderCode,
} from './names.js';
import type { ComposedResults } from '../evaluate/compose.js';
import { PROFILE } from './texts.js';

// The evidence ZIP of a period (spec §10.9), written across slices through the shared resumable ZIP writer, every
// entry stored with its size and CRC-32 in its local header (so a strict streaming reader accepts it), within
// 5 000 entries and 2 GiB.
//
// - Combined (`zipMode: 'combined'`): `00-berkas-bukti.pdf`, then one folder per component (`K-koleksi/` …
//   `G-pengelolaan/`) with the indicators' evidence in sheet order — each uploaded file, and each generated list as a
//   PDF built from its report's rows — then `profil/` (the profile's photos, the prerequisite copies and the period's
//   other files). Entries are `<official number>-<nn>-<slug>.<ext>`, `nn` counting per indicator.
// - Per component (`zipMode: 'components'`): one ZIP per component (`K-koleksi.zip` … `G-pengelolaan.zip`,
//   `profil.zip`) inside the outer ZIP, each holding `00-lembar-<folder>.pdf` (that component's indicator sheets; the
//   profile form for `profil`) and its files. Each inner ZIP is written to `component-<code>.zip` in the run's work
//   folder first, then stored in the outer one.
// - The statistics mode: `00-berkas-bukti.pdf`, `profil/`, and `lampiran/` with each register list and statistical
//   annex as a PDF.
//
// A generated list longer than a PDF holds (10 000 rows) is left out with the warning `generated_too_large:<item>`;
// a component whose files pass `accreditation.evidence.componentLimitMb` gets `component_over_limit:<code>:<bytes>`; a
// stored file that is gone gets `file_missing:<file id>`. The archive passing its bounds while it is written ends the
// run REPORT_TOO_LARGE.
//
// The work is a list of units in a fixed order (each with a sortable key); the state keeps the key of the last unit
// done and the progress of the current one (its CRC pass, then its copy, both by byte offset; for a generated list,
// gathering its rows and building its PDF first), so a slice can stop between any two writes and the next goes on
// from the writers' checkpoints. The current unit carries everything it needs, so it is finished even when the
// period's evidence changed between slices.

/** How the evidence ZIP is cut. */
export type ZipMode = 'combined' | 'components';

/** Read and written per step. */
const CHUNK = 1024 * 1024;

/** The budget a slice keeps when it stops between writes. */
const MARGIN_MS = 3_000;

/** A PDF of a generated list is begun only with this much budget left (unless nothing ran yet in the slice). */
const PDF_MIN_MS = 8_000;

/** A component's work files: its ZIP and that ZIP's central directory. */
const componentFile = (ctx: DocumentCtx, code: ZipFolderCode, ext: 'zip' | 'central'): DataPath =>
  reportWorkPath(ctx.dataDir, ctx.runId, `component-${code}.${ext}`);

/** The work file of the first generated list's PDF: the sheets of the components take entry-1 … entry-7. */
const FIRST_LIST_PDF = 8;
/** The last work file number a generated list may take. */
const LAST_LIST_PDF = 9_999;

/** The folders of a school instrument's components, in order; then the profile, then the statistics annex. */
const COMPONENT_CODES = ['K', 'SP', 'L', 'T', 'F', 'G'] as const;
const PROFILE_INDEX = 7;
const ANNEX_INDEX = 8;

/** The label of each profile photo item (the slug of a photo without a caption). */
const PHOTO_LABELS: Readonly<Record<string, string>> = Object.freeze({
  photo_front: PROFILE.photoFront,
  photo_collection: PROFILE.photoCollection,
  photo_staff: PROFILE.photoStaff,
  photo_reading_room: PROFILE.photoReadingRoom,
});

/** The folder code of a unit's component index (1-based). */
function folderOf(index: number): ZipFolderCode {
  if (index >= 1 && index <= 6) return COMPONENT_CODES[index - 1]!;
  return index === PROFILE_INDEX ? 'profil' : 'lampiran';
}

/** The sheet PDF of component index `index` in the components mode (`entry-<index>.pdf`). */
export function sheetWorkName(index: number): string {
  return `entry-${index}.pdf`;
}

/** One unit of work. */
export interface ZipUnit {
  key: string;
  kind: 'work' | 'file' | 'generated' | 'close';
  writer: 'outer' | 'inner';
  folder: ZipFolderCode | 'root';
  /** The entry name without its counter for a numbered unit (`{n}` stands for it), else the full name. */
  name: string;
  /** The counter group of a numbered unit (an indicator, `profil`, `prasyarat`, `lain`, `lampiran`), else null. */
  group: string | null;
  /** The warning code part of a generated list. */
  label: string;
  /** What is copied: `file:<id>` or `work:<name>` (a generated list's own PDF); empty for a component's ZIP. */
  source: string;
  /** The size used by the estimate: a file's stored size; one mebibyte for a generated PDF. */
  estimate: number;
  report: { id: string; params: Record<string, unknown> } | null;
  /** The heading of a generated list's PDF. */
  title: string;
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** An evidence row with its file. */
interface EvidenceFile {
  id: string;
  indicator_code: string | null;
  evidence_code: string | null;
  file_id: string;
  caption: string;
  sort_order: number;
  created_at: number;
  original_name: string;
  mime: string;
  size: number;
}

async function evidenceFiles(db: Kysely<DB>, periodId: string): Promise<EvidenceFile[]> {
  const rows = await db
    .selectFrom('accred_evidence as e')
    .innerJoin('files as f', 'f.id', 'e.file_id')
    .select(['e.id', 'e.indicator_code', 'e.evidence_code', 'e.file_id', 'e.caption', 'e.sort_order', 'e.created_at', 'f.original_name', 'f.mime', 'f.size'])
    .where('e.period_id', '=', periodId)
    .execute();
  return rows.map((r) => ({ ...r, sort_order: Number(r.sort_order), created_at: Number(r.created_at), size: Number(r.size) }));
}

/** The sortable key part of a file: its sort order, its creation, its id. */
const fileKey = (f: EvidenceFile): string => `${pad(f.sort_order + 2 ** 31, 11)}.${pad(f.created_at, 15)}.${f.id}`;

/** The entry name of a numbered unit in `mode`: inside its folder (combined) or at the root of its component's ZIP. */
function numberedName(mode: ZipMode, folder: ZipFolderCode, base: string): string {
  return mode === 'combined' ? `${ZIP_FOLDERS[folder]}/${base}` : base;
}

/** Results without values: the sheets' order is all the units read of them. */
const NO_RESULTS: ComposedResults = Object.freeze({ prerequisites: null, indicators: [], snp: [], score: null, missingEvidence: [] });

/** The units of the evidence ZIP of `p` in `mode`, in order. The statistics mode always writes the combined layout. */
export async function zipUnits(db: Kysely<DB>, p: DocPeriod, mode: ZipMode): Promise<ZipUnit[]> {
  const files = await evidenceFiles(db, p.id);
  const units: ZipUnit[] = [];
  const components = mode === 'components' && p.school;
  const writer = components ? 'inner' : 'outer';
  if (!components) {
    units.push({ key: '00', kind: 'work', writer: 'outer', folder: 'root', name: DOSSIER_ENTRY, group: null, label: '', source: 'work:dossier.pdf', estimate: CHUNK, report: null, title: '' });
  }
  const sheetAndClose = (index: number): void => {
    if (!components) return;
    const folder = folderOf(index);
    const cc = pad(index, 2);
    units.push({ key: `${cc}.0`, kind: 'work', writer: 'inner', folder, name: sheetEntryName(folder), group: null, label: '', source: `work:${sheetWorkName(index)}`, estimate: CHUNK, report: null, title: '' });
    units.push({ key: `${cc}.9`, kind: 'close', writer: 'outer', folder, name: componentZipName(folder), group: null, label: '', source: '', estimate: 0, report: null, title: '' });
  };

  // Files by indicator and item.
  const byIndicator = new Map<string, EvidenceFile[]>();
  for (const f of files) {
    const key = f.indicator_code ?? '';
    const list = byIndicator.get(key) ?? [];
    list.push(f);
    byIndicator.set(key, list);
  }
  const known = new Set<string>();
  const items = p.school ? sheetItems(p.instrument, NO_RESULTS) : [];
  let indicatorIndex = 0;
  let lastComponent: string | null = null;
  for (const s of items) {
    const index = COMPONENT_CODES.indexOf(s.component.code) + 1;
    if (lastComponent !== s.component.code) {
      sheetAndClose(index);
      lastComponent = s.component.code;
      indicatorIndex = 0;
    }
    indicatorIndex += 1;
    const folder = folderOf(index);
    const code = catalogueCode(s.indicator);
    known.add(code);
    const prefix = s.indicator.officialNo;
    const base = `${pad(index, 2)}.1.${pad(indicatorIndex, 3)}`;
    const own = byIndicator.get(code) ?? [];
    s.indicator.evidence.forEach((item, e) => {
      const itemKey = `${base}.${pad(e, 3)}`;
      if (item.kind === 'generated' && item.reportId !== undefined) {
        units.push({
          key: `${itemKey}.`,
          kind: 'generated',
          writer,
          folder,
          name: numberedName(mode, folder, `${prefix}-{n}-${slugOf(msg(item.labelKey))}.pdf`),
          group: code,
          label: `${prefix}.${item.code}`,
          source: '',
          estimate: CHUNK,
          report: { id: item.reportId, params: evidenceReportParams(item, { periodId: p.id, D: p.D }) },
          title: `${prefix} · ${msg(item.labelKey)}`,
        });
      }
      for (const f of own.filter((x) => x.evidence_code === item.code)) units.push(fileUnit(mode, folder, code, prefix, `${itemKey}.${fileKey(f)}`, f, msg(item.labelKey), writer));
    });
    const codes = new Set(s.indicator.evidence.map((i) => i.code));
    for (const f of own.filter((x) => x.evidence_code === null || !codes.has(x.evidence_code))) {
      units.push(fileUnit(mode, folder, code, prefix, `${base}.999.${fileKey(f)}`, f, msg(s.indicator.labelKey), writer));
    }
  }
  if (components) {
    // A component without indicators in this instrument still gets its sheet and its ZIP.
    for (let i = 1; i <= 6; i += 1) if (!units.some((u) => u.key === `${pad(i, 2)}.0`)) sheetAndClose(i);
  }

  // The profile folder: the photos in slot order, the prerequisite copies, the period's other files.
  sheetAndClose(PROFILE_INDEX);
  const cc = pad(PROFILE_INDEX, 2);
  const photoOrder = Object.keys(PROFILE_PHOTO_SLOTS);
  const rest: { f: EvidenceFile; group: string; e: number; label: string }[] = [];
  for (const [indicator, list] of byIndicator) {
    if (known.has(indicator)) continue;
    for (const f of list) {
      if (indicator === PROFILE_CODE) {
        const e = f.evidence_code === null ? photoOrder.length : Math.max(0, photoOrder.indexOf(f.evidence_code));
        rest.push({ f, group: 'profil', e, label: f.evidence_code === null ? '' : (PHOTO_LABELS[f.evidence_code] ?? '') });
      } else if (indicator === PREREQUISITES_CODE) rest.push({ f, group: 'prasyarat', e: 10, label: '' });
      else rest.push({ f, group: 'lain', e: 20, label: '' });
    }
  }
  for (const r of rest) units.push(fileUnit(mode, 'profil', r.group, r.group, `${cc}.1.000.${pad(r.e, 3)}.${fileKey(r.f)}`, r.f, r.label, writer));

  // The statistics mode's annex lists.
  if (!p.school) {
    annexPlan(p).forEach((spec, i) => {
      const heading = annexHeading(spec);
      units.push({
        key: `${pad(ANNEX_INDEX, 2)}.1.${pad(i + 1, 3)}.`,
        kind: 'generated',
        writer: 'outer',
        folder: 'lampiran',
        name: annexEntryName(i + 1, slugOf(heading)),
        group: null,
        label: `lampiran-${counterText(i + 1)}`,
        source: '',
        estimate: CHUNK,
        report: { id: spec.reportId, params: spec.params },
        title: heading,
      });
    });
  }
  units.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // Each generated list gets a PDF work file of its own (the instrument and the annex plan fix their order), so one
  // list's file is never overwritten by the next while it may still be copied after a stopped slice.
  let pdf = FIRST_LIST_PDF;
  for (const u of units) {
    if (u.kind !== 'generated') continue;
    if (pdf > LAST_LIST_PDF) throw new ExportRunFailure('internal');
    u.source = `work:entry-${pdf}.pdf`;
    pdf += 1;
  }
  return units;
}

/** A unit copying an evidence file. */
function fileUnit(mode: ZipMode, folder: ZipFolderCode, group: string, prefix: string, key: string, f: EvidenceFile, fallback: string, writer: 'outer' | 'inner'): ZipUnit {
  const caption = f.caption.trim();
  const slug = slugOf(caption !== '' ? caption : fallback !== '' ? fallback : f.original_name.replace(/\.[^.]*$/, ''));
  return {
    key,
    kind: 'file',
    writer,
    folder,
    name: numberedName(mode, folder, `${prefix}-{n}-${slug}.${extensionOf(f.original_name, f.mime)}`),
    group,
    label: '',
    source: `file:${f.file_id}`,
    estimate: f.size,
    report: null,
    title: '',
  };
}

/** What a ZIP of `units` would hold: its entries (every archive's) and its bytes. */
export function zipEstimate(units: readonly ZipUnit[]): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  for (const u of units) {
    entries += 1;
    bytes += u.estimate;
  }
  return { entries, bytes };
}

/**
 * The refusal of a ZIP over its bounds at the start of a run.
 */
export function zipTooLarge(limit: 'entries' | 'bytes', value: number): DomainError {
  const max = limit === 'entries' ? REPORT_ZIP_MAX_ENTRIES : REPORT_ZIP_MAX_BYTES;
  return new DomainError('REPORT_TOO_LARGE', {
    detail:
      limit === 'entries'
        ? `ZIP ini akan berisi ${value} berkas; paling banyak ${max} / This ZIP would hold ${value} entries; at most ${max}`
        : `ZIP ini akan berukuran ${value} bita; paling besar ${max} / This ZIP would be ${value} bytes; at most ${max}`,
    meta: { rows: value, max, format: 'zip', limit },
  });
}

// ---- the state -----------------------------------------------------------------------------------------------------

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const collectSchema = z.strictObject({ cursor: z.string().max(32_000).nullable(), bytes: count, rows: count });

const unitSchema = z.strictObject({
  key: z.string().max(200),
  kind: z.enum(['work', 'file', 'generated', 'close']),
  writer: z.enum(['outer', 'inner']),
  folder: z.string().max(16),
  name: z.string().max(1_024),
  numbered: z.boolean(),
  label: z.string().max(64),
  source: z.string().max(64),
  report: z.strictObject({ id: z.string().max(64), params: z.record(z.string(), z.unknown()) }).nullable(),
  title: z.string().max(600),
  step: z.enum(['rows', 'pdf', 'finish', 'crc', 'copy']),
  collect: collectSchema,
  at: count,
  crc: count,
  size: count,
  open: z.boolean(),
});

type UnitState = z.infer<typeof unitSchema>;

/** Where a ZIP is. */
export const zipStateSchema = z.strictObject({
  mode: z.enum(['combined', 'components']),
  /** The key of the last unit done. */
  done: z.string().max(200).nullable(),
  /** The counter group of the last numbered entry, and how many entries it numbered. */
  group: z.string().max(32).nullable(),
  n: count,
  outer: zipWriterCheckpointSchema.nullable(),
  inner: zipWriterCheckpointSchema.nullable(),
  /** The component the inner ZIP is being written for. */
  innerOf: z.string().max(16).nullable(),
  unit: unitSchema.nullable(),
  /** The bytes written per component folder (combined layout). */
  sizes: z.record(z.string(), count),
  entries: count,
  warnings: z.array(z.string().max(64)).max(40),
});

export type ZipState = z.infer<typeof zipStateSchema>;

/** The start of a ZIP. */
export function zipStart(mode: ZipMode): ZipState {
  return { mode, done: null, group: null, n: 0, outer: null, inner: null, innerOf: null, unit: null, sizes: {}, entries: 0, warnings: [] };
}

/** A ZIP that passed its bounds while being written: the run ends REPORT_TOO_LARGE. */
function tooLarge(e: ZipLimitError): ExportRunFailure {
  return new ExportRunFailure('REPORT_TOO_LARGE', `REPORT_TOO_LARGE rows=${e.value} max=${e.max} format=zip limit=${e.kind}`);
}

const warn = (st: ZipState, code: string): void => {
  if (!st.warnings.includes(code) && st.warnings.length < 40) st.warnings.push(code);
};

// ---- the writing -----------------------------------------------------------------------------------------------------

/** A builder of a generated list's PDF from its rows. */
export type ListPdf = (unit: UnitState, rows: readonly (readonly (string | number | null)[])[]) => Uint8Array;

/** The open writers of one slice. */
class Writers {
  outer: ZipWriter | null = null;
  inner: ZipWriter | null = null;

  constructor(
    private readonly ctx: DocumentCtx,
    private readonly st: ZipState,
  ) {}

  async outerWriter(): Promise<ZipWriter> {
    this.outer ??= await openZipWriter(reportWorkPath(this.ctx.dataDir, this.ctx.runId, 'output.part'), reportWorkPath(this.ctx.dataDir, this.ctx.runId, 'output.central'), {
      checkpoint: this.st.outer,
      maxEntries: REPORT_ZIP_MAX_ENTRIES,
      maxBytes: REPORT_ZIP_MAX_BYTES,
    });
    return this.outer;
  }

  async innerWriter(folder: ZipFolderCode): Promise<ZipWriter> {
    if (this.inner !== null && this.st.innerOf === folder) return this.inner;
    const checkpoint: ZipWriterCheckpoint | null = this.st.innerOf === folder ? this.st.inner : null;
    this.inner = await openZipWriter(componentFile(this.ctx, folder, 'zip'), componentFile(this.ctx, folder, 'central'), {
      checkpoint,
      maxEntries: REPORT_ZIP_MAX_ENTRIES,
      maxBytes: REPORT_ZIP_MAX_BYTES,
    });
    this.st.innerOf = folder;
    if (checkpoint === null) this.st.inner = null;
    return this.inner;
  }

  /** Every open writer's checkpoint into the state. */
  async checkpoint(): Promise<void> {
    if (this.outer !== null) this.st.outer = await this.outer.checkpoint();
    if (this.inner !== null) this.st.inner = await this.inner.checkpoint();
  }
}

/** The state of a unit about to begin. */
function begin(u: ZipUnit, st: ZipState): UnitState {
  let name = u.name;
  const numbered = u.group !== null;
  if (numbered) {
    if (st.group !== u.group) {
      st.group = u.group;
      st.n = 0;
    }
    name = u.name.replace('{n}', counterText(st.n + 1));
  }
  const step: UnitState['step'] = u.kind === 'generated' ? 'rows' : u.kind === 'close' ? 'finish' : 'crc';
  return {
    key: u.key,
    kind: u.kind,
    writer: u.writer,
    folder: u.folder,
    name,
    numbered,
    label: u.label,
    source: u.source,
    report: u.report,
    title: u.title,
    step,
    collect: { ...COLLECT_START },
    at: 0,
    crc: 0,
    size: 0,
    open: false,
  };
}

/** Reads `[from, from + length)` of a unit's source. */
class Source {
  private handle: FileHandle | null = null;

  constructor(
    private readonly ctx: DocumentCtx,
    private readonly source: string,
  ) {}

  /** The size of the source, or null when it is gone. */
  async size(): Promise<number | null> {
    if (this.source.startsWith('file:')) return (await this.ctx.storage.stat(this.source.slice(5)))?.size ?? null;
    const info = await statOrNull(this.workPath());
    return info === null || info.kind !== 'file' ? null : info.size;
  }

  private workPath(): DataPath {
    return reportWorkPath(this.ctx.dataDir, this.ctx.runId, this.source.slice(5));
  }

  async read(from: number, length: number): Promise<Buffer> {
    if (this.source.startsWith('file:')) {
      const stream = await this.ctx.storage.get(this.source.slice(5), { start: from, end: from + length - 1 });
      if (stream === null) throw new ExportRunFailure('internal');
      const parts: Buffer[] = [];
      for await (const chunk of stream) parts.push(Buffer.from(chunk));
      const out = Buffer.concat(parts);
      if (out.byteLength !== length) throw new ExportRunFailure('internal');
      return out;
    }
    this.handle ??= await openRead(this.workPath());
    const buf = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buf, 0, length, from);
    if (bytesRead !== length) throw new ExportRunFailure('internal');
    return buf;
  }

  async close(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
    this.handle = null;
  }
}

/**
 * Removes the work files of the units done before this slice (their entries are in the archives the state's checkpoints
 * hold): the evidence file PDF, the sheets' and lists' PDFs, the components' ZIPs. A file is kept while its unit may
 * still have to be copied again from the state a slice starts with.
 */
async function removeDoneWork(ctx: DocumentCtx, units: readonly ZipUnit[], done: string | null): Promise<void> {
  if (done === null) return;
  for (const u of units) {
    if (u.key > done) break;
    if (u.source.startsWith('work:')) await removeFile(reportWorkPath(ctx.dataDir, ctx.runId, u.source.slice(5)));
    if (u.kind === 'close') {
      await removeFile(componentFile(ctx, u.folder as ZipFolderCode, 'zip'));
      await removeFile(componentFile(ctx, u.folder as ZipFolderCode, 'central'));
    }
  }
}

/**
 * One slice of the ZIP: goes on from `st` through `units` until every unit is done (then the archive is finished) or
 * the slice's budget runs low (then the writers' checkpoints are kept in the state).
 *
 * @throws ExportRunFailure REPORT_TOO_LARGE when an archive passes 5 000 entries or 2 GiB
 */
export async function writeZip(
  ctx: DocumentCtx,
  units: readonly ZipUnit[],
  st: ZipState,
  listPdf: ListPdf,
): Promise<Extract<DocumentStep, { done: true }> | { done: false; state: ZipState }> {
  const w = new Writers(ctx, st);
  const slice = { worked: false };
  const low = (): boolean => ctx.budgetLeftMs() < MARGIN_MS;
  const pause = async (): Promise<{ done: false; state: ZipState }> => {
    await w.checkpoint();
    return { done: false, state: st };
  };
  try {
    await removeDoneWork(ctx, units, st.done);
    const queue = units.filter((u) => (st.done === null || u.key > st.done) && (st.unit === null || u.key > st.unit.key));
    for (;;) {
      if (st.unit === null) {
        const next = queue.shift();
        if (next === undefined) break;
        st.unit = begin(next, st);
      }
      const u = st.unit;
      const r = await runUnit(ctx, w, st, u, { low, slice, listPdf });
      if (r === 'paused') return await pause();
      if (r === 'done' && u.numbered) st.n += 1;
      st.done = u.key;
      st.unit = null;
      if (low() && queue.length > 0) return await pause();
    }
    const limit = ctx.settings.componentLimitMb * 1024 * 1024;
    if (st.mode === 'combined') {
      for (const code of [...COMPONENT_CODES, 'profil'] as const) {
        const bytes = st.sizes[code] ?? 0;
        if (bytes > limit) warn(st, `component_over_limit:${code}:${bytes}`);
      }
    }
    const outer = await w.outerWriter();
    await outer.finish();
    return { done: true, rowCount: st.entries, nonLatinRows: 0, warnings: st.warnings };
  } catch (error) {
    if (error instanceof ZipLimitError) throw tooLarge(error);
    throw error;
  }
}

/** Runs unit `u` on: done (an entry written), skipped (nothing written), or paused. */
async function runUnit(
  ctx: DocumentCtx,
  w: Writers,
  st: ZipState,
  u: UnitState,
  o: { low: () => boolean; slice: { worked: boolean }; listPdf: ListPdf },
): Promise<'done' | 'skipped' | 'paused'> {
  const rowsFile = reportWorkPath(ctx.dataDir, ctx.runId, 'rows.ndjson');
  if (u.step === 'rows') {
    // `rows.ndjson` is shared by the lists: a list starts gathering only once the state that holds the previous list
    // as done is kept, that is at the start of a slice.
    if (u.collect.cursor === null && u.collect.bytes === 0 && o.slice.worked) return 'paused';
    const def = tableReport(u.report!.id);
    const r = await collectRows(ctx, def, u.report!.params, rowsFile, u.collect, { tag: 0, max: REPORT_PDF_MAX_ROWS });
    u.collect = r.state;
    o.slice.worked = true;
    if (!r.done) return 'paused';
    if (r.state.rows > REPORT_PDF_MAX_ROWS) {
      warn(st, `generated_too_large:${u.label}`);
      return 'skipped';
    }
    u.step = 'pdf';
  }
  if (u.step === 'pdf') {
    if (o.slice.worked && ctx.budgetLeftMs() < PDF_MIN_MS) return 'paused';
    o.slice.worked = true;
    const rows = (await readCollected(rowsFile, u.collect.bytes)).get(0) ?? [];
    await writeBytesAtomic(reportWorkPath(ctx.dataDir, ctx.runId, u.source.slice(5)), o.listPdf(u, rows));
    u.step = 'crc';
  }
  if (u.step === 'finish') {
    const folder = u.folder as ZipFolderCode;
    const inner = await w.innerWriter(folder);
    const { size } = await inner.finish();
    o.slice.worked = true;
    w.inner = null;
    st.inner = null;
    st.innerOf = null;
    if (folder !== 'lampiran' && size > ctx.settings.componentLimitMb * 1024 * 1024) warn(st, `component_over_limit:${folder}:${size}`);
    u.source = `work:component-${folder}.zip`;
    u.step = 'crc';
  }
  const src = new Source(ctx, u.source);
  try {
    if (u.step === 'crc') {
      const size = await src.size();
      if (size === null) {
        if (u.kind === 'file') {
          warn(st, `file_missing:${u.source.slice(5)}`);
          return 'skipped';
        }
        throw new ExportRunFailure('internal');
      }
      if (u.at === 0) u.size = size;
      while (u.at < u.size) {
        if (o.slice.worked && o.low()) return 'paused';
        const n = Math.min(CHUNK, u.size - u.at);
        u.crc = crc32(await src.read(u.at, n), u.crc);
        u.at += n;
        o.slice.worked = true;
      }
      u.step = 'copy';
      u.at = 0;
    }
    const writer = u.writer === 'outer' ? await w.outerWriter() : await w.innerWriter(u.folder as ZipFolderCode);
    if (!u.open) {
      await writer.beginEntry(u.name, { method: 0, size: u.size, crc32: u.crc });
      u.open = true;
    }
    while (u.at < u.size) {
      if (o.slice.worked && o.low()) return 'paused';
      const n = Math.min(CHUNK, u.size - u.at);
      await writer.write(await src.read(u.at, n));
      u.at += n;
      o.slice.worked = true;
    }
    await writer.endEntry();
    st.entries += 1;
    if (st.mode === 'combined' && u.folder !== 'root') st.sizes[u.folder] = (st.sizes[u.folder] ?? 0) + u.size;
    return 'done';
  } finally {
    await src.close();
  }
}

/** The PDF of a generated list: its heading, its report's title, and the report's table. */
export function listPdfBuilder(ctx: DocumentCtx, p: DocPeriod): ListPdf {
  return (u, rows) => {
    const def = tableReport(u.report!.id);
    const layout = documentLayout(ctx, p, { title: u.title });
    layout.heading(u.title, 2);
    layout.paragraph(reportTitle(def.id), { size: 9 });
    const params = { ...u.report!.params };
    printReportTable(layout, columnsOf(def, def.paramsSchema.parse(params)), rows);
    return layout.toBytes();
  };
}
