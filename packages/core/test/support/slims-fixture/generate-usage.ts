import { addDays, addMonths, ddcClassOf, isCalendarDate } from '@altis/shared';
import { resolveWindow, type DateSpan } from '../../../src/accreditation/windows.js';
import type { FixtureCell, FixtureData, FixtureRow } from './generate.js';

// The usage rows of the synthetic SLiMS fixture, for the aggregate usage import, and the counts that import must find.
// SLiMS 9 table/column names (interoperability facts, no SLiMS code). Built from the plain fixture's data (its copies
// and titles, and its three members with their few loans) and appended to it before the dump is written (index.ts);
// the catalogue tables are never changed, so the catalogue migration sees the plain fixture.
//
// The rows: 4 member types; 320 members with unique ids, names, addresses, e-mails and institutions, their types and
// expiry dates; 30 graduates whose `member` row is gone but whose loans and visits remain; 3 000 loans across `loan`
// and `loan_history` (one in five only in the history, renewals with `return_date` filled and `is_return = 0`, history
// rows of copies that no longer exist, whose class only the history row still holds); 5 000 `visitor_count` rows
// (repeat check-ins within the hour, two identical rows, guests with an empty or a NULL id, a member id with spaces
// around it, a pair 20 minutes apart across a month boundary, a 0/50/100-minute chain, a pair exactly 60 minutes
// apart); `read_counter` rows; zero dates and `1970-01-01` in every dated table.
//
// The expectation is computed here from the final rows (the plain fixture's included), independently of the import,
// by these rules:
//
// - A member id is trimmed. NULL or empty is a guest: group `guest`. An id with a `member` row whose `member_type_id` is
//   set: group `slims_type:<member_type_id>`. Any other id (no `member` row: a deleted graduate; or a row without a
//   type, as the plain fixture's three members): group `member_unknown`.
// - A date is the first 10 characters of the cell; it counts when it is a calendar date other than `1970-01-01` (so
//   NULL, zero dates and `1970-01-01` are dropped as invalid); a date on or after `cutoverOn` is dropped too. The month
//   is the date's first 7 characters.
// - Loans: the rows of `loan` in order, then those of `loan_history`; a `loan_id` met before (in either table) is
//   skipped. No loan of the fixture has a dropped date in one table and a counted one in the other, so it does not
//   matter whether a dropped loan counts as met. Per month: by group, in total (key `''`), and by class
//   `ddc:<0…9|2X|NON>` (the main class of `ddcClassOf`, `000` written `0`), the class text being the classification of
//   the title the `item_code` leads to through `item`, or, when that is empty or the copy is gone, the history row's own
//   `classification`.
// - Visits: every `visitor_count` row with a counted date, by group and in total. A member's check-in is a repeat when
//   their previous check-in (counted, kept or not, in any month) lies less than `dedupeMinutes` minutes before it;
//   `visits_deduped` counts the check-ins that are not repeats, and every guest visit. `dedupeMinutes = 0` keeps all.
// - Distinct borrowers and visitors: distinct trimmed member ids, members only (no guest cell), by group and in total.
// - `in_library_uses`: `read_counter` rows with a counted `created_at`, total only.
// - Span metrics, for the three spans (the period and the two before it, oldest first; a date counts in a span when
//   `from ≤ date ≤ to`): `titles_used` (distinct `biblio_id`: through `item`, else the history row's) and `items_used`
//   (distinct non-empty `item_code`), from loans and reads, total only; `distinct_borrowers` and `distinct_visitors` by
//   group and in total; `members_active`: members with a type and a counted `expire_date` on or after the span's `to`,
//   by `slims_type:<id>` and in total.
// - A cell that is not listed is 0. `months` runs from the first to the last month holding a counted row.
//
// The expectation holds for the usage option alone (the re-sync option's catalogue changes may remove copies the class
// lookups use).

/** What the usage rows cover and how the import is run against them. */
export interface UsageFixtureOptions {
  /** The first month of the usage rows, `YYYY-MM` (default `2023-07`). */
  fromMonth?: string;
  /** How many months the usage rows cover, 2-120 (default 36). */
  months?: number;
  /** The period whose span metrics are expected (default: the last 12 months of the rows). */
  period?: { startsOn: string; endsOn: string };
  /** The repeat-visit window in minutes, 0-720 (default 60; 0 keeps every check-in). */
  dedupeMinutes?: number;
  /** Rows dated on or after this day are not counted (default null: none is cut). */
  cutoverOn?: string | null;
}

/** The options as the expectation was computed with them. */
export interface ResolvedUsageOptions {
  fromMonth: string;
  months: number;
  period: { startsOn: string; endsOn: string };
  dedupeMinutes: number;
  cutoverOn: string | null;
}

/** metric → group key → count; a missing entry is 0. */
export type UsageCells = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** The tables the usage import reads, as the fixture holds them. */
export type UsageFixtureTable = 'loan' | 'loan_history' | 'visitor_count' | 'member' | 'mst_member_type' | 'item' | 'biblio' | 'read_counter';

