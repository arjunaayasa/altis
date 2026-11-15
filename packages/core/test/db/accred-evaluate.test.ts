import { isDomainError, newId } from '@altis/shared';
import type { EvidenceCreateBody } from '@altis/shared/api/accreditation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { getResults } from '../../src/accreditation/evaluate/index.js';
import { evaluateJob } from '../../src/accreditation/evaluate/job.js';
import { createEvidence, evidenceChecklist } from '../../src/accreditation/evidence/index.js';
import { putAnswer } from '../../src/accreditation/periods/answers.js';
import { periodProvider } from '../../src/accreditation/providers/period.js';
import { registersProvider } from '../../src/accreditation/providers/registers.js';
import { systemProvider } from '../../src/accreditation/providers/system.js';
import { usageProvider } from '../../src/accreditation/providers/usage.js';
import { AccredMetaPayload, AccredResultPayload } from '../../src/accreditation/types.js';
import type { JobContext } from '../../src/jobs/types.js';
import { loadAccredSettings } from '../../src/settings/accreditation.js';
import {
  SEEDED_AT,
  SMA,
  drive,
  enqueue,
  evaluateNow,
  fakeProviders,
  inTx,
  openAccredDb,
  rowsOf,
  seedPeriod,
  type AccredDb,
  type FakeOptions,
} from './accred-results-support.js';

// The evaluation of a period on the engine picked by ALTIS_TEST_DB:
// - every indicator, school standard and the prerequisites of the instrument get a stored result, the providers run in
//   order across as many slices as they need (values one provider computed are read back by a later slice), the
//   evaluation ends ready with its start as `computedAt` and one event on the accreditation channel; a period has one
//   live evaluation, and a provider that fails marks the evaluation failed;
// - the real register, period, system and usage providers fill their indicators;
// - the evidence checklists of the real instruments;
// - the results as the workspace reads them: the score follows the answers at once, and the results are stale after
//   a change made at or after the start of their evaluation.

const ctx = testDbContext();

const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => 'resolved',
    (e: unknown) => (isDomainError(e) ? { code: e.code, errors: (e.meta as { errors?: unknown } | undefined)?.errors } : e),
  );

