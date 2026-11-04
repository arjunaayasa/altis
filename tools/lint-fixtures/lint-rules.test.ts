import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const fixturesDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixturesDir, '../..');
const eslint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, 'eslint.config.js') });

const SERVER_TS = 'apps/server/src/__fixture__.ts';
const FS_RULE = 'altis/no-nonliteral-fs';
const SET_RULE = 'altis/no-set-reads-assigned';
const STREAM_MESSAGE = 'Kysely .stream() needs pg-cursor (L31): page with readPkBatch';

// Rule scope is path-based, so every snippet is linted as if it lived at `virtualPath`.
async function lintCode(code: string, virtualPath = SERVER_TS) {
  const [result] = await eslint.lintText(code, { filePath: virtualPath });
  if (!result) throw new Error(`no lint result for ${virtualPath}`);
  return result.messages;
}

async function lintFixture(name: string, virtualPath = SERVER_TS) {
  return lintCode(readFileSync(resolve(fixturesDir, name), 'utf8'), virtualPath);
}

describe('lint guardrails: one violation per fixture', () => {
  it.each([
    ['uses-fetch.ts', SERVER_TS, 'no-restricted-globals', 'fetch'],
    ['static-sqlite.ts', SERVER_TS, 'no-restricted-imports', "await import('node:sqlite')"],
    ['undici-import.ts', SERVER_TS, 'no-restricted-imports', 'undici'],
    ['sql-raw.ts', SERVER_TS, 'no-restricted-syntax', 'sql.raw'],
    ['inner-html.tsx', 'apps/server/src/__fixture__.tsx', 'no-restricted-syntax', 'sanitizedHtml'],
    ['fs-nonliteral.ts', SERVER_TS, FS_RULE, 'dataPath'],
    ['fs-promises-nonliteral.ts', SERVER_TS, FS_RULE, 'dataPath'],
    ['fs-named-import.ts', SERVER_TS, FS_RULE, 'dataPath'],
    ['fs-renamed-namespace.ts', SERVER_TS, FS_RULE, 'dataPath'],
    ['fs-rename-second-arg.ts', SERVER_TS, FS_RULE, 'dataPath'],
    ['fs-require.cjs', 'apps/server/src/__fixture__.cjs', FS_RULE, 'dataPath'],
    ['path-nonliteral.ts', SERVER_TS, FS_RULE, 'dataPath'],
    ['path-named-import.ts', SERVER_TS, FS_RULE, 'dataPath'],
    ['path-nonliteral-tail.ts', SERVER_TS, FS_RULE, 'dataPath'],
    ['set-reads-assigned.ts', SERVER_TS, SET_RULE, 'UPDATE SET reads a, assigned earlier in the same statement'],
    ['kysely-stream.ts', SERVER_TS, 'no-restricted-syntax', STREAM_MESSAGE],
  ])('%s fires exactly %s', async (fixture, virtualPath, ruleId, fragment) => {
    const messages = await lintFixture(fixture, virtualPath);
    expect(messages.map((m) => m.ruleId)).toEqual([ruleId]);
    expect(messages[0]?.message).toContain(fragment);
  });

  it('clean.ts: literal fs/path arguments, fd calls, type-only and dynamic node:sqlite pass', async () => {
    expect(await lintFixture('clean.ts')).toEqual([]);
  });

  it('local-path-variable.ts: a variable named `path` that was not imported from node:path passes', async () => {
    expect(await lintFixture('local-path-variable.ts')).toEqual([]);
  });

  it('set-reads-own.ts: a value reading its own column, or one assigned later, passes', async () => {
    expect(await lintFixture('set-reads-own.ts')).toEqual([]);
  });

  it('fs-import-equals.ts: `import fs = require(...)` is followed without crashing the rule', async () => {
    const messages = await lintFixture('fs-import-equals.ts');
    expect(messages.filter((m) => m.fatal === true)).toEqual([]);
    // typescript-eslint's recommended no-require-imports objects to the form as well.
    expect(messages.map((m) => m.ruleId).sort()).toEqual(['@typescript-eslint/no-require-imports', FS_RULE]);
    expect(messages.find((m) => m.ruleId === FS_RULE)?.message).toContain('dataPath');
  });
});

