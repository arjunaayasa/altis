import { gzipSync } from 'node:zlib';
import type { ForeignMysql } from '@altis/db';
import type { RawEntry } from '../helpers/raw-zip.js';
import { generateSlimsFixture, renderDump, type FixtureCell, type FixtureData, type FixtureRow, type SlimsFixtureExpected } from './slims-fixture/generate.js';
import { generateUsage } from './slims-fixture/generate-usage.js';
import { FIXTURE_TABLES } from './slims-fixture/schema.js';

// The synthetic SLiMS fixture as a real MySQL server holds it, for the test that reads the same SLiMS through its dump
// and through a direct connection (slims-db-source-mysql.test.ts). SLiMS 9 table/column names only (interoperability
// facts, no SLiMS code).
//
// - The data: the plain fixture with the usage rows (member types, members, loans, visits), so the member, visit and
//   circulation stages have real work; five typed members get a `member_image`, whose files the test writes under
//   `images/persons/` of a SLiMS folder (stored, not a JPEG, missing, too large).
// - Two cells the fixture holds that no MySQL server could have dumped are made what the server would store, on both
//   paths alike (`adjustments` lists them, so a new one is noticed): a text longer than its `varchar(n)` (a server in
//   the dump's non-strict mode cuts it to n characters) and a `char(n)` value ending in spaces (a server strips them).
// - mysqlDumpStatements splits the dump into the statements a client would send: `--` comments dropped, `/*!...*/`
//   kept (the server runs them), a `DELIMITER` block (the trigger of `loan`) skipped, `SET NAMES` taken by the
//   splitter itself (the statements after `SET NAMES latin1` are decoded as Windows-1252, which is MySQL's `latin1`,
//   and sent as UTF-8 text on the client's utf8mb4 connection: the server stores the same latin1 bytes), and the
//   `AUTO_INCREMENT` of a column dropped from a CREATE TABLE without a primary key (a phpMyAdmin-style table, whose key
//   comes by ALTER TABLE at the end of the dump; MySQL refuses an auto column that is not a key).
// - renderDumpInOrder writes the same data with each table's rows in the order given (the test gives the server's
//   primary-key order, the order the database source reads in, as mysqldump writes an InnoDB table).

/** The members whose photo the test supplies, and what the migration must make of each. */
export interface SlimsPhotoCase {
  memberId: string;
  /** `member.member_image`: the file under `images/persons/`. */
  image: string;
  /** The file's bytes in the SLiMS folder, or null when it is missing there. */
  bytes: Buffer | null;
  outcome: 'stored' | 'not_jpeg' | 'missing' | 'too_large';
}

export interface MysqlSlimsFixture {
  /** The rows of every table (in the fixture's order) and the files zip's entries, as the dump holds them. */
  data: FixtureData;
  /** The mysqldump-style dump (plain) and its gzip. */
  dump: Buffer;
  dumpGz: Buffer;
  expected: SlimsFixtureExpected;
  /** The SLiMS folder's files (the fixture's files zip, and the member photos), SLiMS-relative paths. */
  files: { rel: string; data: Buffer }[];
  photos: SlimsPhotoCase[];
  /** The cells changed to what a MySQL server stores (see the top of this file): `<kind> <table>.<column>`. */
  adjustments: string[];
}

/** A JPEG as the migration recognises one (SOI, an APP0 marker, EOI), `size` bytes of filler. */
function jpeg(fill: number, size: number): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, fill), Buffer.from([0xff, 0xd9])]);
}

/** The PNG signature and some filler: an image, but not a JPEG. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);

/** The member photo upload limit of the migration (500 KB), and a file just past it. */
const PHOTO_TOO_LARGE = 500 * 1024 + 1;

