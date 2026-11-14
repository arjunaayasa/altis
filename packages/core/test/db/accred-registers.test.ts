import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { isDomainError, newId } from '@altis/shared';
import type { RegisterKind, StaffView } from '@altis/shared/api/accreditation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import {
  archiveRegisterRow,
  archiveTraining,
  createRegisterRow,
  createTraining,
  listRegister,
  updateRegisterRow,
  updateTraining,
} from '../../src/accreditation/registers/index.js';
import { txCtx, type Actor, type TxCtx } from '../../src/context.js';

// The five registers of the library and the staff trainings on the engine picked by ALTIS_TEST_DB: create, list,
// update with the version the client read (a stale one is CONFLICT_STALE), soft archive; a branch other than null is
// refused; a budget year is unique among the live rows and free again once archived; a document's aspects come from its
// kind's list; the staff list embeds the live trainings, and a training needs a live staff member; files are claimed
// from completed `accreditation.evidence` uploads nobody owns, and a replaced file is released; every write audits once
// with the names of the fields, never their values; the registers stay editable while a period is frozen.

const ctx = testDbContext();

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 0);
const STAFF = newId(NOW - 86_400_000);
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

/** A create body and a patch (without its version) of each register, the patch changing `field`. */
const SAMPLES: Readonly<Record<RegisterKind, { body: Record<string, unknown>; patch: Record<string, unknown>; field: string }>> = {
  activities: {
    body: { kind: 'promotion', title: 'Pameran Buku Baru', heldOn: '2026-02-10', participants: 40, partner: 'OSIS', usesLibraryFacility: true, externalSpeaker: false },
    patch: { title: 'Pameran Buku Baru Semester Genap' },
    field: 'title',
  },
  staff: {
    body: {
      name: 'Siti Rahmawati',
      role: 'head',
      isLibrarian: true,
      employment: 'civil_servant',
      educationLevel: 's1',
      educationLibrary: false,
      libraryTraining: true,
      competencyCert: false,
      associationMember: true,
      appointmentRef: '800/112/SMA/2024',
      startsOn: '2024-07-15',
    },
    patch: { position: 'Kepala Perpustakaan' },
    field: 'position',
  },
  partnerships: {
    body: { partner: 'Dinas Perpustakaan Kabupaten', kind: 'mou', startsOn: '2025-02-01', endsOn: '2027-01-31', scope: 'Layanan perpustakaan keliling' },
    patch: { kind: 'pks' },
    field: 'kind',
  },
  budgets: {
    body: { year: 2024, libraryMinor: 650_000_000, parentNonpersonnelMinor: 10_000_000_000, currency: 'IDR' },
    patch: { collectionMinor: 250_000_000 },
    field: 'collectionMinor',
  },
  documents: {
    body: { kind: 'collection_policy', title: 'Kebijakan Pengembangan Koleksi', reference: '421.3/015/2025', issuedOn: '2025-08-01', aspectCodes: ['a1', 'a2', 'a3'] },
    patch: { issuedBy: 'Kepala Sekolah' },
    field: 'issuedBy',
  },
};

const TABLES: Readonly<Record<RegisterKind, string>> = {
  activities: 'library_activities',
  staff: 'library_staff',
  partnerships: 'library_partnerships',
  budgets: 'library_budgets',
  documents: 'library_documents',
};