describe('lint guardrails: fs/path bindings are followed by import source', () => {
  const flagged: [name: string, code: string, virtualPath?: string][] = [
    ['default import', "import fs from 'node:fs'; declare const p: string; export const c = fs.readFileSync(p);"],
    [
      'named import of promises',
      "import { promises as fsp } from 'node:fs'; declare const p: string; export const c = await fsp.readFile(p);",
    ],
    [
      'fs/promises default import',
      "import fsp from 'node:fs/promises'; declare const p: string; export const c = await fsp.readFile(p);",
    ],
    [
      'bare module specifier',
      "import * as fs from 'fs'; declare const p: string; export const c = fs.readFileSync(p);",
    ],
    [
      'path/posix named import',
      "import { join } from 'node:path/posix'; declare const p: string; export const c = join(p, 'a');",
    ],
    [
      'alias of fs.promises',
      "import * as fs from 'node:fs'; const fsp = fs.promises; declare const p: string; export const c = await fsp.readFile(p);",
    ],
    [
      'destructured from a namespace',
      "import * as fs from 'node:fs'; const { readFileSync } = fs; declare const p: string; export const c = readFileSync(p);",
    ],
    [
      'destructured from require()',
      "const { readFileSync: read } = require('node:fs');\nmodule.exports = read(process.argv[2]);",
      'apps/server/src/__fixture__.cjs',
    ],
    [
      'inline require()',
      "module.exports = require('node:fs').readFileSync(process.argv[2]);",
      'apps/server/src/__fixture__.cjs',
    ],
    [
      'dynamic import()',
      "const fs = await import('node:fs');\nexport const c = fs.readFileSync(process.argv[2]);",
      'apps/server/src/__fixture__.mjs',
    ],
    [
      'template literal with an expression',
      'import * as fs from "node:fs"; declare const d: string; export const c = fs.readFileSync(`${d}/x`);',
    ],
    [
      'path.posix',
      "import * as path from 'node:path'; declare const p: string; export const c = path.posix.join(p, 'a');",
    ],
    [
      'optional call',
      "import * as fs from 'node:fs'; declare const p: string; export const c = fs?.readFileSync(p);",
    ],
    [
      'spread arguments',
      "import * as fs from 'node:fs'; declare const a: [string]; export const c = fs.readFileSync(...a);",
    ],
    [
      'a non-literal later argument of a path function',
      "import * as path from 'node:path'; declare const p: string; export const c = path.join('/srv/public', p);",
    ],
    [
      'a non-literal second argument of path.resolve()',
      "import { resolve } from 'node:path'; declare const p: string; export const c = resolve('a', 'b', p);",
    ],
    [
      'a non-literal argument of path.relative()',
      "import * as path from 'node:path'; declare const p: string; export const c = path.relative('/srv', p);",
    ],
  ];

  it.each(flagged.map(([name, code, path]) => [name, code, path ?? SERVER_TS] as const))(
    'flags %s',
    async (_name, code, virtualPath) => {
      const messages = await lintCode(code, virtualPath);
      expect(messages.map((m) => m.ruleId)).toEqual([FS_RULE]);
    },
  );

  it.each([
    [
      'a local parameter named path',
      'export function f(path: string, x: string) { return path.concat(x); }',
    ],
    [
      'a local object named fs',
      'declare const x: string; const fs = { readFileSync: (p: string) => p }; export const c = fs.readFileSync(x);',
    ],
    [
      'a shadowing local that hides the import',
      "import * as path from 'node:path'; export const f = (x: string) => { const path = { join: (a: string) => a }; return path.join(x); }; export const g = path.sep;",
    ],
    [
      'literal arguments',
      "import { readFileSync } from 'node:fs'; import * as path from 'node:path'; export const c = [readFileSync('a'), path.join('a', 'b')];",
    ],
    [
      'a static template literal',
      'import * as fs from "node:fs"; export const c = fs.readFileSync(`a.txt`);',
    ],
    [
      'a function imported from another module',
      "import { join } from './helpers.js'; declare const p: string; export const c = join(p);",
    ],
    [
      'fd-based calls',
      "import * as fs from 'node:fs'; declare const fd: number; fs.fsyncSync(fd); fs.closeSync(fd); export const c = fs.fstatSync(fd);",
    ],
    [
      'path members that are not calls',
      "import * as path from 'node:path'; export const c = path.sep;",
    ],
    [
      'a method of a value that came from a path call with literals',
      "import * as path from 'node:path'; export const c = path.join('a', 'b').length;",
    ],
    [
      'a path function whose every argument is a literal',
      "import * as path from 'node:path'; export const c = [path.join('/srv', 'public', 'x'), path.resolve('a', `b`)];",
    ],
  ])('accepts %s', async (_name, code) => {
    expect(await lintCode(code)).toEqual([]);
  });

  it('accepts an import alias of a namespace member (`import x = N.y`), which imports no module', async () => {
    const code =
      'namespace N { export const readFileSync = (p: string) => p; }\nimport read = N.readFileSync;\n' +
      'declare const p: string;\nexport const c = read(p);';
    // typescript-eslint's recommended no-namespace objects to the namespace itself; the fs rule must neither fire
    // nor crash.
    expect((await lintCode(code)).map((m) => m.ruleId)).toEqual(['@typescript-eslint/no-namespace']);
  });

  it.each([
    "fs.renameSync(a, 'b')",
    "fs.renameSync('a', b)",
    "fs.copyFileSync('a', b)",
    "fs.cpSync('a', b)",
    "fs.linkSync('a', b)",
    "fs.symlinkSync('a', b)",
    "fs.promises.rename('a', b)",
    "fs.promises.copyFile('a', b)",
    "fs.promises.cp('a', b)",
    "fs.promises.link('a', b)",
    "fs.promises.symlink('a', b)",
  ])('checks every path argument: %s', async (call) => {
    const code = `import * as fs from 'node:fs'; export declare const a: string; export declare const b: string; ${call};`;
    const messages = await lintCode(code);
    expect(messages.map((m) => m.ruleId)).toEqual([FS_RULE]);
  });

  it('reports a call with several non-literal path arguments once', async () => {
    const code =
      "import * as fs from 'node:fs'; export declare const a: string; export declare const b: string; fs.renameSync(a, b);";
    expect(await lintCode(code)).toHaveLength(1);
  });
});