type DatedTable = 'loan' | 'loan_history' | 'visitor_count' | 'read_counter';

/** What the aggregate import must count from the usage rows. */
export interface UsageExpectation {
  options: ResolvedUsageOptions;
  memberTypes: readonly { id: number; name: string }[];
  /** The period's span and the two before it, oldest first (`spans[2]` is the period). */
  spans: readonly [DateSpan, DateSpan, DateSpan];
  /** Every month from the first to the last holding a counted row, `YYYY-MM`. */
  months: readonly string[];
  /** Per month: metric → group key → count (non-zero cells only). */
  monthly: Readonly<Record<string, UsageCells>>;
  /** Per span (index as `spans`): metric → group key → count (non-zero cells only). */
  spanCells: readonly [UsageCells, UsageCells, UsageCells];
  /** The count of one monthly cell (0 when not listed). */
  cell(month: string, metric: string, groupKey: string): number;
  /** The count of one span cell (0 when not listed). */
  spanCell(span: 0 | 1 | 2, metric: string, groupKey: string): number;
  /** The rows of each usage table in the dump (the plain fixture's included). */
  rows: Readonly<Record<UsageFixtureTable, number>>;
  /** Rows not counted: an invalid date, a date on or after the cut-over, a history row of a loan already met. */
  dropped: { dateInvalid: Readonly<Record<DatedTable, number>>; afterCutover: Readonly<Record<DatedTable, number>>; historyDuplicates: number };
  /** Counted loans and visits of ids without a typed `member` row (group `member_unknown`). */
  memberUnknown: { loans: number; visits: number };
  /** Where the traps are (raw member ids and SLiMS date strings). */
  traps: UsageTraps;
  /**
   * Every personal value of the generated rows (member ids, names, e-mails, addresses, institutions), for scans. Each
   * holds a space, `-` or `@`, so none can turn up by chance in a ULID, a hex hash, a date or a number.
   */
  personalValues: readonly string[];
}

export interface UsageTraps {
  /** One member's check-ins 20 minutes apart across a month boundary (one kept with a 60-minute window). */
  monthBoundary: { memberId: string; checkins: readonly [string, string] };
  /** One member's check-ins at 0, 50 and 100 minutes (one kept with a 60-minute window). */
  chain: { memberId: string; checkins: readonly [string, string, string] };
  /** One member's check-ins exactly 60 minutes apart (both kept with a 60-minute window). */
  exactWindow: { memberId: string; checkins: readonly [string, string] };
  /** Two identical `visitor_count` rows (one kept unless the window is 0). */
  identical: { memberId: string; checkin: string };
  /** A member id stored with spaces around it, and the same member's check-in 30 minutes later without them. */
  padded: { stored: string; memberId: string; checkins: readonly [string, string] };
  /** The ids of graduates whose `member` row is gone (group `member_unknown`). */
  graduates: readonly string[];
  /** Visits stored with an empty and with a NULL member id (dropped dates included). */
  guests: { empty: number; null: number };
  /** Loans renewed in SLiMS: `return_date` filled, `is_return = 0`. */
  renewals: readonly number[];
  /** How many loans are found only in `loan_history`. */
  historyOnly: number;
  /** History-only loans of copies that no longer exist: their class comes from the history row. */
  goneCopies: readonly { loanId: number; itemCode: string; classification: string | null }[];
}

/** The expectation the fixture hook returns. */
export type UsageFixtureExpected = UsageExpectation;

// ---------------------------------------------------------------------------------------------------------------------

/** mulberry32: a small deterministic generator (its own seed: the plain fixture's sequence is not disturbed). */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USAGE_SEED = 20261104;
const pad = (n: number, w: number): string => String(n).padStart(w, '0');

const TYPES = [
  { id: 1, name: 'Siswa', prefix: 'SIS', count: 240 },
  { id: 2, name: 'Guru', prefix: 'GRU', count: 40 },
  { id: 3, name: 'Staf TU', prefix: 'STF', count: 20 },
  { id: 4, name: 'Umum', prefix: 'UMU', count: 20 },
] as const;
const GRADUATES = 30;
const GUESTS = 120;
const LOANS = 3000;
const FIRST_LOAN_ID = 101;
const VISITS = 5000;
const READS = 300;

