import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { runWorkDir, runWorkPath, type DataPath } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeStagedRow, encodeStagedRow, openStagedDumpSource } from '../../src/migration/slims/source/dump-source.js';
import { splitDump } from '../../src/migration/slims/source/dump-split.js';
import type { SlimsRow, SlimsSource, SlimsTableInfo, SplitCheckpoint } from '../../src/migration/slims/source/types.js';
import { SLIMS_USAGE_COLUMNS, memberHash, openStagedUsageSource, openUsageDbSource, splitUsageDump, type SlimsUsageTable } from '../../src/migration/slims/source/usage.js';
import { fakeForeignMysql, fixtureMysqlTables } from '../fixtures/slims-fake.js';
import { buildData, generateSlimsFixture, type FixtureData } from '../support/slims-fixture/generate.js';
import { generateUsage, keptCheckins, type UsageExpectation } from '../support/slims-fixture/generate-usage.js';
import { SLIMS_FIXTURE_SEED, slimsFixtureBytes } from '../support/slims-fixture/index.js';

// The read-only SLiMS usage import's readers (spec §11.2): the dump splitter and the direct connection read only the
// columns the counts need, and replace every member id by its keyed hash as the row is read or split, so no name,
// address, institution or raw member id ever reaches a staging file, a checkpoint or a returned row. The synthetic
// fixture with its usage rows carries the personal values the scans look for.

const KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256);
const USAGE_TABLES = Object.keys(SLIMS_USAGE_COLUMNS) as SlimsUsageTable[];
const CFG = { host: 'slims.example', port: 3306, user: 'baca', password: 'x', database: 'slims', tls: false };

let tmp: string;
let dataDir: string;
let data: FixtureData;
let expected: UsageExpectation;
let dump: Buffer;

beforeAll(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-slims-usage-')));
  dataDir = path.join(tmp, 'data');
  await fsp.mkdir(dataDir);
  // The fixture's data as its usage hook builds it (the rows appended per table), kept for the fake server.
  const hooked: { data?: FixtureData; expected?: UsageExpectation } = {};
  const out = generateSlimsFixture(SLIMS_FIXTURE_SEED, {
    transform: (plain) => {
      const usage = generateUsage(plain, {});
      const rows = new Map(plain.rows);
      for (const [table, added] of Object.entries(usage.rows)) rows.set(table, [...(rows.get(table) ?? []), ...added]);
      hooked.data = { ...plain, rows };
      hooked.expected = usage.expected;
      return hooked.data;
    },
  });
  dump = out.dump;
  data = hooked.data!;
  expected = hooked.expected!;
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const noHeadroom = async (): Promise<void> => {};

/** A clock that moves 1 ms each time it is read: a slice's budget of n ms ends at its n-th statement end. */
function ticking(): () => number {
  let t = 0;
  return () => (t += 1);
}

/** The dump in its own run folder, and an empty staging folder of another run. */
async function placeDump(bytes: Buffer): Promise<{ dumpPath: DataPath; stagingDir: DataPath }> {
  const dumpRun = newId();
  const dumpPath = runWorkPath(dataDir, dumpRun, 'dump.bin');
  await fsp.mkdir(path.dirname(dumpPath), { recursive: true });
  await fsp.writeFile(dumpPath, bytes);
  const stagingDir = runWorkDir(dataDir, newId());
  await fsp.mkdir(stagingDir, { recursive: true });
  return { dumpPath, stagingDir };
}

/** Every file of a folder, name → bytes. */
async function filesOf(dir: string): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  for (const name of (await fsp.readdir(dir)).sort()) out[name] = await fsp.readFile(path.join(dir, name));
  return out;
}

/** Every file of a folder, name → SHA-256 (cheaper to compare than the bytes). */
async function digestsOf(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(await filesOf(dir))) out[name] = createHash('sha256').update(bytes).digest('hex');
  return out;
}

/** The rows of a staging file. */
function stagedRows(bytes: Buffer): SlimsRow[] {
  return bytes
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map(decodeStagedRow);
}

/** Splits to the end in one slice. */
async function splitWhole(gz = false): Promise<{ stagingDir: DataPath; tables: SlimsTableInfo[]; checkpoint: SplitCheckpoint }> {
  const r = await placeDump(gz ? gzipSync(dump) : dump);
  const result = await splitUsageDump({ ...r, gz, checkpoint: null, budgetMs: 600_000, hashKey: KEY, ensureHeadroom: noHeadroom });
  expect(result.done).toBe(true);
  return { stagingDir: r.stagingDir, tables: result.tables, checkpoint: result.checkpoint };
}

