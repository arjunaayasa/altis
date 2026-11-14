import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { withTx } from '@altis/db';
import { reportExportPath } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import type { CompactSnapshot, NoteRef } from '@altis/shared/api/accreditation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { copySnapshotDossier, freezePeriod, getSnapshot, listSnapshots, openSnapshotDossier, unfreezePeriod } from '../../src/accreditation/evaluate/index.js';
import { sweepUnfinishedSnapshotCopies } from '../../src/accreditation/snapshots.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import type { StorageDriver } from '../../src/files/serve.js';
import { orphanUploadsReportsStep } from '../../src/reports/housekeeping/orphan-uploads.js';
import { ACCRED_METRICS, type AccredMetricId } from '../../src/accreditation/metric-ids.js';
import { putUsageCells } from '../../src/accreditation/usage/cells.js';
import { txCtx } from '../../src/context.js';
import { seedStockFixture } from '../support/stock-fixture.js';
import {
  PASSING,
  SEEDED_AT,
  SMA,
  answerAll,
  evaluateNow,
  fakeProviders,
  fakeValue,
  inTx,
  openAccredDb,
  seedPeriod,
  sqlCapture,
  type AccredDb,
} from './accred-results-support.js';

// The freeze of a period and its snapshots on the engine picked by ALTIS_TEST_DB:
// - a freeze of fresh results keeps a compact snapshot (values, final answers, notes, standards, prerequisites, the
//   missing evidence) with the estimate and its predicate, and nothing changed later alters it; a second freeze is
//   refused; results older than the last change (a deleted usage cell included) or gone (a restore empties them) are
//   refused as stale and the period stays open;
// - unfreezing opens the period again and keeps the snapshots; an open period cannot be unfrozen;
// - the first statement of both is their conditional update of the period row;
// - the compact values of the largest instrument with the most notes stay within 60 000 bytes;
// - the newest evidence file PDF of the whole dossier, finished after the results were computed, is copied for the
//   snapshot (a request letter alone never is); a copy that fails leaves nothing behind, and one killed on the way
//   leaves a row the reports housekeeping removes, with its content, a day later.

const ctx = testDbContext();

const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => 'resolved',
    (e: unknown) => (isDomainError(e) ? { code: e.code, meta: e.meta } : e),
  );

const silent = { info() {}, warn() {}, error() {} };

