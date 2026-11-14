import { createHash, randomBytes } from 'node:crypto';
import { withTx, type DB, type DbHandle } from '@altis/db';
import type { Insertable, Transaction } from 'kysely';
import { instrumentById, localStorageDriver, writeSettings, type AccredInstrument } from '../../../packages/core/src/index.js';
import { ACTIVITY_KINDS, LOCAL_WORK_KINDS, REFERENCE_KINDS, addDays, newId, type ActivityKind, type DocumentKind } from '../../../packages/shared/src/index.js';
import { perfCounts, prng, seedPhase2, type PerfCounts } from '../perf-phase2/seed.js';

// The seed `perf-komunitas` (the community roadmap's performance budgets of the reports and the accreditation
// workspace): the Phase 2 catalogue of tools/test/perf-phase2 (100 000 records and 150 000 items at scale 1, written
// by seedPhase2), and on top of it what a school library keeps for its accreditation:
//
// - the library's settings (a school library, its name and time zone) and the staff member who works with them;
// - one accreditation period of the senior-high instrument (`sch-sma-2025`) over the last school year that has ended,
//   with the institution's profile, its population and facilities, and the answers of the indicators answered by
//   hand;
// - the registers: 300 activities in the period, 20 staff members with three trainings each, three budget years,
//   three partnerships, and the documents a school library holds (its collection policy with six aspects, its rules
//   and procedures, its founding decree and duties, the four standard procedures, its work programme, the head's
//   performance report, three annual and six semester reports);
// - 36 months of usage statistics up to the period's end, as an aggregate SLiMS import leaves them (by member type,
//   guests and totals, loans by DDC class, the distinct counts of the period and the two school years before it) with
//   the member types mapped to the school's groups;
// - with `withEvidence`, evidence files on the period's indicators: 2 000 entries of 256 KiB (500 MiB) at scale 1,
//   spread over every indicator's upload items, stored through the local storage driver;
// - some records annotated with the accreditation fields (reference kinds, local works, audience), so the collection
//   provider has them to count, and one title in 20 without its classification, with a call number of letters only
//   (unless `unclassified` is false; seedUnclassified adds them later).
//
// The registers do not scale (a school library keeps about as many whatever its catalogue); the catalogue and the
// evidence do. seedExtraItems adds copies to the catalogue up to a total (the report export of a million rows).
// Everything is written straight into the tables in multi-row batches, the way seedPhase2 writes the catalogue.

/** The counts of the seed at scale 1, beside the catalogue's (PERF_PHASE2_SEED). */
export const PERF_KOMUNITAS_SEED = Object.freeze({
  name: 'perf-komunitas',
  activities: 300,
  staff: 20,
  trainingsPerStaff: 3,
  budgetYears: 3,
  partnerships: 3,
  usageMonths: 36,
  evidenceEntries: 2_000,
  evidenceEntryBytes: 256 * 1024,
});

/** The instrument of the seeded period. */
export const PERF_INSTRUMENT_ID = 'sch-sma-2025';
/** The library's time zone. */
export const PERF_TZ = 'Asia/Jakarta';
/** The library's name (printed in the documents). */
export const PERF_LIBRARY_NAME = 'Perpustakaan SMA Perf';

/** The SLiMS member types the usage rows count by, and the school group each is mapped to. */
export const PERF_MEMBER_TYPES = Object.freeze([
  { id: 1, name: 'Siswa', group: 'student' },
  { id: 2, name: 'Guru', group: 'teacher' },
  { id: 3, name: 'Tenaga Kependidikan', group: 'edu_staff' },
  { id: 4, name: 'Umum', group: 'public' },
] as const);

export interface KomunitasCounts {
  catalog: PerfCounts;
  /** Evidence files (0 without `withEvidence`). */
  evidenceEntries: number;
  evidenceBytes: number;
}

/** The seed's counts at `scale`: the catalogue of perfCounts and the evidence files (with `withEvidence`). */
export function komunitasCounts(scale = 1, o: { withEvidence?: boolean } = {}): KomunitasCounts {
  const catalog = perfCounts(scale);
  const entries = o.withEvidence === true ? Math.max(1, Math.round(PERF_KOMUNITAS_SEED.evidenceEntries * scale)) : 0;
  return { catalog, evidenceEntries: entries, evidenceBytes: entries * PERF_KOMUNITAS_SEED.evidenceEntryBytes };
}