/** Every row of a source's table, page after page. */
async function readAll(source: SlimsSource, table: string, limit = 500): Promise<{ rows: SlimsRow[]; cursors: string[] }> {
  const rows: SlimsRow[] = [];
  const cursors: string[] = [];
  let after: string | null = null;
  for (let i = 0; i < 10_000; i += 1) {
    const page = await source.rows(table, after, limit);
    rows.push(...page.rows);
    if (page.next === null) return { rows, cursors };
    cursors.push(page.next);
    after = page.next;
  }
  throw new Error('readAll: no end');
}

/** Rows in a stable order, as comparable text. */
const sortedText = (rows: SlimsRow[]): string[] => rows.map(encodeStagedRow).sort();

/** The personal values found in `bytes`. */
function leaks(bytes: Buffer): string[] {
  return expected.personalValues.filter((v) => bytes.includes(Buffer.from(v, 'utf8')));
}

describe('the usage fixture', () => {
  it('is the dump the fixture hook writes, with the rows the usage import reads', () => {
    const hooked = slimsFixtureBytes(SLIMS_FIXTURE_SEED, { usage: {} });
    expect(hooked.dump.equals(dump)).toBe(true);
    expect(hooked.hooks.usage?.months).toEqual(expected.months);
    const members = data.rows.get('member')!.filter((m) => typeof m['member_type_id'] === 'number');
    expect(members.length).toBeGreaterThanOrEqual(300);
    for (const column of ['member_id', 'member_name', 'member_address']) expect(new Set(members.map((m) => m[column])).size, column).toBe(members.length);
    expect(data.rows.get('mst_member_type')!.map((t) => t['member_type_name'])).toEqual(['Siswa', 'Guru', 'Staf TU', 'Umum']);
    const loanIds = new Set([...data.rows.get('loan')!, ...data.rows.get('loan_history')!].map((l) => l['loan_id']));
    expect(loanIds.size).toBe(3000 + 4); // the plain fixture's four loans included
    expect(data.rows.get('visitor_count')!.length).toBe(5000);
    expect(expected.traps.historyOnly).toBe(600);
    expect(expected.traps.renewals.length).toBeGreaterThan(100);
    expect(expected.traps.guests.empty).toBeGreaterThan(0);
    expect(expected.traps.guests.null).toBeGreaterThan(0);
    expect(expected.rows).toMatchObject({ visitor_count: 5000, member: 323, mst_member_type: 4 });
  });

  it('expects every counted row once: invalid dates and repeated history rows are dropped, guests are never deduplicated', () => {
    const sum = (metric: string, key: string): number => expected.months.reduce((n, m) => n + expected.cell(m, metric, key), 0);
    expect(expected.dropped.dateInvalid).toEqual({ loan: 3, loan_history: 2, visitor_count: 5, read_counter: 2 });
    expect(sum('loans', '')).toBe(3000 + 4 - 5);
    expect(sum('visits', '')).toBe(5000 - 5);
    expect(sum('in_library_uses', '')).toBe(302 - 2);
    expect(sum('visits_deduped', 'guest')).toBe(sum('visits', 'guest'));
    expect(sum('visits_deduped', '')).toBeLessThan(sum('visits', ''));
    expect(sum('loans', 'member_unknown')).toBe(expected.memberUnknown.loans);
    expect(expected.memberUnknown.visits).toBeGreaterThan(200);
    for (const m of expected.months) {
      const groups = Object.entries(expected.monthly[m]?.['loans'] ?? {});
      const byGroup = groups.filter(([k]) => k !== '' && !k.startsWith('ddc:')).reduce((n, [, v]) => n + v, 0);
      const byClass = groups.filter(([k]) => k.startsWith('ddc:')).reduce((n, [, v]) => n + v, 0);
      expect(byGroup, m).toBe(expected.cell(m, 'loans', ''));
      expect(byClass, m).toBe(expected.cell(m, 'loans', ''));
    }
    const classes = new Set(expected.months.flatMap((m) => Object.keys(expected.monthly[m]?.['loans'] ?? {}).filter((k) => k.startsWith('ddc:'))));
    for (const key of ['ddc:2X', 'ddc:NON', 'ddc:8', 'ddc:2']) expect(classes, key).toContain(key);
    expect(expected.spanCell(2, 'members_active', '')).toBeGreaterThan(0);
    expect(expected.spanCell(2, 'distinct_borrowers', '')).toBeGreaterThan(0);
    expect(expected.spanCell(0, 'titles_used', '')).toBeGreaterThan(0);
  });

  it('places the repeat-visit traps, and its repeat rule keeps what the traps describe', () => {
    const t = expected.traps;
    const visitsOf = (id: string): string[] =>
      data.rows
        .get('visitor_count')!
        .filter((v) => typeof v['member_id'] === 'string' && v['member_id'].trim() === id)
        .map((v) => v['checkin_date'] as string)
        .sort();
    expect(visitsOf(t.chain.memberId)).toEqual([...t.chain.checkins]);
    expect(keptCheckins(t.chain.checkins, 60)).toEqual([true, false, false]);
    expect(visitsOf(t.monthBoundary.memberId)).toEqual([...t.monthBoundary.checkins]);
    expect(t.monthBoundary.checkins[0].slice(0, 7)).not.toBe(t.monthBoundary.checkins[1].slice(0, 7));
    expect(keptCheckins(t.monthBoundary.checkins, 60)).toEqual([true, false]);
    expect(keptCheckins(t.exactWindow.checkins, 60)).toEqual([true, true]);
    expect(visitsOf(t.identical.memberId)).toEqual([t.identical.checkin, t.identical.checkin]);
    expect(keptCheckins([t.identical.checkin, t.identical.checkin], 60)).toEqual([true, false]);
    expect(visitsOf(t.padded.memberId)).toEqual([...t.padded.checkins]);
    expect(keptCheckins(t.padded.checkins, 60)).toEqual([true, false]);
    for (const list of [t.chain.checkins, t.monthBoundary.checkins, [t.identical.checkin, t.identical.checkin]]) expect(keptCheckins(list, 0).every(Boolean)).toBe(true);
  });

  it('a 0-minute window keeps every check-in; the cut-over drops the rows on and after its day', () => {
    const plain = buildData(SLIMS_FIXTURE_SEED);
    const off = generateUsage(plain, { dedupeMinutes: 0 }).expected;
    for (const m of off.months) expect(off.cell(m, 'visits_deduped', ''), m).toBe(off.cell(m, 'visits', ''));
    expect(off.cell(expected.months[10]!, 'visits', '')).toBe(expected.cell(expected.months[10]!, 'visits', ''));
    const cut = generateUsage(buildData(SLIMS_FIXTURE_SEED), { cutoverOn: '2026-01-15' }).expected;
    expect(cut.months[cut.months.length - 1]).toBe('2026-01');
    expect(cut.dropped.afterCutover.visitor_count).toBeGreaterThan(0);
    expect(cut.cell('2025-12', 'loans', '')).toBe(expected.cell('2025-12', 'loans', ''));
    expect(cut.cell('2026-01', 'visits', '')).toBeLessThan(expected.cell('2026-01', 'visits', ''));
  });
});