describe('lint guardrails: fs-nonliteral scope', () => {
  it.each([
    'apps/server/src/__fixture__.ts',
    'apps/server/src/cli/__fixture__.ts',
    'apps/server/src/__fixture__.mjs',
    'apps/server/src/__fixture__.js',
    'packages/db/src/__fixture__.ts',
    'packages/db/src/__fixture__.mts',
    'packages/core/src/__fixture__.ts',
    'packages/core/src/auth/__fixture__.ts',
    'apps/admin/src/__fixture__.ts',
    'apps/admin/src/lib/__fixture__.tsx',
  ])('applies to %s', async (virtualPath) => {
    const messages = await lintFixture('fs-nonliteral.ts', virtualPath);
    expect(messages.map((m) => m.ruleId)).toEqual([FS_RULE]);
  });

  it.each([
    'packages/platform/src/atomic.ts',
    'packages/platform/src/datapath.ts',
    'packages/platform/src/rotating-file.ts',
    'packages/crypto/src/__fixture__.ts',
    'packages/core/scripts/gen-common-passwords.ts',
    'tools/release/src/__fixture__.ts',
    // The admin build script writes apps/admin/.build/inputs.json (S21).
    'apps/admin/vite.config.ts',
  ])('does not apply to %s', async (virtualPath) => {
    expect(await lintFixture('fs-nonliteral.ts', virtualPath)).toEqual([]);
    expect(await lintFixture('fs-named-import.ts', virtualPath)).toEqual([]);
    expect(await lintFixture('path-nonliteral.ts', virtualPath)).toEqual([]);
  });

  it.each([
    'apps/server/test/__fixture__.test.ts',
    'apps/server/src/__fixture__.test.ts',
    'packages/db/test/__fixture__.test.ts',
    'packages/db/test/helpers/__fixture__.ts',
    'packages/core/test/__fixture__.test.ts',
  ])('does not apply to test code in %s', async (virtualPath) => {
    expect(await lintFixture('fs-nonliteral.ts', virtualPath)).toEqual([]);
  });

  it('keeps the other restrictions active in files outside the fs scope', async () => {
    const messages = await lintFixture('sql-raw.ts', 'packages/platform/src/atomic.ts');
    expect(messages.map((m) => m.ruleId)).toEqual(['no-restricted-syntax']);
    expect(messages[0]?.message).toContain('sql.raw');
  });

  it('keeps the other restrictions active in test code', async () => {
    const messages = await lintFixture('sql-raw.ts', 'apps/server/test/__fixture__.test.ts');
    expect(messages.map((m) => m.ruleId)).toEqual(['no-restricted-syntax']);
  });
});

