import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanText, phpUnserialize } from '../../src/migration/slims/source/index.js';
import { createSqlDumpParser, type DumpEvent } from '../../src/migration/slims/source/sql-dump.js';
import type { SlimsRow } from '../../src/migration/slims/source/types.js';
import { FIXTURE_TABLES, SLIMS_FIXTURE_SEED, buildSlimsFixture, slimsFixtureBytes, type SlimsFixture } from '../support/slims-fixture/index.js';

// The synthetic SLiMS fixture (spec §11.7) against the dump reader: deterministic, its counts and traps as `expected`
// says, the same events whatever the chunking.

let dir: string;
let fixture: SlimsFixture;

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-slims-fixture-'));
  fixture = await buildSlimsFixture(dir);
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

/** The events of `dump` pushed in pieces of `size` bytes. */
function events(dump: Buffer, size: number): DumpEvent[] {
  const parser = createSqlDumpParser();
  const out: DumpEvent[] = [];
  for (let i = 0; i < dump.length; i += size) out.push(...parser.push(dump.toString('latin1', i, Math.min(dump.length, i + size))));
  out.push(...parser.end());
  return out;
}

/** Every row per table, in dump order. */
function rowsByTable(list: readonly DumpEvent[]): Map<string, SlimsRow[]> {
  const out = new Map<string, SlimsRow[]>();
  for (const e of list) {
    if (e.type !== 'insert') continue;
    out.set(e.table, [...(out.get(e.table) ?? []), ...e.rows]);
  }
  return out;
}

/** The entry names of a zip, in central-directory order. */
async function zipNames(bytes: Buffer): Promise<string[]> {
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, z) => (error || z === undefined ? reject(error) : resolve(z))),
  );
  return new Promise((resolve, reject) => {
    const names: string[] = [];
    zip.on('entry', (entry: Entry) => {
      names.push(String(entry.fileName));
      zip.readEntry();
    });
    zip.on('end', () => resolve(names));
    zip.on('error', reject);
    zip.readEntry();
  });
}

