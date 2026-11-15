import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

// The barrels of @altis/core (Phase 2 Task 3, preflight M14). `src/index.ts` joins each area's barrel with
// `export * from`, and `export *` silently drops a name two of them export (ESM leaves an ambiguous name out, and tsc
// reports TS2308 only once both sides are merged), as it drops a barrel's name that src/index.ts also exports by name.
// So every barrel that src/index.ts joins is read here, and one exported name in two places fails: two parallel tasks
// that both add `tokenize` find out in their own worktree, not at the merge. A generic name carries its module's prefix
// (`searchTokenize`, `htmlTokenize`); helpers stay out of the barrels.

const SRC = new URL('../src/', import.meta.url);
const INDEX_TEXT = readFileSync(new URL('index.ts', SRC), 'utf8');

/** The specifier of every `export * from '<x>'` of `text`. */
function starSpecifiers(text: string): string[] {
  return [...text.matchAll(/^export \* from '([^']+)';/gm)].map((m) => m[1]!);
}

/** `<name>` or `<name> as <alias>`, with an optional `type ` prefix: the exported name. */
function exportedName(entry: string): string | null {
  const words = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
  const name = (words[1] ?? words[0] ?? '').trim();
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
}

/**
 * The names a module's text exports by itself (`export {…}` lists, with or without `from`, `export type {…}`,
 * declarations), without following `export *`: the type-only names, which an import at run time cannot see.
 */
function namedExports(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    const list = m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const entry of list.split(',')) {
      const name = exportedName(entry);
      if (name !== null) names.push(name);
    }
  }
  const declaration = /^export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of text.matchAll(declaration)) names.push(m[1]!);
  for (const m of text.matchAll(/^export \* as ([A-Za-z_$][\w$]*) from/gm)) names.push(m[1]!);
  return names;
}

/** `rel` (a `./x/index.js` specifier) resolved against the folder URL `from`, as the TypeScript source file. */
function sourceUrl(rel: string, from: URL): URL {
  return new URL(rel.replace(/\.js$/, '.ts'), from);
}

/** Every name the barrel at `url` exports: its values (imported) and its type names (read), barrels below included. */
async function barrelNames(url: URL): Promise<{ values: Record<string, unknown>; names: Set<string> }> {
  const values = (await import(url.href)) as Record<string, unknown>;
  const names = new Set(Object.keys(values));
  const visit = (file: URL, seen: Set<string>): void => {
    if (seen.has(file.href)) return;
    seen.add(file.href);
    const text = readFileSync(file, 'utf8');
    for (const name of namedExports(text)) names.add(name);
    for (const rel of starSpecifiers(text)) if (rel.startsWith('.')) visit(sourceUrl(rel, file), seen);
  };
  visit(url, new Set());
  return { values, names };
}

/** Each name found in more than one of `sets`, with the sets that hold it. */
function duplicates(sets: ReadonlyMap<string, ReadonlySet<string>>): Record<string, string[]> {
  const holders = new Map<string, string[]>();
  for (const [where, names] of sets) for (const name of names) holders.set(name, [...(holders.get(name) ?? []), where]);
  return Object.fromEntries([...holders].filter(([, list]) => list.length > 1));
}

describe('the barrels of @altis/core (M14)', () => {
  const barrels = starSpecifiers(INDEX_TEXT);

  it('src/index.ts joins the Phase 2 barrels of Task 3 with export *', () => {
    for (const b of [
      './catalog/index.js',
      './search/index.js',
      './marc/index.js',
      './print/index.js',
      './html/index.js',
      './net/index.js',
      './migration/index.js',
      './opac-pages/index.js',
    ]) {
      expect(barrels, b).toContain(b);
    }
  });

  // ---- Komunitas K1 (reports and accreditation) ----
  it('src/index.ts joins the reports and accreditation barrels, then members and circulation, then visits and the member tools, then stocktake, with export *, at its end', () => {
    expect(barrels.slice(-7)).toEqual([
      './reports/index.js',
      './accreditation/index.js',
      './members/index.js',
      './circulation/index.js',
      './visits/index.js',
      './members/ext/index.js',
      './stocktake/index.js',
    ]);
  });

  it('catalog/index.ts joins every catalog area barrel, and neither data/ (Task 1) nor lib/ (Task 5)', () => {
    const text = readFileSync(new URL('catalog/index.ts', SRC), 'utf8');
    const areas = starSpecifiers(text);
    for (const area of ['masters', 'authorities', 'locations', 'records', 'items', 'attachments', 'runs', 'csv', 'render', 'exchange', 'copy', 'labels']) {
      expect(areas, area).toContain(`./${area}/index.js`);
    }
    expect(text).not.toMatch(/from '\.\/(?:data|lib)\//);
  });

  it('the duplicate check finds a name two barrels export (a self-test)', () => {
    const sets = new Map([
      ['./a/index.js', new Set(['tokenize', 'parseA'])],
      ['./b/index.js', new Set(['tokenize', 'parseB'])],
      ['src/index.ts', new Set(['parseB'])],
    ]);
    expect(duplicates(sets)).toEqual({ tokenize: ['./a/index.js', './b/index.js'], parseB: ['./b/index.js', 'src/index.ts'] });
    expect(namedExports("export { a, type B as C } from './x.js';\nexport type { D } from './y.js';\nexport interface E {}\nexport const f = 1;")).toEqual([
      'a',
      'C',
      'D',
      'E',
      'f',
    ]);
  });

  it('no name is exported by two barrels, nor by a barrel and src/index.ts itself', async () => {
    const sets = new Map<string, ReadonlySet<string>>();
    for (const b of barrels) sets.set(b, (await barrelNames(sourceUrl(b, SRC))).names);
    sets.set('src/index.ts (by name)', new Set(namedExports(INDEX_TEXT)));
    expect(duplicates(sets)).toEqual({});
  });

  it('every value a barrel exports reaches @altis/core as that very value', async () => {
    const lost: string[] = [];
    for (const b of barrels) {
      const { values } = await barrelNames(sourceUrl(b, SRC));
      for (const [name, value] of Object.entries(values)) {
        if ((core as Record<string, unknown>)[name] !== value) lost.push(`${b}: ${name}`);
      }
    }
    expect(lost).toEqual([]);
  });
});