/** The school year a period of the seed covers: the last one that has ended at `today` (`YYYY-MM-DD`). */
export function lastSchoolYear(today: string): { startsOn: string; endsOn: string; name: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const start = month >= 7 ? year - 1 : year - 2;
  return { startsOn: `${start}-07-01`, endsOn: `${start + 1}-06-30`, name: `Tahun pelajaran ${start}/${start + 1}` };
}

/** `YYYY-MM` of the month `n` months after `month` (negative: before). */
export function monthPlus(month: string, n: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The last day of `month` (`YYYY-MM`). */
export function monthEnd(month: string): string {
  return addDays(`${monthPlus(month, 1)}-01`, -1);
}

/** The 36 months of usage up to the month of `endsOn`, oldest first. */
export function usageMonths(endsOn: string, count: number = PERF_KOMUNITAS_SEED.usageMonths): string[] {
  const last = endsOn.slice(0, 7);
  return Array.from({ length: count }, (_, i) => monthPlus(last, i - count + 1));
}

/** `YYYY-MM-DD` of the local date of epoch `ms` in Asia/Jakarta (UTC+7, no daylight saving). */
export function jakartaDate(ms: number): string {
  return new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);
}

const ROWS_PER_INSERT = 200;

async function insertRows<T extends keyof DB & string>(trx: Transaction<DB>, table: T, rows: Insertable<DB[T]>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    // Kysely cannot narrow a generic table's insert type; the rows are typed by the caller.
    await (trx.insertInto(table) as unknown as { values(v: unknown[]): { execute(): Promise<unknown> } }).values(rows.slice(i, i + ROWS_PER_INSERT)).execute();
  }
}

export interface SeedKomunitasOptions {
  /** The scale of the catalogue and of the evidence (default 1). */
  scale?: number;
  /** DATA_DIR: where the attachment and evidence files go. */
  dataDir: string;
  /** Write the evidence files (default false). */
  withEvidence?: boolean;
  /** Seed the catalogue (default true). */
  catalog?: boolean;
  /** One title in 20 without its classification (default true; seedUnclassified adds them later). */
  unclassified?: boolean;
  /** Seed the accreditation part (default true); false leaves the catalogue, the settings and the staff member only. */
  accreditation?: boolean;
  /** The clock the rows are written at (default Date.now()). */
  now?: number;
  say?: (line: string) => void;
}

export interface SeedKomunitasResult {
  counts: KomunitasCounts;
  /** The branches of the catalogue's copies (none without the catalogue). */
  branchIds: string[];
  staffId: string;
  /** The seeded period, or null without the accreditation part. */
  periodId: string | null;
  /** The period's span. */
  span: { startsOn: string; endsOn: string };
  /** The seed's duration in ms, and the catalogue's part of it. */
  ms: number;
  catalogMs: number;
}

/**
 * Writes the seed into the migrated, empty database `h` (see the top of this file).
 *
 * @throws Error when records exist already (seedPhase2), or a master of the Phase 2 data the seed names is missing
 */
export async function seedKomunitas(h: DbHandle, o: SeedKomunitasOptions): Promise<SeedKomunitasResult> {
  const t0 = Date.now();
  const now = o.now ?? Date.now();
  const say = o.say ?? (() => undefined);
  const counts = komunitasCounts(o.scale ?? 1, { withEvidence: o.withEvidence === true });
  const span = lastSchoolYear(jakartaDate(now));

  await withTx(h, (trx) =>
    writeSettings(trx, { 'library.name': PERF_LIBRARY_NAME, 'library.type': 'sekolah', 'library.timezone': PERF_TZ }, { keyring: [], now, actorId: null }),
  );
  const staffId = newId(now);
  await h.db
    .insertInto('staff_users')
    .values({ id: staffId, username_key: 'petugas-perf', username_display: 'petugas-perf', name: 'Petugas Perf', password_hash: 'x', status: 'active', created_at: now, updated_at: now })
    .execute();

  let branchIds: string[] = [];
  let catalogMs = 0;
  if (o.catalog !== false) {
    const seeded = await seedPhase2(h, { counts: counts.catalog, dataDir: o.dataDir, now, say });
    branchIds = seeded.branchIds;
    catalogMs = seeded.ms;
    await annotateRecords(h, { fields: true, unclassified: o.unclassified !== false });
    say(`seed: ${counts.catalog.records} records annotated with accreditation fields`);
  }
  if (o.accreditation === false) return { counts, branchIds, staffId, periodId: null, span, ms: Date.now() - t0, catalogMs };

  const instrument = instrumentById(PERF_INSTRUMENT_ID);
  if (instrument === null) throw new Error(`seedKomunitas: this build has no instrument ${PERF_INSTRUMENT_ID}`);
  const periodId = await seedPeriod(h, span, staffId, now);
  await seedRegisters(h, span, staffId, now);
  say(`seed: period ${span.name}, ${PERF_KOMUNITAS_SEED.activities} activities, ${PERF_KOMUNITAS_SEED.staff} staff, ${PERF_KOMUNITAS_SEED.budgetYears} budget years, documents`);
  const usageRows = await seedUsage(h, span, now);
  say(`seed: ${usageRows} usage rows over ${PERF_KOMUNITAS_SEED.usageMonths} months`);
  if (counts.evidenceEntries > 0) {
    await seedEvidence(h, o.dataDir, instrument, periodId, staffId, counts.evidenceEntries, now, say);
    say(`seed: ${counts.evidenceEntries} evidence files (${Math.round(counts.evidenceBytes / 1_048_576)} MiB)`);
  }
  return { counts, branchIds, staffId, periodId, span, ms: Date.now() - t0, catalogMs };
}

