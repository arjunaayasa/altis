import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { runWorkDir, runWorkPath, type DataPath } from '@altis/platform';
import { DomainError, isDomainError, newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectSlimsVersion, openStagedDumpSource, splitDump } from '../../src/migration/slims/source/index.js';
import type { SplitDumpReader } from '../../src/migration/slims/source/dump-split.js';
import { DumpParseError, createSqlDumpParser } from '../../src/migration/slims/source/sql-dump.js';
import type { SlimsRow, SlimsTableInfo, SplitCheckpoint } from '../../src/migration/slims/source/types.js';
import { slimsFixtureBytes } from '../support/slims-fixture/index.js';

// splitDump (spec §11.1, S10): a dump split into one NDJSON staging file per table the migration reads, sliced and
// resumable from its checkpoint; and the staged source that reads those files back in batches.

let tmp: string;
let dataDir: string;

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-slims-split-')));
  dataDir = path.join(tmp, 'data');
  await fsp.mkdir(dataDir);
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const noHeadroom = async (): Promise<void> => {};

/** A clock that moves 1 ms each time it is read: a slice's budget of n ms ends at its n-th statement end. */
function ticking(): () => number {
  let t = 0;
  return () => (t += 1);
}

/** A run whose `dump.bin` holds `bytes`. */
async function run(bytes: Buffer): Promise<{ dumpPath: DataPath; stagingDir: DataPath }> {
  const runId = newId();
  const dumpPath = runWorkPath(dataDir, runId, 'dump.bin');
  await fsp.mkdir(path.dirname(dumpPath), { recursive: true });
  await fsp.writeFile(dumpPath, bytes);
  return { dumpPath, stagingDir: runWorkDir(dataDir, runId) };
}

/** Every staging file of a run, name → bytes. */
async function staged(stagingDir: DataPath): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  for (const name of (await fsp.readdir(stagingDir)).sort()) {
    if (name.endsWith('.ndjson')) out[name] = await fsp.readFile(path.join(stagingDir, name));
  }
  return out;
}

/**
 * Splits the run's dump to its end, slice after slice. `budgets[n]` is the budget of slice n (60 s after the list):
 * each slice is answered from a fresh call with the checkpoint as a job payload carries it (JSON).
 */
async function splitAll(
  r: { dumpPath: DataPath; stagingDir: DataPath },
  o: {
    gz?: boolean;
    budgets?: number[];
    checkpoint?: SplitCheckpoint | null;
    keep?: { reader: SplitDumpReader | null };
    heartbeat?: () => Promise<void>;
    heartbeatStepBytes?: number;
    now?: () => number;
  } = {},
): Promise<{ slices: number; tables: SlimsTableInfo[]; checkpoints: SplitCheckpoint[] }> {
  let checkpoint: SplitCheckpoint | null = o.checkpoint ?? null;
  const checkpoints: SplitCheckpoint[] = [];
  for (let slices = 1; slices < 10_000; slices += 1) {
    const result = await splitDump({
      dumpPath: r.dumpPath,
      gz: o.gz ?? false,
      stagingDir: r.stagingDir,
      checkpoint,
      budgetMs: o.budgets?.[slices - 1] ?? 60_000,
      ensureHeadroom: noHeadroom,
      now: o.now ?? ticking(),
      ...(o.keep === undefined ? {} : { keep: o.keep }),
      ...(o.heartbeat === undefined ? {} : { heartbeat: o.heartbeat }),
      ...(o.heartbeatStepBytes === undefined ? {} : { heartbeatStepBytes: o.heartbeatStepBytes }),
    });
    checkpoint = JSON.parse(JSON.stringify(result.checkpoint)) as SplitCheckpoint; // as a job payload carries it
    checkpoints.push(checkpoint);
    if (result.done) return { slices, tables: result.tables, checkpoints };
  }
  throw new Error('splitDump never finished');
}

