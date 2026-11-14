import fs from 'node:fs';
import { once } from 'node:events';
import { FIXTURE_TABLES } from '../../../packages/core/test/support/slims-fixture/schema.js';
import { perfBarcode, perfCounts, perfRecord, prng, type PerfCounts } from '../perf-phase2/seed.js';
import { PERF_MEMBER_TYPES, monthEnd, usageMonths } from './seed.js';

// The SLiMS dump of the usage import's budget (the community roadmap: an aggregate import of 1 000 000 `loan_history`
// and 1 000 000 `visitor_count` rows within 30 minutes): a SLiMS 9 mysqldump in the table and column layout of the
// synthetic fixture's schema (packages/core/test/support/slims-fixture/schema.ts; SLiMS 9 table/column names,
// interoperability facts, no SLiMS code). Every table of that schema is created; these are filled, at scale 1:
//
// - `mst_member_type`: the four member types of PERF_MEMBER_TYPES;
// - `member`: 20 000 members (their types in the shares of a school: students first), their expiry dates;
// - `biblio` and `item`: the Phase 2 perf catalogue (100 000 titles, 150 000 copies; only what the class lookup of a
//   loan reads: the title, its class, the copy's code);
// - `loan`: 50 000 loans of the last two months (one in ten still out);
// - `loan_history`: 1 000 000 loans over the 36 months up to the period's end, each with its class and member type;
// - `visitor_count`: 1 000 000 check-ins over the same months, school days and hours, one in seven a guest (an empty
//   or NULL member id with a name and an institution), members checking in again within the hour now and then;
// - `read_counter`: 50 000 uses in the library.
//
// Rows and names are generated from fixed formulas (prng), so one scale always writes the same dump. The file is
// written as a stream, a batch at a time: memory stays flat whatever the scale.

/** The rows of the usage tables at scale 1. */
export const USAGE_DUMP_ROWS = Object.freeze({
  members: 20_000,
  loans: 50_000,
  loanHistory: 1_000_000,
  visits: 1_000_000,
  reads: 50_000,
});

export interface UsageDumpCounts {
  catalog: PerfCounts;
  members: number;
  loans: number;
  loanHistory: number;
  visits: number;
  reads: number;
}

/** The dump's rows at `scale` (each at least 1). */
export function usageDumpCounts(scale = 1): UsageDumpCounts {
  const of = (n: number): number => Math.max(1, Math.round(n * scale));
  return {
    catalog: perfCounts(scale),
    members: of(USAGE_DUMP_ROWS.members),
    loans: of(USAGE_DUMP_ROWS.loans),
    loanHistory: of(USAGE_DUMP_ROWS.loanHistory),
    visits: of(USAGE_DUMP_ROWS.visits),
    reads: of(USAGE_DUMP_ROWS.reads),
  };
}

/** The member id of member `k` (0-based). */
export function perfMemberId(k: number): string {
  return `PRF${String(k + 1).padStart(7, '0')}`;
}

/** The member type of member `k`: students first (about 85 %), then teachers, staff and the public. */
function memberTypeOf(k: number): (typeof PERF_MEMBER_TYPES)[number] {
  const u = (k * 7_919) % 100;
  return PERF_MEMBER_TYPES[u < 85 ? 0 : u < 94 ? 1 : u < 97 ? 2 : 3]!;
}

/** What mysqldump writes for each character it escapes in a string literal. */
const SQL_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['\\', '\\\\'],
  ["'", "\\'"],
  ['"', '\\"'],
  [String.fromCharCode(0), '\\0'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  [String.fromCharCode(26), '\\Z'],
]);

type SqlCell = string | number | null;

function sqlText(s: string): string {
  let out = "'";
  for (const ch of s) out += SQL_ESCAPES.get(ch) ?? ch;
  return `${out}'`;
}

const cell = (v: SqlCell): string => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : sqlText(v));

function tableOf(name: string): (typeof FIXTURE_TABLES)[number] {
  const table = FIXTURE_TABLES.find((t) => t.name === name);
  if (table === undefined) throw new Error(`usage dump: no fixture table ${name}`);
  return table;
}