describe.skipIf(!ctx.available)(`accreditation evaluation [${engineLabel()}]`, () => {
  let db: AccredDb;

  beforeAll(async () => {
    db = await openAccredDb('accred-evaluate');
  });

  afterAll(async () => {
    await db?.close();
  });

  const metaOf = async (periodId: string) => AccredMetaPayload.parse((await rowsOf(db, periodId)).get('_meta'));
  const results = async (periodId: string) => getResults(db.h.db, periodId, await loadAccredSettings(db.h.db), Date.now());

  /** A completed `accreditation.evidence` upload nobody owns; its id. */
  async function upload(name = 'bukti.pdf'): Promise<string> {
    const id = newId();
    await db.h.db
      .insertInto('files')
      .values({ id, original_name: name, mime: 'application/pdf', size: 1000, sha256: '0'.repeat(64), context: 'accreditation.evidence', owner_type: null, owner_id: null, access: 'staff', status: 'ok', created_at: SEEDED_AT, created_by: null })
      .execute();
    return id;
  }

  const evidence = (body: Omit<EvidenceCreateBody, 'caption'> & { caption?: string }) => inTx(db, (tx) => createEvidence(tx, { caption: 'Bukti', ...body }, SEEDED_AT), SEEDED_AT);

  it('every indicator, standard and the prerequisites of the upper secondary instrument get a stored result across slices', async () => {
    const periodId = await seedPeriod(db);
    const calls: NonNullable<FakeOptions['calls']> = [];
    const registry = db.registry(fakeProviders({ slices: { registers: 2 }, calls }));
    const { jobId } = await enqueue(db, registry, periodId);
    const before = Date.now();
    expect(await drive(db, registry, jobId)).toEqual(['continued', 'continued', 'succeeded']);
    const after = Date.now();

    // The registers provider ran over three slices, asked for its own metrics only, from where it stopped.
    const registersCalls = calls.filter((c) => c.provider === 'registers');
    expect(registersCalls.map((c) => c.cursor)).toEqual([null, '1', '2']);
    expect(registersCalls.every((c) => c.ids.every((id) => id.startsWith('registers.')))).toBe(true);
    expect(calls.map((c) => c.provider)).toEqual(['collection', 'registers', 'registers', 'registers', 'period', 'system', 'usage', 'stocktake']);

    const rows = await rowsOf(db, periodId);
    const indicatorCodes = SMA.components.flatMap((c) => c.indicators.map((i) => `SCH-${i.code}`));
    const snpCodes = SMA.snp.map((s) => s.code);
    expect(indicatorCodes).toHaveLength(42);
    expect(snpCodes).toHaveLength(14);
    expect([...rows.keys()].sort()).toEqual([...indicatorCodes, ...snpCodes, 'SCH-PRASYARAT', '_meta'].sort());
    for (const code of indicatorCodes) expect(AccredResultPayload.parse(rows.get(code)).kind, code).toBe('indicator');
    for (const code of snpCodes) expect(AccredResultPayload.parse(rows.get(code)).kind, code).toBe('snp');
    // The titles were computed in the first slice and read back by the third, where the prerequisites were written.
    expect(AccredResultPayload.parse(rows.get('SCH-PRASYARAT'))).toMatchObject({
      kind: 'prerequisites',
      prerequisites: { titles: { pass: true, count: 1500, asOf: '2026-06-30' }, npp: { pass: true }, foundingDecree: { pass: true }, met: true },
    });
    // A standard measured against the class count of the period (another provider than its metric's).
    expect(AccredResultPayload.parse(rows.get('SNP-S-11'))).toMatchObject({ kind: 'snp', metric: 'registers.active_staff' });

    const meta = await metaOf(periodId);
    expect(meta).toMatchObject({ status: 'ready', jobId, computedAt: meta.startedAt, prerequisites: { met: true } });
    expect(meta.startedAt).toBeGreaterThanOrEqual(before);
    expect(meta.startedAt).toBeLessThanOrEqual(after);
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);

    const events = await db.h.db.selectFrom('events').select(['channel', 'type', 'payload']).where('type', '=', 'accreditation.results.changed').execute();
    expect(events.map((e) => ({ channel: e.channel, payload: JSON.parse(e.payload) as unknown }))).toEqual([{ channel: 'accreditation', payload: { periodId } }]);

    const view = await results(periodId);
    expect(view).toMatchObject({ status: 'ready', computedAt: meta.computedAt, stale: false, jobId });
    expect(view.indicators).toHaveLength(42);
    expect(view.snp).toHaveLength(14);
  });

  it('a slice that runs again after the evaluation committed its end (a stopped process) changes nothing', async () => {
    const periodId = await seedPeriod(db);
    const providers = fakeProviders({ slices: { registers: 1 } });
    expect(await evaluateNow(db, periodId, providers)).toEqual(['continued', 'succeeded']);
    const rows = await rowsOf(db, periodId);
    const meta = await metaOf(periodId);
    const events = (await db.h.db.selectFrom('events').select('seq').execute()).length;
    const handler = evaluateJob(() => ({ dataDir: db.dataDir, baseUrl: '', keyring: [], storage: db.storage, log: { info() {}, warn() {}, error() {} }, appVersion: '0.1.0' }), { providers });
    const job = {
      jobId: meta.jobId,
      db: db.h.db,
      handle: db.h,
      now: () => Date.now(),
      budgetLeftMs: () => 20_000,
      cancelled: () => false,
      heartbeat: async () => {},
      log: { info() {}, warn() {}, error() {} },
    } as unknown as JobContext;
    // The checkpoint of the second slice: the registers provider, from where it stopped.
    expect(await handler.run(job, { periodId, startedAt: meta.startedAt, providerIndex: 1, resume: { cursor: '1', state: null } })).toEqual({ done: true });
    expect(await rowsOf(db, periodId)).toEqual(rows);
    expect((await db.h.db.selectFrom('events').select('seq').execute()).length).toBe(events);
  });

  it('a second evaluation of a period while one runs joins it; the running state shows', async () => {
    const periodId = await seedPeriod(db);
    const registry = db.registry(fakeProviders({ slices: { collection: 1 } }));
    const first = await enqueue(db, registry, periodId);
    expect(first.existing).toBe(false);
    expect((await results(periodId)).status).toBe('queued');
    expect(await drive(db, registry, first.jobId, { maxSlices: 1 })).toEqual(['continued']);
    expect(await enqueue(db, registry, periodId)).toEqual({ jobId: first.jobId, existing: true });
    expect(await metaOf(periodId)).toMatchObject({ status: 'running', jobId: first.jobId });
    expect(await results(periodId)).toMatchObject({ status: 'running', jobId: first.jobId, computedAt: null, stale: true });
    expect(await drive(db, registry, first.jobId)).toEqual(['succeeded']);
    expect((await metaOf(periodId)).status).toBe('ready');
  });

  it('a provider that throws marks the evaluation failed', async () => {
    const periodId = await seedPeriod(db);
    const registry = db.registry(fakeProviders({ throws: 'period' }));
    const { jobId } = await enqueue(db, registry, periodId);
    expect(await drive(db, registry, jobId)).toEqual(['retry']);
    expect(await metaOf(periodId)).toMatchObject({ status: 'failed', jobId });
  });

  it('an unknown or archived period cannot be evaluated', async () => {
    const registry = db.registry(fakeProviders());
    expect(await failure(enqueue(db, registry, newId()))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the real register, period, system and usage providers fill their indicators', async () => {
    const periodId = await seedPeriod(db, { students: 300, teachers: 30, eduStaff: 10, ictDevices: 17, bandwidthMbps: 30 });
    for (const heldOn of ['2025-08-12', '2026-02-03']) {
      await db.h.db
        .insertInto('library_activities')
        .values({
          id: newId(SEEDED_AT),
          branch_id: null,
          kind: 'needs_survey',
          title: `Survei kebutuhan ${heldOn}`,
          held_on: heldOn,
          ended_on: null,
          participants: 40,
          partner: null,
          uses_library_facility: 0,
          external_speaker: 0,
          description: null,
          archived_at: null,
          version: 0,
          created_at: SEEDED_AT,
          created_by: null,
          updated_at: SEEDED_AT,
          updated_by: null,
        })
        .execute();
    }
    for (const month of ['2025-08', '2025-09']) {
      await db.h.db
        .insertInto('usage_stats')
        .values({ source: 'manual', metric: 'visits', span_from: `${month}-01`, span_to: `${month}-30`, branch_key: '', group_key: 'grp:student', value: 340, run_id: null, updated_at: SEEDED_AT, updated_by: null })
        .execute();
    }
    expect(await evaluateNow(db, periodId, [registersProvider, periodProvider, systemProvider, usageProvider])).toEqual(['succeeded']);

    const rows = await rowsOf(db, periodId);
    const indicator = (code: string) => {
      const p = AccredResultPayload.parse(rows.get(code));
      if (p.kind !== 'indicator') throw new Error(code);
      return { metric: p.metric, value: p.value?.value ?? null, basis: p.value?.basis ?? null, suggestion: p.suggestion };
    };
    // Two needs surveys in the period (SMA: 2 → b).
    expect(indicator('SCH-K4')).toEqual({ metric: 'registers.activities.needs_survey', value: 2, basis: 'register', suggestion: 'b' });
    // 17 devices for 340 people: 5 % (≥ 4 → a).
    expect(indicator('SCH-SP4')).toEqual({ metric: 'period.ict_devices_pct', value: 5, basis: 'manual', suggestion: 'a' });
    // 30 Mbps → c.
    expect(indicator('SCH-SP6')).toEqual({ metric: 'period.bandwidth_mbps', value: 30, basis: 'manual', suggestion: 'c' });
    // 680 student visits in 2 months with data (divisor 2 school months) for 340 people: 100 % (≥ 76 → a).
    expect(indicator('SCH-L14')).toEqual({ metric: 'usage.school_visits_pct', value: 100, basis: 'manual', suggestion: 'a' });
    // No collection provider ran: the titles have no data and the prerequisites fail on them.
    expect(AccredResultPayload.parse(rows.get('SCH-PRASYARAT'))).toMatchObject({
      prerequisites: { titles: { pass: false, count: 0 }, npp: { pass: true }, met: false },
      titles: { value: null, basis: 'none' },
    });
    expect(indicator('SCH-K1')).toEqual({ metric: 'collection.titles', value: null, basis: 'none', suggestion: null });
  });

  it('the evidence checklist of a real instrument: items of another indicator are refused, generated ones are present', async () => {
    const periodId = await seedPeriod(db);
    expect(await failure(evidence({ uploadId: await upload(), periodId, indicatorCode: 'SCH-K2', evidenceCode: 'title_list' }))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'evidenceCode', code: 'invalid' }],
    });
    await evidence({ uploadId: await upload('katalog.pdf'), periodId, indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot', caption: 'Layar katalog' });

    const checklist = await evidenceChecklist(db.h.db, periodId, SMA);
    expect(checklist.get('SCH-K1')!.map((e) => [e.code, e.present])).toEqual([
      ['title_list', true],
      ['catalogue_screenshot', true],
      ['ddc_recap', true],
    ]);
    expect(checklist.get('SCH-K1')![1]!.files.map((f) => [f.name, f.caption])).toEqual([['katalog.pdf', 'Layar katalog']]);
    expect(checklist.get('SCH-K3')!.map((e) => [e.code, e.present])).toEqual([['policy_document', false]]);

    const view = await results(periodId);
    const k = view.missingEvidence.find((m) => m.component === 'K')!;
    expect(k.items).toContainEqual({ indicatorCode: 'SCH-K3', officialNo: 'K3', evidenceCode: 'policy_document', labelKey: 'accred.evidence.K3.policy_document' });
    expect(k.items.some((i) => i.indicatorCode === 'SCH-K1')).toBe(false);
    expect(view.indicators.find((i) => i.code === 'SCH-K1')!.evidence.map((e) => e.present)).toEqual([true, true, true]);
  });

  it('the score follows the answers without a new evaluation; a later change makes the results stale', async () => {
    const periodId = await seedPeriod(db, { floorM2: 120 });
    expect(await evaluateNow(db, periodId, fakeProviders())).toEqual(['succeeded']);
    const first = await results(periodId);
    expect(first.stale).toBe(false);
    const sp1 = first.indicators.find((i) => i.code === 'SCH-SP1')!;
    // The building item is answered by hand and shows the floor area.
    expect(sp1).toMatchObject({ metric: 'period.floor_m2', value: 3, suggestion: null, suggest: false, answer: null, final: null });
    expect(sp1.notes).toContainEqual({ key: 'accred.note.sp1_floor', params: { m2: 3 } });

    await inTx(db, (tx) => putAnswer(tx, periodId, 'SCH-SP1', { answer: 'a', mode: 'manual', note: null }, SEEDED_AT), SEEDED_AT);
    const second = await results(periodId);
    expect(second.computedAt).toBe(first.computedAt);
    expect(second.stale).toBe(false);
    expect(second.indicators.find((i) => i.code === 'SCH-SP1')).toMatchObject({ answer: { answer: 'a', mode: 'manual' }, final: 'a' });
    expect(second.score!.answered).toBe(first.score!.answered + 1);
    expect(second.score!.naLow).not.toBe(first.score!.naLow);

    // A register row edited after the evaluation started.
    await db.h.db
      .insertInto('library_partnerships')
      .values({
        id: newId(),
        branch_id: null,
        partner: 'Perpustakaan Daerah',
        kind: 'mou',
        starts_on: '2025-08-01',
        ends_on: null,
        scope: null,
        document_file_id: null,
        archived_at: null,
        version: 0,
        created_at: Date.now() + 1,
        created_by: null,
        updated_at: Date.now() + 1,
        updated_by: null,
      })
      .execute();
    expect(await results(periodId)).toMatchObject({ stale: true, computedAt: first.computedAt });
  });

  it('results computed at the very millisecond of the last change are stale', async () => {
    const periodId = await seedPeriod(db);
    expect(await evaluateNow(db, periodId, fakeProviders())).toEqual(['succeeded']);
    const view = await results(periodId);
    expect(view.stale).toBe(false);
    await db.h.db.updateTable('accred_periods').set({ updated_at: view.computedAt! }).where('id', '=', periodId).execute();
    expect(await results(periodId)).toMatchObject({ stale: true, changedAt: view.computedAt, computedAt: view.computedAt });
  });
});
