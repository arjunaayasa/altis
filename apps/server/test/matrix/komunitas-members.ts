import { createHash } from 'node:crypto';
import { acceptChunk, completeUpload, createUpload, uploadContext, uploadOwner } from '@altis/core';
import { withTx } from '@altis/db';
import { newId, systemRolePermissions } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';

// The matrix rows, fixtures and `system` route ids of the members API (member types, the CSV import, members): one row
// per route id in the row format of db/matrix.test.ts's CATALOG, one fixture per route in the same order. Every route is
// `deny` in maintenance, so there is no maintenance entry; the import report is a download (`mode: system`).
//
// Each call gets rows of its own, seeded straight into the tables at version 0, so that a super admin's call succeeds
// (audit once) whatever the personas before it did.

/** The trail and archive columns of a seeded row. */
const trail = (s: MatrixSeed) => ({ archived_at: null, version: 0, created_at: s.now, created_by: null, updated_at: s.now, updated_by: null });

/** A code or a member number no other call uses. */
const unique = (prefix: string): string => `${prefix}${newId().slice(-12)}`;

/** A live member type of its own (code `MT…`, may borrow 3); its id. */
export async function seedMemberType(s: MatrixSeed): Promise<string> {
  const id = newId();
  const code = unique('MT');
  await s.h.db
    .insertInto('member_types')
    .values({
      id,
      code_display: code,
      code_key: code,
      name_id: 'Tipe Matriks',
      name_en: 'Matrix type',
      accred_group: 'student',
      membership_days: 365,
      loan_limit: 3,
      holds_allowed: 1,
      holds_limit: 2,
      online_renewal: 1,
      sort_order: 0,
      ...trail(s),
    })
    .execute();
  return id;
}

/** An active member of a type of its own, valid until the end of 2099; its id and member number. */
export async function seedMember(s: MatrixSeed): Promise<{ id: string; memberNo: string }> {
  const id = newId();
  const memberNo = unique('AM');
  await s.h.db
    .insertInto('members')
    .values({
      id,
      member_no_display: memberNo,
      member_no_key: memberNo,
      member_type_id: await seedMemberType(s),
      home_branch_id: null,
      status: 'active',
      status_note: null,
      name: 'Anggota Matriks',
      name_key: 'anggota matriks',
      gender: null,
      birth_date: null,
      identity_no: null,
      institution: null,
      class_name: null,
      email: null,
      phone: null,
      address: null,
      postal_code: null,
      mailing_address: null,
      notes: null,
      photo_file_id: null,
      locale: 'id',
      joined_on: '2026-01-02',
      valid_from: '2026-01-02',
      expires_on: '2099-12-31',
      password_hash: null,
      must_reset_password: 0,
      session_version: 0,
      last_login_at: null,
      anonymized_at: null,
      source: 'manual',
      ...trail(s),
    })
    .execute();
  return { id, memberNo };
}

/** A member import run of its own (a finished dry run); its id. */
async function seedImportRun(s: MatrixSeed): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('catalog_runs')
    .values({
      id,
      kind: 'member_import',
      dry_run: 1,
      format: 'csv-members',
      status: 'succeeded',
      options: '{"mode":"create_only"}',
      summary: '{}',
      report_file_id: null,
      output_name: null,
      output_size: null,
      expires_at: null,
      job_id: null,
      created_at: s.now,
      created_by: s.user?.id ?? null,
      finished_at: s.now,
    })
    .execute();
  return id;
}

const CSV = 'member_no;name;member_type\r\nMTX-1;Anggota Impor;SISWA\r\n';

/**
 * Whether the caller holds `members.import.run` with a full session (matrix-fixtures.ts's `holds`, written out: an area
 * file imports no value from that module, whose top level reads this area's merge).
 */
function mayImport(s: MatrixSeed): boolean {
  if (s.user === null) return false;
  if (s.persona === 'super_admin' || s.persona === 'admin') return systemRolePermissions(s.persona).includes('members.import.run');
  return s.persona === 'perm:members.import.run';
}

/** A completed `members.import` upload of `userId` holding {@link CSV}; its id. */
async function stagedCsv(s: MatrixSeed, userId: string): Promise<string> {
  if (s.dataDir === undefined) throw new Error('the member import fixture needs the DATA_DIR of the app');
  const dataDir = s.dataDir;
  const bytes = Buffer.from(CSV, 'utf8');
  const owner = uploadOwner(userId);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const context = uploadContext('members.import')!;
  // A caller may hold at most 3 live uploads. Uploads that earlier fixtures staged for calls which never took them (a
  // refused write) are let expire first, so this one always fits.
  await s.h.db.updateTable('upload_sessions').set({ expires_at: s.now - 1 }).where('owner', '=', owner).where('expires_at', '>', s.now).execute();
  const { id } = await withTx(s.h, (trx) => createUpload(trx, { owner, context, size: bytes.byteLength, sha256, now: s.now, dataDir }));
  await acceptChunk(s.h, { id, owner, n: 0, data: bytes, now: s.now, dataDir });
  await completeUpload(s.h, { id, owner, originalName: 'anggota.csv', now: s.now, dataDir });
  return id;
}

