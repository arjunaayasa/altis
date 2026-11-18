import type { ForeignMysql, ForeignMysqlConfig } from '@altis/db';
import { isDomainError } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { openDbSource, type SlimsDbConfig } from '../../src/migration/slims/source/index.js';

// The direct-connection source (spec §11.1): SELECT only, keyset pages of at most 500 rows by primary key (a row
// comparison for a composite key), LIMIT/OFFSET for a table without one (flagged `no_pk`) and for the author and
// subject links (in the table's own order), every identifier a `??` value. A fake ForeignMysql stands in for the server; the real MariaDB variant runs in Task 39.

const CFG: SlimsDbConfig = { host: 'db.example', port: 3306, user: 'baca', password: 'x', database: 'slims', tls: false };

interface Table {
  columns: string[];
  primaryKey: string[];
  rows: Record<string, Buffer | number | string | null>[];
}

const b = (s: string): Buffer => Buffer.from(s, 'utf8');

/**
 * A SLiMS database in memory: item (1 200 rows), biblio_custom (cf_* columns), biblio_relation (composite key), biblio_author
 * (composite key, rows out of key order), search_biblio (derived), altis_lokal (unknown, no key), biblio_attachment (no key),
 * mst_language (text key).
 */
function database(): Map<string, Table> {
  const tables = new Map<string, Table>();
  tables.set('item', {
    columns: ['item_id', 'biblio_id', 'item_code'],
    primaryKey: ['item_id'],
    rows: Array.from({ length: 1200 }, (_, i) => ({ item_id: i + 1, biblio_id: (i % 300) + 1, item_code: b(`B${String(i + 1).padStart(5, '0')}`) })),
  });
  tables.set('biblio_custom', {
    columns: ['biblio_id', 'cf_4c5d6', 'cf_7e8f9'],
    primaryKey: ['biblio_id'],
    rows: [
      { biblio_id: 1, cf_4c5d6: b('12'), cf_7e8f9: Buffer.from([0x43, 0x61, 0x66, 0xe9]) },
      { biblio_id: 2, cf_4c5d6: null, cf_7e8f9: b('Café') },
    ],
  });
  tables.set('biblio_relation', {
    columns: ['biblio_id', 'rel_biblio_id', 'rel_type'],
    primaryKey: ['biblio_id', 'rel_biblio_id'],
    rows: [1, 2, 3].flatMap((bid) => [1, 2].map((rid) => ({ biblio_id: bid, rel_biblio_id: rid, rel_type: rid }))),
  });
  // In the order the authors were entered, not in key order (a MyISAM table gives them so).
  tables.set('biblio_author', {
    columns: ['biblio_id', 'author_id', 'level'],
    primaryKey: ['biblio_id', 'author_id'],
    rows: [
      { biblio_id: 2, author_id: 9, level: 1 },
      { biblio_id: 2, author_id: 3, level: 1 },
      { biblio_id: 1, author_id: 5, level: 2 },
      { biblio_id: 1, author_id: 4, level: 1 },
      { biblio_id: 3, author_id: 1, level: 1 },
    ],
  });
  tables.set('search_biblio', { columns: ['biblio_id', 'title'], primaryKey: ['biblio_id'], rows: [{ biblio_id: 1, title: b('Laskar Pelangi') }] });
  tables.set('altis_lokal', { columns: ['id'], primaryKey: [], rows: [{ id: 1 }, { id: 2 }] });
  tables.set('biblio_attachment', { columns: ['biblio_id', 'file_id'], primaryKey: [], rows: Array.from({ length: 7 }, (_, i) => ({ biblio_id: i + 1, file_id: i + 1 })) });
  tables.set('mst_language', {
    columns: ['language_id', 'language_name'],
    primaryKey: ['language_id'],
    rows: [
      { language_id: b(''), language_name: b('Kosong') },
      { language_id: b('en'), language_name: b('English') },
      { language_id: b('id'), language_name: b('Indonesia') },
    ],
  });
  return tables;
}