describe('lint guardrails: the admin SPA (apps/admin)', () => {
  it('may call fetch: it reaches its own server, and P18 is about the server\'s outbound connections', async () => {
    expect(await lintFixture('uses-fetch.ts', 'apps/admin/src/lib/__fixture__.ts')).toEqual([]);
  });

  it('has browser globals', async () => {
    expect(await lintCode('export const here = window.location.pathname + document.title;', 'apps/admin/src/__fixture__.ts')).toEqual([]);
  });

  it.each([
    ['inner-html.tsx', 'apps/admin/src/components/__fixture__.tsx', 'no-restricted-syntax'],
    ['sql-raw.ts', 'apps/admin/src/__fixture__.ts', 'no-restricted-syntax'],
    ['static-sqlite.ts', 'apps/admin/src/__fixture__.ts', 'no-restricted-imports'],
  ])('keeps the other restrictions: %s', async (fixture, virtualPath, ruleId) => {
    const messages = await lintFixture(fixture, virtualPath);
    expect(messages.map((m) => m.ruleId)).toEqual([ruleId]);
  });

  it('the server keeps the fetch ban', async () => {
    const messages = await lintFixture('uses-fetch.ts', 'apps/server/src/__fixture__.ts');
    expect(messages.map((m) => m.ruleId)).toEqual(['no-restricted-globals']);
  });
});