/** Records per annotating batch. */
const ANNOTATE_BATCH = 2_000;

/** Letters only (`A`…`Z`, then two letters, …) for `n`: a call-number token without a class number in it. */
export function lettersOf(n: number): string {
  let out = '';
  let k = n;
  do {
    out = String.fromCharCode(65 + (k % 26)) + out;
    k = Math.floor(k / 26) - 1;
  } while (k >= 0);
  return out;
}

/**
 * The accreditation fields on some live records, by their position in id order: one in 40 a reference kind, one in
 * 250 a student's local work (its kind in turn), one in 7 an audience. One in 20 loses its classification and gets a
 * call number of letters only (`FIK <letters>`, nearly one per title), as many migrated catalogues hold: the DDC recap
 * then folds a group per such call number.
 */
async function annotateRecords(h: DbHandle, o: { fields: boolean; unclassified: boolean }): Promise<void> {
  let after = '';
  let position = 0;
  for (;;) {
    const ids = (await h.db.selectFrom('records').select('id').where('id', '>', after).where('archived_at', 'is', null).orderBy('id').limit(ANNOTATE_BATCH).execute()).map((r) => r.id);
    if (ids.length === 0) return;
    const reference = new Map<string, string[]>();
    const local = new Map<string, string[]>();
    const audience: string[] = [];
    const unclassified: [string, string][] = [];
    ids.forEach((id, i) => {
      const n = position + i;
      if (o.unclassified && n % 20 === 13) unclassified.push([id, `FIK ${lettersOf(Math.floor(n / 20))}`]);
      if (!o.fields) return;
      if (n % 40 === 3) {
        const kind = REFERENCE_KINDS[Math.floor(n / 40) % REFERENCE_KINDS.length]!;
        (reference.get(kind) ?? reference.set(kind, []).get(kind)!).push(id);
      }
      if (n % 250 === 11) {
        const kind = LOCAL_WORK_KINDS[Math.floor(n / 250) % LOCAL_WORK_KINDS.length]!;
        (local.get(kind) ?? local.set(kind, []).get(kind)!).push(id);
      }
      if (n % 7 === 5) audience.push(id);
    });
    await withTx(h, async (trx) => {
      for (const [kind, list] of reference) await trx.updateTable('records').set({ reference_kind: kind }).where('id', 'in', list).execute();
      for (const [kind, list] of local) await trx.updateTable('records').set({ local_work: 'student', local_work_kind: kind }).where('id', 'in', list).execute();
      if (audience.length > 0) await trx.updateTable('records').set({ audience: 'general' }).where('id', 'in', audience).execute();
      for (const [id, callNumber] of unclassified) await trx.updateTable('records').set({ classification: null, call_number: callNumber }).where('id', '=', id).execute();
    });
    position += ids.length;
    after = ids[ids.length - 1]!;
  }
}

/**
 * Takes the classification of one live title in 20 (by position in id order) and gives it a call number of letters
 * only, as seedKomunitas does unless `unclassified` is false: a catalogue measured first without such titles, then
 * with them.
 */
export async function seedUnclassified(h: DbHandle): Promise<void> {
  await annotateRecords(h, { fields: false, unclassified: true });
}

/** The six services the period offers. */
const SERVICES = ['reading_room', 'circulation', 'reference', 'information_literacy', 'speed_reading', 'extension'];