describe.skipIf(!ctx.available)(`registers of the library [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let yearSerial = 0;

  const run = <T>(fn: (tx: TxCtx) => Promise<T>, now = NOW): Promise<T> => withTx(h, (trx) => fn(txCtx(trx, now, ACTOR)));

  /** The sample create body of `kind`, a budget with a year of its own. */
  const sample = (kind: RegisterKind): Record<string, unknown> =>
    kind === 'budgets' ? { ...SAMPLES.budgets.body, year: 1950 + (yearSerial += 1) } : { ...SAMPLES[kind].body };

  /** A completed upload of `context` nobody owns (its `files` row, as completion leaves it); its id. */
  async function upload(context = 'accreditation.evidence', name = 'sertifikat.pdf'): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('files')
      .values({
        id,
        original_name: name,
        mime: 'application/pdf',
        size: 1234,
        sha256: '0'.repeat(64),
        context,
        owner_type: null,
        owner_id: null,
        access: 'staff',
        status: 'ok',
        created_at: NOW,
        created_by: null,
      })
      .execute();
    return id;
  }

  const ownerOf = async (fileId: string) => h.db.selectFrom('files').select(['owner_type', 'owner_id']).where('id', '=', fileId).executeTakeFirstOrThrow();

  async function lastSeq(): Promise<number> {
    const row = await h.db.selectFrom('audit_log').select((eb) => eb.fn.max('seq').as('seq')).executeTakeFirst();
    return Number(row?.seq ?? 0);
  }

  /** The audit entries after `seq`, as `{action, entity, entityId, meta}`. */
  async function auditsAfter(seq: number): Promise<{ action: string; entity: string | null; entityId: string | null; meta: Record<string, unknown> }[]> {
    const rows = await h.db.selectFrom('audit_log').select(['action', 'entity', 'entity_id', 'meta']).where('seq', '>', seq).orderBy('seq').execute();
    return rows.map((r) => ({ action: r.action, entity: r.entity, entityId: r.entity_id, meta: JSON.parse(r.meta) as Record<string, unknown> }));
  }

  /** A staff member through the service; its id. */
  const staff = async (): Promise<string> => (await run((tx) => createRegisterRow(tx, 'staff', sample('staff') as never, NOW))).id;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-registers-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  for (const kind of Object.keys(SAMPLES) as RegisterKind[]) {
    it(`${kind}: create, list, update, a stale version, archive; each write audited once with field names only`, async () => {
      const seq = await lastSeq();
      const created = await run((tx) => createRegisterRow(tx, kind, sample(kind) as never, NOW));
      expect(created).toEqual({ id: expect.any(String), version: 0 });
      const listed = (await listRegister(h.db, kind)).rows.find((r) => r.id === created.id);
      expect(listed).toMatchObject({ id: created.id, version: 0, createdAt: NOW, createdBy: STAFF, updatedAt: NOW, updatedBy: STAFF });

      const patch = SAMPLES[kind].patch;
      expect(await run((tx) => updateRegisterRow(tx, kind, created.id, { version: 0, ...patch } as never, NOW + 1_000), NOW + 1_000)).toEqual({ id: created.id, version: 1 });
      const updated = (await listRegister(h.db, kind)).rows.find((r) => r.id === created.id) as unknown as Record<string, unknown>;
      expect(updated[SAMPLES[kind].field]).toEqual(Object.values(patch)[0]);
      expect(updated).toMatchObject({ version: 1, updatedAt: NOW + 1_000 });

      expect(await failure(run((tx) => updateRegisterRow(tx, kind, created.id, { version: 0, ...patch } as never, NOW + 2_000)))).toEqual({ code: 'CONFLICT_STALE' });

      expect(await run((tx) => archiveRegisterRow(tx, kind, created.id, NOW + 3_000), NOW + 3_000)).toEqual({ id: created.id, version: 2 });
      expect((await listRegister(h.db, kind)).rows.map((r) => r.id)).not.toContain(created.id);
      const stored = await h.db
        .selectFrom(TABLES[kind] as 'library_activities')
        .select(['archived_at', 'updated_at'])
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect({ archivedAt: Number(stored.archived_at), updatedAt: Number(stored.updated_at) }).toEqual({ archivedAt: NOW + 3_000, updatedAt: NOW + 3_000 });
      expect(await failure(run((tx) => updateRegisterRow(tx, kind, created.id, { version: 2, ...patch } as never, NOW)))).toEqual({ code: 'NOT_FOUND' });
      expect(await failure(run((tx) => archiveRegisterRow(tx, kind, created.id, NOW)))).toEqual({ code: 'NOT_FOUND' });
      expect(await failure(run((tx) => archiveRegisterRow(tx, kind, newId(), NOW)))).toEqual({ code: 'NOT_FOUND' });

      const audits = await auditsAfter(seq);
      expect(audits.map((a) => a.action)).toEqual(['accreditation.register.create', 'accreditation.register.update', 'accreditation.register.archive']);
      for (const a of audits) {
        expect(a.entity).toBe(TABLES[kind]);
        expect(a.entityId).toBe(created.id);
        expect(Object.keys(a.meta).sort()).toEqual(['entity', 'fields', 'id']);
        expect(a.meta).toMatchObject({ entity: TABLES[kind], id: created.id });
      }
      expect(audits[0]!.meta['fields']).toEqual(Object.keys(sample(kind)));
      expect(audits[1]!.meta['fields']).toEqual([SAMPLES[kind].field]);
      expect(audits[2]!.meta['fields']).toEqual([]);
      // Names only: no value of a body reaches the audit log.
      const metaText = JSON.stringify(audits.map((a) => a.meta));
      for (const value of [...Object.values(SAMPLES[kind].body), ...Object.values(patch)]) {
        if (typeof value === 'string' && value.length > 3) expect(metaText).not.toContain(value);
      }
    });

    it(`${kind}: a branch other than null is refused (the registers are library-wide); null is accepted`, async () => {
      expect(await failure(run((tx) => createRegisterRow(tx, kind, { ...sample(kind), branchId: newId() } as never, NOW)))).toEqual({
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'branchId', code: 'branch_scope_not_available' }],
      });
      const created = await run((tx) => createRegisterRow(tx, kind, { ...sample(kind), branchId: null } as never, NOW));
      expect(await failure(run((tx) => updateRegisterRow(tx, kind, created.id, { version: 0, branchId: 'cabang-utara' } as never, NOW)))).toEqual({
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'branchId', code: 'branch_scope_not_available' }],
      });
      const row = await h.db
        .selectFrom(TABLES[kind] as 'library_activities')
        .select('branch_id')
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow();
      expect(row.branch_id).toBeNull();
    });
  }

  it('activities: an end before the start is invalid, on create and on a patch against the stored start', async () => {
    expect(await failure(run((tx) => createRegisterRow(tx, 'activities', { ...SAMPLES.activities.body, endedOn: '2026-02-09' } as never, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'endedOn', code: 'invalid' }],
    });
    const { id } = await run((tx) => createRegisterRow(tx, 'activities', SAMPLES.activities.body as never, NOW));
    expect(await failure(run((tx) => updateRegisterRow(tx, 'activities', id, { version: 0, endedOn: '2026-01-31' }, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'endedOn', code: 'invalid' }],
    });
    expect(await run((tx) => updateRegisterRow(tx, 'activities', id, { version: 0, endedOn: '2026-02-12' }, NOW))).toEqual({ id, version: 1 });
  });

  it('budgets: a second live budget of a year is `year` taken; once archived the year can be entered again', async () => {
    const body = { year: 2025, libraryMinor: 520_000_000, currency: 'IDR' };
    const first = await run((tx) => createRegisterRow(tx, 'budgets', body, NOW));
    expect(await failure(run((tx) => createRegisterRow(tx, 'budgets', { ...body, libraryMinor: 1 }, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'year', code: 'taken' }],
    });
    const other = await run((tx) => createRegisterRow(tx, 'budgets', { ...body, year: 2026 }, NOW));
    expect(await failure(run((tx) => updateRegisterRow(tx, 'budgets', other.id, { version: 0, year: 2025 }, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'year', code: 'taken' }],
    });

    await run((tx) => archiveRegisterRow(tx, 'budgets', first.id, NOW));
    const archived = await h.db.selectFrom('library_budgets').select(['scope_key', 'year']).where('id', '=', first.id).executeTakeFirstOrThrow();
    expect(archived).toEqual({ scope_key: `~${first.id}`, year: 2025 });
    const again = await run((tx) => createRegisterRow(tx, 'budgets', body, NOW));
    expect(again).toEqual({ id: expect.any(String), version: 0 });
    const live = (await listRegister(h.db, 'budgets')).rows.filter((r) => r.year === 2025 || r.year === 2026);
    expect(live.map((r) => [r.year, r.libraryMinor, r.currency])).toEqual([
      [2026, 520_000_000, 'IDR'],
      [2025, 520_000_000, 'IDR'],
    ]);
  });

  it('documents: aspect codes come from the kind`s list (aspectCodes.<i> invalid), a patch is checked against the stored kind', async () => {
    const policy = { kind: 'collection_policy', title: 'Kebijakan Koleksi' };
    expect(await failure(run((tx) => createRegisterRow(tx, 'documents', { ...policy, aspectCodes: ['a1', 'a9'] } as never, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'aspectCodes.1', code: 'invalid' }],
    });
    expect(await failure(run((tx) => createRegisterRow(tx, 'documents', { kind: 'rules', title: 'Tata Tertib', aspectCodes: ['a1'] } as never, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'aspectCodes.0', code: 'invalid' }],
    });
    // Stored once each, in the kind's order.
    const { id } = await run((tx) => createRegisterRow(tx, 'documents', { ...policy, aspectCodes: ['a3', 'a1', 'a3'] } as never, NOW));
    expect((await listRegister(h.db, 'documents')).rows.find((r) => r.id === id)?.aspectCodes).toEqual(['a1', 'a3']);

    const rules = await run((tx) => createRegisterRow(tx, 'documents', { kind: 'rules', title: 'Tata Tertib Perpustakaan' } as never, NOW));
    expect(await failure(run((tx) => updateRegisterRow(tx, 'documents', rules.id, { version: 0, aspectCodes: ['a2'] }, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'aspectCodes.0', code: 'invalid' }],
    });
    // A new kind without aspects refuses the aspects the row still holds.
    expect(await failure(run((tx) => updateRegisterRow(tx, 'documents', id, { version: 0, kind: 'rules' }, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [
        { path: 'aspectCodes.0', code: 'invalid' },
        { path: 'aspectCodes.1', code: 'invalid' },
      ],
    });
    expect(await run((tx) => updateRegisterRow(tx, 'documents', id, { version: 0, aspectCodes: ['a2', 'a8'] }, NOW))).toEqual({ id, version: 1 });
    expect((await listRegister(h.db, 'documents')).rows.find((r) => r.id === id)?.aspectCodes).toEqual(['a2', 'a8']);
  });

  it('staff: the list embeds the live trainings, latest first, with their certificate names', async () => {
    const staffId = await staff();
    const certificate = await upload('accreditation.evidence', 'sertifikat-diklat.pdf');
    const t1 = await run((tx) => createTraining(tx, staffId, { title: 'Diklat Pengelolaan Perpustakaan Sekolah', heldOn: '2025-03-10', hours: 40, certificateUploadId: certificate }, NOW));
    const t2 = await run((tx) => createTraining(tx, staffId, { title: 'Bimtek Katalogisasi', organizer: 'Perpusnas', heldOn: '2025-09-02' }, NOW));
    const t3 = await run((tx) => createTraining(tx, staffId, { title: 'Seminar Literasi', heldOn: '2024-11-20' }, NOW));
    await run((tx) => archiveTraining(tx, t3.id, NOW));

    const person = (await listRegister(h.db, 'staff')).rows.find((r) => r.id === staffId) as StaffView;
    expect(person.trainings).toEqual([
      { id: t2.id, staffId, title: 'Bimtek Katalogisasi', organizer: 'Perpusnas', heldOn: '2025-09-02', hours: null, certificateFileId: null, certificateFileName: null, version: 0 },
      {
        id: t1.id,
        staffId,
        title: 'Diklat Pengelolaan Perpustakaan Sekolah',
        organizer: null,
        heldOn: '2025-03-10',
        hours: 40,
        certificateFileId: certificate,
        certificateFileName: 'sertifikat-diklat.pdf',
        version: 0,
      },
    ]);
    expect(await ownerOf(certificate)).toEqual({ owner_type: 'staff_trainings', owner_id: t1.id });
  });

  it('staff: a training of an archived or unknown staff member is NOT_FOUND, for every write', async () => {
    const staffId = await staff();
    const t = await run((tx) => createTraining(tx, staffId, { title: 'Diklat Dasar', heldOn: '2025-01-10' }, NOW));
    await run((tx) => archiveRegisterRow(tx, 'staff', staffId, NOW));
    expect(await failure(run((tx) => createTraining(tx, staffId, { title: 'Diklat Lanjut', heldOn: '2025-05-10' }, NOW)))).toEqual({ code: 'NOT_FOUND' });
    expect(await failure(run((tx) => createTraining(tx, newId(), { title: 'Diklat Lanjut', heldOn: '2025-05-10' }, NOW)))).toEqual({ code: 'NOT_FOUND' });
    expect(await failure(run((tx) => updateTraining(tx, t.id, { version: 0, hours: 8 }, NOW)))).toEqual({ code: 'NOT_FOUND' });
    expect(await failure(run((tx) => archiveTraining(tx, t.id, NOW)))).toEqual({ code: 'NOT_FOUND' });
    expect((await listRegister(h.db, 'staff')).rows.map((r) => r.id)).not.toContain(staffId);
  });

  it('trainings: update with a stale version is CONFLICT_STALE; archive; each write audited once with entity staff_trainings', async () => {
    const staffId = await staff();
    const seq = await lastSeq();
    const t = await run((tx) => createTraining(tx, staffId, { title: 'Diklat Dasar', heldOn: '2025-01-10' }, NOW));
    expect(await run((tx) => updateTraining(tx, t.id, { version: 0, hours: 32 }, NOW))).toEqual({ id: t.id, version: 1 });
    expect(await failure(run((tx) => updateTraining(tx, t.id, { version: 0, hours: 8 }, NOW)))).toEqual({ code: 'CONFLICT_STALE' });
    expect(await run((tx) => archiveTraining(tx, t.id, NOW))).toEqual({ id: t.id, version: 2 });
    expect(await failure(run((tx) => archiveTraining(tx, t.id, NOW)))).toEqual({ code: 'NOT_FOUND' });
    const audits = (await auditsAfter(seq)).filter((a) => a.entityId === t.id);
    expect(audits.map((a) => [a.action, a.entity, a.meta])).toEqual([
      ['accreditation.register.create', 'staff_trainings', { entity: 'staff_trainings', id: t.id, fields: ['title', 'heldOn'] }],
      ['accreditation.register.update', 'staff_trainings', { entity: 'staff_trainings', id: t.id, fields: ['hours'] }],
      ['accreditation.register.archive', 'staff_trainings', { entity: 'staff_trainings', id: t.id, fields: [] }],
    ]);
  });

  it('files: only an unowned completed accreditation upload can be claimed (`<field>` not_found otherwise)', async () => {
    const staffId = await staff();
    const cover = await upload('catalog.cover', 'sampul.jpg');
    expect(await failure(run((tx) => createTraining(tx, staffId, { title: 'Diklat', heldOn: '2025-01-10', certificateUploadId: cover }, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'certificateUploadId', code: 'not_found' }],
    });
    expect(await ownerOf(cover)).toEqual({ owner_type: null, owner_id: null });
    expect(await failure(run((tx) => createTraining(tx, staffId, { title: 'Diklat', heldOn: '2025-01-10', certificateUploadId: newId() }, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'certificateUploadId', code: 'not_found' }],
    });

    const agreement = await upload('accreditation.evidence', 'mou.pdf');
    const p = await run((tx) => createRegisterRow(tx, 'partnerships', { ...SAMPLES.partnerships.body, documentUploadId: agreement } as never, NOW));
    expect(await ownerOf(agreement)).toEqual({ owner_type: 'library_partnerships', owner_id: p.id });
    // Owned already: another row cannot take it.
    expect(await failure(run((tx) => createRegisterRow(tx, 'documents', { kind: 'rules', title: 'Tata Tertib', fileUploadId: agreement } as never, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'fileUploadId', code: 'not_found' }],
    });
    const listed = (await listRegister(h.db, 'partnerships')).rows.find((r) => r.id === p.id);
    expect(listed).toMatchObject({ documentFileId: agreement, documentFileName: 'mou.pdf' });
  });

  it('files: replacing a file claims the new one and releases the old one; null releases it; the same id keeps it', async () => {
    const first = await upload('accreditation.evidence', 'sk-lama.pdf');
    const second = await upload('accreditation.evidence', 'sk-baru.pdf');
    const doc = await run((tx) => createRegisterRow(tx, 'documents', { kind: 'founding_decree', title: 'SK Pendirian', fileUploadId: first } as never, NOW));
    expect(await run((tx) => updateRegisterRow(tx, 'documents', doc.id, { version: 0, fileUploadId: first }, NOW))).toEqual({ id: doc.id, version: 1 });
    expect(await ownerOf(first)).toEqual({ owner_type: 'library_documents', owner_id: doc.id });

    const seq = await lastSeq();
    expect(await run((tx) => updateRegisterRow(tx, 'documents', doc.id, { version: 1, fileUploadId: second }, NOW))).toEqual({ id: doc.id, version: 2 });
    expect(await ownerOf(first)).toEqual({ owner_type: null, owner_id: null });
    expect(await ownerOf(second)).toEqual({ owner_type: 'library_documents', owner_id: doc.id });
    expect((await auditsAfter(seq))[0]?.meta).toEqual({ entity: 'library_documents', id: doc.id, fields: ['fileUploadId'] });
    expect((await listRegister(h.db, 'documents')).rows.find((r) => r.id === doc.id)).toMatchObject({ fileId: second, fileName: 'sk-baru.pdf' });

    expect(await run((tx) => updateRegisterRow(tx, 'documents', doc.id, { version: 2, fileUploadId: null }, NOW))).toEqual({ id: doc.id, version: 3 });
    expect(await ownerOf(second)).toEqual({ owner_type: null, owner_id: null });
    expect((await listRegister(h.db, 'documents')).rows.find((r) => r.id === doc.id)).toMatchObject({ fileId: null, fileName: null });

    // A training's certificate follows the same rule.
    const staffId = await staff();
    const cert = await upload();
    const cert2 = await upload();
    const t = await run((tx) => createTraining(tx, staffId, { title: 'Diklat', heldOn: '2025-01-10', certificateUploadId: cert }, NOW));
    await run((tx) => updateTraining(tx, t.id, { version: 0, certificateUploadId: cert2 }, NOW));
    expect([await ownerOf(cert), await ownerOf(cert2)]).toEqual([
      { owner_type: null, owner_id: null },
      { owner_type: 'staff_trainings', owner_id: t.id },
    ]);
  });

  it('staff: a linked ALTIS account must exist (`staffUserId` not_found)', async () => {
    expect(await failure(run((tx) => createRegisterRow(tx, 'staff', { ...SAMPLES.staff.body, staffUserId: newId() } as never, NOW)))).toEqual({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'staffUserId', code: 'not_found' }],
    });
  });

  it('registers stay editable while a period is frozen', async () => {
    await h.db
      .insertInto('accred_periods')
      .values({
        id: newId(NOW),
        name: 'Tahun ajaran 2025/2026',
        instrument_id: 'test-sch',
        kind: 'school_year',
        starts_on: '2025-07-01',
        ends_on: '2026-06-30',
        branch_id: null,
        profile: '{}',
        all_registered_confirmed: 0,
        status: 'frozen',
        frozen_at: NOW,
        frozen_by: null,
        archived_at: null,
        version: 0,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    const a = await run((tx) => createRegisterRow(tx, 'activities', { ...SAMPLES.activities.body, heldOn: '2025-09-01' } as never, NOW));
    expect(await run((tx) => updateRegisterRow(tx, 'activities', a.id, { version: 0, participants: 55 }, NOW))).toEqual({ id: a.id, version: 1 });
    expect(await run((tx) => archiveRegisterRow(tx, 'activities', a.id, NOW))).toEqual({ id: a.id, version: 2 });
  });
});