describe('splitUsageDump', () => {
  it('stages only the usage tables, each row holding exactly the projected columns', async () => {
    const { stagingDir, tables } = await splitWhole();
    const files = await filesOf(stagingDir);
    expect(Object.keys(files)).toEqual([...USAGE_TABLES.map((t) => `${t}.ndjson`), 'split_tables.ndjson'].sort());
    for (const table of USAGE_TABLES) {
      const rows = stagedRows(files[`${table}.ndjson`]!);
      expect(rows.length, table).toBe(expected.rows[table]);
      for (const row of rows) expect(Object.keys(row), table).toEqual([...SLIMS_USAGE_COLUMNS[table]]);
    }
    expect(tables.map((t) => t.name)).toEqual([...USAGE_TABLES].sort());
    for (const t of tables) {
      expect(t.columns, t.name).toEqual([...SLIMS_USAGE_COLUMNS[t.name as SlimsUsageTable]]);
      expect(t.rows, t.name).toBe(expected.rows[t.name as SlimsUsageTable]);
    }
  });

  it('writes no personal value: a byte scan of every staged file, the checkpoint and the table list finds none', async () => {
    const { stagingDir, tables, checkpoint } = await splitWhole();
    expect(expected.personalValues.length).toBeGreaterThan(900);
    for (const v of expected.personalValues) expect(v, v).toMatch(/[ @-]/);
    // The fixture holds the values the scan looks for.
    expect(leaks(dump).length).toBe(expected.personalValues.length);
    for (const [name, bytes] of Object.entries(await filesOf(stagingDir))) expect(leaks(bytes), name).toEqual([]);
    expect(leaks(Buffer.from(JSON.stringify(checkpoint)))).toEqual([]);
    expect(leaks(Buffer.from(JSON.stringify(tables)))).toEqual([]);
  });

  it('replaces every member id by memberHash(key, id): members, loans, history and visits; guests stay empty or NULL', async () => {
    const { stagingDir } = await splitWhole();
    const files = await filesOf(stagingDir);
    const members = stagedRows(files['member.ndjson']!);
    expect(members).toEqual(
      data.rows.get('member')!.map((m) => ({ member_id: memberHash(KEY, m['member_id'] as string), member_type_id: m['member_type_id'] ?? null, expire_date: m['expire_date'] ?? null })),
    );
    const visits = stagedRows(files['visitor_count.ndjson']!);
    expect(visits.filter((v) => v['member_id'] === '').length).toBe(expected.traps.guests.empty);
    expect(visits.filter((v) => v['member_id'] === null).length).toBe(expected.traps.guests.null);
    const padded = visits.filter((v) => v['member_id'] === memberHash(KEY, expected.traps.padded.memberId)).map((v) => v['checkin_date']);
    expect(padded).toEqual([...expected.traps.padded.checkins]);
    for (const table of ['loan', 'loan_history', 'visitor_count'] as const) {
      for (const row of stagedRows(files[`${table}.ndjson`]!)) {
        const id = row['member_id'];
        if (id !== null && id !== '') expect(id, table).toMatch(/^[0-9a-f]{32}$/);
      }
    }
    const graduate = memberHash(KEY, expected.traps.graduates[0]!);
    expect(stagedRows(files['loan.ndjson']!).some((l) => l['member_id'] === graduate) || stagedRows(files['loan_history.ndjson']!).some((l) => l['member_id'] === graduate)).toBe(true);
  });

  it('resumed from mid-dump checkpoints (a gzipped dump, a slice run twice after a crash) gives the same staged files', async () => {
    const reference = await digestsOf((await splitWhole()).stagingDir);
    for (const gz of [false, true]) {
      const r = await placeDump(gz ? gzipSync(dump) : dump);
      const now = ticking();
      let checkpoint: SplitCheckpoint | null = null;
      let slices = 0;
      let replayed = false;
      for (;;) {
        slices += 1;
        const result = await splitUsageDump({ ...r, gz, checkpoint, budgetMs: 40, hashKey: KEY, ensureHeadroom: noHeadroom, now });
        // A job payload carries the checkpoint as JSON; it names files and counts only.
        expect(leaks(Buffer.from(JSON.stringify(result.checkpoint)))).toEqual([]);
        if (slices === 3 && !replayed) {
          // Killed after this slice wrote but before its checkpoint was saved: the next attempt starts from the last one.
          replayed = true;
          continue;
        }
        checkpoint = JSON.parse(JSON.stringify(result.checkpoint)) as SplitCheckpoint;
        if (result.done) break;
      }
      expect(slices, `gz ${gz}`).toBeGreaterThan(5);
      expect(await digestsOf(r.stagingDir), `gz ${gz}`).toEqual(reference);
    }
  });

  it('reads the staged rows back through openStagedUsageSource, which serves only the usage tables and columns', async () => {
    const { stagingDir, tables } = await splitWhole();
    const files = await filesOf(stagingDir);
    const source = openStagedUsageSource(stagingDir, tables);
    expect((await source.tables()).map((t) => t.name)).toEqual([...USAGE_TABLES].sort());
    for (const table of USAGE_TABLES) {
      const { rows } = await readAll(source, table, 300);
      expect(rows, table).toEqual(stagedRows(files[`${table}.ndjson`]!));
    }
    expect((await source.rows('mst_author', null, 10)).rows).toEqual([]);
    // A staged file carrying more than the projection (not one this split writes) is read back projected.
    const other = runWorkDir(dataDir, newId());
    await fsp.mkdir(other, { recursive: true });
    await fsp.writeFile(path.join(other, 'member.ndjson'), `${JSON.stringify({ member_id: 'a'.repeat(32), member_name: 'Nama Lengkap', member_type_id: 1, expire_date: null })}\n`);
    await fsp.writeFile(path.join(other, 'biblio.ndjson'), `${JSON.stringify({ biblio_id: 1, title: 'Judul', classification: '301' })}\n`);
    const extra = openStagedUsageSource(other, [
      { name: 'member', columns: ['member_id', 'member_name', 'member_type_id', 'expire_date'], primaryKey: ['member_id'], rows: 1 },
      { name: 'biblio', columns: ['biblio_id', 'title', 'classification'], primaryKey: ['biblio_id'], rows: 1 },
      { name: 'mst_author', columns: ['author_id'], primaryKey: ['author_id'], rows: 1 },
    ]);
    expect(await extra.tables()).toEqual([
      { name: 'member', columns: ['member_id', 'member_type_id', 'expire_date'], primaryKey: ['member_id'], rows: 1 },
      { name: 'biblio', columns: ['biblio_id', 'classification'], primaryKey: ['biblio_id'], rows: 1 },
    ]);
    expect((await extra.rows('member', null, 10)).rows).toEqual([{ member_id: 'a'.repeat(32), member_type_id: 1, expire_date: null }]);
    expect((await extra.rows('biblio', null, 10)).rows).toEqual([{ biblio_id: 1, classification: '301' }]);
  });

  it('leaves the catalogue split as it was: without the options no usage-only table is staged and read tables stay whole', async () => {
    const r = await placeDump(dump);
    const result = await splitDump({ ...r, gz: false, checkpoint: null, budgetMs: 600_000, ensureHeadroom: noHeadroom });
    const files = await filesOf(r.stagingDir);
    for (const table of ['member', 'loan', 'loan_history', 'visitor_count', 'mst_member_type', 'read_counter']) expect(Object.hasOwn(files, `${table}.ndjson`), table).toBe(false);
    expect(Object.keys(stagedRows(files['item.ndjson']!)[0]!)).toEqual(expect.arrayContaining(['item_id', 'item_code', 'price', 'received_date', 'input_date']));
    expect(Object.keys(stagedRows(files['item.ndjson']!)[0]!).length).toBeGreaterThan(SLIMS_USAGE_COLUMNS.item.length);
    expect(result.tables.find((t) => t.name === 'member')?.columns).toContain('member_name');
    const source = openStagedDumpSource(r.stagingDir, result.tables);
    expect((await source.rows('member', null, 10)).rows).toEqual([]);
    expect((await source.rows('biblio', null, 1)).rows[0]).toHaveProperty('title');
  });
});

