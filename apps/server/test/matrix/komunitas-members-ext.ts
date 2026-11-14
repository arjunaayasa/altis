import { newId, normalizeKey } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';
import { seedMember } from './komunitas-members.js';

// The matrix rows and fixtures of the member tools (bulk actions, cards, restore, photo, the personal-data export and
// anonymisation), visits and guestbook stations (the API at a branch and the station's own pages), and the settings
// groups of members, visits and privacy: one row per route id in the row format of db/matrix.test.ts's CATALOG, one
// fixture per route. Visits and stations are branch-scoped (`@branchId`). The station pages (`/kunjungan`) are public
// with the station's own cookie; the persona loop leaves them to visit-station.test.ts.
//
// Each call gets rows of its own (a branch, a member, a visit, a station) seeded straight into the tables, so that a
// super admin's call succeeds (audit once) whatever the personas before it did.

const unique = (prefix: string): string => `${prefix}${newId().slice(-12)}`;

/** A live branch of its own; its id. */
async function seedBranch(s: MatrixSeed): Promise<string> {
  const id = newId();
  const code = unique('MV');
  await s.h.db
    .insertInto('branches')
    .values({ id, code_key: normalizeKey(code), code_display: code, name: `Cabang ${code}`, timezone: 'Asia/Jakarta', created_at: s.now, updated_at: s.now })
    .execute();
  return id;
}

/** An archived member of its own; its id. */
async function seedArchivedMember(s: MatrixSeed): Promise<string> {
  const { id } = await seedMember(s);
  await s.h.db.updateTable('members').set({ archived_at: s.now }).where('id', '=', id).execute();
  return id;
}

/** A visit of its own (a guest's) at `branchId`; its id. */
async function seedVisit(s: MatrixSeed, branchId: string): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('visits')
    .values({
      id,
      branch_id: branchId,
      location_id: null,
      visited_on: '2026-01-02',
      visited_at: s.now,
      source: 'manual',
      member_id: null,
      member_type_id: null,
      accred_group: 'guest',
      class_name: null,
      guest_name: 'Tamu Matriks',
      guest_institution: 'Sekolah Matriks',
      purpose: null,
      headcount: 1,
      is_repeat: 0,
      station_id: null,
      day_key: null,
      note: null,
      voided_at: null,
      voided_by: null,
      created_by: null,
    })
    .execute();
  return id;
}

