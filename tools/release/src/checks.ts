import fsp from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import * as acorn from 'acorn';

// The release guards (spec §4.2, §4.3, §7.10, §8.3; Task 17 rulings). Each one throws `Error('<CODE>:<subject> …')`.
//
// - Licences: only packages actually bundled into server.mjs or app.js count (esbuild metafile inputs mapped to their
//   package through node_modules/<name>/package.json); devDependencies never reach a bundle, so never count. A
//   package's SPDX expression must be satisfiable with the allowlist: OR needs one allowed side, AND needs both; a
//   WITH exception, an unknown identifier, `SEE LICENSE IN …`, `UNLICENSED` or no licence at all is refused.
//   The only way around the allowlist is LICENSE_ALLOWANCES: a package reviewed by hand, by exact name, version and
//   licence (the UI typeface under the SIL Open Font License).
// - Native modules: no `.node` file among the bundle inputs.
// - Self-contained bundles: at run time server.mjs and app.js load node built-ins only (no relative or bare
//   specifier: node_modules lookup from the release folder would walk up into the app folder, DATA_DIR or $HOME).
//   The specifiers come from the esbuild metafile and, read from the finished bundles themselves, from
//   scanRuntimeImports (Phase 1b: a bundled mail library is the first with optional `require`s of its own).
// - Production hygiene: no test hook (`ALTIS_TEST_`), no test-only permission (`test.branch.manage`), none of the
//   release fixtures' migrations or their table (`9001_test_expand`, `9002_test_contract`, `test_fixture`; decision
//   D1d-26) and no dev key material in any shipped file (the needles: build.ts PRODUCTION_LEAK_NEEDLES).

/**
 * SPDX identifiers a bundled package may be licensed under (ruling: MIT/BSD/Apache/ISC and equivalents; MIT-0, "MIT No
 * Attribution", since Phase 1b, decision D17: it is MIT without the notice condition, which nodemailer uses).
 */
export const LICENSE_ALLOWLIST: readonly string[] = Object.freeze([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'Unlicense',
  'CC0-1.0',
]);

/**
 * A package admitted under a licence that is not on {@link LICENSE_ALLOWLIST}, reviewed by hand: that exact name,
 * version and declared licence only. Another version, or another licence, is refused again.
 */
export interface LicenseAllowance {
  name: string;
  version: string;
  license: string;
}

/**
 * The reviewed exceptions to the allowlist.
 *
 * - The UI typeface, Plus Jakarta Sans, under the SIL Open Font License 1.1. The package holds font files and
 *   stylesheets, no code. The OFL lets the fonts be bundled and redistributed with any software, as long as they are
 *   not sold by themselves and keep their copyright notice and licence (reproduced in the notices); it puts no
 *   condition on the software they ship with. It is not allowed for packages in general: it is a licence for fonts.
 */
export const LICENSE_ALLOWANCES: readonly LicenseAllowance[] = Object.freeze([
  Object.freeze({ name: '@fontsource-variable/plus-jakarta-sans', version: '5.3.0', license: 'OFL-1.1' }),
]);

export interface BundledPackage {
  name: string;
  version: string;
  /** The SPDX expression of package.json `license` (or the old `licenses` list as an OR); undefined when absent. */
  license: string | undefined;
  /** Absolute folder of the package. */
  dir: string;
}

function fail(code: string, subject: string, detail?: string): never {
  throw new Error(detail === undefined ? `${code}:${subject}` : `${code}:${subject} (${detail})`);
}

// ---------------------------------------------------------------------------------------------------------------
// SPDX expressions

type Token = '(' | ')' | 'AND' | 'OR' | 'WITH' | { id: string };

function tokenize(expression: string): Token[] | null {
  const tokens: Token[] = [];
  for (const word of expression.replace(/([()])/g, ' $1 ').split(/\s+/).filter((w) => w !== '')) {
    if (word === '(' || word === ')' || word === 'AND' || word === 'OR' || word === 'WITH') tokens.push(word);
    else if (/^[A-Za-z0-9.+-]+$/.test(word)) tokens.push({ id: word });
    else return null;
  }
  return tokens;
}

/**
 * Evaluates `expression` (SPDX license expression: identifiers, AND, OR, WITH, parentheses; AND binds tighter than OR)
 * to whether it can be satisfied with {@link LICENSE_ALLOWLIST}. Identifiers are compared exactly (the canonical
 * case); anything that does not parse is not allowed.
 */