/** The comparable form of a key value as the fake server sees it. */
const key = (v: unknown): string | number => (Buffer.isBuffer(v) ? v.toString('utf8') : (v as string | number));

function compare(a: readonly (string | number)[], b2: readonly (string | number)[]): number {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]! < b2[i]!) return -1;
    if (a[i]! > b2[i]!) return 1;
  }
  return 0;
}

/**
 * A fake server that understands the statements the source sends: the three information_schema reads, COUNT(*), and
 * a SELECT of `??` columns with a keyset WHERE or LIMIT/OFFSET.
 */
function fakeServer(tables: Map<string, Table>): { connect: (cfg: ForeignMysqlConfig, o: { connectTimeoutMs: number }) => Promise<ForeignMysql>; log: { sql: string; params: unknown[] }[]; opened: { cfg: ForeignMysqlConfig; connectTimeoutMs: number }[]; closed: number } {
  const log: { sql: string; params: unknown[] }[] = [];
  const opened: { cfg: ForeignMysqlConfig; connectTimeoutMs: number }[] = [];
  const state = { closed: 0 };
  const db: ForeignMysql = {
    async query(sql, params) {
      log.push({ sql, params: [...params] });
      if (sql.includes('information_schema.TABLES')) return [...tables.keys()].map((t) => ({ name: b(t) }));
      if (sql.includes('information_schema.COLUMNS')) {
        return [...tables].flatMap(([t, def]) => def.columns.map((c, i) => ({ tname: b(t), cname: b(c), position: i + 1 })));
      }
      if (sql.includes('information_schema.STATISTICS')) {
        return [...tables].flatMap(([t, def]) => def.primaryKey.map((c, i) => ({ tname: b(t), cname: b(c), seq: i + 1 })));
      }
      if (sql.startsWith('SELECT COUNT(*)')) return [{ n: tables.get(params[0] as string)!.rows.length }];
      const m = /^SELECT ((?:\?\?, )*\?\?) FROM \?\?(?: WHERE \(((?:\?\?, )*\?\?)\) > \(((?:\?, )*\?)\))?(?: ORDER BY ((?:\?\?, )*\?\?))? LIMIT \?(?: OFFSET \?)?$/.exec(sql);
      if (m === null) throw new Error(`unexpected statement ${sql}`);
      const ncols = m[1]!.split(', ').length;
      const columns = params.slice(0, ncols) as string[];
      const table = tables.get(params[ncols] as string)!;
      let at = ncols + 1;
      let rows = table.rows;
      let after: (string | number)[] | null = null;
      if (m[2] !== undefined) {
        const nkey = m[2].split(', ').length;
        after = params.slice(at + nkey, at + 2 * nkey).map(key);
        at += 2 * nkey;
      }
      if (m[4] !== undefined) {
        const nkey = m[4].split(', ').length;
        const keyColumns = params.slice(at, at + nkey) as string[];
        at += nkey;
        const of = (r: Record<string, unknown>): (string | number)[] => keyColumns.map((c) => key(r[c]));
        rows = [...rows].sort((x, y) => compare(of(x), of(y)));
        if (after !== null) rows = rows.filter((r) => compare(of(r), after) > 0);
      }
      const limit = params[at] as number;
      const offset = sql.endsWith('OFFSET ?') ? (params[at + 1] as number) : 0;
      return rows.slice(offset, offset + limit).map((r) => Object.fromEntries(columns.map((c) => [c, r[c]!])));
    },
    async close() {
      state.closed += 1;
    },
  };
  return {
    connect: async (cfg, o) => {
      opened.push({ cfg, connectTimeoutMs: o.connectTimeoutMs });
      return db;
    },
    log,
    opened,
    get closed() {
      return state.closed;
    },
  };
}