async function seedPeriod(h: DbHandle, span: { startsOn: string; endsOn: string; name: string }, staffId: string, now: number): Promise<string> {
  const id = newId(now);
  const profile = {
    schoolLevel: 'sma_smk_ma',
    npp: '3201010D1000099',
    status: 'negeri',
    foundedYear: 1985,
    foundingDecree: { number: 'SK-07/1985', date: '1985-07-15', issuer: 'Kepala Sekolah' },
    schoolName: 'SMA Perf',
    schoolHead: 'Kepala Sekolah Perf',
    libraryHead: 'Kepala Perpustakaan Perf',
    libraryHeadId: '198501012010012001',
    address: { street: 'Jl. Uji Kinerja 1', village: 'Sukamaju', district: 'Cibeunying', regency: 'Kota Bandung', province: 'Jawa Barat', postalCode: '40123' },
    phone: '022-765432',
    website: 'https://perpus.sma-perf.sch.id',
    email: 'perpus@sma-perf.sch.id',
    certificateName: PERF_LIBRARY_NAME,
  };
  await h.db
    .insertInto('accred_periods')
    .values({
      id,
      branch_id: null,
      name: span.name,
      kind: 'school_year',
      starts_on: span.startsOn,
      ends_on: span.endsOn,
      instrument_id: PERF_INSTRUMENT_ID,
      status: 'open',
      frozen_at: null,
      frozen_by: null,
      profile: JSON.stringify(profile),
      students: 1_080,
      teachers: 64,
      edu_staff: 20,
      classes: 30,
      population_served: null,
      teachers_using: 40,
      all_registered_confirmed: 1,
      user_pcs: 12,
      staff_pcs: 3,
      ict_devices: 15,
      scanners: 2,
      floor_m2: 240,
      bandwidth_mbps: 50,
      hours_per_week: 40,
      services: JSON.stringify(SERVICES),
      external_website_url: null,
      archived_at: null,
      version: 0,
      created_at: now,
      created_by: staffId,
      updated_at: now,
      updated_by: staffId,
    })
    .execute();
  // The indicators answered by hand.
  const answers: [string, string][] = [
    ['SCH-SP1', 'a'],
    ['SCH-SP2', 'b'],
    ['SCH-SP3', 'c'],
    ['SCH-F3', 'c'],
  ];
  await h.db
    .insertInto('accred_answers')
    .values(answers.map(([code, answer]) => ({ period_id: id, indicator_code: code, answer, mode: 'manual', note: null, updated_at: now, updated_by: staffId })))
    .execute();
  return id;
}

/** `count` dates spread evenly from `from` to `to` (inclusive), in order. */
function spread(from: string, to: string, count: number): string[] {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  return Array.from({ length: count }, (_, i) => addDays(from, count === 1 ? 0 : Math.floor((i * days) / (count - 1))));
}

/** The documents a school library holds (kind, its aspects, and when it was issued relative to the period's end year). */
function documentRows(endYear: number): { kind: DocumentKind; title: string; aspects: string[] | null; issuedOn: string }[] {
  const e = endYear;
  const rows: { kind: DocumentKind; title: string; aspects: string[] | null; issuedOn: string }[] = [
    { kind: 'collection_policy', title: 'Kebijakan pengembangan koleksi', aspects: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], issuedOn: `${e - 3}-07-10` },
    { kind: 'rules', title: 'Tata tertib perpustakaan', aspects: null, issuedOn: `${e - 3}-07-10` },
    { kind: 'sop_membership', title: 'Prosedur keanggotaan', aspects: null, issuedOn: `${e - 3}-07-10` },
    { kind: 'sop_loan', title: 'Prosedur peminjaman', aspects: null, issuedOn: `${e - 3}-07-10` },
    { kind: 'founding_decree', title: 'Surat keputusan pendirian perpustakaan', aspects: null, issuedOn: '1985-07-15' },
    { kind: 'duties', title: 'Uraian tugas pengelola perpustakaan', aspects: null, issuedOn: `${e - 2}-07-15` },
    { kind: 'pos_collection', title: 'Prosedur operasional pengembangan koleksi', aspects: null, issuedOn: `${e - 2}-07-15` },
    { kind: 'pos_organisation', title: 'Prosedur operasional pengorganisasian bahan pustaka', aspects: null, issuedOn: `${e - 2}-07-15` },
    { kind: 'pos_service', title: 'Prosedur operasional layanan', aspects: null, issuedOn: `${e - 2}-07-15` },
    { kind: 'pos_promotion', title: 'Prosedur operasional promosi', aspects: null, issuedOn: `${e - 2}-07-15` },
    { kind: 'library_program', title: 'Program kerja perpustakaan', aspects: ['a1', 'a2', 'a3'], issuedOn: `${e - 1}-07-05` },
    { kind: 'head_performance_report', title: 'Laporan kinerja kepala perpustakaan', aspects: ['a1', 'a2', 'a3', 'a4'], issuedOn: `${e}-06-01` },
  ];
  for (let y = e - 3; y <= e - 1; y += 1) rows.push({ kind: 'report_annual', title: `Laporan tahunan ${y}`, aspects: null, issuedOn: `${y}-12-15` });
  for (const d of [`${e - 3}-12-20`, `${e - 2}-06-20`, `${e - 2}-12-20`, `${e - 1}-06-20`, `${e - 1}-12-20`, `${e}-06-20`]) {
    rows.push({ kind: 'report_semester', title: `Laporan semester ${d.slice(0, 7)}`, aspects: null, issuedOn: d });
  }
  return rows;
}

