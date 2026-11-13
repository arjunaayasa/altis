import { describe, expect, it } from 'vitest';
import { slimsTableRole } from '../../src/migration/slims/source/detect.js';
import { generateSlimsFixture } from '../support/slims-fixture/generate.js';
import { FIXTURE_TABLES, SLIMS_FIXTURE_SEED, slimsFixtureBytes, type FixtureRow } from '../support/slims-fixture/index.js';

// The hooks of the synthetic SLiMS fixture: the usage rows of the aggregate usage import and the catalogue changes a
// library makes after a first migration are applied to the data before the dump is written, so the tables the
// catalogue migration reads stay byte for byte as the plain fixture has them unless a hook changes them on purpose. The
// two usage tables are in every dump, empty without the usage option, and not read by the catalogue migration.

/** The dump's text per table: from its "Table structure" comment to the next one (or the dump's tail). */
function sections(dump: Buffer): Map<string, string> {
  const text = dump.toString('latin1');
  const marks = [...text.matchAll(/^-- Table structure for table `([^`]+)`$/gm)];
  const out = new Map<string, string>();
  marks.forEach((m, i) => out.set(m[1]!, text.slice(m.index, i + 1 < marks.length ? marks[i + 1]!.index : text.indexOf('/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE'))));
  return out;
}

describe('the SLiMS fixture hooks', () => {
  const plain = slimsFixtureBytes();
  const catalogueTables = [...new Set([...plain.expected.roles.read, ...plain.expected.roles.archived])];

  it('the usage option leaves every table the catalogue migration reads as the plain fixture has it, byte for byte', () => {
    const usage = slimsFixtureBytes(SLIMS_FIXTURE_SEED, { usage: { fromMonth: '2025-07', months: 12 } });
    const a = sections(plain.dump);
    const b = sections(usage.dump);
    expect(catalogueTables.length).toBeGreaterThan(20);
    for (const table of catalogueTables) expect(b.get(table), table).toBe(a.get(table));
    expect(usage.filesZip.equals(plain.filesZip)).toBe(true);
  });

  it('with both options, only the tables the catalogue changes touch differ from the plain dump, and the hooks expectations come back', () => {
    const both = slimsFixtureBytes(SLIMS_FIXTURE_SEED, { usage: {}, mutateCatalog: true });
    const a = sections(plain.dump);
    const b = sections(both.dump);
    const touched = both.hooks.mutation!.tables;
    for (const table of catalogueTables.filter((t) => !touched.includes(t))) expect(b.get(table), table).toBe(a.get(table));
    for (const table of touched) expect(b.get(table), table).not.toBe(a.get(table));
    expect(both.hooks.usage?.rows.visitor_count).toBe(5000);
    expect(both.hooks.mutation).toMatchObject({ catalogChanges: 10 });
    expect(plain.hooks).toEqual({ usage: null, mutation: null });
    for (const table of catalogueTables) if (!touched.includes(table)) expect(both.expected.tables[table], table).toEqual(plain.expected.tables[table]);
    // One copy added, two gone with their title; two titles gone; two item statuses and two loans added.
    expect(both.expected.tables['item']!.source).toBe(plain.expected.tables['item']!.source - 1);
    expect(both.expected.tables['biblio']!.source).toBe(plain.expected.tables['biblio']!.source - 2);
    expect(both.expected.tables['mst_item_status']!.source).toBe(plain.expected.tables['mst_item_status']!.source + 2);
    const usageOnly = slimsFixtureBytes(SLIMS_FIXTURE_SEED, { usage: {} });
    expect(both.expected.tables['loan']!.source).toBe(usageOnly.expected.tables['loan']!.source + 2);
  });

  it('expected: the catalogue tables and roles as before, plus the two empty usage tables, not read by the catalogue migration', () => {
    expect(plain.expected.roles.phase3).toEqual(['member', 'loan', 'loan_history', 'visitor_count', 'mst_member_type']);
    expect(plain.expected.tables['visitor_count']).toEqual({ source: 0 });
    expect(plain.expected.tables['mst_member_type']).toEqual({ source: 0 });
    expect(Object.keys(plain.expected.tables)).toEqual(FIXTURE_TABLES.map((t) => t.name));
    for (const table of ['visitor_count', 'mst_member_type', 'member', 'loan', 'loan_history']) expect(slimsTableRole(table), table).toBe('phase3');
    expect(plain.expected.roles.read).not.toContain('visitor_count');
  });

  it('the usage tables and columns are in the dump: the visitor log, the member types, and the new member, loan and history columns', () => {
    const s = sections(plain.dump);
    expect(s.get('visitor_count')).toContain('`checkin_date` datetime NOT NULL');
    expect(s.get('mst_member_type')).toContain('`member_type_name` varchar(50) NOT NULL');
    for (const column of ['member_type_id', 'member_address', 'expire_date']) expect(s.get('member')).toContain(`\`${column}\``);
    for (const column of ['is_lent', 'is_return', 'return_date']) expect(s.get('loan')).toContain(`\`${column}\``);
    for (const column of ['classification', 'member_type_name', 'loan_date']) expect(s.get('loan_history')).toContain(`\`${column}\``);
  });

  it('generateSlimsFixture renders the data a transform returns, and counts its rows', () => {
    const visit: FixtureRow = { visitor_id: 1, member_id: null, member_name: 'Tamu', institution: 'SMP Tetangga', checkin_date: '2025-08-04 08:15:00' };
    const out = generateSlimsFixture(SLIMS_FIXTURE_SEED, {
      transform: (data) => ({ ...data, rows: new Map([...data.rows, ['visitor_count', [visit]]]) }),
    });
    expect(out.expected.tables['visitor_count']).toEqual({ source: 1 });
    expect(sections(out.dump).get('visitor_count')).toContain("INSERT INTO `visitor_count` VALUES (1,NULL,'Tamu','SMP Tetangga','2025-08-04 08:15:00');");
    for (const table of catalogueTables) expect(sections(out.dump).get(table), table).toBe(sections(plain.dump).get(table));
  });
});