/** The rows of a whole dump, per table, as the parser reads them. */
function parsedRows(dump: Buffer): Map<string, SlimsRow[]> {
  const parser = createSqlDumpParser();
  const out = new Map<string, SlimsRow[]>();
  for (const e of [...parser.push(dump.toString('latin1')), ...parser.end()]) {
    if (e.type === 'insert') out.set(e.table, [...(out.get(e.table) ?? []), ...e.rows]);
  }
  return out;
}

describe('splitDump', () => {
  it('splits the fixture into one staging file per table the migration reads, and counts the others', async () => {
    const { dump, expected } = slimsFixtureBytes();
    const r = await run(dump);
    const { slices, tables, checkpoints } = await splitAll(r);
    expect(slices).toBe(1);
    expect(checkpoints[0]!.offset).toBe(dump.length);
    const files = await staged(r.stagingDir);
    expect(Object.keys(files)).toContain('biblio.ndjson');
    // The member and circulation tables are staged for the people stages; a derived table and the system log are not.
    for (const table of ['search_biblio', 'system_log']) expect(Object.keys(files)).not.toContain(`${table}.ndjson`);
    for (const table of ['member', 'loan', 'loan_history', 'read_counter']) expect(Object.keys(files)).toContain(`${table}.ndjson`);
    for (const table of expected.roles.read) expect(Object.keys(files)).toContain(`${table}.ndjson`);
    const counts = Object.fromEntries(tables.map((t) => [t.name, t.rows]));
    expect(counts).toEqual(Object.fromEntries(Object.entries(expected.tables).map(([t, { source }]) => [t, source])));
    expect(tables.find((t) => t.name === 'biblio')!.columns.slice(0, 3)).toEqual(['biblio_id', 'gmd_id', 'title']);
    expect(tables.find((t) => t.name === 'content')!.primaryKey).toEqual(['content_id']);
    expect(tables.map((t) => t.name)).toEqual([...tables.map((t) => t.name)].sort());
  });

  it.each([false, true])('stopped by a 1 ms budget after its first slices, then resumed, gives the staging of a single pass (gz %s)', { timeout: 60_000 }, async (gz) => {
    const { dump } = slimsFixtureBytes();
    const bytes = gz ? gzipSync(dump) : dump;
    const single = await run(bytes);
    const whole = await splitAll(single, { gz });
    const sliced = await run(bytes);
    const parts = await splitAll(sliced, { gz, budgets: [1, 1, 1, 1] });
    expect(parts.slices).toBe(5);
    const offsets = parts.checkpoints.map((c) => c.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(offsets[0]).toBeGreaterThan(0);
    expect(offsets[3]).toBeLessThan(dump.length);
    expect(await staged(sliced.stagingDir)).toEqual(await staged(single.stagingDir));
    expect(parts.tables).toEqual(whole.tables);
    for (const cp of parts.checkpoints) expect(Buffer.byteLength(JSON.stringify(cp))).toBeLessThan(65_535);
  });

  it('stops at the first statement end after its budget, inside a table, and resumes there', { timeout: 60_000 }, async () => {
    const insert = (from: number): string =>
      `INSERT INTO \`item\` VALUES ${Array.from({ length: 50 }, (_, k) => `(${from + k},'B${from + k}','Rak ''A''')`).join(',')};\n`;
    const create = 'CREATE TABLE `item` (`item_id` int, `item_code` varchar(20), `site` varchar(50), PRIMARY KEY (`item_id`));\n';
    const dump = Buffer.from(create + Array.from({ length: 12 }, (_, i) => insert(i * 50 + 1)).join(''));
    const single = await run(dump);
    await splitAll(single);
    const r = await run(dump);
    const parts = await splitAll(r, { budgets: Array.from({ length: 30 }, () => 1) });
    expect(parts.slices).toBe(14); // one statement a slice (CREATE TABLE, then each INSERT), and the final line feed
    const middle = parts.checkpoints[5]!;
    expect(dump.toString('latin1', middle.offset - 1, middle.offset)).toBe(';');
    expect(middle.rows).toEqual({ item: 250 });
    const lines = (await fsp.readFile(path.join(single.stagingDir, 'item.ndjson'))).toString('utf8').split('\n');
    expect(middle.files['item.ndjson']).toBe(Buffer.byteLength(`${lines.slice(0, 250).join('\n')}\n`));
    expect(lines[0]).toBe(`{"item_id":1,"item_code":"B1","site":"Rak 'A'"}`);
    expect(await staged(r.stagingDir)).toEqual(await staged(single.stagingDir));
  });

  it('cuts back what a killed slice appended after its checkpoint, and removes files the checkpoint does not know', { timeout: 60_000 }, async () => {
    const { dump } = slimsFixtureBytes();
    const single = await run(dump);
    await splitAll(single);
    const r = await run(dump);
    let checkpoint: SplitCheckpoint | null = null;
    for (let i = 0; i < 3; i += 1) {
      checkpoint = (await splitDump({ dumpPath: r.dumpPath, gz: false, stagingDir: r.stagingDir, checkpoint, budgetMs: i === 0 ? 50 : 1, ensureHeadroom: noHeadroom, now: ticking() })).checkpoint;
    }
    const some = Object.keys(checkpoint!.files).find((f) => checkpoint!.files[f]! > 0)!;
    await fsp.appendFile(path.join(r.stagingDir, some), '{"half a row');
    await fsp.writeFile(path.join(r.stagingDir, 'zz_late.ndjson'), '{}\n');
    await splitAll(r, { checkpoint, budgets: [1] });
    expect(await staged(r.stagingDir)).toEqual(await staged(single.stagingDir));
  });

  it('starts over when a staging file is shorter than its checkpoint says', { timeout: 60_000 }, async () => {
    const { dump } = slimsFixtureBytes();
    const single = await run(dump);
    await splitAll(single);
    const r = await run(dump);
    const first = await splitDump({ dumpPath: r.dumpPath, gz: false, stagingDir: r.stagingDir, checkpoint: null, budgetMs: 300, ensureHeadroom: noHeadroom, now: ticking() });
    expect(first.done).toBe(false);
    const checkpoint = first.checkpoint;
    const some = Object.keys(checkpoint.files).find((f) => checkpoint.files[f]! > 10)!;
    await fsp.truncate(path.join(r.stagingDir, some), 5);
    const calls: number[] = [];
    const result = await splitDump({
      dumpPath: r.dumpPath,
      gz: false,
      stagingDir: r.stagingDir,
      checkpoint,
      budgetMs: 60_000,
      ensureHeadroom: async (_dir, bytes) => {
        calls.push(bytes);
      },
    });
    expect(result.done).toBe(true);
    expect(calls).toEqual([3 * dump.length]); // a split that starts over checks its headroom as a first slice does
    expect(await staged(r.stagingDir)).toEqual(await staged(single.stagingDir));
  });

  it('checks the headroom for 3 × the dump first, and stops with DISK_QUOTA when a later check fails (S10)', async () => {
    // A high-ratio .sql.gz: a few KiB that inflate to about 2 MiB of rows.
    const tuples = Array.from({ length: 400 }, (_, i) => `(${i + 1},'${'Judul berulang '.repeat(20)}')`).join(',');
    const sql = `CREATE TABLE \`biblio\` (\`biblio_id\` int, \`title\` text, PRIMARY KEY (\`biblio_id\`));\n${Array.from({ length: 20 }, () => `INSERT INTO \`biblio\` VALUES ${tuples};\n`).join('')}`;
    const gz = gzipSync(Buffer.from(sql));
    expect(sql.length / gz.length).toBeGreaterThan(50);
    const r = await run(gz);
    const calls: number[] = [];
    const ensureHeadroom = async (dir: string, bytes: number): Promise<void> => {
      expect(dir).toBe(dataDir);
      calls.push(bytes);
      if (calls.length === 2) throw new DomainError('DISK_QUOTA', { meta: { reason: 'headroom' } });
    };
    const error = await splitDump({ dumpPath: r.dumpPath, gz: true, stagingDir: r.stagingDir, checkpoint: null, budgetMs: 60_000, ensureHeadroom, headroomStepBytes: 256 * 1024 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isDomainError(error) && error.code).toBe('DISK_QUOTA');
    expect(calls).toEqual([3 * gz.length, 256 * 1024]);
    const size = (await fsp.stat(path.join(r.stagingDir, 'biblio.ndjson'))).size;
    expect(size).toBeGreaterThanOrEqual(256 * 1024);
    expect(size).toBeLessThan(512 * 1024); // not grown on after the failed check (the whole split writes about 2 MiB)
  });

  it('S10 with the platform probe: every re-check really writes its probe (the 10-minute cache never answers one)', async () => {
    const tuples = Array.from({ length: 400 }, (_, i) => `(${i + 1},'${'Judul berulang '.repeat(20)}')`).join(',');
    const sql = `CREATE TABLE \`biblio\` (\`biblio_id\` int, \`title\` text, PRIMARY KEY (\`biblio_id\`));\n${Array.from({ length: 20 }, () => `INSERT INTO \`biblio\` VALUES ${tuples};\n`).join('')}`;
    const r = await run(gzipSync(Buffer.from(sql)));
    const step = 256 * 1024;
    const realOpen = fsp.open.bind(fsp);
    let probes = 0;
    const open = vi.spyOn(fsp, 'open').mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      if (/^headroom-[0-9a-f]{16}$/.test(path.basename(String(args[0])))) probes += 1;
      return realOpen(...args);
    });
    try {
      const result = await splitDump({ dumpPath: r.dumpPath, gz: true, stagingDir: r.stagingDir, checkpoint: null, budgetMs: 60_000, headroomStepBytes: step });
      expect(result.done).toBe(true);
    } finally {
      open.mockRestore();
    }
    const written = (await fsp.stat(path.join(r.stagingDir, 'biblio.ndjson'))).size;
    expect(written).toBeGreaterThan(8 * step);
    // The first check, then one per step written (each one a probe of its own, never a cache hit).
    expect(probes).toBeGreaterThanOrEqual(Math.floor(written / step));
  });

  it('refuses rows that cannot be named, keeps bytes as $hex, and ignores tables it does not read', async () => {
    const r = await run(Buffer.from("INSERT INTO `search_biblio` VALUES (1,'x');\nINSERT INTO `biblio` VALUES (1,'t');\n"));
    const error = await splitAll(r).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DumpParseError);
    expect(error).toMatchObject({ code: 'columns_unknown', table: 'biblio' });

    const bytes = Buffer.concat([
      Buffer.from("CREATE TABLE `mst_publisher` (`publisher_id` int, `publisher_name` varchar(100));\nINSERT INTO `mst_publisher` VALUES (7,'Caf"),
      Buffer.from([0xe9]),
      Buffer.from("'),(8,_binary 0x00ff);\n"),
    ]);
    const s = await run(bytes);
    const { tables } = await splitAll(s);
    const line = (await fsp.readFile(path.join(s.stagingDir, 'mst_publisher.ndjson'), 'utf8')).split('\n')[0];
    expect(line).toBe('{"publisher_id":7,"publisher_name":{"$hex":"436166e9"}}');
    const source = openStagedDumpSource(s.stagingDir, tables);
    expect((await source.rows('mst_publisher', null, 10)).rows).toEqual([
      { publisher_id: 7, publisher_name: Uint8Array.from([0x43, 0x61, 0x66, 0xe9]) },
      { publisher_id: 8, publisher_name: Uint8Array.from([0x00, 0xff]) },
    ]);
  });

  it('C19: a gz split resumed without its reader skips the decompressed prefix with heartbeats, and its budget counts from the skip\'s end', { timeout: 60_000 }, async () => {
    const { dump } = slimsFixtureBytes();
    const gz = gzipSync(dump);
    const single = await run(gz);
    await splitAll(single, { gz: true });
    // A clock that the skip moves on: each heartbeat stands for a long decompression (far past any slice's budget).
    let t = 0;
    const now = (): number => (t += 1);
    let beats = 0;
    const heartbeat = async (): Promise<void> => {
      beats += 1;
      t += 1_000_000;
    };
    const sliced = await run(gz);
    const parts = await splitAll(sliced, { gz: true, budgets: [40, 40, 40, 40], heartbeat, heartbeatStepBytes: 4096, now });
    expect(beats).toBeGreaterThan(3); // the resumed slices skipped their prefix, heartbeating
    // Each resumed slice still moved about 40 statements (not one): the split ends in as many slices as without skips.
    const unhurried = await run(gz);
    const baseline = await splitAll(unhurried, { gz: true, budgets: [40, 40, 40, 40] });
    expect(parts.slices).toBe(baseline.slices);
    expect(parts.checkpoints.map((c) => c.offset)).toEqual(baseline.checkpoints.map((c) => c.offset));
    expect(await staged(sliced.stagingDir)).toEqual(await staged(single.stagingDir));
  });

  it.each([false, true])('C19: a reader kept between the slices of one process reads on without decompressing again (gz %s)', { timeout: 60_000 }, async (gz) => {
    const { dump } = slimsFixtureBytes();
    const bytes = gz ? gzipSync(dump) : dump;
    const single = await run(bytes);
    const whole = await splitAll(single, { gz });
    let beats = 0;
    const heartbeat = async (): Promise<void> => {
      beats += 1;
    };
    const keep: { reader: SplitDumpReader | null } = { reader: null };
    const sliced = await run(bytes);
    // Slice by slice, as the pipeline's job session keeps it: the reader stays at each checkpoint's offset.
    let checkpoint: SplitCheckpoint | null = null;
    const positions: number[] = [];
    for (let slice = 0; slice < 4; slice += 1) {
      const r = await splitDump({ dumpPath: sliced.dumpPath, gz, stagingDir: sliced.stagingDir, checkpoint, budgetMs: 2, ensureHeadroom: noHeadroom, now: ticking(), keep, heartbeat, heartbeatStepBytes: 1 });
      expect(r.done).toBe(false);
      checkpoint = JSON.parse(JSON.stringify(r.checkpoint)) as SplitCheckpoint;
      expect(keep.reader).not.toBeNull();
      expect(keep.reader!.position).toBe(checkpoint.offset);
      positions.push(checkpoint.offset);
    }
    expect(beats).toBe(0); // nothing was decompressed twice
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // A retried slice resumes from an older checkpoint than the kept reader stands at: the reader is opened again.
    const older = await splitDump({ dumpPath: sliced.dumpPath, gz, stagingDir: sliced.stagingDir, checkpoint: null, budgetMs: 2, ensureHeadroom: noHeadroom, now: ticking(), keep });
    expect(older.checkpoint.offset).toBe(positions[0]);
    const rest = await splitAll(sliced, { gz, checkpoint: JSON.parse(JSON.stringify(older.checkpoint)) as SplitCheckpoint, keep, heartbeat, heartbeatStepBytes: 1 });
    expect(rest.tables).toEqual(whole.tables);
    expect(keep.reader).toBeNull(); // the dump's end closes it
    expect(await staged(sliced.stagingDir)).toEqual(await staged(single.stagingDir));
  });

  it('a data-only dump (complete INSERTs, no CREATE TABLE): the table list carries their columns, resumed too (L12)', { timeout: 60_000 }, async () => {
    const insert = (table: string, columns: string[], ...tuples: string[]): string =>
      `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES ${tuples.join(',')};\n`;
    const others = ['mst_gmd', 'mst_publisher', 'mst_place', 'mst_language', 'mst_author', 'mst_topic', 'biblio_author', 'biblio_topic', 'mst_location']
      .concat(['mst_coll_type', 'mst_item_status', 'mst_supplier', 'biblio_attachment', 'files', 'biblio_relation', 'mst_voc_ctrl', 'mst_custom_field'])
      .map((t) => insert(t, ['x_id'], '(1)'));
    const dump = Buffer.from(
      [
        insert('biblio', ['biblio_id', 'title', 'content_type_id'], "(1,'Satu',1)", "(2,'Dua',2)"),
        insert('biblio', ['biblio_id', 'title', 'content_type_id', 'cf_7a1b'], "(3,'Tiga',1,'nilai')"),
        insert('item', ['item_id', 'biblio_id', 'item_code'], "(1,1,'B0001')"),
        insert('item_custom', ['item_id', 'cf_9c2d'], "(1,'lain')"),
        ...others,
      ].join(''),
    );
    const whole = await splitAll(await run(dump));
    const columnsOf = (tables: SlimsTableInfo[], name: string): string[] | undefined => tables.find((t) => t.name === name)?.columns;
    expect(columnsOf(whole.tables, 'biblio')).toEqual(['biblio_id', 'title', 'content_type_id', 'cf_7a1b']);
    expect(columnsOf(whole.tables, 'item')).toEqual(['item_id', 'biblio_id', 'item_code']);
    expect(columnsOf(whole.tables, 'item_custom')).toEqual(['item_id', 'cf_9c2d']);
    // So the version is detected from the INSERTs' columns (SLiMS 8/9's biblio.content_type_id), not refused as unknown.
    expect(detectSlimsVersion(whole.tables).version).toBe('9');

    // Sliced at every statement and resumed from the checkpoint as a job payload carries it: the same list and staging.
    const s = await run(dump);
    const sliced = await splitAll(s, { budgets: Array.from({ length: 40 }, () => 1) });
    expect(sliced.slices).toBeGreaterThan(3);
    expect(sliced.tables).toEqual(whole.tables);

    // The INSERTs' columns name no positions: a later INSERT without a column list still cannot be named.
    const positional = Buffer.from(insert('biblio', ['biblio_id', 'title'], "(1,'Satu')") + "INSERT INTO `biblio` VALUES (2,'Dua');\n");
    await expect(splitAll(await run(positional))).rejects.toMatchObject({ code: 'columns_unknown', table: 'biblio' });
    await expect(splitAll(await run(positional), { budgets: [1, 1, 1] })).rejects.toMatchObject({ code: 'columns_unknown', table: 'biblio' });
  });

  it('a mysqldump --no-create-info whose small library has empty tables: those are listed empty, so SLiMS 9 is detected (L12)', { timeout: 60_000 }, async () => {
    const insert = (table: string, columns: string[], ...tuples: string[]): string =>
      `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES ${tuples.join(',')};\n`;
    // What mysqldump writes for a table without rows when it writes no structure: its locks and keys, no INSERT.
    const empty = (table: string): string =>
      `LOCK TABLES \`${table}\` WRITE;\n/*!40000 ALTER TABLE \`${table}\` DISABLE KEYS */;\n/*!40000 ALTER TABLE \`${table}\` ENABLE KEYS */;\nUNLOCK TABLES;\n`;
    const filled = ['mst_gmd', 'mst_publisher', 'mst_place', 'mst_language', 'mst_author', 'mst_topic', 'biblio_author', 'biblio_topic', 'mst_location']
      .concat(['mst_coll_type', 'mst_item_status'])
      .map((t) => insert(t, ['x_id'], '(1)'));
    const emptied = ['biblio_relation', 'mst_voc_ctrl', 'mst_supplier', 'files', 'biblio_attachment'];
    const body = [
      insert('biblio', ['biblio_id', 'title', 'content_type_id'], "(1,'Satu',1)"),
      insert('item', ['item_id', 'biblio_id', 'item_code'], "(1,1,'B0001')"),
      ...filled,
      ...emptied.map(empty),
    ];
    const dump = Buffer.from([...body, insert('loan_history', ['loan_id'], '(1)')].join(''));
    const whole = await splitAll(await run(dump));
    const info = detectSlimsVersion(whole.tables);
    expect(info.version).toBe('9');
    for (const table of emptied) {
      expect(whole.tables.find((t) => t.name === table)).toEqual({ name: table, columns: [], primaryKey: [], rows: 0 });
      expect(info.missing).not.toContain(table);
    }
    // Sliced at every statement and resumed: the same list.
    const sliced = await splitAll(await run(dump), { budgets: Array.from({ length: 40 }, () => 1) });
    expect(sliced.slices).toBeGreaterThan(3);
    expect(sliced.tables).toEqual(whole.tables);

    // Without rows in a SLiMS 9 marker the version stays what the dump shows: SLiMS 8's columns (best effort, warned).
    const eight = await splitAll(await run(Buffer.from(body.join(''))));
    expect(detectSlimsVersion(eight.tables).version).toBe('8');
    // A dump with structure lists only what it holds: a table it never names stays missing.
    const structured = await splitAll(await run(Buffer.from(`CREATE TABLE \`biblio\` (\`biblio_id\` int, \`content_type_id\` int);\n${body.join('')}`)));
    expect(structured.tables.map((t) => t.name)).not.toContain('mst_voc_ctrl');
    expect(detectSlimsVersion(structured.tables).version).toBe('unknown');
  });

  it('refuses a dump with more tables than a checkpoint can carry, and a gzip that is not one', async () => {
    const many = Array.from({ length: 600 }, (_, i) => `CREATE TABLE t${i} (a int);`).join('\n');
    await expect(splitAll(await run(Buffer.from(many)))).rejects.toMatchObject({ code: 'too_many_tables' });
    await expect(splitAll(await run(Buffer.from('not gzip at all')), { gz: true })).rejects.toMatchObject({ code: 'gzip_invalid' });
  });
});