describe('the synthetic SLiMS fixture', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = slimsFixtureBytes();
    const b = slimsFixtureBytes(SLIMS_FIXTURE_SEED);
    expect(a.dump.equals(b.dump)).toBe(true);
    expect(a.dumpGz.equals(b.dumpGz)).toBe(true);
    expect(a.filesZip.equals(b.filesZip)).toBe(true);
    expect(slimsFixtureBytes(7).dump.equals(a.dump)).toBe(false);
  });

  it('writes the dump, its gzip and the files zip', async () => {
    const dump = await fsp.readFile(fixture.dumpPath);
    expect(gunzipSync(await fsp.readFile(fixture.dumpGzPath)).equals(dump)).toBe(true);
    const names = await zipNames(await fsp.readFile(fixture.filesZipPath));
    for (const prefix of ['repository/', 'images/docs/', 'images/content/']) expect(names.some((n) => n.startsWith(prefix) && !n.endsWith('/'))).toBe(true);
    expect(names.filter((n) => !n.endsWith('/'))).toEqual(fixture.expected.zipFiles);
    for (const missing of fixture.expected.traps.missingFiles) expect(names).not.toContain(missing.rel);
    for (const cover of fixture.expected.traps.covers.missing) expect(names).not.toContain(cover.rel);
    expect(names).not.toContain(fixture.expected.traps.content.images.missing[0]);
  });

  it('holds about 300 records, 600 items and every table §11.4 reads, as many rows as expected says', async () => {
    const all = events(await fsp.readFile(fixture.dumpPath), 65536);
    const rows = rowsByTable(all);
    expect(fixture.expected.tables['biblio']!.source).toBe(rows.get('biblio')!.length);
    expect(rows.get('biblio')!.length).toBe(300);
    expect(rows.get('item')!.length).toBe(600);
    for (const [table, { source }] of Object.entries(fixture.expected.tables)) expect([table, rows.get(table)?.length ?? 0]).toEqual([table, source]);
    const created = all.filter((e) => e.type === 'create').map((e) => e.table);
    expect(created).toEqual(FIXTURE_TABLES.map((t) => t.name));
    const keys = new Map(all.flatMap((e) => (e.type === 'create' || e.type === 'primaryKey' ? [[e.table, e.primaryKey] as const] : [])));
    for (const t of FIXTURE_TABLES) expect([t.name, keys.get(t.name)]).toEqual([t.name, [...t.primaryKey]]);
  });

  it('gives the same events in 1-, 7- and 4096-byte chunks', async () => {
    const dump = await fsp.readFile(fixture.dumpPath);
    const whole = events(dump, dump.length);
    expect(events(dump, 4096)).toEqual(whole);
    expect(events(dump, 7)).toEqual(whole);
    expect(events(dump, 1)).toEqual(whole);
  });

  it('stores each trap as expected says, and the clean-up makes of it what expected says', async () => {
    const rows = rowsByTable(events(await fsp.readFile(fixture.dumpPath), 65536));
    const pk = new Map(FIXTURE_TABLES.map((t) => [t.name, t.primaryKey]));
    const find = (table: string, key: string): SlimsRow => {
      const columns = pk.get(table)!.length > 0 ? pk.get(table)! : ['biblio_id', 'file_id'];
      const row = rows.get(table)!.find((r) => columns.map((c) => String(r[c])).join('|') === key);
      if (row === undefined) throw new Error(`no row ${table} ${key}`);
      return row;
    };
    const t = fixture.expected.traps;
    for (const trap of [...t.mojibake, ...t.backslash, ...t.nul]) {
      const cell = find(trap.table, trap.key)[trap.column];
      expect([trap.key, cell]).toEqual([trap.key, trap.stored]);
      expect([trap.key, cleanText(cell as string).value]).toEqual([trap.key, trap.clean]);
    }
    for (const trap of t.cp1252) {
      const cell = find(trap.table, trap.key)[trap.column];
      expect(cell).toBeInstanceOf(Uint8Array);
      expect(cleanText(cell as Uint8Array)).toEqual({ value: trap.clean, fixes: ['cp1252'] });
    }
    for (const trap of t.php.valid) expect(phpUnserialize(find(trap.table, trap.key)[trap.column] as string)).toEqual({ ok: true, value: trap.value });
    for (const trap of t.php.broken) expect(phpUnserialize(find(trap.table, trap.key)[trap.column] as string)).toEqual({ ok: false, strings: trap.strings });
    for (const y of t.years) expect(find('biblio', String(y.biblioId))['publish_year']).toBe(y.text);
    for (const z of t.zeroDates) expect(String(find(z.table, z.key)[z.column])).toMatch(/^0000-00-00/);
    expect(t.hidden.map((id) => find('biblio', String(id))['opac_hide'])).toEqual([1, 1, 1]);
    expect(rows.get('item')!.filter((r) => Number(r['biblio_id']) > 300).map((r) => r['item_id'])).toEqual(t.orphans.items.map((o) => o.itemId));
    expect(t.orphans.missingBiblioIds).toEqual([9001, 9002]);
    expect(find('biblio_custom', '1')['cf_4c5d6']).toBe('12');
    expect(rows.get('mst_language')!.some((r) => r['language_id'] === '')).toBe(true);
    expect(rows.get('mst_topic')!.filter((r) => ['o', 'c'].includes(r['topic_type'] as string)).map((r) => r['topic_id'])).toEqual([7, 8]);
    expect(rows.get('biblio_relation')!.filter((r) => r['rel_biblio_id'] === 0)).toHaveLength(t.relations.zero);
    expect(find('item', '20')).toMatchObject({ price: 125000, price_currency: 'Rp' });
    const statuses = new Map<string, number>();
    for (const r of rows.get('item')!) statuses.set(r['item_status_id'] as string, (statuses.get(r['item_status_id'] as string) ?? 0) + 1);
    for (const [stored, { items }] of Object.entries(t.itemStatuses)) expect([stored, statuses.get(stored)]).toEqual([stored, items]);
    expect(find('item', '13')['item_code']).toBe('B–0013');
  });
});