async function seedRegisters(h: DbHandle, span: { startsOn: string; endsOn: string }, staffId: string, now: number): Promise<void> {
  const trail = { archived_at: null, version: 0, created_at: now, created_by: staffId, updated_at: now, updated_by: staffId };
  const r = prng(20_261_104);
  const endYear = Number(span.endsOn.slice(0, 4));
  const threeYearsBack = addDays(span.startsOn, -730);

  const activityKinds: readonly ActivityKind[] = ACTIVITY_KINDS.filter((k) => k !== 'other');
  const activities: Insertable<DB['library_activities']>[] = spread(span.startsOn, span.endsOn, PERF_KOMUNITAS_SEED.activities).map((heldOn, i) => {
    const kind = activityKinds[i % activityKinds.length]!;
    return {
      id: newId(now),
      branch_id: null,
      kind,
      title: `Kegiatan ${kind.replace(/_/g, ' ')} ${i + 1}`,
      held_on: heldOn,
      ended_on: null,
      participants: 10 + Math.floor(r() * 90),
      partner: i % 9 === 0 ? 'Dinas Perpustakaan Kota' : null,
      uses_library_facility: kind === 'learning_session' || kind === 'writing_guidance' ? (i % 2 === 0 ? 1 : 0) : 0,
      external_speaker: i % 11 === 0 ? 1 : 0,
      description: null,
      ...trail,
    };
  });

  const roles = ['head', 'librarian', 'librarian', 'librarian', 'ict', 'ict', ...Array<string>(10).fill('technical'), 'other', 'other', 'other', 'other'];
  const staff: Insertable<DB['library_staff']>[] = roles.slice(0, PERF_KOMUNITAS_SEED.staff).map((role, i) => ({
    id: newId(now),
    branch_id: null,
    staff_user_id: null,
    name: `Tenaga Perpustakaan Perf ${i + 1}`,
    position: role === 'head' ? 'Kepala perpustakaan' : 'Staf perpustakaan',
    role,
    is_librarian: role === 'head' || role === 'librarian' ? 1 : 0,
    employment: i % 3 === 0 ? 'civil_servant' : 'contract',
    education_level: role === 'head' || role === 'librarian' ? 's1' : 'sma',
    education_library: role === 'librarian' ? 1 : 0,
    library_training: 1,
    competency_cert: role === 'technical' && i % 2 === 0 ? 1 : 0,
    association_member: role === 'head' || role === 'librarian' ? 1 : 0,
    appointment_ref: `SK-PERF-${String(i + 1).padStart(3, '0')}`,
    starts_on: `${endYear - 6}-07-01`,
    ends_on: null,
    ...trail,
  }));
  const trainings: Insertable<DB['staff_trainings']>[] = staff.flatMap((s, i) =>
    spread(threeYearsBack, span.endsOn, PERF_KOMUNITAS_SEED.trainingsPerStaff).map((heldOn, k) => ({
      id: newId(now),
      library_staff_id: s.id,
      title: `Pelatihan perpustakaan ${i + 1}.${k + 1}`,
      organizer: 'Perpustakaan Nasional',
      held_on: addDays(heldOn, i),
      hours: 8 + 8 * k,
      certificate_file_id: null,
      ...trail,
    })),
  );

  const budgets: Insertable<DB['library_budgets']>[] = Array.from({ length: PERF_KOMUNITAS_SEED.budgetYears }, (_, k) => {
    const year = endYear - PERF_KOMUNITAS_SEED.budgetYears + 1 + k;
    return {
      id: newId(now),
      scope_key: '',
      branch_id: null,
      year,
      library_minor: (60_000_000 + k * 5_000_000) * 100,
      parent_minor: 2_000_000_000 * 100,
      parent_nonpersonnel_minor: 1_000_000_000 * 100,
      collection_minor: (30_000_000 + k * 2_000_000) * 100,
      community_minor: 5_000_000 * 100,
      currency: 'IDR',
      note: null,
      ...trail,
    };
  });

  const partnerships: Insertable<DB['library_partnerships']>[] = [
    { kind: 'mou', partner: 'Dinas Perpustakaan Kota', startsOn: `${endYear - 3}-01-01`, endsOn: `${endYear - 1}-12-31` },
    { kind: 'pks', partner: 'Perpustakaan Universitas Negeri', startsOn: `${endYear - 1}-02-01`, endsOn: null },
    { kind: 'mou', partner: 'Taman Bacaan Masyarakat', startsOn: `${endYear}-01-10`, endsOn: `${endYear + 1}-01-09` },
  ]
    .slice(0, PERF_KOMUNITAS_SEED.partnerships)
    .map((p) => ({ id: newId(now), branch_id: null, partner: p.partner, kind: p.kind, starts_on: p.startsOn, ends_on: p.endsOn, scope: 'Layanan bersama', document_file_id: null, ...trail }));

  const documents: Insertable<DB['library_documents']>[] = documentRows(endYear).map((d) => ({
    id: newId(now),
    branch_id: null,
    kind: d.kind,
    title: d.title,
    reference: `DOK-${d.kind}-${d.issuedOn}`.slice(0, 191),
    issued_on: d.issuedOn,
    issued_by: 'Kepala Sekolah',
    aspect_codes: d.aspects === null ? null : JSON.stringify(d.aspects),
    valid_until: null,
    file_id: null,
    ...trail,
  }));

  await withTx(h, async (trx) => {
    await insertRows(trx, 'library_activities', activities);
    await insertRows(trx, 'library_staff', staff);
    await insertRows(trx, 'staff_trainings', trainings);
    await insertRows(trx, 'library_budgets', budgets);
    await insertRows(trx, 'library_partnerships', partnerships);
    await insertRows(trx, 'library_documents', documents);
  });
}

