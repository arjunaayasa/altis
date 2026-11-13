import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { isDomainError, newId } from '@altis/shared';
import type { AnswerPutBody, PeriodCreateBody, PeriodPatchBody } from '@altis/shared/api/accreditation';
import type { KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import {
  archivePeriod,
  catalogSyncedAt,
  createPeriod,
  getPeriod,
  lastChangeOf,
  listPeriods,
  putAnswer,
  updatePeriod,
} from '../../src/accreditation/periods/index.js';
import { txCtx, type Actor, type TxCtx } from '../../src/context.js';
import { loadAccredSettings } from '../../src/settings/accreditation.js';
import { writeSettings } from '../../src/settings/service.js';

// The accreditation periods below the routes, on the engine picked by ALTIS_TEST_DB: which instrument fits the library
// (its type and school level) and which span it accepts; what a new period copies (the profile and the population of
// an earlier period, or only the library's street address on a first period); the writers of a period's data, each
// taking the period's row first and refused once the period is frozen; the answers of an instrument's indicators; and
// the last change a period's computed results depend on, which tells the workspace that they are out of date.

const ctx = testDbContext();
/** In the past, and so is everything the cases write after it: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 8, 1, 2, 0, 0);
const DAY = 86_400_000;
const ACTOR: Actor = { type: 'staff', id: newId(NOW), ip: null };

/** What a rejected promise rejected with: `{code, errors}` for VALIDATION_FAILED, `{code, meta}` otherwise. */
async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => 'resolved',
    (e: unknown) => {
      if (!isDomainError(e)) throw e;
      if (e.code === 'VALIDATION_FAILED') return { code: e.code, errors: e.meta?.['errors'] };
      return e.meta === undefined ? { code: e.code } : { code: e.code, meta: e.meta };
    },
  );
}

const invalid = (path: string, code: string) => ({ code: 'VALIDATION_FAILED', errors: [{ path, code }] });