// Made-up name parts: person p is GIVEN[p % 20] MIDDLE[p / 20 % 12] FAMILY[p / 240 % 15], unique below 3 600.
const GIVEN = ['Arif', 'Bunga', 'Cahyo', 'Dinda', 'Erlangga', 'Farah', 'Gilang', 'Hana', 'Irfan', 'Juwita', 'Kevin', 'Laras', 'Mahesa', 'Nurul', 'Oktaviani', 'Prasetyo', 'Qonita', 'Reza', 'Salsabila', 'Tegar'];
const MIDDLE = ['Adi', 'Bayu', 'Cempaka', 'Dirga', 'Embun', 'Fadli', 'Galuh', 'Harum', 'Intan', 'Jagad', 'Kirana', 'Lintang'];
const FAMILY = ['Ardiansyah', 'Budiman', 'Chandra', 'Darmawan', 'Effendi', 'Firmansyah', 'Gunadi', 'Hartono', 'Iskandar', 'Junaedi', 'Kurniawan', 'Lesmana', 'Mulyadi', 'Nugroho', 'Oetomo'];
const STREETS = ['Anggrek', 'Bougenvil', 'Cendana', 'Dahlia', 'Flamboyan', 'Gardenia', 'Kamboja', 'Kenanga', 'Mawar', 'Teratai'];
const VILLAGES = ['Sukamaju', 'Sukasari', 'Mekarjaya', 'Cibening', 'Karangsari', 'Tegalrejo', 'Sidomulyo', 'Banjarsari'];
const PLACES = ['Cimahi', 'Bekasi', 'Depok', 'Bogor', 'Tangerang', 'Serang', 'Garut', 'Tasikmalaya', 'Cirebon', 'Kuningan'];
/** The classifications history rows of gone copies hold: 2X, NON (a letter token, an empty text, NULL), 800, 200. */
const HISTORY_CLASSES: readonly (string | null)[] = ['2X4.1', 'FIK 813 AND', '813.5', '', '297.3', null];

interface Person {
  name: string;
  address: string;
  institution: string;
  email: string | null;
}

function person(p: number): Person {
  return {
    name: `${GIVEN[p % 20]} ${MIDDLE[Math.floor(p / 20) % 12]} ${FAMILY[Math.floor(p / 240) % 15]}`,
    address: `Jl. ${STREETS[p % 10]} No. ${p + 1}, RT ${pad((p % 9) + 1, 2)}/RW ${pad((Math.floor(p / 9) % 7) + 1, 2)}, ${VILLAGES[p % 8]}`,
    institution: `Yayasan Pendidikan ${PLACES[Math.floor(p / 10) % 10]} Unit ${p + 1}`,
    email: p % 3 === 0 ? `pemustaka${p + 1}@contoh.test` : null,
  };
}

/** The months `fromMonth` … `fromMonth + months − 1`. */
function monthList(fromMonth: string, months: number): string[] {
  return Array.from({ length: months }, (_, i) => addMonths(`${fromMonth}-01`, i).slice(0, 7));
}

const lastDay = (month: string): string => addDays(addMonths(`${month}-01`, 1), -1);

function resolveOptions(o: UsageFixtureOptions): ResolvedUsageOptions {
  const fromMonth = o.fromMonth ?? '2023-07';
  const months = o.months ?? 36;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(fromMonth)) throw new TypeError(`generateUsage: fromMonth ${fromMonth} is not YYYY-MM`);
  if (!Number.isSafeInteger(months) || months < 2 || months > 120) throw new TypeError(`generateUsage: months ${months} is not 2-120`);
  const end = lastDay(monthList(fromMonth, months)[months - 1]!);
  const period = o.period ?? { startsOn: addMonths(addDays(end, 1), -12), endsOn: end };
  if (!isCalendarDate(period.startsOn) || !isCalendarDate(period.endsOn) || period.startsOn > period.endsOn) throw new TypeError('generateUsage: period is not a span of dates');
  const dedupeMinutes = o.dedupeMinutes ?? 60;
  if (!Number.isSafeInteger(dedupeMinutes) || dedupeMinutes < 0 || dedupeMinutes > 720) throw new TypeError(`generateUsage: dedupeMinutes ${dedupeMinutes} is not 0-720`);
  const cutoverOn = o.cutoverOn ?? null;
  if (cutoverOn !== null && !isCalendarDate(cutoverOn)) throw new TypeError(`generateUsage: cutoverOn ${cutoverOn} is not a date`);
  return { fromMonth, months, period: { startsOn: period.startsOn, endsOn: period.endsOn }, dedupeMinutes, cutoverOn };
}

// ---------------------------------------------------------------------------------------------------------------------
// The rows

interface Generated {
  rows: Record<UsageFixtureTable, FixtureRow[]>;
  traps: UsageTraps;
}