/** The DDC classes the loans of a month are counted by. */
const DDC_KEYS = ['ddc:0', 'ddc:1', 'ddc:2', 'ddc:3', 'ddc:4', 'ddc:5', 'ddc:6', 'ddc:7', 'ddc:8', 'ddc:9', 'ddc:2X', 'ddc:NON'];

/**
 * The usage rows of 36 months up to the period's end, as the aggregate import writes them (source `slims`): per month
 * the visits (raw and without repeats), the loans, the distinct visitors and borrowers by member type, guests and in
 * total, the loans by class and the uses in the library; per school year (the period and the two before it) the
 * distinct counts; and the member types mapped to the school's groups. Answers the rows written.
 */
async function seedUsage(h: DbHandle, span: { startsOn: string; endsOn: string }, now: number): Promise<number> {
  const r = prng(36_036);
  const rows: Insertable<DB['usage_stats']>[] = [];
  const cell = (metric: string, spanFrom: string, spanTo: string, groupKey: string, value: number): void => {
    rows.push({ source: 'slims', metric, span_from: spanFrom, span_to: spanTo, branch_key: '', group_key: groupKey, value, run_id: null, updated_at: now, updated_by: null });
  };
  const typeKeys = PERF_MEMBER_TYPES.map((t) => `slims_type:${t.id}`);
  const shares = [0.82, 0.12, 0.03, 0.02];
  for (const month of usageMonths(span.endsOn)) {
    const from = `${month}-01`;
    const to = monthEnd(month);
    const holiday = month.endsWith('-07') || month.endsWith('-12');
    const base = holiday ? 150 : 2_000 + Math.floor(r() * 800);
    const groups = (scale: number): number[] => shares.map((s) => Math.max(0, Math.round(base * scale * s * (0.9 + r() * 0.2))));
    const visits = groups(1);
    const deduped = visits.map((v) => Math.round(v * 0.85));
    const unknown = Math.round(base * 0.01);
    const guests = Math.round(base * 0.04);
    const loans = groups(0.6);
    const visitors = visits.map((v) => Math.round(v / 6));
    const borrowers = loans.map((v) => Math.round(v / 3));
    const sum = (list: number[]): number => list.reduce((a, b) => a + b, 0);
    for (const [metric, values, guest] of [
      ['visits', visits, guests],
      ['visits_deduped', deduped, guests],
      ['loans', loans, null],
      ['distinct_visitors', visitors, null],
      ['distinct_borrowers', borrowers, null],
    ] as const) {
      values.forEach((v, i) => cell(metric, from, to, typeKeys[i]!, v));
      cell(metric, from, to, 'member_unknown', metric === 'loans' ? Math.round(unknown * 0.6) : unknown);
      if (guest !== null) cell(metric, from, to, 'guest', guest);
      cell(metric, from, to, '', sum(values) + (guest ?? 0) + unknown);
    }
    const loanTotal = sum(loans) + Math.round(unknown * 0.6);
    let left = loanTotal;
    DDC_KEYS.forEach((key, i) => {
      const v = i === DDC_KEYS.length - 1 ? left : Math.floor(loanTotal / DDC_KEYS.length);
      left -= v;
      cell('loans', from, to, key, v);
    });
    cell('in_library_uses', from, to, '', Math.round(base * 0.3));
  }
  for (let k = 0; k < 3; k += 1) {
    const from = `${Number(span.startsOn.slice(0, 4)) - 2 + k}-07-01`;
    const to = `${Number(span.startsOn.slice(0, 4)) - 1 + k}-06-30`;
    cell('titles_used', from, to, '', 6_000 + k * 400);
    cell('items_used', from, to, '', 9_000 + k * 500);
    PERF_MEMBER_TYPES.forEach((t, i) => {
      cell('distinct_borrowers', from, to, typeKeys[i]!, Math.round(900 * shares[i]!));
      cell('distinct_visitors', from, to, typeKeys[i]!, Math.round(1_100 * shares[i]!));
      cell('members_active', from, to, typeKeys[i]!, Math.round(1_200 * shares[i]!));
    });
    cell('distinct_borrowers', from, to, '', 900);
    cell('distinct_visitors', from, to, '', 1_100);
    cell('members_active', from, to, '', 1_200);
  }
  await withTx(h, async (trx) => {
    await insertRows(trx, 'usage_stats', rows);
    await insertRows(
      trx,
      'usage_group_map',
      PERF_MEMBER_TYPES.map((t) => ({ group_key: `slims_type:${t.id}`, label: t.name, accred_group: t.group, updated_at: now, updated_by: null })),
    );
  });
  return rows.length;
}