/** A guestbook station of its own at `branchId`; its id. */
async function seedStation(s: MatrixSeed, branchId: string): Promise<string> {
  const id = newId();
  await s.h.db
    .insertInto('visit_stations')
    .values({
      id,
      branch_id: branchId,
      location_id: null,
      name: 'Buku tamu matriks',
      token_hash: null,
      activation_hash: null,
      activation_expires_at: null,
      activated_at: null,
      last_seen_at: null,
      revoked_at: null,
      version: 0,
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return id;
}

/** `:id` of a member of its own, with `body`. */
const onMember =
  (body: (s: MatrixSeed, memberNo: string) => unknown): MatrixFixture =>
  async (s) => {
    const m = await seedMember(s);
    return { params: { id: m.id }, body: body(s, m.memberNo) };
  };

const MEMBERS = '/api/v1/members';
const VISITS = '/api/v1/visits';
const BRANCH_VISITS = '/api/v1/branches/:branchId/visits';
const manage = (action: string): string => `P:members.records.manage | - | - | write | deny | store | members.member.${action} | handler | -`;
const VISITS_READ = 'P:visits.records.read | - | - | read | deny | none | null | - | -';
const VISITS_MANAGE = 'P:visits.records.manage@branchId';
const STATIONS = 'P:visits.stations.manage@branchId';
const settings = (reauth: boolean): string => `P:system.settings.manage | - | ${reauth ? 'reauth' : '-'} | write | deny | store | settings.update | handler | -`;

const rows: Record<string, string> = {
  'members.bulk': `POST ${MEMBERS}/bulk | ${manage('bulk_update')}`,
  'members.cards': `POST ${MEMBERS}/cards | P:members.records.read | - | - | read | deny | none | members.card.print | self | -`,
  'members.restore': `POST ${MEMBERS}/:id/restore | ${manage('restore')}`,
  'members.photo': `PUT ${MEMBERS}/:id/photo | ${manage('photo_set')}`,
  'members.privacy.export': `POST ${MEMBERS}/:id/privacy/export | P:members.privacy.manage | - | reauth | system | deny | none | members.privacy.export | self | -`,
  'members.privacy.anonymize': `POST ${MEMBERS}/:id/privacy/anonymize | P:members.privacy.manage | - | reauth | system | deny | store | members.privacy.anonymize | handler | -`,
  'visits.summary': `GET ${VISITS}/summary | ${VISITS_READ}`,
  'visits.stations.list': `GET ${VISITS}/stations | ${VISITS_READ}`,
  'visits.list': `GET ${VISITS} | ${VISITS_READ}`,
  'visits.create': `POST ${BRANCH_VISITS} | ${VISITS_MANAGE} | - | - | write | deny | store | visits.visit.create | handler | -`,
  'visits.checkin': `POST ${BRANCH_VISITS}/checkin | ${VISITS_MANAGE} | - | - | write | deny | none | null | handler | -`,
  'visits.stations.create': `POST ${BRANCH_VISITS}/stations | ${STATIONS} | - | - | write | deny | none | visits.station.create | handler | -`,
  'visits.stations.activation_code': `POST ${BRANCH_VISITS}/stations/:id/activation-code | ${STATIONS} | - | - | write | deny | none | visits.station.activation_code | handler | -`,
  'visits.stations.revoke': `DELETE ${BRANCH_VISITS}/stations/:id | ${STATIONS} | - | - | system | deny | store | visits.station.revoke | handler | -`,
  'visits.void': `POST ${BRANCH_VISITS}/:id/void | ${VISITS_MANAGE} | - | - | write | deny | store | visits.visit.void | handler | -`,
  'settings.members.put': `PUT /api/v1/settings/members | ${settings(false)}`,
  'settings.visits.put': `PUT /api/v1/settings/visits | ${settings(false)}`,
  'settings.privacy.put': `PUT /api/v1/settings/privacy | ${settings(true)}`,
  'opac.visits.activate.page': 'GET /kunjungan/aktifkan | pub | - | - | read | allow | none | null | - | station',
  'opac.visits.activate': 'POST /kunjungan/aktifkan | pub | - | - | write | deny | none | null | self | also:visits.station.activated ip:visit_station_activate:ip station form',
  'opac.visits.page': 'GET /kunjungan | pub | - | - | read | allow | none | null | - | station',
  'opac.visits.checkin': 'POST /kunjungan | pub | - | - | write | deny | none | null | self | station form',
};

const fixtures: Record<string, MatrixFixture> = {
  'members.bulk': async (s) => ({ body: { action: 'extend', ids: [(await seedMember(s)).id], from: 'today', days: 30 } }),
  'members.cards': async (s) => ({ body: { memberIds: [(await seedMember(s)).id] } }),
  'members.restore': async (s) => ({ params: { id: await seedArchivedMember(s) }, body: { version: 0 } }),
  'members.photo': onMember(() => ({ version: 0, fileId: null })),
  'members.privacy.export': async (s) => ({ params: { id: (await seedMember(s)).id } }),
  'members.privacy.anonymize': onMember((_s, memberNo) => ({ version: 0, confirmMemberNo: memberNo })),
  'visits.summary': async () => ({ query: { on: '2026-01-02' } }),
  'visits.stations.list': async () => ({ query: { includeRevoked: 'true' } }),
  'visits.list': async () => ({ query: { from: '2026-01-01', limit: '20' } }),
  'visits.create': async (s) => ({ params: { branchId: await seedBranch(s) }, body: { guest: { name: 'Tamu Baru', institution: 'Instansi Baru' } } }),
  'visits.checkin': async (s) => ({ params: { branchId: await seedBranch(s) }, body: { memberNo: (await seedMember(s)).memberNo } }),
  'visits.stations.create': async (s) => ({ params: { branchId: await seedBranch(s) }, body: { name: 'Buku tamu baru' } }),
  'visits.stations.activation_code': async (s) => {
    const branchId = await seedBranch(s);
    return { params: { branchId, id: await seedStation(s, branchId) } };
  },
  'visits.stations.revoke': async (s) => {
    const branchId = await seedBranch(s);
    return { params: { branchId, id: await seedStation(s, branchId) } };
  },
  'visits.void': async (s) => {
    const branchId = await seedBranch(s);
    return { params: { branchId, id: await seedVisit(s, branchId) } };
  },
  'settings.members.put': async () => ({ body: {} }),
  'settings.visits.put': async () => ({ body: {} }),
  'settings.privacy.put': async () => ({ body: {} }),
  'opac.visits.activate.page': async () => ({}),
  'opac.visits.activate': async () => ({}),
  'opac.visits.page': async () => ({}),
  'opac.visits.checkin': async () => ({}),
};

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance: { 'opac.visits.activate.page': 'allow', 'opac.visits.page': 'allow' },
  systemRoutes: ['members.privacy.export', 'members.privacy.anonymize', 'visits.stations.revoke'],
};