/** The photo cases, given the first five members that have a type (in the fixture's order). */
function photoCases(memberIds: readonly string[]): SlimsPhotoCase[] {
  const [a, b, c, d, e] = memberIds;
  if (e === undefined) throw new Error(`the fixture has ${memberIds.length} typed members, the photo cases need 5`);
  return [
    { memberId: a!, image: `${a!.toLowerCase()}.jpg`, bytes: jpeg(0x11, 300), outcome: 'stored' },
    { memberId: b!, image: `kelas-7/${b!.toLowerCase()}.jpg`, bytes: jpeg(0x22, 900), outcome: 'stored' },
    { memberId: c!, image: `${c!.toLowerCase()}.jpg`, bytes: PNG, outcome: 'not_jpeg' },
    { memberId: d!, image: `${d!.toLowerCase()}.jpg`, bytes: null, outcome: 'missing' },
    { memberId: e, image: `${e.toLowerCase()}-besar.jpg`, bytes: jpeg(0x33, PHOTO_TOO_LARGE), outcome: 'too_large' },
  ];
}

/** Every cell of `data` a MySQL server would store differently, made what it would store; each change listed. */
function asMysqlStores(data: FixtureData, adjustments: string[]): FixtureData {
  const rows = new Map<string, FixtureRow[]>();
  for (const [table, list] of data.rows) rows.set(table, list);
  for (const table of FIXTURE_TABLES) {
    const list = rows.get(table.name);
    if (list === undefined) continue;
    const limits = table.columns.flatMap(([name, type]) => {
      const m = /^(var)?char\((\d+)\)/i.exec(type);
      return m === null ? [] : [{ name, max: Number(m[2]), fixed: m[1] === undefined }];
    });
    if (limits.length === 0) continue;
    rows.set(
      table.name,
      list.map((row) => {
        let out = row;
        for (const { name, max, fixed } of limits) {
          const v = out[name];
          if (typeof v !== 'string') continue;
          let next = v;
          if ([...next].length > max) {
            next = [...next].slice(0, max).join('');
            adjustments.push(`cut ${table.name}.${name}`);
          }
          if (fixed && / +$/.test(next)) {
            next = next.replace(/ +$/, '');
            adjustments.push(`trailing_spaces ${table.name}.${name}`);
          }
          if (next !== v) out = { ...out, [name]: next };
        }
        return out;
      }),
    );
  }
  return { ...data, rows };
}

/** The fixture of the test (see the top of this file), for `seed`. */
export function mysqlSlimsFixture(seed: number): MysqlSlimsFixture {
  const adjustments: string[] = [];
  let photos: SlimsPhotoCase[] = [];
  let zip: RawEntry[] = [];
  const held: { data: FixtureData | null } = { data: null };
  const { dump, expected } = generateSlimsFixture(seed, {
    transform(data) {
      // The usage rows, appended per table (as slimsFixtureBytes's `usage` option does).
      const usage = generateUsage(data, {});
      const merged = new Map(data.rows);
      for (const [table, added] of Object.entries(usage.rows)) merged.set(table, [...(merged.get(table) ?? []), ...added]);
      const members = merged.get('member') ?? [];
      photos = photoCases(members.filter((r) => r['member_type_id'] !== null && r['member_type_id'] !== undefined).map((r) => String(r['member_id'])).slice(0, 5));
      const images = new Map(photos.map((p) => [p.memberId, p.image]));
      merged.set(
        'member',
        members.map((r) => (images.has(String(r['member_id'])) ? { ...r, member_image: images.get(String(r['member_id']))! } : r)),
      );
      zip = data.zip;
      held.data = asMysqlStores({ ...data, rows: merged }, adjustments);
      return held.data;
    },
  });
  const final = held.data;
  if (final === null) throw new Error('the fixture transform did not run');
  const files = zip
    .filter((e) => typeof e.name === 'string' && !e.name.endsWith('/'))
    .map((e) => ({ rel: e.name as string, data: e.data ?? Buffer.alloc(0) }));
  for (const p of photos) if (p.bytes !== null) files.push({ rel: `images/persons/${p.image}`, data: p.bytes });
  return { data: final, dump, dumpGz: gzipSync(dump), expected, files, photos, adjustments: [...new Set(adjustments)].sort() };
}

