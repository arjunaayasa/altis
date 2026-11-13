import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { isDomainError, newId } from '@altis/shared';
import type { EvidenceCreateBody } from '@altis/shared/api/accreditation';
import type { KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { archiveEvidence, createEvidence, evidenceChecklist, listEvidence } from '../../src/accreditation/evidence/index.js';
import { instrumentById } from '../../src/accreditation/instruments/index.js';
import { archiveRegisterRow, createRegisterRow } from '../../src/accreditation/registers/index.js';
import { txCtx, type Actor, type TxCtx } from '../../src/context.js';

// The evidence files on the engine picked by ALTIS_TEST_DB, on periods of the test instrument `test-sch` (its
// indicators K1, K2, K3 and SP1 carry the school instruments' real evidence lists):
// - a period's evidence takes the period's lock first (a frozen period refuses it with ACCRED_PERIOD_FROZEN), then
//   claims the upload; a register row's evidence takes no period lock;
// - the indicator must be one of the instrument's (or the profile or the prerequisites), the item one of the
//   indicator's; the linked register row must be live;
// - archiving deletes the row, releases the file, touches the period (and the register row), and empties the profile
//   photo slot that named the file;
// - the checklist per indicator, and the size of each component's files.

const ctx = testDbContext();

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 0);
const EARLIER = NOW - 86_400_000;
const STAFF = newId(EARLIER);
const ACTOR: Actor = { type: 'staff', id: STAFF, ip: null };

/** What a rejected promise rejected with: `{code, errors?}` for a DomainError, else the error; 'resolved' when it did not. */
async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => 'resolved',
    (e: unknown) => {
      if (!isDomainError(e)) return e;
      const errors = (e.meta as { errors?: unknown } | undefined)?.errors;
      return errors === undefined ? { code: e.code } : { code: e.code, errors };
    },
  );
}