function generateRows(data: FixtureData, opt: ResolvedUsageOptions, spans: readonly [DateSpan, DateSpan, DateSpan]): Generated {
  const rand = generator(USAGE_SEED);
  const int = (n: number): number => Math.floor(rand() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)]!;
  const months = monthList(opt.fromMonth, opt.months);
  const monthAt = (i: number): string => months[Math.min(i, months.length - 1)]!;
  const randomDate = (): string => `${pick(months)}-${pad(1 + int(28), 2)}`;
  const randomTime = (): string => `${pad(7 + int(9), 2)}:${pad(int(60), 2)}:${pad(int(60), 2)}`;
  const plusMinutes = (at: string, minutes: number): string => {
    const n = (from: number, to: number): number => Number(at.slice(from, to));
    const t = Date.UTC(n(0, 4), n(5, 7) - 1, n(8, 10), n(11, 13), n(14, 16), n(17, 19)) + minutes * 60_000;
    return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
  };

  // The copies loans and reads use: plain item codes whose title exists, one item per code.
  const biblios = data.rows.get('biblio') ?? [];
  const biblioIds = new Set(biblios.map((b) => b['biblio_id']));
  const codeCount = new Map<string, number>();
  for (const item of data.rows.get('item') ?? []) {
    const code = item['item_code'];
    if (typeof code === 'string') codeCount.set(code, (codeCount.get(code) ?? 0) + 1);
  }
  const copies = (data.rows.get('item') ?? [])
    .filter((i) => typeof i['item_code'] === 'string' && /^B\d{5}$/.test(i['item_code']) && codeCount.get(i['item_code']) === 1 && biblioIds.has(i['biblio_id']))
    .map((i) => ({ code: i['item_code'] as string, biblioId: i['biblio_id'] as number }));
  if (copies.length < 50) throw new Error('generateUsage: the plain fixture has too few copies');
  const classOf = new Map<number, FixtureCell>(biblios.map((b) => [b['biblio_id'] as number, b['classification'] ?? null]));
  const titleOf = new Map<number, FixtureCell>(biblios.map((b) => [b['biblio_id'] as number, b['title'] ?? null]));

  // ---- member types and members
  const memberTypes: FixtureRow[] = TYPES.map((t) => ({ member_type_id: t.id, member_type_name: t.name }));
  const [e0, e1, e2] = [spans[0].to, spans[1].to, spans[2].to];
  const expiries: readonly (string | null)[] = [addMonths(e0, -3), e0, addDays(e1, -1), e1, e2, addMonths(e2, 12), '0000-00-00', null];
  interface Member extends Person {
    id: string;
    typeName: string;
  }
  const members: Member[] = [];
  const memberRows: FixtureRow[] = [];
  let p = 0;
  for (const t of TYPES) {
    for (let n = 1; n <= t.count; n += 1, p += 1) {
      const m: Member = { ...person(p), id: `${t.prefix}-${pad(n, 4)}`, typeName: t.name };
      members.push(m);
      memberRows.push({
        member_id: m.id,
        member_name: m.name,
        member_email: m.email,
        member_since_date: addMonths(spans[0].from, -(p % 24)),
        member_type_id: t.id,
        member_address: m.address,
        expire_date: expiries[(p * 7) % expiries.length] ?? null,
      });
    }
  }
  const graduates: Member[] = Array.from({ length: GRADUATES }, (_, k) => ({ ...person(p + k), id: `LUL-${pad(k + 1, 4)}`, typeName: 'Siswa' }));
  p += GRADUATES;
  const guests: Person[] = Array.from({ length: GUESTS }, (_, k) => person(p + k));

  // ---- visits: the traps first, then repeat bursts, graduates, guests and members
  interface Visit {
    memberId: string | null;
    name: string;
    institution: string;
    at: string;
  }
  const visits: Visit[] = [];
  const visit = (who: Person, memberId: string | null, at: string): void => {
    visits.push({ memberId, name: who.name, institution: who.institution, at });
  };
  const [boundary, chain, exact, identical, padded] = members as [Member, Member, Member, Member, Member, ...Member[]];
  const traps = {
    monthBoundary: { memberId: boundary.id, checkins: [`${lastDay(monthAt(0))} 23:50:00`, `${monthAt(1)}-01 00:10:00`] as const },
    chain: { memberId: chain.id, checkins: [`${monthAt(1)}-10 10:00:00`, `${monthAt(1)}-10 10:50:00`, `${monthAt(1)}-10 11:40:00`] as const },
    exactWindow: { memberId: exact.id, checkins: [`${monthAt(2)}-11 13:00:00`, `${monthAt(2)}-11 14:00:00`] as const },
    identical: { memberId: identical.id, checkin: `${monthAt(0)}-12 09:15:00` },
    padded: { stored: ` ${padded.id} `, memberId: padded.id, checkins: [`${monthAt(1)}-12 10:00:00`, `${monthAt(1)}-12 10:30:00`] as const },
  };
  for (const at of traps.monthBoundary.checkins) visit(boundary, boundary.id, at);
  for (const at of traps.chain.checkins) visit(chain, chain.id, at);
  for (const at of traps.exactWindow.checkins) visit(exact, exact.id, at);
  visit(identical, identical.id, traps.identical.checkin);
  visit(identical, identical.id, traps.identical.checkin);
  visit(padded, traps.padded.stored, traps.padded.checkins[0]);
  visit(padded, padded.id, traps.padded.checkins[1]);
  // The trap members check in nowhere else, so their sequences stay as described.
  const others = members.slice(5);
  const [o5, o6] = [others[5]!, others[6]!];
  const [g0, g1] = [guests[0]!, guests[1]!];
  const invalid: Visit[] = [
    { memberId: o5.id, name: o5.name, institution: o5.institution, at: '0000-00-00 00:00:00' },
    { memberId: '', name: g0.name, institution: g0.institution, at: '0000-00-00 00:00:00' },
    { memberId: graduates[0]!.id, name: graduates[0]!.name, institution: graduates[0]!.institution, at: '0000-00-00 00:00:00' },
    { memberId: o6.id, name: o6.name, institution: o6.institution, at: '1970-01-01 07:00:00' },
    { memberId: null, name: g1.name, institution: g1.institution, at: '1970-01-01 07:00:00' },
  ];
  for (let k = 0; k < 150; k += 1) {
    const m = pick(others);
    const at = `${randomDate()} ${randomTime()}`;
    visit(m, m.id, at);
    visit(m, m.id, plusMinutes(at, 5 + int(51)));
  }
  for (let k = 0; k < 300; k += 1) {
    const g = pick(graduates);
    visit(g, g.id, `${randomDate()} ${randomTime()}`);
  }
  for (let k = 0; k < 1000; k += 1) visit(pick(guests), k % 3 === 2 ? null : '', `${randomDate()} ${randomTime()}`);
  while (visits.length + invalid.length < VISITS) {
    const m = pick(others);
    visit(m, m.id, `${randomDate()} ${randomTime()}`);
  }
  // SLiMS numbers check-ins as they happen: by time, the rows with a broken date spread among them.
  const ordered = visits.map((v, i) => ({ v, i })).sort((a, b) => (a.v.at < b.v.at ? -1 : a.v.at > b.v.at ? 1 : a.i - b.i)).map((x) => x.v);
  invalid.forEach((v, k) => ordered.splice(Math.floor(((k + 1) * ordered.length) / (invalid.length + 1)), 0, v));
  const visitRows: FixtureRow[] = ordered.map((v, i) => ({ visitor_id: i + 1, member_id: v.memberId, member_name: v.name, institution: v.institution, checkin_date: v.at }));

  // ---- loans: 3 000, numbered by date; one in five only in the history
  const loanDates = Array.from({ length: LOANS }, () => randomDate()).sort();
  const rangeEnd = lastDay(months[months.length - 1]!);
  const loanRows: FixtureRow[] = [];
  const historyRows: FixtureRow[] = [];
  const renewals: number[] = [];
  const goneCopies: { loanId: number; itemCode: string; classification: string | null }[] = [];
  let historyOnly = 0;
  for (let k = 0; k < LOANS; k += 1) {
    const loanId = FIRST_LOAN_ID + k;
    const borrower = k % 10 === 3 || k % 10 === 9 ? pick(graduates) : pick(members);
    const copy = pick(copies);
    let date: string | null = loanDates[k]!;
    if (k === 7 || k === 507) date = '0000-00-00';
    if (k === 1007) date = '1970-01-01';
    if (k % 5 === 4) {
      // Only in the history: the loan row was deleted in SLiMS.
      historyOnly += 1;
      if (k === 1504) date = null;
      if (k === 2504) date = '0000-00-00';
      const stored = k % 50 === 14 ? ` ${borrower.id} ` : borrower.id;
      if (k % 100 === 4) {
        const classification = HISTORY_CLASSES[Math.floor(k / 100) % HISTORY_CLASSES.length] ?? null;
        const itemCode = `Z${pad(90000 + k, 6)}`;
        goneCopies.push({ loanId, itemCode, classification });
        historyRows.push({ loan_id: loanId, item_code: itemCode, biblio_id: 9500 + (k % 7), title: `Judul terhapus ${k}`, member_id: stored, classification, member_type_name: borrower.typeName, loan_date: date });
      } else {
        // Every seventh holds a class that disagrees with its title's: the title's class wins.
        const classification = k % 7 === 0 ? '999' : (classOf.get(copy.biblioId) ?? null);
        historyRows.push({ loan_id: loanId, item_code: copy.code, biblio_id: copy.biblioId, title: titleOf.get(copy.biblioId) ?? null, member_id: stored, classification, member_type_name: borrower.typeName, loan_date: date });
      }
      continue;
    }
    const valid = isCalendarDate(date) && date !== '1970-01-01';
    const renewed = valid && k % 10 === 0;
    const open = valid && !renewed && date > addDays(rangeEnd, -14);
    if (renewed) renewals.push(loanId);
    loanRows.push({
      loan_id: loanId,
      item_code: copy.code,
      member_id: borrower.id,
      loan_date: date,
      due_date: valid ? addDays(date, renewed ? 14 : 7) : '0000-00-00',
      is_lent: 1,
      is_return: renewed || open ? 0 : 1,
      return_date: renewed ? addDays(date, 7) : open || !valid ? null : addDays(date, 1 + (k % 14)),
    });
    if (valid && k % 4 !== 3) {
      historyRows.push({ loan_id: loanId, item_code: copy.code, biblio_id: copy.biblioId, title: titleOf.get(copy.biblioId) ?? null, member_id: borrower.id, classification: classOf.get(copy.biblioId) ?? null, member_type_name: borrower.typeName, loan_date: date });
    }
  }

  // ---- reads (a read-counter plugin's table), numbered by date; the plain fixture has ids 1 and 2
  const readDates = Array.from({ length: READS - 2 }, () => `${randomDate()} ${randomTime()}`).sort();
  const readRows: FixtureRow[] = readDates.map((at, k) => ({ id: 3 + k, item_code: pick(copies).code, title: null, created_at: at }));
  readRows.push({ id: 3 + readDates.length, item_code: copies[0]!.code, title: null, created_at: '0000-00-00 00:00:00' });
  readRows.push({ id: 4 + readDates.length, item_code: copies[1]!.code, title: null, created_at: null });

  return {
    rows: { loan: loanRows, loan_history: historyRows, visitor_count: visitRows, member: memberRows, mst_member_type: memberTypes, item: [], biblio: [], read_counter: readRows },
    traps: {
      ...traps,
      graduates: graduates.map((g) => g.id),
      guests: { empty: visitRows.filter((v) => v['member_id'] === '').length, null: visitRows.filter((v) => v['member_id'] === null).length },
      renewals,
      historyOnly,
      goneCopies,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The ground truth

/** A counted date (`YYYY-MM-DD`), or null for NULL, a zero date, `1970-01-01` or anything else. */
function dateOf(cell: FixtureCell | undefined): string | null {
  if (typeof cell !== 'string') return null;
  const date = cell.slice(0, 10);
  return isCalendarDate(date) && date !== '1970-01-01' ? date : null;
}

/** Seconds of a `YYYY-MM-DD HH:MM:SS` text (any fixed zone: only differences are used). */
function secondsOf(text: string): number {
  const n = (from: number, to: number): number => Number(text.slice(from, to) || '0');
  return Date.UTC(n(0, 4), n(5, 7) - 1, n(8, 10), n(11, 13), n(14, 16), n(17, 19)) / 1000;
}

/**
 * For one member's check-ins (`YYYY-MM-DD HH:MM:SS`, in time order): whether each is kept, that is, not a repeat. A
 * check-in is a repeat when the one before it, kept or not, lies less than `dedupeMinutes` minutes earlier.
 */
export function keptCheckins(checkins: readonly string[], dedupeMinutes: number): boolean[] {
  const window = dedupeMinutes * 60;
  return checkins.map((at, i) => i === 0 || !(secondsOf(at) - secondsOf(checkins[i - 1]!) < window));
}

const idOf = (cell: FixtureCell | undefined): string => (typeof cell === 'string' ? cell.trim() : typeof cell === 'number' ? String(cell) : '');

/** `ddc:<0…9|2X|NON>` of a class text. */
function ddcKey(text: string | null): string {
  const main = ddcClassOf(text, null).main;
  return `ddc:${/^\d00$/.test(main) ? main.slice(0, 1) : main}`;
}

class Counter {
  readonly cells: Record<string, Record<string, number>> = {};

  add(metric: string, key: string, n = 1): void {
    const m = (this.cells[metric] ??= {});
    m[key] = (m[key] ?? 0) + n;
  }

  addSizes(metric: string, sets: ReadonlyMap<string, ReadonlySet<string>>): void {
    for (const [key, set] of sets) if (set.size > 0) this.add(metric, key, set.size);
  }
}

/** Sets by key, created on first use. */
class Sets {
  readonly map = new Map<string, Set<string>>();

  add(key: string, value: string): void {
    let set = this.map.get(key);
    if (set === undefined) this.map.set(key, (set = new Set()));
    set.add(value);
  }
}

function computeExpectation(
  final: Record<UsageFixtureTable, readonly FixtureRow[]>,
  own: Record<UsageFixtureTable, readonly FixtureRow[]>,
  opt: ResolvedUsageOptions,
  spans: readonly [DateSpan, DateSpan, DateSpan],
  traps: UsageTraps,
): UsageExpectation {
  const counted = (date: string | null): 'ok' | 'invalid' | 'cut' => (date === null ? 'invalid' : opt.cutoverOn !== null && date >= opt.cutoverOn ? 'cut' : 'ok');
  const dateInvalid: Record<DatedTable, number> = { loan: 0, loan_history: 0, visitor_count: 0, read_counter: 0 };
  const afterCutover: Record<DatedTable, number> = { loan: 0, loan_history: 0, visitor_count: 0, read_counter: 0 };
  /** The date of `cell` when it counts, else null (the drop is tallied for `table`). */
  const take = (table: DatedTable, cell: FixtureCell | undefined): string | null => {
    const date = dateOf(cell);
    const state = counted(date);
    if (state === 'invalid') dateInvalid[table] += 1;
    if (state === 'cut') afterCutover[table] += 1;
    return state === 'ok' ? date : null;
  };

  const memberType = new Map<string, number | null>();
  for (const m of final.member) {
    const id = idOf(m['member_id']);
    if (id !== '' && !memberType.has(id)) memberType.set(id, typeof m['member_type_id'] === 'number' ? m['member_type_id'] : null);
  }
  const groupOf = (cell: FixtureCell | undefined): string => {
    const id = idOf(cell);
    if (id === '') return 'guest';
    const type = memberType.get(id);
    return type === undefined || type === null ? 'member_unknown' : `slims_type:${type}`;
  };
  const itemBiblio = new Map<string, number>();
  for (const i of final.item) {
    const code = i['item_code'];
    const biblio = i['biblio_id'];
    if (typeof code === 'string' && typeof biblio === 'number' && !itemBiblio.has(code)) itemBiblio.set(code, biblio);
  }
  const biblioClass = new Map<number, string | null>();
  for (const b of final.biblio) {
    const id = b['biblio_id'];
    const cls = b['classification'];
    if (typeof id === 'number') biblioClass.set(id, typeof cls === 'string' ? cls : null);
  }

  const monthly = new Map<string, Counter>();
  const monthCounter = (date: string): Counter => {
    const month = date.slice(0, 7);
    let c = monthly.get(month);
    if (c === undefined) monthly.set(month, (c = new Counter()));
    return c;
  };
  const inSpans = (date: string): (0 | 1 | 2)[] => ([0, 1, 2] as const).filter((s) => spans[s].from <= date && date <= spans[s].to);
  const spanCounters = [new Counter(), new Counter(), new Counter()] as const;
  const spanItems = [new Set<string>(), new Set<string>(), new Set<string>()] as const;
  const spanTitles = [new Set<number>(), new Set<number>(), new Set<number>()] as const;
  const spanBorrowers = [new Sets(), new Sets(), new Sets()] as const;
  const spanVisitors = [new Sets(), new Sets(), new Sets()] as const;
  const monthBorrowers = new Map<string, Sets>();
  const monthVisitors = new Map<string, Sets>();
  const setsOf = (all: Map<string, Sets>, date: string): Sets => {
    const month = date.slice(0, 7);
    let sets = all.get(month);
    if (sets === undefined) all.set(month, (sets = new Sets()));
    return sets;
  };
  const used = (date: string, itemCode: FixtureCell | undefined, historyBiblio: FixtureCell | undefined): void => {
    const code = typeof itemCode === 'string' && itemCode !== '' ? itemCode : null;
    const biblio = code !== null && itemBiblio.has(code) ? itemBiblio.get(code)! : typeof historyBiblio === 'number' ? historyBiblio : null;
    for (const s of inSpans(date)) {
      if (code !== null) spanItems[s].add(code);
      if (biblio !== null) spanTitles[s].add(biblio);
    }
  };
  const memberUnknown = { loans: 0, visits: 0 };

  // Loans.
  const met = new Set<string>();
  let historyDuplicates = 0;
  const loan = (table: 'loan' | 'loan_history', row: FixtureRow): void => {
    const loanId = String(row['loan_id']);
    if (met.has(loanId)) {
      historyDuplicates += 1;
      return;
    }
    met.add(loanId);
    const date = take(table, row['loan_date']);
    if (date === null) return;
    const group = groupOf(row['member_id']);
    const c = monthCounter(date);
    c.add('loans', group);
    c.add('loans', '');
    const code = row['item_code'];
    const biblio = typeof code === 'string' ? itemBiblio.get(code) : undefined;
    const own = biblio === undefined ? null : (biblioClass.get(biblio) ?? null);
    const history = table === 'loan_history' && typeof row['classification'] === 'string' ? row['classification'] : null;
    c.add('loans', ddcKey(own !== null && own.trim() !== '' ? own : history));
    if (group === 'member_unknown') memberUnknown.loans += 1;
    if (group !== 'guest') {
      const id = idOf(row['member_id']);
      for (const sets of [setsOf(monthBorrowers, date), ...inSpans(date).map((s) => spanBorrowers[s])]) {
        sets.add(group, id);
        sets.add('', id);
      }
    }
    used(date, code, table === 'loan_history' ? row['biblio_id'] : undefined);
  };
  for (const row of final.loan) loan('loan', row);
  for (const row of final.loan_history) loan('loan_history', row);

  // Visits.
  const checkins = new Map<string, { t: number; text: string; date: string; group: string; at: number }[]>();
  final.visitor_count.forEach((row, at) => {
    const date = take('visitor_count', row['checkin_date']);
    if (date === null) return;
    const group = groupOf(row['member_id']);
    const c = monthCounter(date);
    c.add('visits', group);
    c.add('visits', '');
    if (group === 'guest') {
      c.add('visits_deduped', 'guest');
      c.add('visits_deduped', '');
      return;
    }
    if (group === 'member_unknown') memberUnknown.visits += 1;
    const id = idOf(row['member_id']);
    const list = checkins.get(id) ?? [];
    const text = row['checkin_date'] as string;
    list.push({ t: secondsOf(text), text, date, group, at });
    checkins.set(id, list);
    for (const sets of [setsOf(monthVisitors, date), ...inSpans(date).map((s) => spanVisitors[s])]) {
      sets.add(group, id);
      sets.add('', id);
    }
  });
  for (const list of checkins.values()) {
    list.sort((a, b) => a.t - b.t || a.at - b.at);
    const kept = keptCheckins(list.map((c) => c.text), opt.dedupeMinutes);
    list.forEach((c, i) => {
      if (!kept[i]) return;
      monthCounter(c.date).add('visits_deduped', c.group);
      monthCounter(c.date).add('visits_deduped', '');
    });
  }

  // Reads.
  for (const row of final.read_counter) {
    const date = take('read_counter', row['created_at']);
    if (date === null) continue;
    monthCounter(date).add('in_library_uses', '');
    used(date, row['item_code'], undefined);
  }

  // The distinct counts, and the span metrics.
  for (const [month, sets] of monthBorrowers) monthCounter(month).addSizes('distinct_borrowers', sets.map);
  for (const [month, sets] of monthVisitors) monthCounter(month).addSizes('distinct_visitors', sets.map);
  for (const s of [0, 1, 2] as const) {
    const c = spanCounters[s];
    if (spanTitles[s].size > 0) c.add('titles_used', '', spanTitles[s].size);
    if (spanItems[s].size > 0) c.add('items_used', '', spanItems[s].size);
    c.addSizes('distinct_borrowers', spanBorrowers[s].map);
    c.addSizes('distinct_visitors', spanVisitors[s].map);
    for (const m of final.member) {
      const type = m['member_type_id'];
      const expires = dateOf(m['expire_date']);
      if (typeof type !== 'number' || idOf(m['member_id']) === '' || expires === null || expires < spans[s].to) continue;
      c.add('members_active', `slims_type:${type}`);
      c.add('members_active', '');
    }
  }

  const present = [...monthly.keys()].sort();
  const months: string[] = [];
  if (present.length > 0) {
    for (let m = present[0]!; m <= present[present.length - 1]!; m = addMonths(`${m}-01`, 1).slice(0, 7)) months.push(m);
  }
  const monthlyCells: Record<string, UsageCells> = {};
  for (const m of present) monthlyCells[m] = monthly.get(m)!.cells;
  const spanCells = [spanCounters[0].cells, spanCounters[1].cells, spanCounters[2].cells] as const;

  // Every personal value of the rows generated here (the plain fixture's three short ids are left out: a random ULID
  // could hold one by chance, while every value here has a character no ULID or hex hash has).
  const personal = new Set<string>();
  const keep = (cell: FixtureCell | undefined): void => {
    if (typeof cell === 'string' && cell.trim() !== '') personal.add(cell.trim());
  };
  for (const m of own.member) for (const c of ['member_id', 'member_name', 'member_email', 'member_address']) keep(m[c]);
  for (const v of own.visitor_count) for (const c of ['member_id', 'member_name', 'institution']) keep(v[c]);
  for (const l of [...own.loan, ...own.loan_history]) keep(l['member_id']);

  const rows = Object.fromEntries(Object.entries(final).map(([t, list]) => [t, list.length])) as Record<UsageFixtureTable, number>;
  return {
    options: opt,
    memberTypes: TYPES.map((t) => ({ id: t.id, name: t.name })),
    spans,
    months,
    monthly: monthlyCells,
    spanCells,
    cell: (month, metric, groupKey) => monthlyCells[month]?.[metric]?.[groupKey] ?? 0,
    spanCell: (span, metric, groupKey) => spanCells[span][metric]?.[groupKey] ?? 0,
    rows,
    dropped: { dateInvalid, afterCutover, historyDuplicates },
    memberUnknown,
    traps,
    personalValues: [...personal].sort(),
  };
}

/** The rows to add per table, and what the import must count from the final rows (the plain fixture's included). */
export function generateUsage(
  data: FixtureData,
  o: UsageFixtureOptions,
): { rows: Readonly<Record<string, readonly FixtureRow[]>>; expected: UsageExpectation } {
  const opt = resolveOptions(o);
  const slices = resolveWindow('three_periods', opt.period, opt.period.endsOn).slices!;
  const spans = [slices[0]!, slices[1]!, slices[2]!] as const;
  const generated = generateRows(data, opt, spans);
  const tables = Object.keys(generated.rows) as UsageFixtureTable[];
  const final = Object.fromEntries(tables.map((t) => [t, [...(data.rows.get(t) ?? []), ...generated.rows[t]]])) as Record<UsageFixtureTable, FixtureRow[]>;
  const rows = Object.fromEntries(tables.filter((t) => generated.rows[t].length > 0).map((t) => [t, generated.rows[t]]));
  return { rows, expected: computeExpectation(final, generated.rows, opt, spans, generated.traps) };
}