/** A key cell as text: a number as its digits, a text as itself (raw bytes as Latin-1). */
function keyText(v: FixtureCell | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  return Buffer.from(v instanceof Uint8Array ? v : v.raw).toString('latin1');
}

/** A row's primary key as one text (the cells' texts joined by U+0000), to match a key read back from the server. */
export function fixtureRowKey(row: FixtureRow, primaryKey: readonly string[]): string {
  return primaryKey.map((c) => keyText(row[c])).join('\u0000');
}

/**
 * The dump of `data` with the rows of each table in `order` listed in that order (`order`: table → the keys of
 * fixtureRowKey, every row's exactly once); the other tables keep the fixture's order. Also the tables whose order
 * changed.
 *
 * @throws Error when a listed order does not hold every row of its table exactly once
 */
export function renderDumpInOrder(data: FixtureData, order: ReadonlyMap<string, readonly string[]>): { dump: Buffer; reordered: string[] } {
  const rows = new Map(data.rows);
  const reordered: string[] = [];
  for (const [table, keys] of order) {
    const pk = FIXTURE_TABLES.find((t) => t.name === table)?.primaryKey ?? [];
    const list = data.rows.get(table) ?? [];
    if (pk.length === 0) throw new Error(`${table} has no primary key to order by`);
    const byKey = new Map(list.map((r) => [fixtureRowKey(r, pk), r]));
    if (byKey.size !== list.length || keys.length !== list.length || new Set(keys).size !== keys.length) {
      throw new Error(`${table}: ${keys.length} keys listed for ${list.length} rows (${byKey.size} distinct)`);
    }
    const next = keys.map((k) => {
      const r = byKey.get(k);
      if (r === undefined) throw new Error(`${table}: the key ${JSON.stringify(k)} is not a row of the fixture`);
      return r;
    });
    if (next.some((r, i) => r !== list[i])) reordered.push(table);
    rows.set(table, next);
  }
  return { dump: renderDump({ ...data, rows }), reordered: reordered.sort() };
}

// ---- the dump as statements ------------------------------------------------------------------------------------------

export interface MysqlDumpStatement {
  sql: string;
  /** The table an INSERT writes, else null. */
  insertInto: string | null;
}