export function licenseAllowed(expression: string | undefined): boolean {
  if (typeof expression !== 'string') return false;
  const parsed = tokenize(expression);
  if (parsed === null || parsed.length === 0) return false;
  const tokens: Token[] = parsed;
  let at = 0;
  const peek = (): Token | undefined => tokens[at];

  function atom(): boolean {
    const token = tokens[at++];
    if (token === '(') {
      const value = or();
      if (tokens[at++] !== ')') throw new SyntaxError('expected )');
      return value;
    }
    if (token === undefined || typeof token === 'string') throw new SyntaxError('expected a licence identifier');
    if (peek() === 'WITH') {
      at += 1;
      const exception = tokens[at++];
      if (exception === undefined || typeof exception === 'string') throw new SyntaxError('expected an exception');
      return false; // a licence exception is not on the allowlist
    }
    return LICENSE_ALLOWLIST.includes(token.id);
  }

  function and(): boolean {
    let value = atom();
    while (peek() === 'AND') {
      at += 1;
      value = atom() && value;
    }
    return value;
  }

  function or(): boolean {
    let value = and();
    while (peek() === 'OR') {
      at += 1;
      value = and() || value;
    }
    return value;
  }

  try {
    const value = or();
    return at === tokens.length && value;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Bundle inputs → packages

const NODE_MODULES = '/node_modules/';

/**
 * The package folder (POSIX, as relative or absolute as `input`) and the folder's package name for an input under
 * the last `node_modules/<name>` or `node_modules/@scope/<name>` of its path; undefined for our own sources and
 * esbuild's virtual modules (`<define:…>`, `namespace:path`).
 */
function packageFolder(input: string): { folder: string; name: string } | undefined {
  const posix = `/${input.replace(/\\/g, '/')}`; // the leading slash lets a relative `node_modules/…` match too
  const at = posix.lastIndexOf(NODE_MODULES);
  if (at === -1) return undefined;
  const start = at + NODE_MODULES.length;
  const parts = posix.slice(start).split('/');
  const nameParts = parts[0]?.startsWith('@') === true ? parts.slice(0, 2) : parts.slice(0, 1);
  if (nameParts.length === 0 || nameParts.some((part) => part === '') || parts.length <= nameParts.length) return undefined;
  const name = nameParts.join('/');
  return { folder: posix.slice(1, start) + name, name };
}

function licenseOf(manifest: Record<string, unknown>): string | undefined {
  const license = manifest['license'];
  if (typeof license === 'string') return license;
  if (license !== null && typeof license === 'object' && typeof (license as { type?: unknown }).type === 'string') {
    return (license as { type: string }).type;
  }
  const licenses = manifest['licenses'];
  if (Array.isArray(licenses)) {
    const types = licenses.map((l: unknown) => (l !== null && typeof l === 'object' ? (l as { type?: unknown }).type : l));
    if (types.length > 0 && types.every((t): t is string => typeof t === 'string')) return types.join(' OR ');
  }
  return undefined;
}

/**
 * The packages that hold `inputs` (esbuild metafile input paths, relative to `root`, or absolute): for each input
 * under a `node_modules/<name>` (or `node_modules/@scope/name`) folder, that folder's package.json. Inputs of our own
 * workspace (no node_modules segment) and esbuild's virtual modules are skipped. Sorted by name, then version; one
 * entry per folder. A package.json that cannot be read gives `version: 'unknown'` and no licence (refused later).
 */
export async function packagesOfInputs(inputs: readonly string[], root: string): Promise<BundledPackage[]> {
  const folders = new Map<string, string>(); // absolute folder → name of the folder
  for (const input of inputs) {
    const found = packageFolder(input);
    if (found !== undefined) folders.set(path.resolve(root, found.folder), found.name);
  }
  const packages: BundledPackage[] = [];
  for (const [dir, folderName] of folders) {
    let manifest: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>;
    } catch {
      // no readable package.json: unknown version, no licence
    }
    packages.push({
      name: typeof manifest['name'] === 'string' ? manifest['name'] : folderName,
      version: typeof manifest['version'] === 'string' ? manifest['version'] : 'unknown',
      license: licenseOf(manifest),
      dir,
    });
  }
  const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return packages.sort((a, b) => order(a.name, b.name) || order(a.version, b.version) || order(a.dir, b.dir));
}

/**
 * Refuses a package whose licence the allowlist cannot satisfy, unless it is one of `allowances` (default
 * {@link LICENSE_ALLOWANCES}) by its exact name, version and declared licence.
 *
 * @throws Error `LICENSE_NOT_ALLOWED:<pkg> (<version>, <licence>)[; also: …]` naming every offending package
 */
export function checkLicenses(packages: readonly BundledPackage[], allowances: readonly LicenseAllowance[] = LICENSE_ALLOWANCES): void {
  const reviewed = (p: BundledPackage): boolean => allowances.some((a) => a.name === p.name && a.version === p.version && a.license === p.license);
  const offenders = packages.filter((p) => !licenseAllowed(p.license) && !reviewed(p)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (offenders.length === 0) return;
  const [first, ...others] = offenders.map((p) => `${p.name} (${p.version}, ${p.license === undefined ? 'no licence' : JSON.stringify(p.license)})`);
  throw new Error(`LICENSE_NOT_ALLOWED:${first!}${others.length > 0 ? `; also: ${others.join(', ')}` : ''}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Native modules, runtime imports, production leaks

/** An acorn node of any kind, with the fields the scan reads. */
type ScanNode = acorn.AnyNode & { start: number };

/** The constant string a load names: a string literal, or a template literal without substitutions; else undefined. */
function constantSpecifier(node: acorn.AnyNode | null | undefined): string | undefined {
  if (node === null || node === undefined) return undefined;
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** Parses a bundle: as a module (server.mjs), else as a script (app.js is CommonJS, and may return at top level). */
function parseBundle(code: string): acorn.Program {
  try {
    return acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (moduleError) {
    try {
      return acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
    } catch {
      throw moduleError; // a bundle that parses in neither mode: the first error names the place
    }
  }
}

/**
 * Every module specifier a bundle loads at run time, read from its code with acorn: static `import` and `export … from`,
 * `import()`, `require()`, and esbuild's require shim (the variable whose initialiser throws "Dynamic require of …",
 * minified to any name). Only constant specifiers are listed, in source order, repeats included: a load whose
 * specifier is computed has none to name. The release build gives the result of server.mjs and app.js to
 * {@link checkRuntimeImports}.
 *
 * The walk is iterative, so a deeply nested tree costs heap and no stack (acorn's own parser is the limit there).
 *
 * @throws SyntaxError when `code` parses neither as a module nor as a script
 */
export function scanRuntimeImports(code: string): string[] {
  const program = parseBundle(code);
  const nodes: ScanNode[] = [];
  const requireNames = new Set(['require']);
  const stack: unknown[] = [program];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (typeof (node as { type?: unknown }).type !== 'string') continue;
    const found = node as ScanNode;
    nodes.push(found);
    if (found.type === 'VariableDeclarator' && found.id.type === 'Identifier' && found.init !== null && found.init !== undefined) {
      if (code.slice(found.init.start, found.init.end).includes('Dynamic require of')) requireNames.add(found.id.name);
    }
    for (const value of Object.values(found)) if (value !== null && typeof value === 'object') stack.push(value);
  }

  const loads: { start: number; specifier: string }[] = [];
  for (const node of nodes) {
    let source: acorn.AnyNode | null | undefined;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration') source = node.source;
    else if (node.type === 'ImportExpression') source = node.source;
    else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && requireNames.has(node.callee.name)) {
      source = node.arguments[0] as acorn.AnyNode | undefined;
    }
    const specifier = constantSpecifier(source);
    if (specifier !== undefined) loads.push({ start: node.start, specifier });
  }
  return loads.sort((a, b) => a.start - b.start).map((load) => load.specifier);
}

/** @throws Error `NATIVE_MODULE:<path>` for the first `.node` file among `inputs` */
export function checkNativeInputs(inputs: readonly string[]): void {
  const native = inputs.find((input) => /\.node$/i.test(input));
  if (native !== undefined) fail('NATIVE_MODULE', native);
}

/** @throws Error `BUNDLE_NOT_SELF_CONTAINED:<specifier>` for the first specifier that is not a node built-in */
export function checkRuntimeImports(specifiers: readonly string[]): void {
  const foreign = specifiers.find((spec) => !isBuiltin(spec));
  if (foreign !== undefined) {
    fail('BUNDLE_NOT_SELF_CONTAINED', foreign, 'loaded at run time from outside the bundle; bundle it or stub it in tools/release/src/build.ts');
  }
}

/** @throws Error `PRODUCTION_BUILD_LEAK:<path> (<needle>)` when a file's text holds one of `needles` */
export function checkNoLeaks(files: readonly { path: string; text: string }[], needles: readonly string[]): void {
  for (const file of files) {
    const needle = needles.find((n) => n !== '' && file.text.includes(n));
    if (needle !== undefined) fail('PRODUCTION_BUILD_LEAK', file.path, needle);
  }
}