describe('openDbSource', () => {
  it('connects with a 10 s timeout and lists the tables with their columns, keys and row counts', async () => {
    const server = fakeServer(database());
    const source = await openDbSource(CFG, { connect: server.connect });
    expect(source.kind).toBe('db');
    expect(server.opened).toEqual([{ cfg: CFG, connectTimeoutMs: 10_000 }]);
    const tables = await source.tables();
    expect(tables.find((t) => t.name === 'item')).toEqual({ name: 'item', columns: ['item_id', 'biblio_id', 'item_code'], primaryKey: ['item_id'], rows: 1200 });
    expect(tables.find((t) => t.name === 'biblio_attachment')).toEqual({ name: 'biblio_attachment', columns: ['biblio_id', 'file_id'], primaryKey: [], rows: 7, flags: ['no_pk'] });
    expect(tables.find((t) => t.name === 'biblio_author')!.primaryKey).toEqual(['biblio_id', 'author_id']);
    // A derived table is counted too (the report lists it with its rows); one the migration does not know is not.
    expect(tables.find((t) => t.name === 'search_biblio')!.rows).toBe(1);
    expect(tables.find((t) => t.name === 'altis_lokal')).toEqual({ name: 'altis_lokal', columns: ['id'], primaryKey: [], rows: null, flags: ['no_pk'] });
    await source.close();
    expect(server.closed).toBe(1);
  });

  it('pages item by item_id in 500s, with every name a ?? value and only SELECT statements', async () => {
    const server = fakeServer(database());
    const source = await openDbSource(CFG, { connect: server.connect });
    const seen: number[] = [];
    const sizes: number[] = [];
    let after: string | null = null;
    do {
      const batch = await source.rows('item', after, 2000);
      sizes.push(batch.rows.length);
      seen.push(...batch.rows.map((r) => r['item_id'] as number));
      after = batch.next;
    } while (after !== null);
    expect(sizes).toEqual([500, 500, 200]);
    expect(seen).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
    const pages = server.log.filter((q) => q.params.includes('item') && q.sql.includes('LIMIT'));
    expect(pages.map((q) => q.sql)).toEqual([
      'SELECT ??, ??, ?? FROM ?? WHERE (??) > (?) ORDER BY ?? LIMIT ?'.replace(' WHERE (??) > (?)', ''),
      'SELECT ??, ??, ?? FROM ?? WHERE (??) > (?) ORDER BY ?? LIMIT ?',
      'SELECT ??, ??, ?? FROM ?? WHERE (??) > (?) ORDER BY ?? LIMIT ?',
    ]);
    expect(pages[1]!.params).toEqual(['item_id', 'biblio_id', 'item_code', 'item', 'item_id', 500, 'item_id', 500]);
    for (const q of server.log) {
      expect(q.sql).toMatch(/^SELECT /);
      expect(q.sql).not.toMatch(/item|biblio|cf_|slims/);
    }
    await source.close();
  });

  it('reads a cf_* column as a ?? value, and text as text when it is UTF-8 and as bytes otherwise', async () => {
    const server = fakeServer(database());
    const source = await openDbSource(CFG, { connect: server.connect });
    const { rows, next } = await source.rows('biblio_custom', null, 500);
    expect(next).toBeNull();
    expect(rows).toEqual([
      { biblio_id: 1, cf_4c5d6: '12', cf_7e8f9: Uint8Array.from([0x43, 0x61, 0x66, 0xe9]) },
      { biblio_id: 2, cf_4c5d6: null, cf_7e8f9: 'Café' },
    ]);
    const query = server.log.find((q) => q.params.includes('biblio_custom') && q.sql.includes('LIMIT'))!;
    expect(query.params).toContain('cf_4c5d6');
    expect(query.sql).not.toContain('cf_');
    await source.close();
  });

  it('pages a composite key by row comparison, a text key by its text, and a table without a key by offset', async () => {
    const server = fakeServer(database());
    const source = await openDbSource(CFG, { connect: server.connect });
    const first = await source.rows('biblio_relation', null, 4);
    const second = await source.rows('biblio_relation', first.next, 4);
    expect([...first.rows, ...second.rows].map((r) => [r['biblio_id'], r['rel_biblio_id']])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
      [3, 1],
      [3, 2],
    ]);
    expect(second.next).toBeNull();
    expect(server.log.at(-1)!.sql).toBe('SELECT ??, ??, ?? FROM ?? WHERE (??, ??) > (?, ?) ORDER BY ??, ?? LIMIT ?');
    expect(server.log.at(-1)!.params.slice(4, 8)).toEqual(['biblio_id', 'rel_biblio_id', 2, 2]);

    const lang1 = await source.rows('mst_language', null, 2);
    const lang2 = await source.rows('mst_language', lang1.next, 2);
    expect([...lang1.rows, ...lang2.rows].map((r) => r['language_id'])).toEqual(['', 'en', 'id']);
    expect(server.log.at(-1)!.params).toContain('en');

    const a = await source.rows('biblio_attachment', null, 5);
    const z = await source.rows('biblio_attachment', a.next, 5);
    expect([...a.rows, ...z.rows].map((r) => r['file_id'])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(server.log.at(-1)!.sql).toBe('SELECT ??, ?? FROM ?? LIMIT ? OFFSET ?');
    expect(z.next).toBeNull();
    await source.close();
  });

  it('reads the author and subject links in the order of the table itself, as mysqldump does, paged by offset', async () => {
    const server = fakeServer(database());
    const source = await openDbSource(CFG, { connect: server.connect });
    const first = await source.rows('biblio_author', null, 3);
    const second = await source.rows('biblio_author', first.next, 3);
    expect([...first.rows, ...second.rows].map((r) => [r['biblio_id'], r['author_id']])).toEqual([
      [2, 9],
      [2, 3],
      [1, 5],
      [1, 4],
      [3, 1],
    ]);
    expect([first.next, second.next]).toEqual(['o:3', null]);
    expect(server.log.at(-1)).toEqual({ sql: 'SELECT ??, ??, ?? FROM ?? LIMIT ? OFFSET ?', params: ['biblio_id', 'author_id', 'level', 'biblio_author', 3, 3] });
    await expect(source.rows('biblio_author', 'k:[1,1]', 3)).rejects.toThrow(TypeError);
    await source.close();
  });

  it('answers no rows for a table the server does not have, and refuses a cursor it did not give', async () => {
    const server = fakeServer(database());
    const source = await openDbSource(CFG, { connect: server.connect });
    expect(await source.rows('member', null, 10)).toEqual({ rows: [], next: null });
    await expect(source.rows('item', 'nonsense', 10)).rejects.toThrow(TypeError);
    await expect(source.rows('item', 'o:5', 10)).rejects.toThrow(TypeError); // an offset cursor for a keyed table
    await expect(source.rows('item', null, 0)).rejects.toThrow(TypeError);
    await source.close();
  });

  it.each([
    ['ECONNREFUSED', 'refused'],
    ['ETIMEDOUT', 'timeout'],
    ['ENOTFOUND', 'dns'],
    ['ER_ACCESS_DENIED_ERROR', 'access_denied'],
    ['ER_BAD_DB_ERROR', 'unknown_database'],
    ['HANDSHAKE_SSL_ERROR', 'tls'],
    ['PROTOCOL_CONNECTION_LOST', 'connection_lost'],
    ['SOMETHING_ELSE', 'other'],
  ])('reports an unreachable server (%s) as MIGRATION_SOURCE_UNREACHABLE with reason %s', async (code, reason) => {
    const connect = async (): Promise<ForeignMysql> => {
      throw Object.assign(new Error(`connect failed (${code}) to db.example as baca`), { code });
    };
    const error = await openDbSource(CFG, { connect }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isDomainError(error) && [error.code, error.meta]).toEqual(['MIGRATION_SOURCE_UNREACHABLE', { reason }]);
  });
});
