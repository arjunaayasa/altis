import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import type { EvidenceListResponse, RegisterKind, StaffView } from '@altis/shared/api/accreditation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The registers and evidence API on the engine picked by ALTIS_TEST_DB:
// - `GET|POST accreditation/{activities,staff,partnerships,budgets,documents}`, `PATCH|DELETE …/:id`: the workspace's
//   readers list, its managers write; a write answers `{id, version}` only (201 for a create); a stale version is 409
//   CONFLICT_STALE; a branch other than null is 422 `branch_scope_not_available`;
// - `POST accreditation/staff/:id/trainings`, `PATCH|DELETE accreditation/trainings/:id`: the staff list embeds the
//   live trainings; a training of an archived staff member is 404;
// - `GET accreditation/evidence?periodId=&indicatorCode=` (with the size of each component's files), `POST
//   accreditation/evidence`, `DELETE accreditation/evidence/:id`, on periods of the test instrument `test-sch`: a frozen
//   period refuses its evidence (409 ACCRED_PERIOD_FROZEN), a register row's evidence does not need an open period.

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 21, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const API = '/api/v1/accreditation';

interface Client {
  get(p: string): Promise<AgentReply>;
  send(method: 'post' | 'patch' | 'put' | 'delete', p: string, body?: unknown): Promise<AgentReply>;
}

const code = (res: AgentReply): string | undefined => (res.json as { code?: string } | undefined)?.code;
const errors = (res: AgentReply): { path: string; code: string }[] => (res.json as { errors?: { path: string; code: string }[] }).errors ?? [];
const stored = (res: AgentReply): { id: string; version: number } => res.json as { id: string; version: number };

/** A create body and a patch (without its version) of each register. */
const SAMPLES: Readonly<Record<RegisterKind, { body: Record<string, unknown>; patch: Record<string, unknown> }>> = {
  activities: {
    body: { kind: 'reading_guidance', title: 'Bimbingan Membaca Kelas X', heldOn: '2026-01-15', participants: 32, usesLibraryFacility: true, externalSpeaker: false },
    patch: { participants: 34 },
  },
  staff: {
    body: {
      name: 'Dewi Lestari',
      role: 'librarian',
      isLibrarian: true,
      educationLibrary: true,
      libraryTraining: true,
      competencyCert: true,
      associationMember: false,
      startsOn: '2023-01-02',
    },
    patch: { employment: 'contract' },
  },
  partnerships: { body: { partner: 'Taman Baca Melati', kind: 'pks', startsOn: '2025-08-01' }, patch: { endsOn: '2026-07-31' } },
  budgets: { body: { year: 2023, libraryMinor: 480_000_000, currency: 'IDR' }, patch: { communityMinor: 15_000_000 } },
  documents: { body: { kind: 'library_program', title: 'Program Kerja Perpustakaan 2025/2026', aspectCodes: ['a1', 'a2'] }, patch: { validUntil: '2026-06-30' } },
};