describe.skipIf(!ctx.available)(`evidence files [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;

  const run = <T>(fn: (tx: TxCtx) => Promise<T>, now = NOW): Promise<T> => withTx(h, (trx) => fn(txCtx(trx, now, ACTOR)));

  /** A period of `test-sch` in `status` (written at EARLIER), with `profile`; its id. */
  async function period(status: 'open' | 'frozen' = 'open', profile: object = {}): Promise<string> {
    const id = newId(EARLIER);
    await h.db
      .insertInto('accred_periods')
      .values({
        id,
        name: 'Tahun ajaran 2025/2026',
        instrument_id: 'test-sch',
        kind: 'school_year',
        starts_on: '2025-07-01',
        ends_on: '2026-06-30',
        branch_id: null,
        profile: JSON.stringify(profile),
        all_registered_confirmed: 0,
        status,
        frozen_at: status === 'frozen' ? EARLIER : null,
        frozen_by: null,
        archived_at: null,
        version: 3,
        created_at: EARLIER,
        created_by: null,
        updated_at: EARLIER,
        updated_by: null,
      })
      .execute();
    return id;
  }

  /** A completed upload of `context` nobody owns, of `size` bytes; its id. */
  async function upload(o: { context?: string; name?: string; size?: number; mime?: string } = {}): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('files')
      .values({
        id,
        original_name: o.name ?? 'bukti.pdf',
        mime: o.mime ?? 'application/pdf',
        size: o.size ?? 1000,
        sha256: '0'.repeat(64),
        context: o.context ?? 'accreditation.evidence',
        owner_type: null,
        owner_id: null,
        access: 'staff',
        status: 'ok',
        created_at: EARLIER,
        created_by: null,
      })
      .execute();
    return id;
  }

  const ownerOf = async (fileId: string) => h.db.selectFrom('files').select(['owner_type', 'owner_id']).where('id', '=', fileId).executeTakeFirstOrThrow();
  const periodRow = async (id: string) => {
    const r = await h.db.selectFrom('accred_periods').select(['updated_at', 'version', 'profile']).where('id', '=', id).executeTakeFirstOrThrow();
    return { updatedAt: Number(r.updated_at), version: Number(r.version), profile: JSON.parse(r.profile) as Record<string, unknown> };
  };
  const evidenceRow = (id: string) => h.db.selectFrom('accred_evidence').selectAll().where('id', '=', id).executeTakeFirst();

  /** Evidence of `periodId` through the service; its id. */
  async function evidence(periodId: string, body: Partial<EvidenceCreateBody> = {}): Promise<string> {
    const uploadId = body.uploadId ?? (await upload());
    const res = await run((tx) =>
      createEvidence(tx, { uploadId, periodId, indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot', caption: 'Tangkapan layar katalog', ...body }, NOW),
    );
    return res.id;
  }

  /** An activity of the register, written at EARLIER; its id. */
  const activity = async (): Promise<string> =>
    (
      await run(
        (tx) =>
          createRegisterRow(tx, 'activities', { kind: 'promotion', title: 'Pameran Buku', heldOn: '2025-10-01', usesLibraryFacility: false, externalSpeaker: false }, EARLIER),
        EARLIER,
      )
    ).id;

  /** The statements of `fn`'s transaction, transaction control left out, captured through a plugin of this test. */
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

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-evidence-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('a period`s evidence: the upload is claimed by the row, the period`s updated_at moves; audited once without the caption', async () => {
    const periodId = await period();
    const fileId = await upload({ name: 'katalog-online.jpg', mime: 'image/jpeg', size: 2048 });
    const seq = Number((await h.db.selectFrom('audit_log').select((eb) => eb.fn.max('seq').as('seq')).executeTakeFirst())?.seq ?? 0);
    const id = await evidence(periodId, { uploadId: fileId, caption: 'Katalog daring sekolah' });
    expect(await ownerOf(fileId)).toEqual({ owner_type: 'accred_evidence', owner_id: id });
    expect(await evidenceRow(id)).toMatchObject({ period_id: periodId, indicator_code: 'SCH-K1', evidence_code: 'catalogue_screenshot', file_id: fileId, caption: 'Katalog daring sekolah' });
    expect(await periodRow(periodId)).toMatchObject({ updatedAt: NOW, version: 3 });

    const audits = await h.db.selectFrom('audit_log').select(['action', 'entity', 'entity_id', 'meta']).where('seq', '>', seq).orderBy('seq').execute();
    expect(audits.map((a) => [a.action, a.entity, a.entity_id])).toEqual([['accreditation.evidence.create', 'accred_evidence', id]]);
    expect(JSON.parse(audits[0]!.meta)).toEqual({
      entity: 'accred_evidence',
      id,
      fields: ['uploadId', 'periodId', 'indicatorCode', 'evidenceCode', 'caption'],
      periodId,
      indicatorCode: 'SCH-K1',
      evidenceCode: 'catalogue_screenshot',
      linkedEntity: null,
    });
    expect(audits[0]!.meta).not.toContain('Katalog daring');
  });

  it('a frozen period refuses its evidence (ACCRED_PERIOD_FROZEN) and the upload stays unclaimed', async () => {
    const periodId = await period('frozen');
    const fileId = await upload();
    expect(await failure(evidence(periodId, { uploadId: fileId }))).toEqual({ code: 'ACCRED_PERIOD_FROZEN' });
    expect(await ownerOf(fileId)).toEqual({ owner_type: null, owner_id: null });
    expect(await failure(evidence(newId(), { uploadId: fileId }))).toEqual({ code: 'NOT_FOUND' });
  });

  it('a register row`s evidence takes no period lock: accepted while a period is frozen; the row`s updated_at moves', async () => {
    await period('frozen');
    const activityId = await activity();
    const fileId = await upload({ name: 'foto-pameran.jpg', mime: 'image/jpeg' });
    const { id } = await run((tx) => createEvidence(tx, { uploadId: fileId, entity: 'library_activities', entityId: activityId, caption: 'Foto pameran' }, NOW));
    expect(await evidenceRow(id)).toMatchObject({ period_id: null, entity: 'library_activities', entity_id: activityId });
    const touched = await h.db.selectFrom('library_activities').select('updated_at').where('id', '=', activityId).executeTakeFirstOrThrow();
    expect(Number(touched.updated_at)).toBe(NOW);

    const listed = await listEvidence(h.db, { entity: 'library_activities', entityId: activityId });
    expect(listed.evidence.map((e) => [e.id, e.fileId, e.fileName, e.caption])).toEqual([[id, fileId, 'foto-pameran.jpg', 'Foto pameran']]);
    expect(listed.componentBytes).toEqual({ K: 0, SP: 0, L: 0, T: 0, F: 0, G: 0, profil: 0 });

    // An archived or unknown register row: `entityId` not_found, and the upload stays unclaimed.
    await run((tx) => archiveRegisterRow(tx, 'activities', activityId, NOW));
    const other = await upload();
    expect(await failure(run((tx) => createEvidence(tx, { uploadId: other, entity: 'library_activities', entityId: activityId, caption: '' }, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'entityId', code: 'not_found' }],
    });
    expect(await failure(run((tx) => createEvidence(tx, { uploadId: other, entity: 'library_staff', entityId: newId(), caption: '' }, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'entityId', code: 'not_found' }],
    });
    expect(await ownerOf(other)).toEqual({ owner_type: null, owner_id: null });
  });

  it('the indicator must be one of the instrument`s, the item one of the indicator`s', async () => {
    const periodId = await period();
    expect(await failure(evidence(periodId, { indicatorCode: 'SCH-K2', evidenceCode: 'title_list' }))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'evidenceCode', code: 'invalid' }],
    });
    expect(await failure(evidence(periodId, { indicatorCode: 'SCH-L7', evidenceCode: 'activity_list' }))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'indicatorCode', code: 'invalid' }],
    });
    expect(await failure(evidence(periodId, { indicatorCode: 'SCH-PROFIL', evidenceCode: 'catalogue_screenshot' }))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'evidenceCode', code: 'invalid' }],
    });
    expect(await failure(evidence(periodId, { indicatorCode: 'SCH-PRASYARAT', evidenceCode: 'photo_front' }))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'evidenceCode', code: 'invalid' }],
    });
    // Accepted: an item of the indicator, a profile photo, the prerequisites or an indicator without an item, the period alone.
    for (const body of [
      { indicatorCode: 'SCH-K2', evidenceCode: 'fiction_screenshot' },
      { indicatorCode: 'SCH-SP1', evidenceCode: 'floor_plan' },
      { indicatorCode: 'SCH-PROFIL', evidenceCode: 'photo_reading_room' },
      { indicatorCode: 'SCH-PRASYARAT', evidenceCode: null },
      { indicatorCode: 'SCH-K3', evidenceCode: null },
      { indicatorCode: null, evidenceCode: null },
    ]) {
      expect(await evidenceRow(await evidence(periodId, body))).toMatchObject({ indicator_code: body.indicatorCode, evidence_code: body.evidenceCode });
    }
  });

  it('only an unowned completed accreditation upload is claimed (`uploadId` not_found otherwise)', async () => {
    const periodId = await period();
    const cover = await upload({ context: 'catalog.cover' });
    expect(await failure(evidence(periodId, { uploadId: cover }))).toEqual({ code: 'VALIDATION_FAILED', errors: [{ path: 'uploadId', code: 'not_found' }] });
    const fileId = await upload();
    await evidence(periodId, { uploadId: fileId });
    expect(await failure(evidence(periodId, { uploadId: fileId }))).toEqual({ code: 'VALIDATION_FAILED', errors: [{ path: 'uploadId', code: 'not_found' }] });
  });

  it('archive deletes the row, releases its file and moves the period`s updated_at; audited once', async () => {
    const periodId = await period();
    const fileId = await upload();
    const id = await evidence(periodId, { uploadId: fileId });
    await h.db.updateTable('accred_periods').set({ updated_at: EARLIER }).where('id', '=', periodId).execute();
    const seq = Number((await h.db.selectFrom('audit_log').select((eb) => eb.fn.max('seq').as('seq')).executeTakeFirst())?.seq ?? 0);

    expect(await run((tx) => archiveEvidence(tx, id, NOW + 5_000), NOW + 5_000)).toEqual({ id, version: 0 });
    expect(await evidenceRow(id)).toBeUndefined();
    expect(await ownerOf(fileId)).toEqual({ owner_type: null, owner_id: null });
    expect(await periodRow(periodId)).toMatchObject({ updatedAt: NOW + 5_000, version: 3 });
    const audits = await h.db.selectFrom('audit_log').select(['action', 'entity', 'entity_id', 'meta']).where('seq', '>', seq).orderBy('seq').execute();
    expect(audits.map((a) => [a.action, a.entity, a.entity_id, JSON.parse(a.meta) as unknown])).toEqual([
      [
        'accreditation.evidence.archive',
        'accred_evidence',
        id,
        { entity: 'accred_evidence', id, fields: [], periodId, indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot', linkedEntity: null },
      ],
    ]);
    expect(await failure(run((tx) => archiveEvidence(tx, id, NOW)))).toEqual({ code: 'NOT_FOUND' });
  });

  it('archive on a frozen period: ACCRED_PERIOD_FROZEN, the row and its file stay', async () => {
    const periodId = await period();
    const fileId = await upload();
    const id = await evidence(periodId, { uploadId: fileId });
    await h.db.updateTable('accred_periods').set({ status: 'frozen', frozen_at: NOW }).where('id', '=', periodId).execute();
    expect(await failure(run((tx) => archiveEvidence(tx, id, NOW)))).toEqual({ code: 'ACCRED_PERIOD_FROZEN' });
    expect(await evidenceRow(id)).toMatchObject({ id, file_id: fileId });
    expect(await ownerOf(fileId)).toEqual({ owner_type: 'accred_evidence', owner_id: id });
  });

  it('archive of a register row`s evidence touches the register row, even while a period is frozen', async () => {
    await period('frozen');
    const activityId = await activity();
    const fileId = await upload();
    const { id } = await run((tx) => createEvidence(tx, { uploadId: fileId, entity: 'library_activities', entityId: activityId, caption: 'Foto' }, NOW));
    await run((tx) => archiveEvidence(tx, id, NOW + 7_000), NOW + 7_000);
    expect(await ownerOf(fileId)).toEqual({ owner_type: null, owner_id: null });
    const touched = await h.db.selectFrom('library_activities').select('updated_at').where('id', '=', activityId).executeTakeFirstOrThrow();
    expect(Number(touched.updated_at)).toBe(NOW + 7_000);
  });

  it('archiving the evidence of the front photo empties profile.photos.front in the same transaction', async () => {
    const front = await upload({ name: 'depan.jpg', mime: 'image/jpeg' });
    const room = await upload({ name: 'ruang-baca.jpg', mime: 'image/jpeg' });
    const periodId = await period('open', { npp: '3204012345678901', photos: { front, collection: null, staff: null, readingRoom: room } });
    const frontRow = await evidence(periodId, { uploadId: front, indicatorCode: 'SCH-PROFIL', evidenceCode: 'photo_front', caption: 'Tampak depan' });
    await evidence(periodId, { uploadId: room, indicatorCode: 'SCH-PROFIL', evidenceCode: 'photo_reading_room', caption: 'Ruang baca' });

    await run((tx) => archiveEvidence(tx, frontRow, NOW + 9_000), NOW + 9_000);
    const after = await periodRow(periodId);
    expect(after.profile).toEqual({ npp: '3204012345678901', photos: { front: null, collection: null, staff: null, readingRoom: room } });
    // The profile changed: the period's version moves with it.
    expect(after).toMatchObject({ updatedAt: NOW + 9_000, version: 4 });
  });

  it('the period lock is the first statement of a period`s evidence create and archive, before any files read', async () => {
    const periodId = await period();
    const fileId = await upload();
    let id = '';
    const create = await statementsOf(async (tx) => {
      id = (
        await createEvidence(tx, { uploadId: fileId, periodId, indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot', caption: 'Katalog' }, NOW)
      ).id;
    });
    expect(create[0]).toMatch(/^update ["`]accred_periods["`] set ["`]version["`] = ["`]version["`] where/);
    expect(create.findIndex((sql) => /["`]files["`]/.test(sql))).toBeGreaterThan(0);

    const archive = await statementsOf((tx) => archiveEvidence(tx, id, NOW));
    expect(archive[0]).toMatch(/^update ["`]accred_periods["`] set ["`]version["`] = ["`]version["`] where/);
    expect(archive.findIndex((sql) => /["`]files["`]/.test(sql))).toBeGreaterThan(0);
    expect(await ownerOf(fileId)).toEqual({ owner_type: null, owner_id: null });
  });

  it('the checklist per indicator: generated items present, others present with ≥ 1 linked file, in the instrument`s order', async () => {
    const periodId = await period();
    const shot = await upload({ name: 'opac.png.jpg', mime: 'image/jpeg' });
    await evidence(periodId, { uploadId: shot, indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot', caption: 'OPAC sekolah' });
    // Another period's evidence never counts.
    await evidence(await period(), { indicatorCode: 'SCH-K3', evidenceCode: 'policy_document' });

    const instrument = instrumentById('test-sch');
    if (instrument === null) throw new Error('the test build has no test-sch instrument');
    const checklist = await evidenceChecklist(h.db, periodId, instrument);
    expect([...checklist.keys()]).toEqual(['SCH-K1', 'SCH-K2', 'SCH-K3', 'SCH-SP1']);
    expect(checklist.get('SCH-K1')).toEqual([
      { code: 'title_list', present: true, files: [] },
      { code: 'catalogue_screenshot', present: true, files: [{ id: shot, name: 'opac.png.jpg', caption: 'OPAC sekolah' }] },
      { code: 'ddc_recap', present: true, files: [] },
    ]);
    expect(checklist.get('SCH-K3')).toEqual([{ code: 'policy_document', present: false, files: [] }]);
    expect(checklist.get('SCH-SP1')).toEqual([
      { code: 'floor_plan', present: false, files: [] },
      { code: 'room_photos', present: false, files: [] },
    ]);
  });

  it('componentBytes: the sum of the period`s file sizes per component (the profile under `profil`), whatever the list shows', async () => {
    const periodId = await period();
    await evidence(periodId, { uploadId: await upload({ size: 4_000_000 }), indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot' });
    await evidence(periodId, { uploadId: await upload({ size: 5_500_000 }), indicatorCode: 'SCH-K3', evidenceCode: 'policy_document' });
    await evidence(periodId, { uploadId: await upload({ size: 700_000 }), indicatorCode: 'SCH-SP1', evidenceCode: 'floor_plan' });
    await evidence(periodId, { uploadId: await upload({ size: 300_000 }), indicatorCode: 'SCH-PROFIL', evidenceCode: 'photo_front' });
    await evidence(periodId, { uploadId: await upload({ size: 90_000 }), indicatorCode: 'SCH-PRASYARAT', evidenceCode: null });

    const all = await listEvidence(h.db, { periodId });
    expect(all.evidence).toHaveLength(5);
    expect(all.componentBytes).toEqual({ K: 9_500_000, SP: 700_000, L: 0, T: 0, F: 0, G: 0, profil: 300_000 });
    const k3 = await listEvidence(h.db, { periodId, indicatorCode: 'SCH-K3' });
    expect(k3.evidence.map((e) => [e.indicatorCode, e.evidenceCode, e.size, e.mime])).toEqual([['SCH-K3', 'policy_document', 5_500_000, 'application/pdf']]);
    expect(k3.componentBytes).toEqual(all.componentBytes);
    expect(await failure(listEvidence(h.db, {}))).toEqual({ code: 'VALIDATION_FAILED', errors: [{ path: 'periodId', code: 'required' }] });
  });
});