describe('lint guardrails: bypass hardening', () => {
  it.each([
    ['globalThis.fetch call', "export const r = globalThis.fetch('https://x');", 'no-restricted-properties'],
    ['globalThis["fetch"] access', "export const r = globalThis['fetch'];", 'no-restricted-properties'],
    ['undici subpath import', "import { request } from 'undici/lib/api';\nexport const r = request;", 'no-restricted-imports'],
    ['export-from node:sqlite', "export { DatabaseSync } from 'node:sqlite';", 'no-restricted-imports'],
    ['sql.raw without a call', "import { sql } from 'kysely';\nexport const r = sql.raw;", 'no-restricted-syntax'],
    ['sql["raw"] call', "import { sql } from 'kysely';\nexport const r = sql['raw']('x');", 'no-restricted-syntax'],
    [
      'aliased sql import',
      "import { sql as q } from 'kysely';\nexport const r = q.raw('x');",
      'no-restricted-syntax',
    ],
    [
      'sql through a namespace import',
      "import * as kysely from 'kysely';\nexport const r = kysely.sql.raw('x');",
      'no-restricted-syntax',
    ],
    [
      'dangerouslySetInnerHTML as a string key',
      "export const props = { 'dangerouslySetInnerHTML': { __html: '<b>x</b>' } };",
      'no-restricted-syntax',
    ],
    [
      'dangerouslySetInnerHTML as a computed key',
      "export const props = { ['dangerouslySetInnerHTML']: { __html: '<b>x</b>' } };",
      'no-restricted-syntax',
    ],
    [
      'dangerouslySetInnerHTML as an identifier key',
      "export const props = { dangerouslySetInnerHTML: { __html: '<b>x</b>' } };",
      'no-restricted-syntax',
    ],
  ])('flags %s', async (_name, code, ruleId) => {
    const messages = await lintCode(code);
    expect(messages.map((m) => m.ruleId)).toEqual([ruleId]);
  });

  it('accepts the permitted kysely forms', async () => {
    const code = "import { sql } from 'kysely';\nexport const r = [sql`select 1`, sql.id('t'), sql.lit(1)];";
    expect(await lintCode(code)).toEqual([]);
  });

  it.each(['apps/server/src/__fixture__.js', 'apps/server/src/__fixture__.mjs', 'packages/bootloader/src/__fixture__.cjs'])(
    'applies the global restrictions to %s',
    async (virtualPath) => {
      const messages = await lintCode("export const r = await fetch('https://x');", virtualPath);
      expect(messages.map((m) => m.ruleId)).toEqual(['no-restricted-globals']);
    },
  );

  it('lints CommonJS sources: require() and node globals are accepted', async () => {
    const code = "const os = require('node:os');\nmodule.exports = os.platform() + process.version;\n";
    expect(await lintCode(code, 'packages/bootloader/src/__fixture__.cjs')).toEqual([]);
  });
});

