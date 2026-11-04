import { describe, expect, it } from 'vitest';
import { SLIMS_COLUMNS, detectSlimsVersion, slimsTableRole } from '../../src/migration/slims/source/detect.js';
import { createSqlDumpParser } from '../../src/migration/slims/source/sql-dump.js';
import type { SlimsTableInfo } from '../../src/migration/slims/source/types.js';
import { slimsFixtureBytes } from '../support/slims-fixture/index.js';

// The version a SLiMS source looks like (spec §11.1: by its core tables and columns, not a version number).

/** A SLiMS 9.8 source as `tables()` would list it, with `change` applied. */
function source(change: (t: Map<string, SlimsTableInfo>) => void = () => {}): SlimsTableInfo[] {
  const tables = new Map<string, SlimsTableInfo>();
  for (const [name, columns] of Object.entries(SLIMS_COLUMNS)) tables.set(name, { name, columns: [...columns], primaryKey: [], rows: 0 });
  tables.set('loan_history', { name: 'loan_history', columns: ['loan_id'], primaryKey: ['loan_id'], rows: 0 });
  change(tables);
  return [...tables.values()];
}

describe('detectSlimsVersion', () => {
  it('recognises the synthetic SLiMS 9 fixture', () => {
    const parser = createSqlDumpParser();
    const tables = new Map<string, SlimsTableInfo>();
    const { dump } = slimsFixtureBytes();
    for (const e of [...parser.push(dump.toString('latin1')), ...parser.end()]) {
      if (e.type === 'create') tables.set(e.table, { name: e.table, columns: e.columns, primaryKey: e.primaryKey, rows: null });
    }
    expect(detectSlimsVersion([...tables.values()])).toEqual({ version: '9', missing: [], unknownColumns: {} });
  });

  it('tells SLiMS 9 from SLiMS 8 and from older or foreign databases', () => {
    expect(detectSlimsVersion(source())).toEqual({ version: '9', missing: [], unknownColumns: {} });
    const eight = source((t) => {
      for (const name of ['loan_history', 'mst_custom_field', 'files_read', 'item_custom']) t.delete(name);
    });
    expect(detectSlimsVersion(eight)).toEqual({ version: '8', missing: ['files_read', 'item_custom', 'mst_custom_field'], unknownColumns: {} });
    const senayan = source((t) => {
      for (const name of ['loan_history', 'mst_custom_field', 'files_read', 'biblio_relation', 'mst_voc_ctrl']) t.delete(name);
      t.get('biblio')!.columns = t.get('biblio')!.columns.filter((c) => !c.endsWith('_type_id'));
    });
    expect(detectSlimsVersion(senayan).version).toBe('unknown');
    const foreign = detectSlimsVersion([{ name: 'wp_posts', columns: ['ID'], primaryKey: ['ID'], rows: 1 }]);
    expect(foreign.version).toBe('unknown');
    expect(foreign.missing.slice(0, 2)).toEqual(['biblio', 'item']);
  });

  it('lists the tables it reads that a SLiMS 9 source lacks', () => {
    const early = source((t) => t.delete('item_custom'));
    expect(detectSlimsVersion(early)).toEqual({ version: '9', missing: ['item_custom'], unknownColumns: {} });
  });

  it('lists the columns it does not know, a custom field column excepted', () => {
    const tables = source((t) => {
      t.get('biblio')!.columns.push('update_date');
      t.get('biblio_custom')!.columns.push('cf_abc12', 'cf_x', 'notes_extra');
      t.get('item_custom')!.columns.push('cf_9c8d7');
      t.get('mst_author')!.columns.push('cf_00001');
    });
    expect(detectSlimsVersion(tables).unknownColumns).toEqual({ biblio: ['update_date'], biblio_custom: ['notes_extra'], mst_author: ['cf_00001'] });
  });
});

describe('slimsTableRole', () => {
  it.each([
    ['biblio', 'read'],
    ['biblio_log', 'read'],
    ['mst_item_status', 'read'],
    ['member', 'phase3'],
    ['member_custom', 'phase3'],
    ['loan_history', 'phase3'],
    ['group_access', 'phase3'],
    ['user', 'phase3'],
    ['search_biblio', 'derived'],
    ['index_words', 'derived'],
    ['read_counter', 'other'],
  ])('%s → %s', (table, role) => {
    expect(slimsTableRole(table)).toBe(role);
  });
});