describe('openUsageDbSource', () => {
  it('lists only the usage tables, with the projected columns and exact row counts', async () => {
    const server = fakeForeignMysql(fixtureMysqlTables(data));
    const source = await openUsageDbSource(CFG, { hashKey: KEY, connect: server.connect });
    expect(server.opened).toEqual([{ cfg: CFG, connectTimeoutMs: 10_000 }]);
    const tables = await source.tables();
    expect(tables.map((t) => t.name)).toEqual([...USAGE_TABLES].sort());
    for (const t of tables) {
      expect(t.columns, t.name).toEqual([...SLIMS_USAGE_COLUMNS[t.name as SlimsUsageTable]]);
      expect(t.rows, t.name).toBe(expected.rows[t.name as SlimsUsageTable]);
    }
    expect((await source.rows('mst_author', null, 10)).rows).toEqual([]);
    const counted = server.log.filter((s) => s.sql.startsWith('SELECT COUNT(*)')).map((s) => s.params[0]);
    expect([...counted].sort()).toEqual([...USAGE_TABLES].sort());
    await source.close();
    expect(server.closed).toBe(1);
  });

  it('names only the projected columns in every SELECT, and returns the rows the dump split stages', async () => {
    const server = fakeForeignMysql(fixtureMysqlTables(data));
    const source = await openUsageDbSource(CFG, { hashKey: KEY, connect: server.connect });
    const staged = await filesOf((await splitWhole()).stagingDir);
    for (const table of USAGE_TABLES) {
      const { rows } = await readAll(source, table);
      expect(sortedText(rows), table).toEqual(sortedText(stagedRows(staged[`${table}.ndjson`]!)));
      for (const row of rows) expect(Object.keys(row), table).toEqual([...SLIMS_USAGE_COLUMNS[table]]);
    }
    const selects = server.log.filter((s) => /^SELECT \?\?/.test(s.sql));
    expect(selects.length).toBeGreaterThan(USAGE_TABLES.length);
    for (const { sql, params } of selects) {
      const n = /^SELECT ((?:\?\?, )*\?\?) FROM/.exec(sql)![1]!.split(', ').length;
      const table = params[n] as SlimsUsageTable;
      expect(params.slice(0, n), sql).toEqual([...SLIMS_USAGE_COLUMNS[table]]);
    }
    for (const { sql, params } of server.log) expect(leaks(Buffer.from(JSON.stringify([sql, params]))), sql).toEqual([]);
  });

  it('hashes every row under the key it was opened with, though the caller wipes its key as soon as the source is open', async () => {
    const server = fakeForeignMysql(fixtureMysqlTables(data));
    const key = Uint8Array.from(KEY);
    const source = await openUsageDbSource(CFG, { hashKey: key, connect: server.connect });
    key.fill(0);
    const { rows } = await readAll(source, 'member');
    await source.close();
    const ids = (data.rows.get('member') ?? []).map((r) => String(r['member_id'] as string | number).trim()).filter((id) => id !== '');
    expect(rows.length).toBe(ids.length);
    expect(new Set(rows.map((r) => r['member_id']))).toEqual(new Set(ids.map((id) => memberHash(KEY, id))));
    const underWipedKey = new Set(ids.map((id) => memberHash(new Uint8Array(32), id)));
    expect(rows.filter((r) => underWipedKey.has(r['member_id'] as string))).toEqual([]);
  });

  it('pages member by its position, never by its id: the cursor is a number and holds no member id', async () => {
    const server = fakeForeignMysql(fixtureMysqlTables(data));
    const source = await openUsageDbSource(CFG, { hashKey: KEY, connect: server.connect });
    const { rows, cursors } = await readAll(source, 'member', 100);
    expect(rows.length).toBe(expected.rows.member);
    expect(cursors).toEqual(['o:100', 'o:200', 'o:300']);
    const statements = server.log.filter((s) => /^SELECT \?\?/.test(s.sql) && s.params[3] === 'member');
    for (const s of statements) {
      expect(s.sql).toBe('SELECT ??, ??, ?? FROM ?? ORDER BY ?? LIMIT ? OFFSET ?');
      expect(s.params.slice(4)).toEqual(['member_id', 100, expect.any(Number)]);
    }
    expect(new Set(rows.map((r) => r['member_id'])).size).toBe(rows.length);
    for (const row of rows) expect(row['member_id']).toMatch(/^[0-9a-f]{32}$/);
    // A table keyed by a projected, unhashed number pages by its key; `item`, whose key is not read, by position.
    const loans = await readAll(source, 'loan', 1000);
    expect(loans.cursors[0]).toMatch(/^k:\[\d+\]$/);
    const items = await readAll(source, 'item', 250);
    expect(items.cursors[0]).toBe('o:250');
    expect(items.rows.length).toBe(expected.rows.item);
  });

  it('leaves out a read counter table the database does not have', async () => {
    const tables = fixtureMysqlTables(data);
    tables.delete('read_counter');
    const server = fakeForeignMysql(tables);
    const source = await openUsageDbSource(CFG, { hashKey: KEY, connect: server.connect });
    expect((await source.tables()).map((t) => t.name)).not.toContain('read_counter');
    expect(await source.rows('read_counter', null, 10)).toEqual({ rows: [], next: null });
  });

  it('refuses a short key before it connects', async () => {
    let connected = 0;
    const server = fakeForeignMysql(fixtureMysqlTables(data, ['member']));
    const connect: typeof server.connect = async (cfg, o) => {
      connected += 1;
      return server.connect(cfg, o);
    };
    await expect(openUsageDbSource(CFG, { hashKey: new Uint8Array(8), connect })).rejects.toThrow(TypeError);
    await expect(splitUsageDump({ ...(await placeDump(dump)), gz: false, checkpoint: null, budgetMs: 1000, hashKey: new Uint8Array(4), ensureHeadroom: noHeadroom })).rejects.toThrow(TypeError);
    expect(connected).toBe(0);
  });
});