/** The CREATE TABLE of a fixture table, as mysqldump writes it. */
function createTable(name: string): string {
  const table = tableOf(name);
  const lines = table.columns.map(([column, type]) => `  \`${column}\` ${type}`);
  if (table.primaryKey.length > 0) lines.push(`  PRIMARY KEY (${table.primaryKey.map((c) => `\`${c}\``).join(',')})`);
  lines.push(...(table.keys ?? []).map((k) => `  ${k}`));
  const charset = table.charset ?? 'utf8mb4';
  return (
    [
      '--',
      `-- Table structure for table \`${name}\``,
      '--',
      '',
      `DROP TABLE IF EXISTS \`${name}\`;`,
      `CREATE TABLE \`${name}\` (`,
      lines.join(',\n'),
      `) ENGINE=InnoDB DEFAULT CHARSET=${charset}${charset === 'utf8mb4' ? ' COLLATE=utf8mb4_unicode_ci' : ''};`,
      '',
    ].join('\n') + '\n'
  );
}

/** The INSERT statements of `rows` (each a column → value map; a column left out is NULL), 200 rows per statement. */
function* inserts(name: string, rows: Iterable<Readonly<Record<string, SqlCell>>>): Iterable<string> {
  const table = tableOf(name);
  const known = new Set(table.columns.map(([c]) => c));
  let batch: string[] = [];
  const flush = (): string => {
    const text = `INSERT INTO \`${name}\` VALUES ${batch.join(',')};\n`;
    batch = [];
    return text;
  };
  yield `LOCK TABLES \`${name}\` WRITE;\n`;
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!known.has(key)) throw new Error(`usage dump: ${name} has no column ${key}`);
    batch.push(`(${table.columns.map(([c]) => cell(row[c] ?? null)).join(',')})`);
    if (batch.length === 200) yield flush();
  }
  if (batch.length > 0) yield flush();
  yield 'UNLOCK TABLES;\n\n';
}

/** A `YYYY-MM-DD` of `month` (a school day of it, 1 … 28). */
function dayOf(month: string, u: number): string {
  return `${month}-${String(1 + Math.floor(u * 28)).padStart(2, '0')}`;
}

