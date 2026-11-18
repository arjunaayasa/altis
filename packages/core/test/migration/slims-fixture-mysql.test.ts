import { describe, expect, it } from 'vitest';
import { fixtureRowKey, mysqlDumpStatements, mysqlSlimsFixture, renderDumpInOrder } from '../support/slims-fixture-mysql.js';
import { FIXTURE_TABLES, SLIMS_FIXTURE_SEED } from '../support/slims-fixture/index.js';

// The fixture of the MySQL direct-source test (slims-db-source-mysql.test.ts, which needs a MySQL server) without a
// server: the dump split into the statements that test sends, and the SLiMS folder it reads the photos from.

describe('the SLiMS fixture as a MySQL server holds it', () => {
  const fixture = mysqlSlimsFixture(SLIMS_FIXTURE_SEED);
  const split = mysqlDumpStatements(fixture.dump);

  it('splits the dump into one INSERT per 50 rows of each table, and skips only the trigger block', () => {
    const inserts = new Map<string, number>();
    for (const s of split.statements) if (s.insertInto !== null) inserts.set(s.insertInto, (inserts.get(s.insertInto) ?? 0) + 1);
    for (const [table, { source }] of Object.entries(fixture.expected.tables)) {
      expect([table, inserts.get(table) ?? 0]).toEqual([table, Math.ceil(source / 50)]);
    }
    expect(split.skipped).toHaveLength(1);
    expect(split.skipped[0]).toMatch(/TRIGGER/);
    expect(split.names).toEqual(['utf8mb4', 'latin1', 'utf8mb4']);
    // No comment line is sent, no statement is cut inside a quoted text.
    expect(split.statements.filter((s) => /^--/.test(s.sql))).toEqual([]);
    expect(split.statements.filter((s) => s.sql.includes('\uFFFD'))).toEqual([]);
    expect(split.statements.filter((s) => s.insertInto !== null && !s.sql.endsWith(')'))).toEqual([]);
  });

  it('drops AUTO_INCREMENT only where the CREATE TABLE has no key yet, and decodes the latin1 rows as Windows-1252', () => {
    expect(split.autoIncrementDropped).toEqual(['content']);
    const create = (table: string): string => split.statements.find((s) => s.sql.startsWith(`CREATE TABLE \`${table}\``))!.sql;
    expect(create('content')).not.toMatch(/AUTO_INCREMENT/);
    expect(create('biblio')).toMatch(/AUTO_INCREMENT/);
    expect(split.statements.some((s) => /^ALTER TABLE `content`\s+ADD PRIMARY KEY/.test(s.sql))).toBe(true);
    for (const t of fixture.expected.traps.cp1252) {
      expect(split.statements.some((s) => s.insertInto === t.table && s.sql.includes(t.clean))).toBe(true);
    }
  });

  it('gives five typed members a photo, and the SLiMS folder their files', () => {
    expect(fixture.photos.map((p) => p.outcome)).toEqual(['stored', 'stored', 'not_jpeg', 'missing', 'too_large']);
    const rels = new Set(fixture.files.map((f) => f.rel));
    for (const p of fixture.photos) {
      expect([p.memberId, rels.has(`images/persons/${p.image}`)]).toEqual([p.memberId, p.bytes !== null]);
      // The dump carries the member's image name.
      expect(split.statements.some((s) => s.insertInto === 'member' && s.sql.includes(`'${p.memberId}'`) && s.sql.includes(`'${p.image}'`))).toBe(true);
    }
    for (const rel of fixture.expected.zipFiles) expect(rels.has(rel)).toBe(true);
    expect(fixture.adjustments).toEqual(['cut biblio.isbn_issn', 'trailing_spaces mst_content_type.code2']);
  });

  it('writes the same dump with the rows of a table in another order, and refuses an order that is not of its rows', () => {
    const keysOf = (table: string): string[] => {
      const pk = FIXTURE_TABLES.find((t) => t.name === table)!.primaryKey;
      return (fixture.data.rows.get(table) ?? []).map((r) => fixtureRowKey(r, pk));
    };
    expect(renderDumpInOrder(fixture.data, new Map([['member', keysOf('member')]]))).toEqual({ dump: fixture.dump, reordered: [] });
    const reversed = renderDumpInOrder(fixture.data, new Map([['member', keysOf('member').reverse()]]));
    expect(reversed.reordered).toEqual(['member']);
    expect(reversed.dump.length).toBe(fixture.dump.length);
    expect(() => renderDumpInOrder(fixture.data, new Map([['member', keysOf('member').slice(1)]]))).toThrow(/keys listed/);
  });
});