describe('lint guardrails: altis/no-set-reads-assigned (spec §6.2)', () => {
  // `.set()` values are checked in the order of the properties: MySQL evaluates SET left to right, so a value that
  // reads a column an earlier property assigned sees the new value there, and the old one on the other dialects.
  // The snippets use free identifiers (db, eb, sql, ...): the rule goes by names, and the lint is not type-aware.
  const MESSAGE = (column: string) =>
    `UPDATE SET reads ${column}, assigned earlier in the same statement (MySQL evaluates left to right)`;

  const update = (set: string) => `export const q = db.updateTable('t')${set};\n`;

  const flagged: [name: string, set: string, columns: string[]][] = [
    ['sql.ref of an earlier column', ".set({ a: 1, b: sql`${sql.ref('a')} + 1` })", ['a']],
    ['eb.ref of an earlier column', ".set({ a: 1, b: eb.ref('a') })", ['a']],
    ['a column string passed to eb()', ".set({ a: 1, b: eb('a', '+', 1) })", ['a']],
    ['sql.id of an earlier column', ".set({ a: 1, b: sql`${sql.id('a')} + 1` })", ['a']],
    ['the expression builder of the callback form', ".set((x) => ({ a: 1, b: x.ref('a') }))", ['a']],
    ['the callback parameter called as a function', ".set((x) => ({ a: 1, b: x('a', '+', 1) }))", ['a']],
    ['a block-bodied callback', ".set((x) => { return { a: 1, b: x.ref('a') }; })", ['a']],
    ['a reference nested in a larger expression', ".set({ a: 1, b: eb('b', '+', eb.ref('a')) })", ['a']],
    ['a qualified reference', ".set({ a: 1, b: sql.ref('t.a') })", ['a']],
    ['a string-literal key', ".set({ 'a': 1, b: eb.ref('a') })", ['a']],
    ['a computed literal key', ".set({ ['a']: 1, b: eb.ref('a') })", ['a']],
    ['a value that is itself a column reference', ".set({ a: eb.ref('c'), b: eb.ref('a') })", ['a']],
    [
      'every offending reference, once each',
      ".set({ a: 1, b: eb.ref('a'), c: sql`${sql.ref('a')} + ${sql.ref('b')}` })",
      ['a', 'a', 'b'],
    ],
    ['an earlier .set() of the same statement', ".set({ a: 1 }).where('id', '=', 1).set({ b: eb.ref('a') })", ['a']],
  ];

  it.each(flagged)('flags %s', async (_name, set, columns) => {
    const messages = await lintCode(update(set));
    expect(messages.map((m) => [m.ruleId, m.message])).toEqual(columns.map((c) => [SET_RULE, MESSAGE(c)]));
  });

  const accepted: [name: string, set: string][] = [
    ['a value reading its own column', ".set({ count: sql`${sql.ref('count')} + 1` })"],
    ['a read of a column assigned later', ".set({ a: eb.ref('b'), b: 2 })"],
    ['a read of a column that is not assigned', ".set({ a: 1, b: eb.ref('c') })"],
    ['values without column references', ".set({ a: 1, b: sql`now()` })"],
    ['a reference with a non-literal name', '.set({ a: 1, b: sql.ref(name) })'],
    ['a spread (its columns are unknown)', ".set({ ...patch, b: eb.ref('a') })"],
    ['a computed key (its column is unknown)', ".set({ [column]: 1, b: eb.ref('a') })"],
    ['an object built elsewhere', '.set(patch)'],
    ['the (column, value) form', ".set('a', eb.ref('a'))"],
    ['a method called ref of an unrelated object', ".set({ a: 1, b: other.ref('a') })"],
    ['a callback that returns something else', '.set((x) => patch(x))'],
    ['an earlier .set() that assigns other columns', ".set({ c: 1 }).set({ b: eb.ref('a') })"],
  ];

  it.each(accepted)('accepts %s', async (_name, set) => {
    expect(await lintCode(update(set))).toEqual([]);
  });

  it('ignores .set() calls that are not an UPDATE (a Map, Headers)', async () => {
    const code =
      "declare const m: Map<string, unknown>;\ndeclare const h: Headers;\n" +
      "m.set('a', 1).set('b', m.get('a'));\nh.set('a', 'x');\nnew Map().set({ a: 1 }, { b: 2 });\n";
    expect(await lintCode(code)).toEqual([]);
  });

  it.each([
    'apps/server/src/__fixture__.ts',
    'apps/server/test/__fixture__.test.ts',
    'packages/db/src/__fixture__.ts',
    'packages/db/test/__fixture__.test.ts',
    'packages/core/src/__fixture__.ts',
    'packages/core/test/__fixture__.test.ts',
    'packages/core/scripts/__fixture__.ts',
    'packages/platform/src/__fixture__.ts',
  ])('applies to %s (test code included)', async (virtualPath) => {
    const messages = await lintFixture('set-reads-assigned.ts', virtualPath);
    expect(messages.map((m) => m.ruleId)).toEqual([SET_RULE]);
  });

  it.each(['apps/admin/src/__fixture__.ts', 'tools/release/src/__fixture__.ts'])(
    'does not apply to %s',
    async (virtualPath) => {
      expect(await lintFixture('set-reads-assigned.ts', virtualPath)).toEqual([]);
    },
  );
});

