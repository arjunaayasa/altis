import { newId } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures, maintenance entries and `system` route ids of the five registers of the library and the
// staff trainings: one row per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the
// same order (each register's list, create, update and archive, in the order of the registers, then the trainings).
// Every route is `deny` in maintenance and none is a `system` route, so there is no maintenance entry and no system
// route id.
//
// Each call gets a row of its own (seeded straight into its table at version 0), so that a super admin's call succeeds
// (one audit entry) whatever the personas before it did; a budget gets a year no other call uses.

/** The trail and archive columns of a seeded register row. */
const trail = (s: MatrixSeed) => ({ archived_at: null, version: 0, created_at: s.now, created_by: null, updated_at: s.now, updated_by: null });

let yearSerial = 0;
/** A budget year no other call of this process uses (the contract accepts 1900-2100). */
const nextYear = (): number => 1900 + (yearSerial++ % 201);

async function seedActivity(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('library_activities')
    .values({
      id,
      branch_id: null,
      kind: 'promotion',
      title: 'Kegiatan Matriks',
      held_on: '2026-01-10',
      ended_on: null,
      participants: null,
      partner: null,
      uses_library_facility: 0,
      external_speaker: 0,
      description: null,
      ...trail(s),
    })
    .execute();
  return id;
}

async function seedStaffMember(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('library_staff')
    .values({
      id,
      branch_id: null,
      staff_user_id: null,
      name: 'Tenaga Matriks',
      position: null,
      role: 'librarian',
      is_librarian: 1,
      employment: null,
      education_level: null,
      education_library: 0,
      library_training: 0,
      competency_cert: 0,
      association_member: 0,
      appointment_ref: null,
      starts_on: '2024-01-02',
      ends_on: null,
      ...trail(s),
    })
    .execute();
  return id;
}

async function seedTraining(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('staff_trainings')
    .values({ id, library_staff_id: await seedStaffMember(s), title: 'Pelatihan Matriks', organizer: null, held_on: '2025-03-01', hours: null, certificate_file_id: null, ...trail(s) })
    .execute();
  return id;
}

async function seedPartnership(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('library_partnerships')
    .values({ id, branch_id: null, partner: 'Mitra Matriks', kind: 'mou', starts_on: '2025-01-01', ends_on: null, scope: null, document_file_id: null, ...trail(s) })
    .execute();
  return id;
}

async function seedBudget(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('library_budgets')
    .values({
      id,
      scope_key: '',
      branch_id: null,
      year: nextYear(),
      library_minor: 1_000_000,
      parent_minor: null,
      parent_nonpersonnel_minor: null,
      collection_minor: null,
      community_minor: null,
      currency: 'IDR',
      note: null,
      ...trail(s),
    })
    .execute();
  return id;
}

async function seedDocument(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('library_documents')
    .values({
      id,
      branch_id: null,
      kind: 'rules',
      title: 'Dokumen Matriks',
      reference: null,
      issued_on: null,
      issued_by: null,
      aspect_codes: null,
      valid_until: null,
      file_id: null,
      ...trail(s),
    })
    .execute();
  return id;
}

/** PATCH `:id` of a row of its own (version 0) with `body`. */
const patch =
  (seed: (s: MatrixSeed) => Promise<string>, body: Record<string, unknown>): MatrixFixture =>
  async (s) => ({ params: { id: await seed(s) }, body: { version: 0, ...body } });

/** DELETE `:id` of a row of its own. */
const archive =
  (seed: (s: MatrixSeed) => Promise<string>): MatrixFixture =>
  async (s) => ({ params: { id: await seed(s) } });

const list: MatrixFixture = async () => ({});

const READ = 'P:accreditation.workspace.read | - | - | read | deny | none | null | - | -';
const write = (action: string): string => `P:accreditation.workspace.manage | - | - | write | deny | store | accreditation.register.${action} | handler | -`;

/** The four rows of register `kind`. */
function rows(kind: string): Record<string, string> {
  const base = `/api/v1/accreditation/${kind}`;
  return {
    [`accreditation.registers.${kind}.list`]: `GET ${base} | ${READ}`,
    [`accreditation.registers.${kind}.create`]: `POST ${base} | ${write('create')}`,
    [`accreditation.registers.${kind}.update`]: `PATCH ${base}/:id | ${write('update')}`,
    [`accreditation.registers.${kind}.archive`]: `DELETE ${base}/:id | ${write('archive')}`,
  };
}

export const MATRIX: AreaMatrix = {
  rows: {
    ...rows('activities'),
    ...rows('staff'),
    ...rows('partnerships'),
    ...rows('budgets'),
    ...rows('documents'),
    'accreditation.trainings.create': `POST /api/v1/accreditation/staff/:id/trainings | ${write('create')}`,
    'accreditation.trainings.update': `PATCH /api/v1/accreditation/trainings/:id | ${write('update')}`,
    'accreditation.trainings.archive': `DELETE /api/v1/accreditation/trainings/:id | ${write('archive')}`,
  },
  fixtures: {
    'accreditation.registers.activities.list': list,
    'accreditation.registers.activities.create': async () => ({
      body: { kind: 'reading_culture', title: 'Gerakan Literasi Matriks', heldOn: '2026-02-02', usesLibraryFacility: false, externalSpeaker: true },
    }),
    'accreditation.registers.activities.update': patch(seedActivity, { participants: 25 }),
    'accreditation.registers.activities.archive': archive(seedActivity),

    'accreditation.registers.staff.list': list,
    'accreditation.registers.staff.create': async () => ({
      body: {
        name: 'Pustakawan Matriks',
        role: 'librarian',
        isLibrarian: true,
        educationLibrary: true,
        libraryTraining: false,
        competencyCert: false,
        associationMember: false,
        startsOn: '2025-07-01',
      },
    }),
    'accreditation.registers.staff.update': patch(seedStaffMember, { position: 'Pustakawan Ahli Pertama' }),
    'accreditation.registers.staff.archive': archive(seedStaffMember),

    'accreditation.registers.partnerships.list': list,
    'accreditation.registers.partnerships.create': async () => ({ body: { partner: 'Mitra Baru Matriks', kind: 'pks', startsOn: '2026-01-05' } }),
    'accreditation.registers.partnerships.update': patch(seedPartnership, { scope: 'Pertukaran koleksi' }),
    'accreditation.registers.partnerships.archive': archive(seedPartnership),

    'accreditation.registers.budgets.list': list,
    'accreditation.registers.budgets.create': async () => ({ body: { year: nextYear(), libraryMinor: 2_500_000, currency: 'IDR' } }),
    'accreditation.registers.budgets.update': patch(seedBudget, { collectionMinor: 500_000 }),
    'accreditation.registers.budgets.archive': archive(seedBudget),

    'accreditation.registers.documents.list': list,
    'accreditation.registers.documents.create': async () => ({ body: { kind: 'collection_policy', title: 'Kebijakan Matriks', aspectCodes: ['a1', 'a2'] } }),
    'accreditation.registers.documents.update': patch(seedDocument, { reference: '001/MTX/2026' }),
    'accreditation.registers.documents.archive': archive(seedDocument),

    'accreditation.trainings.create': async (s) => ({ params: { id: await seedStaffMember(s) }, body: { title: 'Bimtek Matriks', heldOn: '2025-11-03', hours: 16 } }),
    'accreditation.trainings.update': patch(seedTraining, { organizer: 'Perpustakaan Nasional' }),
    'accreditation.trainings.archive': archive(seedTraining),
  },
  maintenance: {},
  systemRoutes: [],
};