/** `:id` of a member of its own, with `body`. */
const onMember =
  (body: (s: MatrixSeed) => unknown = () => undefined): MatrixFixture =>
  async (s) => ({ params: { id: (await seedMember(s)).id }, body: body(s) });

/** `:id` of a member type of its own, with `body`. */
const onType =
  (body: unknown): MatrixFixture =>
  async (s) => ({ params: { id: await seedMemberType(s) }, body });

const READ = 'P:members.records.read | - | - | read | deny | none | null | - | -';
const POST_READ = 'P:members.records.read | - | - | read | deny | none | null | self | -';
const manage = (action: string): string => `P:members.records.manage | - | - | write | deny | store | members.member.${action} | handler | -`;
const types = (action: string): string => `P:members.types.manage | - | - | write | deny | store | members.type.${action} | handler | -`;

const API = '/api/v1/members';

const rows: Record<string, string> = {
  'members.types.list': `GET ${API}/types | ${READ}`,
  'members.types.create': `POST ${API}/types | ${types('create')}`,
  'members.types.update': `PATCH ${API}/types/:id | ${types('update')}`,
  'members.types.archive': `DELETE ${API}/types/:id | ${types('archive')}`,
  'members.imports.create': `POST ${API}/imports | P:members.import.run | - | - | write | deny | store | members.import.start | handler | also:members.import.finish`,
  'members.imports.get': `GET ${API}/imports/:id | P:members.import.run | - | - | read | deny | none | null | - | -`,
  'members.imports.report': `GET ${API}/imports/:id/report | P:members.import.run | - | - | system | deny | none | null | - | -`,
  'members.search': `POST ${API}/search | ${POST_READ}`,
  'members.lookup': `POST ${API}/lookup | ${POST_READ}`,
  'members.duplicates': `POST ${API}/duplicates | ${POST_READ}`,
  'members.create': `POST ${API} | ${manage('create')}`,
  'members.get': `GET ${API}/:id | ${READ}`,
  'members.update': `PATCH ${API}/:id | ${manage('update')}`,
  'members.archive': `DELETE ${API}/:id | ${manage('archive')}`,
  'members.extend': `POST ${API}/:id/extend | ${manage('extend')}`,
  'members.events': `GET ${API}/:id/events | ${READ}`,
};

const fixtures: Record<string, MatrixFixture> = {
  'members.types.list': async () => ({ query: { includeArchived: 'false' } }),
  'members.types.create': async () => ({
    body: { code: unique('NT'), nameId: 'Tipe Baru', nameEn: 'New type', accredGroup: 'public', membershipDays: 365, loanLimit: 2 },
  }),
  'members.types.update': onType({ version: 0, nameId: 'Tipe Diubah' }),
  'members.types.archive': onType({ version: 0 }),
  'members.imports.create': async (s) => ({
    body: { uploadId: mayImport(s) ? await stagedCsv(s, s.user!.id) : newId(), mode: 'create_only', dryRun: true },
  }),
  'members.imports.get': async (s) => ({ params: { id: await seedImportRun(s) } }),
  'members.imports.report': async (s) => ({ params: { id: await seedImportRun(s) } }),
  'members.search': async () => ({ body: { q: 'Matriks' } }),
  'members.lookup': async (s) => ({ body: { no: (await seedMember(s)).memberNo } }),
  'members.duplicates': async () => ({ body: { name: 'Matriks', birthDate: '2010-01-02', phone: '0811-000' } }),
  'members.create': async (s) => ({ body: { memberNo: unique('BM'), memberTypeId: await seedMemberType(s), name: 'Anggota Baru' } }),
  'members.get': onMember(),
  'members.update': onMember(() => ({ version: 0, name: 'Anggota Diubah' })),
  'members.archive': onMember(() => ({ version: 0 })),
  'members.extend': onMember(() => ({ version: 0, from: 'today' })),
  'members.events': async (s) => ({ params: { id: (await seedMember(s)).id }, query: { limit: '20' } }),
};

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance: {},
  systemRoutes: ['members.imports.report'],
};