describe('lint guardrails: no Kysely .stream() (L31)', () => {
  it('kysely-stream.ts: exactly one error, with the message', async () => {
    const messages = await lintFixture('kysely-stream.ts');
    expect(messages.map((m) => [m.ruleId, m.message])).toEqual([['no-restricted-syntax', STREAM_MESSAGE]]);
  });

  it.each([
    ['a select with a chunk size', "export const r = trx.selectFrom('t').select('a').where('a', '>', 1).orderBy('a').stream(100);"],
    ['a CTE', "export const r = db.with('c', (q) => q.selectFrom('t').selectAll()).selectFrom('c').selectAll().stream();"],
    ['selectNoFrom', "export const r = db.selectNoFrom((eb) => eb.val(1).as('one')).stream();"],
    ['an UPDATE ... RETURNING', "export const r = db.updateTable('t').set({ a: 1 }).returningAll().stream();"],
    ['a DELETE ... RETURNING', "export const r = db.deleteFrom('t').where('a', '=', 1).returningAll().stream();"],
    ['an INSERT ... RETURNING', "export const r = db.insertInto('t').values({ a: 1 }).returningAll().stream();"],
  ])('flags %s', async (_name, code) => {
    const messages = await lintCode(code, 'packages/core/src/__fixture__.ts');
    expect(messages.map((m) => [m.ruleId, m.message])).toEqual([['no-restricted-syntax', STREAM_MESSAGE]]);
  });

  it.each([
    ['a File or Blob', 'declare const file: File;\nexport const r = [file.stream(), new Blob([]).stream(), file.slice(0, 1).stream()];'],
    ['a response body', "declare const res: Response;\nexport const r = res.clone().blob().then((b) => b.stream());"],
    ['a Kysely query that is executed', "export const r = db.selectFrom('t').selectAll().execute();"],
    ['a query passed as an argument of .stream()', "export const r = blob.stream(db.selectFrom('t').selectAll());"],
    [
      'a query kept in a variable first (the lint is not type-aware: only a chain from the query starter is seen)',
      "const q = db.selectFrom('t').selectAll();\nexport const r = q.where('a', '=', 1).stream();",
    ],
  ])('accepts %s', async (_name, code) => {
    expect(await lintCode(code, 'packages/core/src/__fixture__.ts')).toEqual([]);
  });

  it('applies to test code too', async () => {
    const messages = await lintFixture('kysely-stream.ts', 'packages/db/test/__fixture__.test.ts');
    expect(messages.map((m) => m.ruleId)).toEqual(['no-restricted-syntax']);
  });
});

// ---- Phase 2 (catalog): Task 3 (S6) ----
describe('lint guardrails: raw HTML from hono/html only in the OPAC page frame and the 1c operations page', () => {
  const RAW = "import { raw } from 'hono/html';\nexport const r = raw('<b>x</b>');";

  it.each([
    ['raw from hono/html', RAW, 'apps/server/src/opac/catalog/views/page.tsx'],
    ['html from hono/html', "import { html } from 'hono/html';\nexport const r = html`<b>${'x'}</b>`;", 'apps/server/src/opac/catalog/home.tsx'],
    ['raw under another name', "import { raw as asIs } from 'hono/html';\nexport const r = asIs('x');", 'apps/server/src/opac/layout.tsx'],
    ['raw from hono/utils/html', "import { raw } from 'hono/utils/html';\nexport const r = raw('x');", 'apps/server/src/api/catalog/x.ts'],
    ['raw in core', RAW, 'packages/core/src/__fixture__.ts'],
    ['raw in a test', RAW, 'apps/server/test/__fixture__.test.ts'],
  ])('flags %s', async (_name, code, virtualPath) => {
    const messages = await lintCode(code, virtualPath);
    expect(messages.map((m) => m.ruleId)).toEqual(['no-restricted-imports']);
    expect(messages[0]?.message).toContain('safeHtml()');
  });

  it.each(['apps/server/src/opac/catalog/page.tsx', 'apps/server/src/ops/update-page.tsx'])('accepts raw in %s', async (virtualPath) => {
    expect(await lintCode(RAW, virtualPath)).toEqual([]);
  });

  it('the two exempt files keep the other import restrictions', async () => {
    const code = "import { DatabaseSync } from 'node:sqlite';\nexport const d = DatabaseSync;";
    const messages = await lintCode(code, 'apps/server/src/opac/catalog/page.tsx');
    expect(messages.map((m) => m.ruleId)).toEqual(['no-restricted-imports']);
    expect(messages[0]?.message).toContain("await import('node:sqlite')");
  });

  it('the other names of hono/utils/html stay allowed (a type emits no markup)', async () => {
    const code = "import type { HtmlEscapedString } from 'hono/utils/html';\nexport type H = HtmlEscapedString;";
    expect(await lintCode(code, 'apps/server/src/x.ts')).toEqual([]);
  });
});