/** Evidence rows (and their files) per batch. */
const EVIDENCE_BATCH = 50;

/**
 * `count` evidence files of PERF_KOMUNITAS_SEED.evidenceEntryBytes each on the period's indicators: the upload,
 * screenshot, signed-document and photo items of every indicator in turn. Each file is a JPEG-framed block of random
 * bytes (what a scan or a photo compresses to: nothing).
 */
async function seedEvidence(h: DbHandle, dataDir: string, instrument: AccredInstrument, periodId: string, staffId: string, count: number, now: number, say: (line: string) => void): Promise<void> {
  const slots: { indicatorCode: string; evidenceCode: string }[] = [];
  for (const c of instrument.components) {
    for (const ind of c.indicators) {
      for (const item of ind.evidence) if (item.kind !== 'generated') slots.push({ indicatorCode: `SCH-${ind.code}`, evidenceCode: item.code });
    }
  }
  if (slots.length === 0) throw new Error(`seedKomunitas: the instrument ${instrument.id} has no evidence item to upload`);
  const storage = localStorageDriver(dataDir);
  const size = PERF_KOMUNITAS_SEED.evidenceEntryBytes;
  for (let start = 0; start < count; start += EVIDENCE_BATCH) {
    const files: Insertable<DB['files']>[] = [];
    const evidence: Insertable<DB['accred_evidence']>[] = [];
    for (let k = start; k < Math.min(count, start + EVIDENCE_BATCH); k += 1) {
      const slot = slots[k % slots.length]!;
      const fileId = newId(now);
      const evidenceId = newId(now);
      const bytes = randomBytes(size);
      bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
      bytes.set([0xff, 0xd9], size - 2);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await storage.put(fileId, bytes, { size, sha256 });
      files.push({ id: fileId, original_name: `bukti-${k + 1}.jpg`, mime: 'image/jpeg', size, sha256, context: 'accreditation.evidence', owner_type: 'accred_evidence', owner_id: evidenceId, access: 'staff', status: 'ok', created_at: now, created_by: staffId });
      evidence.push({ id: evidenceId, period_id: periodId, indicator_code: slot.indicatorCode, evidence_code: slot.evidenceCode, entity: null, entity_id: null, file_id: fileId, caption: `Bukti ${k + 1}`, sort_order: Math.floor(k / slots.length), created_at: now, created_by: staffId });
    }
    await withTx(h, async (trx) => {
      await insertRows(trx, 'files', files);
      await insertRows(trx, 'accred_evidence', evidence);
    });
    const done = Math.min(count, start + EVIDENCE_BATCH);
    if (done % 500 === 0 || done === count) say(`seed: ${done} evidence files`);
  }
}