describe.skipIf(!ctx.available)(`registers and evidence API [${engineLabel()}]`, () => {
  let root: string;
  let app: ReturnType<typeof createApp>;
  let manager: Client;
  let reader: Client;
  let cataloguer: Client;

  async function signedIn(username: string, permissions: string[]): Promise<Client> {
    const user = await seedStaff(h, { username, now: NOW, roles: [{ permissions: permissions as never }] });
    const token = await sessionCookieFor(h, user.id, { now: NOW });
    const agent = createAgent(app);
    agent.setCookie(SID, token);
    const csrf = { 'x-csrf-token': sessionCsrfFor(CONFIG, token) };
    return { get: (p) => agent.get(p), send: (method, p, body) => agent[method](p, body, csrf) };
  }

  /** A completed upload of `context` nobody owns (its `files` row, as completion leaves it); its id. */
  async function upload(context = 'accreditation.evidence', size = 1000, name = 'bukti.pdf'): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('files')
      .values({
        id,
        original_name: name,
        mime: 'application/pdf',
        size,
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

  /** A period of `test-sch` in `status`, with `profile`; its id. */
  async function period(status: 'open' | 'frozen' = 'open', profile: object = {}): Promise<string> {
    const id = newId(NOW);
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
        frozen_at: status === 'frozen' ? NOW : null,
        frozen_by: null,
        archived_at: null,
        version: 0,
        created_at: NOW - 60_000,
        created_by: null,
        updated_at: NOW - 60_000,
        updated_by: null,
      })
      .execute();
    return id;
  }

  const ownerOf = async (fileId: string) => h.db.selectFrom('files').select(['owner_type', 'owner_id']).where('id', '=', fileId).executeTakeFirstOrThrow();

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-accred-registers-')));
    const dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir);
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    manager = await signedIn('kelola_akreditasi', ['accreditation.workspace.manage', 'accreditation.workspace.read']);
    reader = await signedIn('baca_akreditasi', ['accreditation.workspace.read']);
    cataloguer = await signedIn('katalog_saja', ['catalog.records.read']);
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  for (const kind of Object.keys(SAMPLES) as RegisterKind[]) {
    it(`${kind}: create 201 {id, version}, list, update, a stale version 409, archive; readers list, only managers write`, async () => {
      const created = await manager.send('post', `${API}/${kind}`, SAMPLES[kind].body);
      expect(created.status, created.text).toBe(201);
      expect(created.json).toEqual({ id: expect.any(String), version: 0 });
      const { id } = stored(created);

      const listed = await reader.get(`${API}/${kind}`);
      expect(listed.status, listed.text).toBe(200);
      expect((listed.json as { rows: { id: string; version: number }[] }).rows.find((r) => r.id === id)).toMatchObject({ id, version: 0, ...SAMPLES[kind].body });

      const patched = await manager.send('patch', `${API}/${kind}/${id}`, { version: 0, ...SAMPLES[kind].patch });
      expect(patched.status, patched.text).toBe(200);
      expect(patched.json).toEqual({ id, version: 1 });
      const stale = await manager.send('patch', `${API}/${kind}/${id}`, { version: 0, ...SAMPLES[kind].patch });
      expect([stale.status, code(stale)]).toEqual([409, 'CONFLICT_STALE']);

      expect((await reader.send('post', `${API}/${kind}`, SAMPLES[kind].body)).status).toBe(403);
      expect((await cataloguer.get(`${API}/${kind}`)).status).toBe(403);

      const archived = await manager.send('delete', `${API}/${kind}/${id}`);
      expect(archived.status, archived.text).toBe(200);
      expect(archived.json).toEqual({ id, version: 2 });
      expect(((await reader.get(`${API}/${kind}`)).json as { rows: { id: string }[] }).rows.map((r) => r.id)).not.toContain(id);
      expect((await manager.send('delete', `${API}/${kind}/${id}`)).status).toBe(404);
    });

    it(`${kind}: a branch other than null is 422 branch_scope_not_available`, async () => {
      const res = await manager.send('post', `${API}/${kind}`, { ...SAMPLES[kind].body, ...(kind === 'budgets' ? { year: 2001 } : {}), branchId: newId() });
      expect([res.status, code(res)]).toEqual([422, 'VALIDATION_FAILED']);
      expect(errors(res)).toEqual([{ path: 'branchId', code: 'branch_scope_not_available' }]);
    });
  }

  it('budgets: the year 2025 twice is `year` taken; archived, the year is entered again (201)', async () => {
    const body = { year: 2025, libraryMinor: 520_000_000, currency: 'IDR' };
    const first = await manager.send('post', `${API}/budgets`, body);
    expect(first.status, first.text).toBe(201);
    const second = await manager.send('post', `${API}/budgets`, body);
    expect([second.status, errors(second)]).toEqual([422, [{ path: 'year', code: 'taken' }]]);
    expect((await manager.send('delete', `${API}/budgets/${stored(first).id}`)).status).toBe(200);
    const again = await manager.send('post', `${API}/budgets`, body);
    expect(again.status, again.text).toBe(201);
  });

  it('documents: a collection policy with a9 is aspectCodes.1 invalid; rules with any aspect are invalid', async () => {
    const policy = await manager.send('post', `${API}/documents`, { kind: 'collection_policy', title: 'Kebijakan Koleksi', aspectCodes: ['a1', 'a9'] });
    expect([policy.status, errors(policy)]).toEqual([422, [{ path: 'aspectCodes.1', code: 'invalid' }]]);
    const rules = await manager.send('post', `${API}/documents`, { kind: 'rules', title: 'Tata Tertib', aspectCodes: ['a1'] });
    expect([rules.status, errors(rules)]).toEqual([422, [{ path: 'aspectCodes.0', code: 'invalid' }]]);
  });

  it('staff: the list embeds the trainings; a training of an archived staff member is 404; a catalogue upload is not_found', async () => {
    const person = stored(await manager.send('post', `${API}/staff`, SAMPLES.staff.body)).id;
    const certificate = await upload('accreditation.evidence', 2000, 'sertifikat.pdf');
    const t = await manager.send('post', `${API}/staff/${person}/trainings`, { title: 'Diklat Calon Pustakawan', heldOn: '2025-04-14', hours: 60, certificateUploadId: certificate });
    expect(t.status, t.text).toBe(201);
    const listed = ((await reader.get(`${API}/staff`)).json as { rows: StaffView[] }).rows.find((r) => r.id === person);
    expect(listed?.trainings.map((x) => [x.id, x.title, x.hours, x.certificateFileId, x.certificateFileName])).toEqual([
      [stored(t).id, 'Diklat Calon Pustakawan', 60, certificate, 'sertifikat.pdf'],
    ]);

    const patched = await manager.send('patch', `${API}/trainings/${stored(t).id}`, { version: 0, organizer: 'Perpusnas' });
    expect(patched.json).toEqual({ id: stored(t).id, version: 1 });

    const cover = await upload('catalog.cover');
    const refused = await manager.send('post', `${API}/staff/${person}/trainings`, { title: 'Bimtek', heldOn: '2025-05-01', certificateUploadId: cover });
    expect([refused.status, errors(refused)]).toEqual([422, [{ path: 'certificateUploadId', code: 'not_found' }]]);

    expect((await manager.send('delete', `${API}/staff/${person}`)).status).toBe(200);
    const onArchived = await manager.send('post', `${API}/staff/${person}/trainings`, { title: 'Bimtek', heldOn: '2025-05-01' });
    expect([onArchived.status, code(onArchived)]).toEqual([404, 'NOT_FOUND']);
    expect((await manager.send('delete', `${API}/trainings/${stored(t).id}`)).status).toBe(404);
  });

  it('evidence: a frozen period is 409 ACCRED_PERIOD_FROZEN; a register row`s evidence is accepted while it is frozen', async () => {
    const frozen = await period('frozen');
    const fileId = await upload();
    const refused = await manager.send('post', `${API}/evidence`, { uploadId: fileId, periodId: frozen, indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot', caption: 'Katalog' });
    expect([refused.status, code(refused)]).toEqual([409, 'ACCRED_PERIOD_FROZEN']);
    expect(await ownerOf(fileId)).toEqual({ owner_type: null, owner_id: null });

    const activity = stored(await manager.send('post', `${API}/activities`, SAMPLES.activities.body)).id;
    const linked = await manager.send('post', `${API}/evidence`, { uploadId: fileId, entity: 'library_activities', entityId: activity, caption: 'Foto kegiatan' });
    expect(linked.status, linked.text).toBe(201);
    expect(linked.json).toEqual({ id: expect.any(String), version: 0 });
    const list = await reader.get(`${API}/evidence?entity=library_activities&entityId=${activity}`);
    expect(list.status, list.text).toBe(200);
    expect((list.json as EvidenceListResponse).evidence.map((e) => [e.id, e.fileId, e.caption])).toEqual([[stored(linked).id, fileId, 'Foto kegiatan']]);
  });

  it('evidence: the item and the indicator must fit the period`s instrument (422 at the field)', async () => {
    const open = await period();
    const wrongItem = await manager.send('post', `${API}/evidence`, { uploadId: await upload(), periodId: open, indicatorCode: 'SCH-K2', evidenceCode: 'title_list', caption: '' });
    expect([wrongItem.status, errors(wrongItem)]).toEqual([422, [{ path: 'evidenceCode', code: 'invalid' }]]);
    const wrongIndicator = await manager.send('post', `${API}/evidence`, { uploadId: await upload(), periodId: open, indicatorCode: 'SCH-L7', caption: '' });
    expect([wrongIndicator.status, errors(wrongIndicator)]).toEqual([422, [{ path: 'indicatorCode', code: 'invalid' }]]);
    const noTarget = await manager.send('post', `${API}/evidence`, { uploadId: await upload(), caption: '' });
    expect([noTarget.status, errors(noTarget)]).toEqual([422, [{ path: 'periodId', code: 'required' }]]);
  });

  it('evidence: list with componentBytes; archive releases the file, moves the period and empties the front photo slot', async () => {
    const front = await upload('accreditation.evidence', 300_000, 'depan.jpg');
    const open = await period('open', { photos: { front, collection: null, staff: null, readingRoom: null } });
    const k = await upload('accreditation.evidence', 1_200_000, 'kebijakan.pdf');
    const kRow = await manager.send('post', `${API}/evidence`, { uploadId: k, periodId: open, indicatorCode: 'SCH-K3', evidenceCode: 'policy_document', caption: 'Kebijakan' });
    expect(kRow.status, kRow.text).toBe(201);
    const photo = await manager.send('post', `${API}/evidence`, { uploadId: front, periodId: open, indicatorCode: 'SCH-PROFIL', evidenceCode: 'photo_front', caption: 'Depan' });
    expect(photo.status, photo.text).toBe(201);

    const list = await reader.get(`${API}/evidence?periodId=${open}&indicatorCode=SCH-K3`);
    expect(list.status, list.text).toBe(200);
    const body = list.json as EvidenceListResponse;
    expect(body.evidence.map((e) => [e.indicatorCode, e.evidenceCode, e.fileName, e.size])).toEqual([['SCH-K3', 'policy_document', 'kebijakan.pdf', 1_200_000]]);
    expect(body.componentBytes).toEqual({ K: 1_200_000, SP: 0, L: 0, T: 0, F: 0, G: 0, profil: 300_000 });
    expect((await reader.get(`${API}/evidence`)).status).toBe(422);

    await h.db.updateTable('accred_periods').set({ updated_at: NOW - 60_000 }).where('id', '=', open).execute();
    const removed = await manager.send('delete', `${API}/evidence/${stored(photo).id}`);
    expect(removed.status, removed.text).toBe(200);
    expect(await ownerOf(front)).toEqual({ owner_type: null, owner_id: null });
    const after = await h.db.selectFrom('accred_periods').select(['updated_at', 'profile']).where('id', '=', open).executeTakeFirstOrThrow();
    expect(Number(after.updated_at)).toBe(NOW);
    expect(JSON.parse(after.profile)).toEqual({ photos: { front: null, collection: null, staff: null, readingRoom: null } });
    expect((await manager.send('delete', `${API}/evidence/${stored(photo).id}`)).status).toBe(404);
  });
});