describe.skipIf(!ctx.available)(`accreditation periods [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-accred-periods-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  const run = <T>(fn: (tx: TxCtx) => Promise<T>, at = NOW): Promise<T> => withTx(h, (trx) => fn(txCtx(trx, at, ACTOR)));

  async function settings(patch: Record<string, unknown>): Promise<void> {
    await withTx(h, (trx) => writeSettings(trx, patch, { keyring: [], now: NOW, actorId: null }));
  }

  async function create(body: Record<string, unknown>, at = NOW): Promise<string> {
    const s = await loadAccredSettings(h.db);
    const out = await run((tx) => createPeriod(tx, { name: 'Periode uji', ...body } as PeriodCreateBody, s, at), at);
    return out.id;
  }

  async function patch(id: string, body: Partial<PeriodPatchBody> & Record<string, unknown>, at = NOW): Promise<number> {
    const s = await loadAccredSettings(h.db);
    const version = Number((await row(id)).version);
    return (await run((tx) => updatePeriod(tx, id, { version, ...body } as PeriodPatchBody, s, at), at)).version;
  }

  const answer = (periodId: string, code: string, body: AnswerPutBody, at = NOW) => run((tx) => putAnswer(tx, periodId, code, body, at), at);

  const row = (id: string) => h.db.selectFrom('accred_periods').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  /** Every live period archived: the next one is a first period. */
  async function noLivePeriods(): Promise<void> {
    await h.db.updateTable('accred_periods').set({ archived_at: NOW }).where('archived_at', 'is', null).execute();
  }

  /** A `test-sch` period of school year 2025 (an upper secondary school library). */
  async function schoolPeriod(at = NOW): Promise<string> {
    await settings({ 'library.type': 'sekolah' });
    return create({ instrumentId: 'test-sch', kind: 'school_year', startYear: 2025, profile: { schoolLevel: 'sma_smk_ma' } }, at);
  }

  async function freeze(id: string): Promise<void> {
    await h.db.updateTable('accred_periods').set({ status: 'frozen', frozen_at: NOW }).where('id', '=', id).execute();
  }

  describe('createPeriod: the instrument and the span', () => {
    it('an instrument for another library type → ACCRED_INSTRUMENT_MISMATCH with the type and the level', async () => {
      await settings({ 'library.type': 'umum' });
      expect(await failure(create({ instrumentId: 'sch-sma-2025', kind: 'school_year', startYear: 2025 }))).toEqual({
        code: 'ACCRED_INSTRUMENT_MISMATCH',
        meta: { libraryType: 'umum', schoolLevel: null },
      });
    });

    it('a school instrument for another school level → ACCRED_INSTRUMENT_MISMATCH; without a level → profile.schoolLevel required', async () => {
      await settings({ 'library.type': 'sekolah' });
      expect(await failure(create({ instrumentId: 'sch-sma-2025', kind: 'school_year', startYear: 2025, profile: { schoolLevel: 'sd_mi' } }))).toEqual({
        code: 'ACCRED_INSTRUMENT_MISMATCH',
        meta: { libraryType: 'sekolah', schoolLevel: 'sd_mi' },
      });
      await noLivePeriods();
      expect(await failure(create({ instrumentId: 'sch-sma-2025', kind: 'school_year', startYear: 2025 }))).toEqual(
        invalid('profile.schoolLevel', 'required'),
      );
    });

    it('a period kind the instrument does not take → ACCRED_PERIOD_SPAN with the kind and its months', async () => {
      await settings({ 'library.type': 'sekolah' });
      const body = { instrumentId: 'sch-sd-2025', kind: 'calendar_year', startYear: 2025, profile: { schoolLevel: 'sd_mi' } } as const;
      expect(await failure(create(body))).toEqual({ code: 'ACCRED_PERIOD_SPAN', meta: { kind: 'calendar_year', months: 12 } });
      expect(await failure(create({ ...body, kind: 'custom', startYear: undefined, startsOn: '2025-01-01', endsOn: '2025-06-30' }))).toEqual({
        code: 'ACCRED_PERIOD_SPAN',
        meta: { kind: 'custom', months: 6 },
      });
      // The same instrument over a school year is accepted.
      const id = await create({ ...body, kind: 'school_year' });
      expect(await row(id)).toMatchObject({ instrument_id: 'sch-sd-2025', kind: 'school_year', starts_on: '2025-07-01', ends_on: '2026-06-30' });
    });

    it('an unknown instrument → instrumentId not_found', async () => {
      expect(await failure(create({ instrumentId: 'sch-sma-2022', kind: 'school_year', startYear: 2025 }))).toEqual(invalid('instrumentId', 'not_found'));
    });

    it('the statistics mode over 18 free months on a public library: an open, library-wide period at version 0', async () => {
      await settings({ 'library.type': 'umum' });
      const id = await create({ instrumentId: 'general-stats', kind: 'custom', startsOn: '2025-01-01', endsOn: '2026-06-30' });
      expect(await row(id)).toMatchObject({
        name: 'Periode uji',
        instrument_id: 'general-stats',
        kind: 'custom',
        starts_on: '2025-01-01',
        ends_on: '2026-06-30',
        branch_id: null,
        status: 'open',
        archived_at: null,
        version: 0,
        created_by: ACTOR.id,
        updated_by: ACTOR.id,
      });
      expect(Number((await row(id)).created_at)).toBe(NOW);
    });

    it('the school year starts in the configured month', async () => {
      await settings({ 'library.type': 'umum', 'accreditation.schoolYearStartMonth': 1 });
      try {
        const id = await create({ instrumentId: 'general-stats', kind: 'school_year', startYear: 2026 });
        expect(await row(id)).toMatchObject({ starts_on: '2026-01-01', ends_on: '2026-12-31' });
      } finally {
        await settings({ 'accreditation.schoolYearStartMonth': 7 });
      }
    });

    it('a branch → branchId branch_scope_not_available; a missing year → startYear required', async () => {
      await settings({ 'library.type': 'umum' });
      expect(await failure(create({ instrumentId: 'general-stats', kind: 'calendar_year', startYear: 2025, branchId: '01JBRANCH0000000000000000A' }))).toEqual(
        invalid('branchId', 'branch_scope_not_available'),
      );
      expect(await failure(create({ instrumentId: 'general-stats', kind: 'calendar_year' }))).toEqual(invalid('startYear', 'required'));
    });

    it('the audit entry names the instrument, the kind, the span and the period copied', async () => {
      await noLivePeriods();
      await settings({ 'library.type': 'umum' });
      const id = await create({ instrumentId: 'general-stats', kind: 'calendar_year', startYear: 2024 });
      const entry = await h.db.selectFrom('audit_log').select(['action', 'entity', 'meta']).where('entity_id', '=', id).executeTakeFirstOrThrow();
      expect({ ...entry, meta: JSON.parse(entry.meta) as unknown }).toEqual({
        action: 'accreditation.period.create',
        entity: 'accred_periods',
        meta: { instrumentId: 'general-stats', kind: 'calendar_year', startsOn: '2024-01-01', endsOn: '2024-12-31', copiedFrom: null },
      });
    });
  });

  describe('createPeriod: what a new period starts with', () => {
    it("a first period: the street from the library's address, cut to 191 characters; phone, e-mail and website empty", async () => {
      await noLivePeriods();
      await settings({ 'library.type': 'umum', 'library.address': `Jl. ${'x'.repeat(296)}` });
      const id = await create({ instrumentId: 'general-stats', kind: 'calendar_year', startYear: 2025 });
      const view = await getPeriod(h.db, id, NOW);
      expect(view.profile.address?.street).toBe(`Jl. ${'x'.repeat(187)}`);
      expect(view.profile.address?.street).toHaveLength(191);
      expect([view.profile.phone, view.profile.email, view.profile.website]).toEqual([null, null, null]);
    });

    it('a first period: an address over several lines becomes one line', async () => {
      await noLivePeriods();
      await settings({ 'library.type': 'umum', 'library.address': ' Jl. Merdeka 1\r\nKota Contoh\t ' });
      const id = await create({ instrumentId: 'general-stats', kind: 'calendar_year', startYear: 2025 });
      expect((await getPeriod(h.db, id, NOW)).profile.address?.street).toBe('Jl. Merdeka 1 Kota Contoh');
      await settings({ 'library.address': null });
    });

    it("a second period copies the first's profile and population, not the confirmation; a profile in the body replaces the fields it names", async () => {
      await noLivePeriods();
      await settings({ 'library.type': 'sekolah' });
      const first = await create({
        instrumentId: 'test-sch',
        kind: 'school_year',
        startYear: 2024,
        profile: { schoolLevel: 'sma_smk_ma', npp: '3201010D1000001', schoolName: 'SMA Contoh', address: { street: 'Jl. Pelajar 5' } },
      });
      await patch(first, { students: 420, teachers: 31, floorM2: 96, services: ['circulation', 'reference'], allRegisteredConfirmed: true });

      const second = await create({ instrumentId: 'test-sch', kind: 'school_year', startYear: 2025 }, NOW + 1);
      const a = await getPeriod(h.db, first, NOW);
      const b = await getPeriod(h.db, second, NOW);
      expect(b.profile).toEqual(a.profile);
      expect(b).toMatchObject({ students: 420, teachers: 31, floorM2: 96, services: ['circulation', 'reference'], allRegisteredConfirmed: false });

      const third = await create({ instrumentId: 'test-sch', kind: 'rolling_12', endMonth: '2026-12', profile: { npp: '3201010D1000002' } }, NOW + 2);
      expect((await getPeriod(h.db, third, NOW)).profile).toEqual({ ...a.profile, npp: '3201010D1000002' });

      const chosen = await create({ instrumentId: 'test-sch', kind: 'school_year', startYear: 2026, copyFromPeriodId: first }, NOW + 3);
      expect((await getPeriod(h.db, chosen, NOW)).profile).toEqual(a.profile);
      const entry = await h.db.selectFrom('audit_log').select('meta').where('entity_id', '=', chosen).executeTakeFirstOrThrow();
      expect(JSON.parse(entry.meta)).toMatchObject({ copiedFrom: first });

      expect(await failure(create({ instrumentId: 'test-sch', kind: 'school_year', startYear: 2026, copyFromPeriodId: newId() }))).toEqual(
        invalid('copyFromPeriodId', 'not_found'),
      );
    });
  });

  describe('the writers take the period lock first', () => {
    /** The statements of `fn`'s transaction, without the transaction's own control statements. */
    async function statementsOf(fn: (tx: TxCtx) => Promise<unknown>): Promise<string[]> {
      const statements: string[] = [];
      const capture: KyselyPlugin = {
        transformQuery(args) {
          statements.push(h.db.getExecutor().compileQuery(args.node, args.queryId).sql);
          return args.node;
        },
        async transformResult(args) {
          return args.result;
        },
      };
      await withTx({ ...h, db: h.db.withPlugin(capture) }, (trx) => fn(txCtx(trx, NOW, ACTOR)));
      return statements.filter((sql) => !/^\s*(begin|start|set|savepoint|release|commit|rollback)\b/i.test(sql));
    }

    const LOCK = /^update ["`]accred_periods["`] set ["`]version["`] = ["`]version["`] where/;

    it('updatePeriod, archivePeriod and putAnswer: the first statement is the no-op update of the period row', async () => {
      const id = await schoolPeriod();
      const s = await loadAccredSettings(h.db);
      const update = await statementsOf((tx) => updatePeriod(tx, id, { version: 0, students: 300 }, s, NOW));
      const put = await statementsOf((tx) => putAnswer(tx, id, 'SCH-SP1', { answer: 'b', mode: 'manual', note: null }, NOW));
      const archive = await statementsOf((tx) => archivePeriod(tx, id, NOW));
      for (const [what, list] of [
        ['update', update],
        ['answer', put],
        ['archive', archive],
      ] as const) {
        expect(list.length, what).toBeGreaterThan(1);
        expect(list[0], what).toMatch(LOCK);
      }
    });
  });

  describe('a frozen period', () => {
    it('PATCH, DELETE and an answer → ACCRED_PERIOD_FROZEN, nothing changed; an old version on an open period → CONFLICT_STALE', async () => {
      await noLivePeriods();
      const id = await schoolPeriod();
      await answer(id, 'SCH-SP1', { answer: 'c', mode: 'manual', note: null });
      await freeze(id);
      const s = await loadAccredSettings(h.db);
      expect(await failure(run((tx) => updatePeriod(tx, id, { version: 0, students: 1 }, s, NOW)))).toEqual({ code: 'ACCRED_PERIOD_FROZEN' });
      expect(await failure(run((tx) => archivePeriod(tx, id, NOW)))).toEqual({ code: 'ACCRED_PERIOD_FROZEN' });
      expect(await failure(answer(id, 'SCH-SP1', { answer: 'a', mode: 'manual', note: null }))).toEqual({ code: 'ACCRED_PERIOD_FROZEN' });
      expect(await row(id)).toMatchObject({ students: null, archived_at: null, version: 0 });
      expect((await h.db.selectFrom('accred_answers').select('answer').where('period_id', '=', id).executeTakeFirstOrThrow()).answer).toBe('c');

      const open = await schoolPeriod();
      await patch(open, { students: 10 });
      expect(await failure(run((tx) => updatePeriod(tx, open, { version: 0, students: 11 }, s, NOW)))).toEqual({ code: 'CONFLICT_STALE' });
      expect(await row(open)).toMatchObject({ students: 10, version: 1 });
    });

    it('archive: the period leaves the list and its page; archiving it again → NOT_FOUND', async () => {
      const id = await schoolPeriod();
      const out = await run((tx) => archivePeriod(tx, id, NOW + 5));
      expect(out).toEqual({ id, version: 1 });
      expect([Number((await row(id)).archived_at), Number((await row(id)).version)]).toEqual([NOW + 5, 1]);
      expect((await listPeriods(h.db)).periods.map((p) => p.id)).not.toContain(id);
      expect(await failure(getPeriod(h.db, id, NOW))).toEqual({ code: 'NOT_FOUND' });
      expect(await failure(run((tx) => archivePeriod(tx, id, NOW)))).toEqual({ code: 'NOT_FOUND' });
      const entry = await h.db.selectFrom('audit_log').select(['action', 'meta']).where('entity_id', '=', id).where('action', '=', 'accreditation.period.archive').executeTakeFirstOrThrow();
      expect(JSON.parse(entry.meta)).toEqual({});
    });
  });

  describe('updatePeriod', () => {
    it('changes the fields sent; the audit entry names the changed fields only', async () => {
      const id = await schoolPeriod();
      await patch(id, { name: 'Tahun pelajaran 2025/2026', students: 400, teachers: 30, eduStaff: 8, hoursPerWeek: 40, profile: { npp: '3201010D1000009', libraryHead: 'Nama Kepala' } });
      const view = await getPeriod(h.db, id, NOW);
      expect(view).toMatchObject({ name: 'Tahun pelajaran 2025/2026', students: 400, teachers: 30, eduStaff: 8, hoursPerWeek: 40, version: 1 });
      expect(view.profile).toMatchObject({ schoolLevel: 'sma_smk_ma', npp: '3201010D1000009', libraryHead: 'Nama Kepala' });
      const entry = await h.db
        .selectFrom('audit_log')
        .select('meta')
        .where('entity_id', '=', id)
        .where('action', '=', 'accreditation.period.update')
        .executeTakeFirstOrThrow();
      expect(JSON.parse(entry.meta)).toEqual({ fields: ['name', 'profile', 'students', 'teachers', 'eduStaff', 'hoursPerWeek'] });
      expect(entry.meta).not.toContain('Nama Kepala');
    });

    it('a profile field sent as null clears it; teachers using the library may not exceed the teachers', async () => {
      await noLivePeriods();
      await settings({ 'library.address': null });
      const id = await schoolPeriod();
      await patch(id, { teachers: 20, profile: { npp: '3201010D1000010' } });
      await patch(id, { profile: { npp: null } });
      expect((await getPeriod(h.db, id, NOW)).profile).toEqual({ schoolLevel: 'sma_smk_ma', npp: null, address: null, phone: null, email: null, website: null });
      const s = await loadAccredSettings(h.db);
      expect(await failure(run((tx) => updatePeriod(tx, id, { version: 2, teachersUsing: 21 }, s, NOW)))).toEqual({
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'teachersUsing', code: 'too_big' }],
      });
    });

    it('the school level of a school instrument stays one the instrument is for', async () => {
      const id = await schoolPeriod();
      const s = await loadAccredSettings(h.db);
      expect(await failure(run((tx) => updatePeriod(tx, id, { version: 0, profile: { schoolLevel: 'smp_mts' } }, s, NOW)))).toEqual({
        code: 'ACCRED_INSTRUMENT_MISMATCH',
        meta: { libraryType: 'sekolah', schoolLevel: 'smp_mts' },
      });
      expect(await failure(run((tx) => updatePeriod(tx, id, { version: 0, profile: { schoolLevel: null } }, s, NOW)))).toEqual(
        invalid('profile.schoolLevel', 'required'),
      );
    });

    it("a profile photo must be a JPEG evidence file of this period's profile", async () => {
      const id = await schoolPeriod();
      const other = await schoolPeriod();
      const evidence = async (period: string, mime: string, indicatorCode = 'SCH-PROFIL'): Promise<string> => {
        const fileId = newId(NOW);
        await h.db
          .insertInto('files')
          .values({
            id: fileId,
            original_name: mime === 'image/jpeg' ? 'depan.jpg' : 'depan.pdf',
            mime,
            size: 10,
            sha256: 'a'.repeat(64),
            context: 'accreditation.evidence',
            owner_type: 'accred_evidence',
            owner_id: null,
            access: 'staff',
            status: 'ok',
            created_at: NOW,
            created_by: null,
          })
          .execute();
        await h.db
          .insertInto('accred_evidence')
          .values({
            id: newId(NOW),
            period_id: period,
            indicator_code: indicatorCode,
            evidence_code: 'photo_front',
            entity: null,
            entity_id: null,
            file_id: fileId,
            caption: 'Tampak depan',
            created_at: NOW,
            created_by: null,
          })
          .execute();
        return fileId;
      };
      const s = await loadAccredSettings(h.db);
      const tryPhoto = (front: string) => failure(run((tx) => updatePeriod(tx, id, { version: 0, profile: { photos: { front } } }, s, NOW)));
      expect(await tryPhoto(await evidence(id, 'application/pdf'))).toEqual(invalid('profile.photos.front', 'invalid'));
      expect(await tryPhoto(await evidence(other, 'image/jpeg'))).toEqual(invalid('profile.photos.front', 'not_found'));
      expect(await tryPhoto(await evidence(id, 'image/jpeg', 'SCH-SP1'))).toEqual(invalid('profile.photos.front', 'not_found'));
      expect(await tryPhoto(newId())).toEqual(invalid('profile.photos.front', 'not_found'));
      const jpeg = await evidence(id, 'image/jpeg');
      await patch(id, { profile: { photos: { front: jpeg, staff: null } } });
      expect((await getPeriod(h.db, id, NOW)).profile.photos).toEqual({ front: jpeg, staff: null });
      // The photos are evidence of their own period: a copy of the profile starts without them.
      const next = await create({ instrumentId: 'test-sch', kind: 'school_year', startYear: 2026, copyFromPeriodId: id });
      expect((await getPeriod(h.db, next, NOW)).profile).toMatchObject({ schoolLevel: 'sma_smk_ma', photos: null });
    });
  });

  describe('putAnswer', () => {
    it('an override without a note → note required; a code outside the instrument → code invalid', async () => {
      const id = await schoolPeriod();
      expect(await failure(answer(id, 'SCH-K1', { answer: 'b', mode: 'override', note: null }))).toEqual(invalid('note', 'required'));
      expect(await failure(answer(id, 'SCH-K1', { answer: 'b', mode: 'override', note: '  ' }))).toEqual(invalid('note', 'required'));
      expect(await failure(answer(id, 'SCH-L7', { answer: 'b', mode: 'manual', note: null }))).toEqual(invalid('code', 'invalid'));
      expect(await failure(answer(id, 'K1', { answer: 'b', mode: 'manual', note: null }))).toEqual(invalid('code', 'invalid'));
      expect(await failure(answer(id, 'SCH-K1', { answer: null, mode: 'override', note: 'Tanpa jawaban' }))).toEqual(invalid('answer', 'required'));
    });

    it('a manual answer is stored, replaced, and removed by null; the audit entries carry no note', async () => {
      const id = await schoolPeriod();
      const stored = () => h.db.selectFrom('accred_answers').select(['indicator_code', 'answer', 'mode', 'note', 'updated_by']).where('period_id', '=', id).execute();
      expect(await answer(id, 'SCH-SP1', { answer: 'b', mode: 'manual', note: null })).toEqual({ id, version: 0 });
      expect(await stored()).toEqual([{ indicator_code: 'SCH-SP1', answer: 'b', mode: 'manual', note: null, updated_by: ACTOR.id }]);
      await answer(id, 'SCH-K1', { answer: 'a', mode: 'manual', note: null });
      await answer(id, 'SCH-K1', { answer: 'c', mode: 'override', note: 'Rahasia catatan pustakawan' });
      expect(await stored()).toContainEqual({ indicator_code: 'SCH-K1', answer: 'c', mode: 'override', note: 'Rahasia catatan pustakawan', updated_by: ACTOR.id });
      await answer(id, 'SCH-SP1', { answer: null, mode: 'manual', note: null });
      expect((await stored()).map((r) => r.indicator_code)).toEqual(['SCH-K1']);
      const entries = await h.db
        .selectFrom('audit_log')
        .select(['entity', 'meta'])
        .where('entity_id', '=', id)
        .where('action', '=', 'accreditation.answer.update')
        .orderBy('seq')
        .execute();
      expect(entries.map((e) => ({ entity: e.entity, meta: JSON.parse(e.meta) as unknown }))).toEqual([
        { entity: 'accred_periods', meta: { code: 'SCH-SP1', mode: 'manual', answer: 'b', hasNote: false } },
        { entity: 'accred_periods', meta: { code: 'SCH-K1', mode: 'manual', answer: 'a', hasNote: false } },
        { entity: 'accred_periods', meta: { code: 'SCH-K1', mode: 'override', answer: 'c', hasNote: true } },
        { entity: 'accred_periods', meta: { code: 'SCH-SP1', mode: 'manual', answer: null, hasNote: false } },
      ]);
      expect(entries.map((e) => e.meta).join('')).not.toContain('Rahasia');
      // An answer does not touch the period.
      expect(await row(id)).toMatchObject({ version: 0 });
      expect(Number((await row(id)).updated_at)).toBe(NOW);
    });

    it('the statistics mode has no indicator to answer', async () => {
      await settings({ 'library.type': 'umum' });
      const id = await create({ instrumentId: 'general-stats', kind: 'calendar_year', startYear: 2025 });
      expect(await failure(answer(id, 'SCH-SP1', { answer: 'b', mode: 'manual', note: null }))).toEqual(invalid('code', 'invalid'));
    });
  });

  describe('lastChangeOf and stale results', () => {
    // Later than anything the other cases wrote, so that each step below is the newest change.
    const T = NOW + 30 * DAY;

    it('moves with the registers, the usage, the group map, the period, an overlapping period and the last usage import; not with an answer', async () => {
      await settings({ 'library.type': 'sekolah' });
      const id = await create({ instrumentId: 'test-sch', kind: 'school_year', startYear: 2030, profile: { schoolLevel: 'sma_smk_ma' } }, T);
      expect(await lastChangeOf(h.db, id)).toBe(T);

      const staffId = newId(T);
      const trail = (at: number) => ({ archived_at: null, version: 0, created_at: at, created_by: null, updated_at: at, updated_by: null });
      await h.db
        .insertInto('library_activities')
        .values({ id: newId(T), branch_id: null, kind: 'promotion', title: 'Pekan literasi', held_on: '2030-08-10', ended_on: null, participants: 120, partner: null, description: null, ...trail(T + 1) })
        .execute();
      expect(await lastChangeOf(h.db, id)).toBe(T + 1);

      await h.db
        .insertInto('library_staff')
        .values({
          id: staffId,
          branch_id: null,
          staff_user_id: null,
          name: 'Pustakawan Uji',
          position: null,
          role: 'librarian',
          employment: null,
          education_level: null,
          education_library: 0,
          library_training: 0,
          competency_cert: 0,
          association_member: 0,
          appointment_ref: null,
          starts_on: null,
          ends_on: null,
          ...trail(T + 2),
        })
        .execute();
      expect(await lastChangeOf(h.db, id)).toBe(T + 2);
      await h.db
        .insertInto('staff_trainings')
        .values({ id: newId(T), library_staff_id: staffId, title: 'Diklat', organizer: null, held_on: '2030-09-01', hours: 8, certificate_file_id: null, ...trail(T + 3) })
        .execute();
      expect(await lastChangeOf(h.db, id)).toBe(T + 3);
      // An archive is a soft change of the row (archived_at and updated_at).
      await h.db.updateTable('library_staff').set({ archived_at: T + 4, updated_at: T + 4 }).where('id', '=', staffId).execute();
      expect(await lastChangeOf(h.db, id)).toBe(T + 4);

      await h.db
        .insertInto('usage_stats')
        .values({ source: 'manual', metric: 'visits', span_from: '2030-08-01', span_to: '2030-08-31', branch_key: '', group_key: 'grp:student', value: 900, run_id: null, updated_at: T + 5, updated_by: null })
        .execute();
      expect(await lastChangeOf(h.db, id)).toBe(T + 5);

      await h.db.insertInto('usage_group_map').values({ group_key: 'member_unknown', label: 'Anggota terhapus', accred_group: 'student', updated_at: T + 6, updated_by: null }).execute();
      expect(await lastChangeOf(h.db, id)).toBe(T + 6);

      await patch(id, { students: 500 }, T + 7);
      expect(await lastChangeOf(h.db, id)).toBe(T + 7);

      // An overlapping period's change counts (a usage deletion through it touches it); a period elsewhere does not.
      const overlapping = await create({ instrumentId: 'test-sch', kind: 'rolling_12', endMonth: '2031-03' }, T + 8);
      expect(await lastChangeOf(h.db, id)).toBe(T + 8);
      const elsewhere = await create({ instrumentId: 'test-sch', kind: 'school_year', startYear: 2033 }, T + 9);
      expect(await lastChangeOf(h.db, id)).toBe(T + 8);
      expect(await lastChangeOf(h.db, elsewhere)).toBe(T + 9);
      await patch(overlapping, { classes: 12 }, T + 10);
      expect(await lastChangeOf(h.db, id)).toBe(T + 10);

      const evidenceFile = newId(T);
      await h.db
        .insertInto('accred_evidence')
        .values({ id: newId(T), period_id: id, indicator_code: 'SCH-SP1', evidence_code: 'floor_plan', entity: null, entity_id: null, file_id: evidenceFile, caption: 'Denah', created_at: T + 11, created_by: null })
        .execute();
      expect(await lastChangeOf(h.db, id)).toBe(T + 11);

      // An answer is read directly where it matters: it does not move the last change.
      await answer(id, 'SCH-SP1', { answer: 'a', mode: 'manual', note: null }, T + 12);
      expect(await lastChangeOf(h.db, id)).toBe(T + 11);

      const runRow = (kind: string, status: string, finishedAt: number, dryRun = 0) => ({
        id: newId(finishedAt),
        kind,
        status,
        dry_run: dryRun,
        format: null,
        options: '{}',
        summary: '{}',
        report_file_id: null,
        output_name: null,
        output_size: null,
        expires_at: null,
        job_id: null,
        created_at: finishedAt - 1,
        created_by: null,
        finished_at: finishedAt,
      });
      await h.db.insertInto('catalog_runs').values(runRow('slims_usage', 'succeeded', T + 13)).execute();
      expect(await lastChangeOf(h.db, id)).toBe(T + 13);
      await h.db.insertInto('catalog_runs').values(runRow('slims_usage', 'failed', T + 14)).execute();
      await h.db.insertInto('catalog_runs').values(runRow('migration', 'succeeded', T + 15, 1)).execute();
      await h.db.insertInto('catalog_runs').values(runRow('export', 'succeeded', T + 16)).execute();
      expect(await lastChangeOf(h.db, id)).toBe(T + 13);
      expect(await catalogSyncedAt(h.db)).toBeNull();
      await h.db.insertInto('catalog_runs').values(runRow('migration', 'succeeded', T + 17)).execute();
      expect(await lastChangeOf(h.db, id)).toBe(T + 17);
      expect(await catalogSyncedAt(h.db)).toBe(T + 17);
    });

    it('stale: nothing computed, or a change at or after the computation; the last usage import and the catalogue sync on the page', async () => {
      const id = (await listPeriods(h.db)).periods.find((p) => p.startsOn === '2030-07-01')!.id;
      const changed = (await lastChangeOf(h.db, id))!;
      let view = await getPeriod(h.db, id, NOW);
      expect(view).toMatchObject({ lastChangeAt: changed, computedAt: null, stale: true, catalogSyncedAt: T + 17 });

      const meta = (computedAt: number) => JSON.stringify({ status: 'ready', startedAt: computedAt, jobId: newId(), computedAt, durationMs: 10 });
      await h.db.insertInto('accred_results').values({ period_id: id, indicator_code: '_meta', payload: meta(changed), computed_at: changed }).execute();
      view = await getPeriod(h.db, id, NOW);
      expect(view).toMatchObject({ computedAt: changed, stale: true });
      expect((await listPeriods(h.db)).periods.find((p) => p.id === id)).toMatchObject({ computedAt: changed, stale: true });

      await h.db.updateTable('accred_results').set({ payload: meta(changed + 1) }).where('period_id', '=', id).execute();
      expect(await getPeriod(h.db, id, NOW)).toMatchObject({ computedAt: changed + 1, stale: false });
      expect((await listPeriods(h.db)).periods.find((p) => p.id === id)).toMatchObject({ computedAt: changed + 1, stale: false });

      await patch(id, { classes: 14 }, changed + 2);
      expect(await getPeriod(h.db, id, NOW)).toMatchObject({ lastChangeAt: changed + 2, stale: true });

      // The last succeeded usage import, with the cut-over day of its options.
      const usageRun = newId(changed + 3);
      await h.db
        .insertInto('catalog_runs')
        .values({
          id: usageRun,
          kind: 'slims_usage',
          status: 'succeeded',
          dry_run: 0,
          format: null,
          options: JSON.stringify({ sourceKind: 'dump', periodId: id, cutoverOn: '2031-01-15', dedupeMinutes: 60 }),
          summary: '{}',
          report_file_id: null,
          output_name: null,
          output_size: null,
          expires_at: null,
          job_id: null,
          created_at: changed + 2,
          created_by: null,
          finished_at: changed + 3,
        })
        .execute();
      expect((await getPeriod(h.db, id, NOW)).lastUsageImport).toEqual({ runId: usageRun, finishedAt: changed + 3, cutoverOn: '2031-01-15' });
    });

    it('the list: live periods, the latest span first', async () => {
      const list = (await listPeriods(h.db)).periods;
      const starts = list.map((p) => p.startsOn);
      expect([...starts].sort().reverse()).toEqual(starts);
      expect(list[0]).toEqual({
        id: expect.any(String),
        name: 'Periode uji',
        instrumentId: 'test-sch',
        kind: 'school_year',
        startsOn: '2033-07-01',
        endsOn: '2034-06-30',
        status: 'open',
        computedAt: null,
        stale: true,
      });
    });
  });
});
