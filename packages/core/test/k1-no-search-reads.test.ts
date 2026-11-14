import fs from 'node:fs';
import path from 'node:path';
import { TABLE_CLASSES } from '@altis/db';
import { describe, expect, it } from 'vitest';

// The reports and the accreditation metrics never read the search index: its tables are volatile (a restore empties
// them and a reindex rebuilds them at any time), so a report or a score read from them would change with the index.
// This test reads every source file under packages/core/src/reports and packages/core/src/accreditation and fails
// when one names a `search_` table, in a query, a string or a comment alike.

const SRC = path.resolve(import.meta.dirname, '../src');
const FOLDERS = ['reports', 'accreditation'] as const;

/** Every `.ts` file under `dir`, recursively, as paths relative to `SRC`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path.relative(SRC, full));
  }
  return out;
}

/** The `search_` table names `text` holds (any identifier that starts with `search_`), in order. */
function searchTablesNamed(text: string): string[] {
  return [...text.matchAll(/(?<![A-Za-z0-9_])search_[A-Za-z0-9_]*/g)].map((m) => m[0]);
}

describe('the reports and the accreditation metrics never read the search index', () => {
  it('the scanner finds a search table named in a query, a string or a comment, and nothing else', () => {
    expect(searchTablesNamed("db.selectFrom('search_doc').select('record_id')")).toEqual(['search_doc']);
    expect(searchTablesNamed('// joins search_term on the record\nconst t = "search_facet";')).toEqual(['search_term', 'search_facet']);
    expect(searchTablesNamed("selectFrom('records').where('research_note', 'is', null); const searchText = 1;")).toEqual([]);
  });

  it('every registered search table is named search_*, so the scanner covers them all', () => {
    const volatileSearch = Object.keys(TABLE_CLASSES).filter((t) => t.startsWith('search'));
    expect(volatileSearch.length).toBeGreaterThan(0);
    for (const table of volatileSearch) expect(searchTablesNamed(table), table).toEqual([table]);
  });

  it.each(FOLDERS)('no file under src/%s names a search_ table', (folder) => {
    const files = sourceFiles(path.join(SRC, folder));
    expect(files.length).toBeGreaterThan(5);
    const found = files.flatMap((file) => searchTablesNamed(fs.readFileSync(path.join(SRC, file), 'utf8')).map((name) => `${file}: ${name}`));
    expect(found).toEqual([]);
  });
});