describe('openStagedDumpSource', () => {
  it('reads the staging back in batches, the rows equal to what the parser read', async () => {
    const { dump } = slimsFixtureBytes();
    const r = await run(dump);
    const { tables } = await splitAll(r);
    const source = openStagedDumpSource(r.stagingDir, tables);
    expect(source.kind).toBe('dump');
    expect(await source.tables()).toEqual(tables);
    const parsed = parsedRows(dump);
    const items: SlimsRow[] = [];
    let after: string | null = null;
    let batches = 0;
    do {
      const batch = await source.rows('item', after, 500);
      items.push(...batch.rows);
      after = batch.next;
      batches += 1;
    } while (after !== null);
    expect(batches).toBe(2);
    expect(items).toEqual(parsed.get('item'));
    const biblio = await source.rows('biblio', null, 1000);
    expect(biblio.rows).toHaveLength(300); // a limit above 500 reads 500 at most
    expect(biblio.next).toBeNull();
    expect((await source.rows('mst_publisher', null, 500)).rows).toEqual(parsed.get('mst_publisher'));
    await source.close();
  });

  it('takes a plain line number as a cursor, and refuses a cursor that does not point at a line', async () => {
    const { dump } = slimsFixtureBytes();
    const r = await run(dump);
    const { tables } = await splitAll(r);
    const source = openStagedDumpSource(r.stagingDir, tables);
    const first = await source.rows('item', null, 100);
    const viaLine = await source.rows('item', '100', 100);
    const viaCursor = await source.rows('item', first.next, 100);
    expect(viaLine).toEqual(viaCursor);
    expect(viaLine.rows[0]).toMatchObject({ item_id: 101 });
    await expect(source.rows('item', '100:5', 10)).rejects.toThrow(TypeError);
    await expect(source.rows('item', 'abc', 10)).rejects.toThrow(TypeError);
    await expect(source.rows('item', null, 0)).rejects.toThrow(TypeError);
    await expect(source.rows('item', '999999', 10)).resolves.toEqual({ rows: [], next: null });
    // A table it was not given, or did not stage (not read in Phase 2), has no rows.
    expect(await source.rows('search_biblio', null, 10)).toEqual({ rows: [], next: null });
    expect(await source.rows('no_such_table', null, 10)).toEqual({ rows: [], next: null });
  });
});
