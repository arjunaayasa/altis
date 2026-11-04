import { createRequire } from 'node:module';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import noNonLiteralFs from './tools/eslint-rules/no-nonliteral-fs.js';
import noSetReadsAssigned from './tools/eslint-rules/no-set-reads-assigned.js';

// ---------------------------------------------------------------------------
// Guardrails (spec §4.2, §4.3, §7.4, §7.5 and the Global Constraints).
// Every restriction is covered by a fixture or a snippet in tools/lint-fixtures/lint-rules.test.ts.
// ---------------------------------------------------------------------------

const SOURCE_FILES = ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'];

// ESLint's own parser. It is not a direct dependency (and typescript-eslint's parser accepts any syntax whatever
// `ecmaVersion` says), so resolve it from where ESLint is installed.
const espree = createRequire(createRequire(import.meta.url).resolve('eslint'))('espree');

// The one `altis` plugin object: flat config refuses a second, different definition of a plugin name, so every
// block that uses an altis/* rule takes it from here.
const altisPlugin = {
  rules: { 'no-nonliteral-fs': noNonLiteralFs, 'no-set-reads-assigned': noSetReadsAssigned },
};

const FETCH_MESSAGE ='Global fetch is forbidden for outbound connections (P18). Use node:http/node:https.';
const UNDICI_MESSAGE = 'undici is forbidden for outbound connections (P18). Use node:http/node:https.';
const SQL_RAW_MESSAGE =
  'sql.raw is forbidden: build queries with parameterized Kysely, or use a registered SQL helper (spec §7.4).';
const INNER_HTML_MESSAGE =
  'dangerouslySetInnerHTML is forbidden: raw HTML may only go through sanitizedHtml() (spec §7.4).';
const STREAM_MESSAGE = 'Kysely .stream() needs pg-cursor (L31): page with readPkBatch';
const HTML_RAW_MESSAGE =
  'Raw HTML from hono/html is forbidden (Phase 2, S6): put sanitized HTML on an OPAC page with safeHtml() and JSON-LD with ' +
  'jsonLdScript() (apps/server/src/opac/catalog/page.tsx); everything else is text, which JSX escapes.';

/** `no-restricted-imports` paths for every source file. */
const RESTRICTED_IMPORT_PATHS = [
  {
    name: 'node:sqlite',
    allowTypeImports: true,
    message: "node:sqlite is loaded only through await import('node:sqlite') (spec §4.3).",
  },
  { name: 'undici', message: UNDICI_MESSAGE },
];
const RESTRICTED_IMPORT_PATTERNS = [{ group: ['undici/*'], message: UNDICI_MESSAGE }];

/**
 * Phase 2 Task 3 (S6): hono's raw-HTML helpers, allowed only in the two files that own raw output
 * ({@link RAW_HTML_FILES}).
 */
const RAW_HTML_IMPORT_PATHS = [
  { name: 'hono/html', importNames: ['raw', 'html'], message: HTML_RAW_MESSAGE },
  { name: 'hono/utils/html', importNames: ['raw'], message: HTML_RAW_MESSAGE },
];

/** The files that may import hono's `raw`/`html`: the OPAC page frame (S6) and the 1c operations page. */
const RAW_HTML_FILES = ['apps/server/src/opac/catalog/page.tsx', 'apps/server/src/ops/update-page.tsx'];

/** A call of a Kysely query starter: `selectFrom(...)`, `with(...)`, ... */
const KYSELY_QUERY_CALL =
  "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(selectFrom|selectNoFrom|with|updateTable|deleteFrom|insertInto)$/]";

/**
 * The receiver of a `.stream(...)` call when it is a Kysely query chain: a call that is itself a query starter or has
 * one inside it (`db.selectFrom('t').selectAll().stream()`). `file.stream()` has no such call; the lint is not
 * type-aware, so a query first kept in a variable is not recognized.
 */
const KYSELY_STREAM =
  "CallExpression > MemberExpression.callee[computed=false][property.name='stream'] > CallExpression.object" +
  `:matches(${KYSELY_QUERY_CALL}, :has(${KYSELY_QUERY_CALL}))`;

/** `<object>.raw` and `<object>['raw']`, called or not. */
const rawAccess = (object) =>
  `MemberExpression${object}:matches([computed=false][property.name='raw'], [computed=true][property.value='raw'])`;