export interface MysqlDumpSplit {
  statements: MysqlDumpStatement[];
  /** What was not sent: the statements of a DELIMITER block (their first characters). */
  skipped: string[];
  /** The `SET NAMES` the splitter took in place of the server, in order. */
  names: string[];
  /** The CREATE TABLE statements whose AUTO_INCREMENT was dropped (their table). */
  autoIncrementDropped: string[];
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const LATIN1 = new TextDecoder('windows-1252');

/** The index just past the quoted text that starts at `at` (`'`, `"` or a backtick; a backslash escapes in the first two). */
function pastQuote(dump: Buffer, at: number): number {
  const q = dump[at]!;
  for (let j = at + 1; j < dump.length; j += 1) {
    const b = dump[j]!;
    if (b === 0x5c && q !== 0x60) j += 1;
    else if (b === q) return j + 1;
  }
  throw new Error(`the dump has an unterminated quote at byte ${at}`);
}

/** The statements of the mysqldump `dump` (see the top of this file). */
export function mysqlDumpStatements(dump: Buffer): MysqlDumpSplit {
  const out: MysqlDumpSplit = { statements: [], skipped: [], names: [], autoIncrementDropped: [] };
  let charset = 'utf8mb4';
  let delimiter = ';';
  let pieces: Buffer[] = [];
  let from = 0;
  const keep = (to: number): void => {
    if (to > from) pieces.push(dump.subarray(from, to));
  };
  const blank = (to: number): boolean => pieces.every((p) => p.toString('latin1').trim() === '') && dump.subarray(from, to).toString('latin1').trim() === '';
  const emit = (): void => {
    const bytes = Buffer.concat(pieces);
    pieces = [];
    const text = (charset === 'latin1' ? LATIN1 : UTF8).decode(bytes).trim();
    if (text === '') return;
    if (delimiter !== ';') {
      out.skipped.push(text.slice(0, 120));
      return;
    }
    const names = /^\/\*!\d+\s+SET\s+NAMES\s+(\w+)\s*\*\/$/i.exec(text);
    if (names !== null) {
      charset = names[1]!.toLowerCase();
      out.names.push(charset);
      return;
    }
    let sql = text;
    const create = /^CREATE TABLE `([^`]+)`/i.exec(text);
    if (create !== null && !/PRIMARY KEY/i.test(text) && / AUTO_INCREMENT(?![=\w])/.test(text)) {
      sql = text.replace(/ AUTO_INCREMENT(?![=\w])/g, '');
      out.autoIncrementDropped.push(create[1]!);
    }
    out.statements.push({ sql, insertInto: /^INSERT INTO `([^`]+)`/i.exec(text)?.[1] ?? null });
  };
  let i = 0;
  while (i < dump.length) {
    const b = dump[i]!;
    if (b === 0x27 || b === 0x22 || b === 0x60) {
      i = pastQuote(dump, i);
    } else if (b === 0x2d && dump[i + 1] === 0x2d && (i + 2 >= dump.length || dump[i + 2] === 0x20 || dump[i + 2] === 0x0a || dump[i + 2] === 0x09)) {
      // A `--` comment, to the end of its line.
      keep(i);
      const eol = dump.indexOf(0x0a, i);
      i = eol === -1 ? dump.length : eol;
      from = i;
    } else if (b === 0x2f && dump[i + 1] === 0x2a) {
      // A `/* */` comment stays in the statement (the server runs a `/*!...*/` one).
      const end = dump.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`the dump has an unterminated comment at byte ${i}`);
      i = end + 2;
    } else if ((b === 0x44 || b === 0x64) && (i === 0 || dump[i - 1] === 0x0a) && dump.subarray(i, i + 10).toString('latin1').toUpperCase() === 'DELIMITER ' && blank(i)) {
      pieces = [];
      const eol = dump.indexOf(0x0a, i);
      const end = eol === -1 ? dump.length : eol;
      delimiter = dump.subarray(i + 10, end).toString('latin1').trim();
      if (delimiter === '') throw new Error(`the dump has an empty DELIMITER at byte ${i}`);
      i = end;
      from = i;
    } else if (b === delimiter.charCodeAt(0) && dump.subarray(i, i + delimiter.length).toString('latin1') === delimiter) {
      keep(i);
      emit();
      i += delimiter.length;
      from = i;
    } else {
      i += 1;
    }
  }
  keep(dump.length);
  emit();
  return out;
}

/** A cell of a statement's answer as text (the foreign client hands text over as bytes). */
const cellText = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

/**
 * Runs the statements of `dump` (mysqlDumpStatements) one by one on `db` (a session on the empty database to fill),
 * and after each INSERT reads its warnings: a server in the dump's non-strict mode turns a value it cannot store into
 * a warning, not an error, and the test must know the data arrived as the fixture holds it.
 */
export async function loadMysqlDump(db: ForeignMysql, dump: Buffer): Promise<MysqlDumpSplit & { warnings: string[] }> {
  const split = mysqlDumpStatements(dump);
  const warnings: string[] = [];
  for (const [n, s] of split.statements.entries()) {
    try {
      await db.query(s.sql, []);
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code) : '';
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`dump statement ${n + 1} (${s.sql.slice(0, 80)}...) failed: ${code} ${message}`, { cause: error });
    }
    if (s.insertInto === null) continue;
    for (const w of await db.query('SHOW WARNINGS', [])) {
      warnings.push(`${s.insertInto}: ${cellText(w['Level'])} ${cellText(w['Code'])} ${cellText(w['Message'])}`);
    }
  }
  return { ...split, warnings };
}