describe.skipIf(!ctx.available)(`accreditation freeze and snapshots [${engineLabel()}]`, () => {
  let db: AccredDb;

  beforeAll(async () => {
    db = await openAccredDb('accred-freeze');
  });

  afterAll(async () => {
    await db?.close();
  });

  const freeze = (periodId: string, note: string | null = null, now = Date.now()) => inTx(db, (tx) => freezePeriod(tx, periodId, { note }, now), now);
  const unfreeze = (periodId: string, now = Date.now()) => inTx(db, (tx) => unfreezePeriod(tx, periodId, now), now);
  const periodRow = (id: string) => db.h.db.selectFrom('accred_periods').select(['status', 'version', 'frozen_at', 'frozen_by']).where('id', '=', id).executeTakeFirstOrThrow();
  const computedAtOf = async (periodId: string): Promise<number> => {
    const r = await db.h.db.selectFrom('accred_results').select('payload').where('period_id', '=', periodId).where('indicator_code', '=', '_meta').executeTakeFirstOrThrow();
    return (JSON.parse(r.payload) as { computedAt: number }).computedAt;
  };
  const audits = (action: string, entityId: string) =>
    db.h.db.selectFrom('audit_log').select(['actor_id', 'entity', 'meta']).where('action', '=', action).where('entity_id', '=', entityId).execute();

  /** A school period of the upper secondary instrument, every indicator answered `a`, evaluated over the fakes. */
  async function answeredPeriod(): Promise<string> {
    const periodId = await seedPeriod(db);
    await answerAll(db, periodId, SMA, 'a');
    expect(await evaluateNow(db, periodId, fakeProviders())).toEqual(['succeeded']);
    return periodId;
  }

  it('a freeze of fresh results keeps the snapshot, which nothing changed later alters; a second freeze is refused', async () => {
    const periodId = await answeredPeriod();
    const r = await freeze(periodId, 'Diserahkan ke asesor');
    expect(r.version).toBe(1);
    expect(await periodRow(periodId)).toMatchObject({ status: 'frozen', version: 1, frozen_by: db.staffId });

    const row = await db.h.db.selectFrom('accred_snapshots').selectAll().where('id', '=', r.id).executeTakeFirstOrThrow();
    expect({ na: row.na, low: row.na_low, high: row.na_high, grade: row.grade, met: Number(row.prerequisites_met), note: row.note, by: row.created_by }).toEqual({
      na: '100.00',
      low: '100.00',
      high: '100.00',
      grade: 'A',
      met: 1,
      note: 'Diserahkan ke asesor',
      by: db.staffId,
    });
    expect((await audits('accreditation.period.freeze', periodId)).map((a) => ({ actor: a.actor_id, entity: a.entity, meta: JSON.parse(a.meta) as unknown }))).toEqual([
      { actor: db.staffId, entity: 'accred_periods', meta: { snapshotId: r.id, hasNote: true } },
    ]);

    const before = await getSnapshot(db.h.db, r.id);
    expect(before).toMatchObject({ id: r.id, periodId, instrumentId: 'sch-sma-2025', na: '100.00', grade: 'A', prerequisitesMet: true, dossierFileId: null, note: 'Diserahkan ke asesor' });
    expect(before.values.i['SCH-K1']).toEqual({ v: 1500, n: null, d: null, a: 'a', m: 'manual', b: 'manual', k: [] });
    expect(Object.keys(before.values.i)).toHaveLength(42);
    expect(before.values.s['SNP-S-01']).toEqual({ o: 'pass', v: 1500 });
    expect(Object.keys(before.values.s)).toHaveLength(14);
    expect(before.values.p).toEqual({ titles: { pass: true, count: 1500, asOf: '2026-06-30' }, npp: { pass: true }, foundingDecree: { pass: true }, met: true });
    expect((await listSnapshots(db.h.db, periodId)).snapshots.map((s) => s.id)).toEqual([r.id]);

    // A register row, an item's location and a usage cell change after the freeze.
    await db.h.db
      .insertInto('library_activities')
      .values({
        id: newId(),
        branch_id: null,
        kind: 'needs_survey',
        title: 'Survei sesudah pembekuan',
        held_on: '2026-03-02',
        ended_on: null,
        participants: 12,
        partner: null,
        uses_library_facility: 0,
        external_speaker: 0,
        description: null,
        archived_at: null,
        version: 0,
        created_at: Date.now(),
        created_by: null,
        updated_at: Date.now(),
        updated_by: null,
      })
      .execute();
    const stock = await seedStockFixture(db.h.db);
    const locationId = newId();
    await db.h.db
      .insertInto('locations')
      .values({
        id: locationId,
        branch_id: stock.branchId,
        parent_id: null,
        kind: 'room',
        code_display: 'R2',
        code_key: 'R2',
        name: 'Ruang Baca 2',
        shelf_hint: null,
        class_from: null,
        class_to: null,
        map_file_id: null,
        map_x: null,
        map_y: null,
        map_w: null,
        map_h: null,
        archived_at: null,
        version: 0,
        created_at: Date.now(),
        created_by: null,
        updated_at: Date.now(),
        updated_by: null,
      })
      .execute();
    await db.h.db.updateTable('items').set({ location_id: locationId }).where('id', '=', stock.items.received).execute();
    await db.h.db
      .insertInto('usage_stats')
      .values({ source: 'manual', metric: 'loans', span_from: '2025-10-01', span_to: '2025-10-31', branch_key: '', group_key: '', value: 99, run_id: null, updated_at: Date.now(), updated_by: null })
      .execute();
    expect(await getSnapshot(db.h.db, r.id)).toEqual(before);

    expect(await failure(freeze(periodId))).toMatchObject({ code: 'ACCRED_PERIOD_FROZEN' });
    expect(await failure(freeze(newId()))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('results older than the last change are stale: 409 with both times, and the period stays open', async () => {
    const periodId = await answeredPeriod();
    const computedAt = await computedAtOf(periodId);
    const changedAt = Date.now() + 2;
    await db.h.db.updateTable('accred_periods').set({ updated_at: changedAt }).where('id', '=', periodId).execute();
    expect(await failure(freeze(periodId))).toEqual({ code: 'ACCRED_RESULTS_STALE', meta: { computedAt, changedAt } });
    expect(await periodRow(periodId)).toMatchObject({ status: 'open', version: 0, frozen_at: null });
    expect(await db.h.db.selectFrom('accred_snapshots').select('id').where('period_id', '=', periodId).execute()).toEqual([]);

    // Changed at the very millisecond the evaluation started: stale as well.
    await db.h.db.updateTable('accred_periods').set({ updated_at: computedAt }).where('id', '=', periodId).execute();
    expect(await failure(freeze(periodId))).toMatchObject({ code: 'ACCRED_RESULTS_STALE', meta: { computedAt, changedAt: expect.any(Number) } });
  });

  it('results gone (a restore empties them) are stale', async () => {
    const periodId = await answeredPeriod();
    await db.h.db.deleteFrom('accred_results').where('period_id', '=', periodId).execute();
    expect(await failure(freeze(periodId))).toMatchObject({ code: 'ACCRED_RESULTS_STALE', meta: { computedAt: null } });
    expect((await periodRow(periodId)).status).toBe('open');
  });

  it('a usage cell deleted after the evaluation makes the results stale', async () => {
    const periodId = await seedPeriod(db);
    await db.h.db
      .insertInto('usage_stats')
      .values({ source: 'manual', metric: 'visits', span_from: '2025-09-01', span_to: '2025-09-30', branch_key: '', group_key: 'grp:teacher', value: 25, run_id: null, updated_at: SEEDED_AT, updated_by: null })
      .execute();
    expect(await evaluateNow(db, periodId, fakeProviders())).toEqual(['succeeded']);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const now = Date.now();
    await inTx(db, (tx) => putUsageCells(tx, periodId, { cells: [{ metric: 'visits', month: '2025-09', groupKey: 'grp:teacher', value: null }] }, now), now);
    expect(await db.h.db.selectFrom('usage_stats').select('value').where('group_key', '=', 'grp:teacher').execute()).toEqual([]);
    expect(await failure(freeze(periodId))).toMatchObject({ code: 'ACCRED_RESULTS_STALE' });
  });

  it('unfreezing opens the period again and keeps its snapshots; an open period cannot be unfrozen', async () => {
    const periodId = await answeredPeriod();
    const first = await freeze(periodId);
    expect(await unfreeze(periodId)).toEqual({ id: periodId, version: 2 });
    expect(await periodRow(periodId)).toMatchObject({ status: 'open', version: 2, frozen_at: null, frozen_by: null });
    expect((await audits('accreditation.period.unfreeze', periodId)).map((a) => ({ actor: a.actor_id, entity: a.entity, meta: JSON.parse(a.meta) as unknown }))).toEqual([
      { actor: db.staffId, entity: 'accred_periods', meta: {} },
    ]);
    expect(await failure(unfreeze(periodId))).toMatchObject({ code: 'CONFLICT_STALE' });
    expect(await failure(unfreeze(newId()))).toMatchObject({ code: 'NOT_FOUND' });
    // The results are still fresh: a second freeze keeps a second snapshot, the newest first.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await freeze(periodId);
    expect((await listSnapshots(db.h.db, periodId)).snapshots.map((s) => s.id)).toEqual([second.id, first.id]);
  });

  it('the first statement of a freeze and of an unfreeze is the conditional update of the period row', async () => {
    const periodId = await answeredPeriod();
    for (const [what, run] of [
      ['freeze', (tx: Parameters<typeof freezePeriod>[0]) => freezePeriod(tx, periodId, {}, Date.now())],
      ['unfreeze', (tx: Parameters<typeof unfreezePeriod>[0]) => unfreezePeriod(tx, periodId, Date.now())],
    ] as const) {
      const capture = sqlCapture(db);
      await withTx({ ...db.h, db: db.h.db.withPlugin(capture.plugin) }, (trx) => run(txCtx(trx, Date.now(), db.actor)));
      const work = capture.work();
      expect(work[0], what).toMatch(/^update ["`]accred_periods["`] set ["`]status["`] = /);
      expect(work[0], what).toMatch(/where ["`]id["`] = .* and ["`]status["`] = /);
    }
  });

  it('the snapshot names the missing evidence items per component', async () => {
    const periodId = await answeredPeriod();
    const { id } = await freeze(periodId);
    const values: CompactSnapshot = (await getSnapshot(db.h.db, id)).values;
    expect(values.e['K']).toContain('SCH-K3.policy_document');
    expect(values.e['K']).not.toContain('SCH-K1.title_list');
    expect(Object.keys(values.e).every((c) => ['K', 'SP', 'L', 'T', 'F', 'G'].includes(c))).toBe(true);
  });

  it('the compact values of 42 indicators and 14 standards with the most notes stay within 60 000 bytes', async () => {
    // Each metric carries every note its indicators may print (with parameters), a full table and a report link.
    const notesOf = new Map<AccredMetricId, NoteRef[]>();
    for (const c of SMA.components) {
      for (const i of c.indicators) {
        if (i.metric === undefined) continue;
        const list = notesOf.get(i.metric) ?? [];
        for (const key of [...(i.noteKeys ?? []), 'accred.note.truncated', 'accred.note.input_missing']) {
          if (!list.some((n) => n.key === key)) list.push({ key, params: { count: 123_456, field: 'jumlah perangkat TIK milik perpustakaan' } });
        }
        notesOf.set(i.metric, list);
      }
    }
    for (const s of SMA.snp) {
      if (s.metric === null) continue;
      const list = notesOf.get(s.metric) ?? [];
      for (const key of ['accred.note.snp_not_available', 'accred.note.snp_no_previous', 'accred.note.snp_tier_outside']) list.push({ key, params: { classes: 24 } });
      notesOf.set(s.metric, list);
    }
    const table = Array.from({ length: 200 }, (_, n) => [`baris ${n}`, n, n * 7]);
    const providers = fakeProviders({
      value: (id) =>
        fakeValue(id, PASSING[id] ?? 3, {
          notes: notesOf.get(id) ?? [],
          numerator: 123_456,
          denominator: 654_321,
          table,
          detail: { reportId: 'accreditation.annex.activities', params: { periodId: newId() } },
        }),
    });
    const periodId = await seedPeriod(db);
    await answerAll(db, periodId, SMA, 'b');
    expect(await evaluateNow(db, periodId, providers)).toEqual(['succeeded']);
    const { id } = await freeze(periodId);
    const row = await db.h.db.selectFrom('accred_snapshots').select('result_values').where('id', '=', id).executeTakeFirstOrThrow();
    const size = Buffer.byteLength(row.result_values, 'utf8');
    expect(size).toBeLessThanOrEqual(60_000);
    const values = JSON.parse(row.result_values) as CompactSnapshot;
    expect(Object.keys(values.i)).toHaveLength(42);
    expect(Object.keys(values.s)).toHaveLength(14);
    expect(values.i['SCH-K4']!.k.length).toBeGreaterThan(2);
    expect(row.result_values).not.toContain('baris 1');
    expect(row.result_values).not.toContain('accreditation.annex');
    // Every stored result stayed within its own bound too (the tables cut to fit).
    for (const r of await db.h.db.selectFrom('accred_results').select('payload').where('period_id', '=', periodId).execute()) {
      expect(Buffer.byteLength(r.payload, 'utf8')).toBeLessThanOrEqual(16_000);
    }
    expect(Object.keys(ACCRED_METRICS).length).toBeGreaterThan(0);
  });

  describe('the evidence file copy', () => {
    /** A finished dossier run of `periodId` with a PDF of `content`, started at `createdAt` (default just before it finished) and finished at `finishedAt`; its id. */
    async function dossierRun(periodId: string, o: { part?: 'all' | 'request_letter'; createdAt?: number; finishedAt: number; content: string; format?: 'pdf' | 'zip' }): Promise<string> {
      const id = newId(o.finishedAt);
      const format = o.format ?? 'pdf';
      const def = o.part === undefined ? { periodId, zipMode: 'combined' } : { periodId, part: o.part, zipMode: 'combined' };
      await db.h.db
        .insertInto('report_runs')
        .values({
          id,
          report_id: 'accreditation.dossier',
          format,
          locale: 'id',
          params: JSON.stringify({ def }),
          personal: 1,
          status: 'succeeded',
          row_count: 0,
          non_latin_rows: 0,
          output_name: `${id}.${format}`,
          output_size: Buffer.byteLength(o.content),
          error_code: null,
          job_id: null,
          expires_at: o.finishedAt + 7 * 86_400_000,
          created_at: o.createdAt ?? o.finishedAt - 1,
          created_by: db.staffId,
          finished_at: o.finishedAt,
        })
        .execute();
      const file = reportExportPath(db.dataDir, id, format);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, o.content);
      return id;
    }

    const copy = (snapshotId: string) => copySnapshotDossier(db.h, snapshotId, { dataDir: db.dataDir, storage: db.storage, now: Date.now(), log: silent });

    /** When the evaluation's results became ready: its start plus its duration. */
    const readyAtOf = async (periodId: string): Promise<number> => {
      const r = await db.h.db.selectFrom('accred_results').select('payload').where('period_id', '=', periodId).where('indicator_code', '=', '_meta').executeTakeFirstOrThrow();
      const meta = JSON.parse(r.payload) as { computedAt: number; durationMs: number };
      return meta.computedAt + meta.durationMs;
    };

    it('copies the newest whole dossier PDF made once the results were ready, never a request letter alone', async () => {
      const periodId = await answeredPeriod();
      const computedAt = await computedAtOf(periodId);
      const readyAt = await readyAtOf(periodId);
      await dossierRun(periodId, { finishedAt: computedAt - 1, content: '%PDF-1.4 sebelum perhitungan' });
      await dossierRun(periodId, { createdAt: readyAt, finishedAt: readyAt + 1, content: '%PDF-1.4 berkas bukti lengkap' });
      await dossierRun(periodId, { part: 'request_letter', createdAt: readyAt, finishedAt: readyAt + 2, content: '%PDF-1.4 surat permohonan saja' });
      await dossierRun(periodId, { createdAt: readyAt, finishedAt: readyAt + 3, content: 'PK zip', format: 'zip' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const { id } = await freeze(periodId);
      expect((await getSnapshot(db.h.db, id)).dossierFileId).toBeNull();

      const fileId = await copy(id);
      expect(fileId).not.toBeNull();
      expect((await getSnapshot(db.h.db, id)).dossierFileId).toBe(fileId);
      const file = await db.h.db.selectFrom('files').selectAll().where('id', '=', fileId!).executeTakeFirstOrThrow();
      const content = '%PDF-1.4 berkas bukti lengkap';
      expect(file).toMatchObject({
        mime: 'application/pdf',
        size: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
        context: 'accreditation.dossier',
        owner_type: 'accred_snapshots',
        owner_id: id,
        access: 'staff',
        status: 'ok',
      });
      expect(file.original_name).toMatch(/\.pdf$/);
      const opened = await openSnapshotDossier(db.h.db, id, db.dataDir);
      expect({ size: opened.size, mime: opened.mime, snapshotId: opened.snapshotId, fileName: opened.fileName }).toEqual({
        size: Buffer.byteLength(content),
        mime: 'application/pdf',
        snapshotId: id,
        fileName: file.original_name,
      });
      expect(await fsp.readFile(opened.path, 'utf8')).toBe(content);
      // Copying again keeps the one copy.
      expect(await copy(id)).toBe(fileId);
      expect(await db.h.db.selectFrom('files').select('id').where('owner_id', '=', id).execute()).toHaveLength(1);
    });

    it('a dossier PDF started before the results were ready is never kept, though it finished after they were computed', async () => {
      const periodId = await answeredPeriod();
      const readyAt = await readyAtOf(periodId);
      // Started while the evaluation still ran (its PDF may print the results before it, or half of them), finished after.
      await dossierRun(periodId, { createdAt: readyAt - 1, finishedAt: readyAt + 2, content: '%PDF-1.4 dibuat saat menghitung' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const early = await freeze(periodId);
      expect(await copy(early.id)).toBeNull();

      // Once a run started after the results were ready exists, that one is kept, even beside a newer early one.
      const second = await answeredPeriod();
      const ready = await readyAtOf(second);
      await dossierRun(second, { createdAt: ready, finishedAt: ready + 1, content: '%PDF-1.4 sesudah siap' });
      await dossierRun(second, { createdAt: ready - 1, finishedAt: ready + 2, content: '%PDF-1.4 sebelum siap' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const { id } = await freeze(second);
      const fileId = await copy(id);
      expect(fileId).not.toBeNull();
      const file = await db.h.db.selectFrom('files').select('sha256').where('id', '=', fileId!).executeTakeFirstOrThrow();
      expect(file.sha256).toBe(createHash('sha256').update('%PDF-1.4 sesudah siap').digest('hex'));
    });

    it('without a dossier run newer than the results the snapshot keeps no copy', async () => {
      const periodId = await answeredPeriod();
      const computedAt = await computedAtOf(periodId);
      await dossierRun(periodId, { finishedAt: computedAt - 5, content: '%PDF-1.4 lama' });
      await dossierRun(periodId, { part: 'request_letter', finishedAt: computedAt + 1, content: '%PDF-1.4 surat' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const { id } = await freeze(periodId);
      expect(await copy(id)).toBeNull();
      expect((await getSnapshot(db.h.db, id)).dossierFileId).toBeNull();
      expect(await failure(openSnapshotDossier(db.h.db, id, db.dataDir))).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a run whose file is gone leaves the snapshot without a copy', async () => {
      const periodId = await answeredPeriod();
      const readyAt = await readyAtOf(periodId);
      const runId = await dossierRun(periodId, { createdAt: readyAt, finishedAt: readyAt + 1, content: '%PDF-1.4 hilang' });
      await fsp.rm(reportExportPath(db.dataDir, runId, 'pdf'));
      await new Promise((resolve) => setTimeout(resolve, 5));
      const { id } = await freeze(periodId);
      expect(await copy(id)).toBeNull();
      expect((await getSnapshot(db.h.db, id)).dossierFileId).toBeNull();
    });

    it('a copy whose storing fails leaves neither a file row nor content behind', async () => {
      const periodId = await answeredPeriod();
      const readyAt = await readyAtOf(periodId);
      await dossierRun(periodId, { createdAt: readyAt, finishedAt: readyAt + 1, content: '%PDF-1.4 gagal disimpan' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const { id } = await freeze(periodId);
      let key: string | null = null;
      const failing: StorageDriver = {
        ...db.storage,
        put: async (k, d, m) => {
          key = k;
          await db.storage.put(k, d, m);
          throw new Error('disk gone');
        },
      };
      expect(await copySnapshotDossier(db.h, id, { dataDir: db.dataDir, storage: failing, now: Date.now(), log: silent })).toBeNull();
      expect(key).not.toBeNull();
      expect(await db.storage.stat(key!)).toBeNull();
      expect(await db.h.db.selectFrom('files').select('id').where('owner_id', '=', id).execute()).toEqual([]);
      expect((await getSnapshot(db.h.db, id)).dossierFileId).toBeNull();
    });

    it('a copy killed after it stored the content leaves a row, which the reports housekeeping removes with the content a day later', async () => {
      const periodId = await answeredPeriod();
      const readyAt = await readyAtOf(periodId);
      await dossierRun(periodId, { createdAt: readyAt, finishedAt: readyAt + 1, content: '%PDF-1.4 terputus' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const { id } = await freeze(periodId);
      // The process dies once the content is stored: the copy never goes on.
      let stored!: (key: string) => void;
      const storedKey = new Promise<string>((resolve) => (stored = resolve));
      const dying: StorageDriver = {
        ...db.storage,
        put: async (k, d, m) => {
          await db.storage.put(k, d, m);
          stored(k);
          return new Promise<void>(() => undefined);
        },
      };
      const at = Date.now();
      void copySnapshotDossier(db.h, id, { dataDir: db.dataDir, storage: dying, now: at, log: silent });
      const key = await storedKey;
      expect(await db.storage.stat(key)).not.toBeNull();
      expect((await getSnapshot(db.h.db, id)).dossierFileId).toBeNull();
      expect(await db.h.db.selectFrom('files').select(['id', 'status']).where('owner_id', '=', id).execute()).toEqual([{ id: key, status: 'missing' }]);

      const sweep = (now: number) =>
        orphanUploadsReportsStep.run({
          h: db.h,
          now,
          deps: { dataDir: db.dataDir, baseUrl: 'https://perpus.example.sch.id', keyring: [], storage: db.storage, log: silent } satisfies CatalogJobDeps,
          cursor: null,
          budgetLeftMs: () => 60_000,
          enqueue: async () => undefined,
        });
      // Not a day old yet: a copy may still be on its way.
      expect(await sweep(at + 60_000)).toEqual({ done: true, cursor: null });
      expect(await db.storage.stat(key)).not.toBeNull();
      expect(await sweep(at + 25 * 3_600_000)).toEqual({ done: true, cursor: null });
      expect(await db.storage.stat(key)).toBeNull();
      expect(await db.h.db.selectFrom('files').select('id').where('owner_id', '=', id).execute()).toEqual([]);
    });

    it('the housekeeping never removes a copy a snapshot names, even one whose content went missing', async () => {
      const periodId = await answeredPeriod();
      const readyAt = await readyAtOf(periodId);
      await dossierRun(periodId, { createdAt: readyAt, finishedAt: readyAt + 1, content: '%PDF-1.4 tetap' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const { id } = await freeze(periodId);
      const at = Date.now();
      const fileId = await copySnapshotDossier(db.h, id, { dataDir: db.dataDir, storage: db.storage, now: at, log: silent });
      expect(fileId).not.toBeNull();
      // A restore that did not find the content marks the row missing; the snapshot still names it.
      await db.h.db.updateTable('files').set({ status: 'missing' }).where('id', '=', fileId!).execute();
      await sweepUnfinishedSnapshotCopies(db.h.db, { storage: db.storage, now: at + 25 * 3_600_000, log: silent });
      expect(await db.h.db.selectFrom('files').select('id').where('id', '=', fileId!).execute()).toHaveLength(1);
      expect(await db.storage.stat(fileId!)).not.toBeNull();
    });
  });
});