/** `no-restricted-syntax` selectors for every source file. */
const SYNTAX_RESTRICTIONS = [
  { selector: rawAccess("[object.name='sql']"), message: SQL_RAW_MESSAGE },
  // kysely.sql.raw(...) through a namespace import
  { selector: rawAccess("[object.type='MemberExpression'][object.property.name='sql']"), message: SQL_RAW_MESSAGE },
  {
    // `import { sql as q } from 'kysely'` would hide q.raw from the selectors above.
    selector: "ImportDeclaration[source.value='kysely'] > ImportSpecifier[imported.name='sql'][local.name!='sql']",
    message: `Import sql from kysely under its own name so that sql.raw stays detectable. ${SQL_RAW_MESSAGE}`,
  },
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: INNER_HTML_MESSAGE },
  { selector: "Property[computed=false][key.name='dangerouslySetInnerHTML']", message: INNER_HTML_MESSAGE },
  { selector: "Property[key.value='dangerouslySetInnerHTML']", message: INNER_HTML_MESSAGE },
  // L31: Kysely's PostgreSQL .stream() needs pg-cursor, which is not wired; large reads page with readPkBatch.
  { selector: KYSELY_STREAM, message: STREAM_MESSAGE },
];

export default defineConfig(
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    // Build byproducts (apps/admin/.build: tsc declarations and the bundle's inputs.json).
    '**/.build/**',
    // Agent worktrees: other checkouts of this repository, linted in their own right.
    '.claude/**',
    // Fixtures hold deliberate violations; lint-rules.test.ts lints their text under virtual paths.
    'tools/lint-fixtures/*.{ts,tsx,js,mjs,cjs}',
    '!tools/lint-fixtures/*.test.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // CommonJS sources (the passenger shim) legitimately use require().
    files: ['**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // The passenger-sim worker shim is plain CommonJS with ES2017 syntax (no `??`, no `?.`), like app.js. Covered by
    // tools/release/passenger-sim/test/sim.test.ts.
    files: ['tools/release/passenger-sim/shim.cjs'],
    languageOptions: {
      parser: espree,
      ecmaVersion: 2017,
      sourceType: 'commonjs',
      globals: { globalThis: 'readonly' },
    },
  },
  {
    files: SOURCE_FILES,
    rules: {
      // P18: no global fetch/undici for outbound connections.
      'no-restricted-globals': ['error', { name: 'fetch', message: FETCH_MESSAGE }],
      'no-restricted-properties': [
        'error',
        { object: 'globalThis', property: 'fetch', message: FETCH_MESSAGE },
        { object: 'global', property: 'fetch', message: FETCH_MESSAGE },
      ],
      'no-restricted-imports': [
        'error',
        { paths: [...RESTRICTED_IMPORT_PATHS, ...RAW_HTML_IMPORT_PATHS], patterns: RESTRICTED_IMPORT_PATTERNS },
      ],
      'no-restricted-syntax': ['error', ...SYNTAX_RESTRICTIONS],
    },
  },
  {
    // Phase 2 Task 3 (S6): the two files that own raw HTML output keep every other import restriction.
    files: RAW_HTML_FILES,
    rules: {
      'no-restricted-imports': ['error', { paths: RESTRICTED_IMPORT_PATHS, patterns: RESTRICTED_IMPORT_PATTERNS }],
    },
  },
  {
    // `fs-nonliteral` (spec §7.5). packages/platform/** holds the fs/path helpers and is intentionally
    // out of scope; test code needs temp-dir paths and is exempt. packages/core/src/** is in scope (Phase 1b),
    // packages/core/scripts/** (generators that read and write the data files) is not.
    files: [
      'apps/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
      'packages/db/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
      'packages/core/src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}',
    ],
    // apps/admin/vite.config.ts is a build script, not app code: it writes apps/admin/.build/inputs.json (S21).
    ignores: ['**/test/**', '**/*.test.{js,jsx,mjs,cjs,ts,tsx,mts,cts}', 'apps/admin/vite.config.ts'],
    plugins: { altis: altisPlugin },
    rules: { 'altis/no-nonliteral-fs': 'error' },
  },
  {
    // The admin SPA runs in the browser: browser globals, and `fetch` is how it reaches its own server (/api/v1). P18
    // forbids global fetch for the server's outbound connections, which the SPA never makes. Its other restrictions
    // (dangerouslySetInnerHTML, sql.raw, node:sqlite, the fs rule outside vite.config.ts) stay.
    files: ['apps/admin/**/*.{js,jsx,mjs,ts,tsx,mts}'],
    ignores: ['apps/admin/vite.config.ts'],
    languageOptions: { globals: globals.browser },
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    // `set-reads-assigned` (spec §6.2): UPDATE statements are built in the packages and in the server, and test
    // code runs them on every dialect, so it is held to the same rule.
    files: ['packages/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}', 'apps/server/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
    plugins: { altis: altisPlugin },
    rules: { 'altis/no-set-reads-assigned': 'error' },
  },
);