/** Copies added per transaction by seedExtraItems. */
const EXTRA_BATCH = 2_000;

/** The barcode of extra copy `j` (0-based): apart from the catalogue's `P2…`. */
export function extraBarcode(j: number): string {
  return `P3${String(j + 1).padStart(7, '0')}`;
}

/**
 * Adds available copies (with their `imported` history row) to the live records, one record after another in id
 * order and round again, until the live copies number `total`. Answers how many it added (0 when there are as many
 * already).
 */
export async function seedExtraItems(h: DbHandle, o: { total: number; now?: number; say?: (line: string) => void }): Promise<number> {
  const now = o.now ?? Date.now();
  const say = o.say ?? (() => undefined);
  const live = Number((await h.db.selectFrom('items').select((eb) => eb.fn.countAll().as('n')).where('archived_at', 'is', null).executeTakeFirstOrThrow()).n);
  const wanted = o.total - live;
  if (wanted <= 0) return 0;
  const branch = await h.db.selectFrom('branches').select('id').where('archived_at', 'is', null).orderBy('created_at').orderBy('id').limit(1).executeTakeFirstOrThrow();
  const shelf = await h.db.selectFrom('locations').select('id').where('branch_id', '=', branch.id).where('kind', '=', 'shelf').orderBy('id').limit(1).executeTakeFirstOrThrow();
  const type = await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow();
  let added = 0;
  let after = '';
  while (added < wanted) {
    let records = (await h.db.selectFrom('records').select('id').where('id', '>', after).where('archived_at', 'is', null).orderBy('id').limit(EXTRA_BATCH).execute()).map((r) => r.id);
    if (records.length === 0) {
      // Round again from the first record.
      records = (await h.db.selectFrom('records').select('id').where('archived_at', 'is', null).orderBy('id').limit(EXTRA_BATCH).execute()).map((r) => r.id);
      if (records.length === 0) throw new Error('seedExtraItems: no live record to add copies to');
    }
    const take = records.slice(0, Math.min(records.length, wanted - added));
    const items: Insertable<DB['items']>[] = [];
    const events: Insertable<DB['item_events']>[] = [];
    take.forEach((recordId, i) => {
      const j = added + i;
      const id = newId(now);
      const year = 2015 + (j % 10);
      items.push({
        id,
        record_id: recordId,
        branch_id: branch.id,
        barcode_display: extraBarcode(j),
        barcode_key: extraBarcode(j),
        inventory_no: `INV-X/${year}/${String(j + 1).padStart(7, '0')}`,
        call_number: null,
        location_id: shelf.id,
        collection_type_id: type.id,
        status: 'available',
        status_note: null,
        parts_total: 1,
        acq_source: 'purchase',
        order_no: null,
        order_date: null,
        received_date: `${year}-0${1 + (j % 9)}-1${j % 10}`,
        invoice_date: null,
        supplier_id: null,
        invoice_no: null,
        price: 50_000 * 100,
        currency: 'IDR',
        note: null,
        archived_at: null,
        version: 0,
        created_at: now,
        created_by: null,
        updated_at: now,
        updated_by: null,
      });
      events.push({ id: newId(now), item_id: id, at: now, type: 'imported', from_status: null, to_status: 'available', from_location_id: null, to_location_id: shelf.id, actor_type: 'cli', actor_id: null, meta: '{"fields":[]}' });
    });
    await withTx(h, async (trx) => {
      await insertRows(trx, 'items', items);
      await insertRows(trx, 'item_events', events);
    });
    added += take.length;
    after = take[take.length - 1]!;
    if (added % 100_000 < EXTRA_BATCH || added === wanted) say(`seed: ${added} of ${wanted} extra copies`);
  }
  return added;
}