/** A `hh:mm:ss` of school hours (07:00 … 15:59). */
function timeOf(u: number): string {
  const minutes = 7 * 60 + Math.floor(u * 9 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
}

/**
 * Writes the dump of `scale` to `file` (see the top of this file), its usage months the 36 up to `endsOn` (the
 * period's end). Answers the bytes written and the counts.
 */
export async function writeUsageDump(file: string, o: { scale?: number; endsOn: string }): Promise<{ bytes: number; counts: UsageDumpCounts }> {
  const counts = usageDumpCounts(o.scale ?? 1);
  const months = usageMonths(o.endsOn);
  const recent = months.slice(-2);
  const lastDay = monthEnd(months[months.length - 1]!);
  const filled = new Set(['mst_member_type', 'member', 'biblio', 'item', 'loan', 'loan_history', 'visitor_count', 'read_counter']);
  /** The copy `j` (0-based) of the catalogue: its record number and its code. */
  const itemCount = counts.catalog.items;

  function* chunks(): Iterable<string> {
    yield [
      '-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)',
      '--',
      '-- Host: localhost    Database: slims_perf_usage',
      '-- ------------------------------------------------------',
      '',
      '/*!40101 SET NAMES utf8mb4 */;',
      "/*!40103 SET TIME_ZONE='+00:00' */;",
      '',
    ].join('\n') + '\n';
    for (const table of FIXTURE_TABLES) {
      yield createTable(table.name);
      if (filled.has(table.name)) yield* inserts(table.name, rowsOf(table.name));
    }
    yield '-- Dump completed\n';
  }

  function* rowsOf(name: string): Iterable<Readonly<Record<string, SqlCell>>> {
    switch (name) {
      case 'mst_member_type':
        for (const t of PERF_MEMBER_TYPES) yield { member_type_id: t.id, member_type_name: t.name };
        return;
      case 'member':
        for (let k = 0; k < counts.members; k += 1) {
          const t = memberTypeOf(k);
          yield {
            member_id: perfMemberId(k),
            member_name: `Anggota Perf ${k + 1}`,
            member_email: null,
            member_since_date: `${months[0]!.slice(0, 4)}-07-15`,
            member_type_id: t.id,
            member_address: `Jl. Anggota Perf No. ${k + 1}`,
            expire_date: `${Number(lastDay.slice(0, 4)) + (k % 3)}-06-30`,
          };
        }
        return;
      case 'biblio':
        for (let n = 0; n < counts.catalog.records; n += 1) {
          const rec = perfRecord(n, counts.catalog);
          yield { biblio_id: n + 1, gmd_id: 1, title: rec.title, call_number: rec.callNumber, language_id: 'id', classification: rec.classification, opac_hide: 0, promoted: 0, frequency_id: 0 };
        }
        return;
      case 'item':
        for (let n = 0; n < counts.catalog.records; n += 1) {
          for (const j of perfRecord(n, counts.catalog).items) {
            yield { item_id: j + 1, biblio_id: n + 1, coll_type_id: 1, item_code: perfBarcode(j), inventory_code: `INV/${String(j + 1).padStart(7, '0')}`, location_id: 'PST', item_status_id: '', source: 1 };
          }
        }
        return;
      case 'loan': {
        const r = prng(4_001);
        for (let k = 0; k < counts.loans; k += 1) {
          const day = dayOf(recent[k % recent.length]!, r());
          const open = k % 10 === 0;
          yield {
            loan_id: k + 1,
            item_code: perfBarcode(Math.floor(r() * itemCount)),
            member_id: perfMemberId(Math.floor(r() * counts.members)),
            loan_date: day,
            due_date: day,
            is_lent: 1,
            is_return: open ? 0 : 1,
            return_date: open ? null : day,
          };
        }
        return;
      }
      case 'loan_history': {
        const r = prng(4_002);
        for (let k = 0; k < counts.loanHistory; k += 1) {
          const j = Math.floor(r() * itemCount);
          const member = Math.floor(r() * counts.members);
          // A loan of a member of the school, its class and its type kept with it.
          yield {
            loan_id: counts.loans + k + 1,
            item_code: perfBarcode(j),
            biblio_id: 1 + (j % counts.catalog.records),
            title: null,
            member_id: perfMemberId(member),
            classification: String((j % 10) * 100).padStart(3, '0'),
            member_type_name: memberTypeOf(member).name,
            loan_date: dayOf(months[Math.floor(r() * months.length)]!, r()),
          };
        }
        return;
      }
      case 'visitor_count': {
        const r = prng(4_003);
        let previous: { member: string; date: string; minutes: number } | null = null;
        for (let k = 0; k < counts.visits; k += 1) {
          const guest = k % 7 === 6;
          let member = guest ? null : perfMemberId(Math.floor(r() * counts.members));
          let checkin = `${dayOf(months[Math.floor(r() * months.length)]!, r())} ${timeOf(r())}`;
          // Now and then the same member again within the hour (a repeat the import does not count twice).
          if (!guest && previous !== null && k % 13 === 0) {
            member = previous.member;
            const minutes = Math.min(previous.minutes + 20, 15 * 60 + 59);
            checkin = `${previous.date} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
          }
          if (member !== null) previous = { member, date: checkin.slice(0, 10), minutes: Number(checkin.slice(11, 13)) * 60 + Number(checkin.slice(14, 16)) };
          yield {
            visitor_id: k + 1,
            member_id: guest ? (k % 2 === 0 ? '' : null) : member,
            member_name: guest ? `Tamu Perf ${k + 1}` : '',
            institution: guest ? 'Sekolah Mitra' : null,
            checkin_date: checkin,
          };
        }
        return;
      }
      case 'read_counter': {
        const r = prng(4_004);
        for (let k = 0; k < counts.reads; k += 1) {
          yield { id: k + 1, item_code: perfBarcode(Math.floor(r() * itemCount)), title: null, created_at: `${dayOf(months[Math.floor(r() * months.length)]!, r())} ${timeOf(r())}` };
        }
        return;
      }
      default:
        return;
    }
  }

  const out = fs.createWriteStream(file);
  let bytes = 0;
  try {
    let part = '';
    for (const chunk of chunks()) {
      part += chunk;
      if (part.length >= 1 << 20) {
        bytes += Buffer.byteLength(part);
        if (!out.write(part)) await once(out, 'drain');
        part = '';
      }
    }
    bytes += Buffer.byteLength(part);
    if (part !== '' && !out.write(part)) await once(out, 'drain');
  } finally {
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
  }
  return { bytes, counts };
}
