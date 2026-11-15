import { execFile } from 'node:child_process';
import { createHash, createPrivateKey } from 'node:crypto';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  KEYSET_MAX_DOCS,
  KEYSET_TYP,
  RELEASE_TYP,
  generateKeyPair,
  signDetached,
  verifyRelease,
  verifyReleaseWithRoots,
  type ReleaseManifest,
  type TrustedKey,
} from '@altis/crypto';
import { MIN_SERVER_VERSIONS, PHASE1_MIGRATIONS } from '@altis/db';
import { PASSPHRASE_ENV, runCli as signCli } from '@altis/sign-cli';
import { ADMIN_ASSET_NAME } from '@altis/platform';
import * as acorn from 'acorn';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PRODUCTION_LEAK_NEEDLES,
  RELEASE_KEY_ENV,
  buildRelease,
  checkAdminPage,
  gitSourceState,
  parseReleaseArgs,
  type BuildReleaseResult,
  type SourceState,
} from '../src/build.js';
import { readZip, extractZip, type ZipEntry, MAX_DEFLATE_RATIO } from '../src/zip.js';

// Task 17: `pnpm release --profile test|production --version <v> --out <dir>` → <dir>/altis-<v>.zip + build-report.json.
// Rulings: licence allowlist; byte-identical zips; production keys from env/CLI only (MISSING_RELEASE_KEY, never dev
// keys: DEV_KEY_IN_PRODUCTION); source maps only in <out>/private/sourcemaps; verifyRelease(check:'all') of the
// unzipped release; server.mjs embeds __TRUSTED_KEYS__ so doctor can verify (R62); one self-contained server.mjs; the
// zip's app.js is built for the release's own profile by the release build (never a file left in dist/). R65: app.js
// and server.mjs embed root public keys only; the release key is trusted through the shipped root-signed keyset.json,
// and the build never needs a root private key.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const DEV_KEYS = path.join(REPO_ROOT, 'tools', 'keys', 'dev');
const TEMPLATE = path.join(REPO_ROOT, 'tools', 'release', 'templates', 'ecosystem.config.cjs');
const VERSION = '0.1.0-test';
const RELEASE = `bundled-release/${VERSION}`;
const BUILD_TIMEOUT = 180_000;
const SERVER_BANNER = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

/** The zip's files but the hashed admin assets (`public/admin/assets/*`, which sit between the two public files). */
const LAYOUT = [
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.txt',
  'app.js',
  `${RELEASE}/keyset.json`,
  `${RELEASE}/manifest.json`,
  `${RELEASE}/manifest.sig`,
  `${RELEASE}/public/THIRD_PARTY_NOTICES.txt`,
  `${RELEASE}/public/admin/index.html`,
  `${RELEASE}/public/admin/install.html`,
  `${RELEASE}/server.mjs`,
  'ecosystem.config.cjs',
  'package.json',
  // Last, so that an extraction that stops part-way never leaves a `.complete` behind.
  `${RELEASE}/.complete`,
];

/** The hashed admin assets of a release's zip paths. */
const adminAssets = (paths: readonly string[], release = RELEASE): string[] => paths.filter((p) => p.startsWith(`${release}/public/admin/assets/`));

const packageJsonLiteral = (version: string): string =>
  `{"name":"altis","private":true,"version":"${version}","license":"AGPL-3.0-only","type":"commonjs","main":"app.js","scripts":{"start":"node app.js"},"engines":{"node":">=22.16"}}\n`;

/** A clean checkout at a fixed commit: production tests must not depend on the state of this working tree. */
const CLEAN_SOURCE: SourceState = { commit: 'c0ffee'.padEnd(40, '0'), committedAt: 1_793_059_200, dirty: false };

const ECOSYSTEM_LITERAL =
  "module.exports = {apps:[{name:'altis', script:'app.js', exec_mode:'fork', instances:1, autorestart:true, max_memory_restart:'450M', env:{NODE_ENV:'production'}}]}\n";

let tmp: string;

beforeAll(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-release-test-')));
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

/** Every public dev key (tools/keys/dev/trusted.json). */
async function devTrustedKeys(): Promise<TrustedKey[]> {
  return JSON.parse(await fsp.readFile(path.join(DEV_KEYS, 'trusted.json'), 'utf8')) as TrustedKey[];
}

/** The dev trust anchors (tools/keys/dev/roots.json). */
async function devRootKeys(): Promise<TrustedKey[]> {
  return JSON.parse(await fsp.readFile(path.join(DEV_KEYS, 'roots.json'), 'utf8')) as TrustedKey[];
}

function entry(entries: ZipEntry[], name: string): ZipEntry {
  const found = entries.find((e) => e.path === name);
  if (found === undefined) throw new Error(`no ${name} in the zip`);
  return found;
}

const textOf = (entries: ZipEntry[], name: string): string => entry(entries, name).data.toString('utf8');

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A sign-cli run whose output is kept; throws when it fails. */
async function altisSign(argv: string[]): Promise<void> {
  const lines: string[] = [];
  const code = await signCli(argv, { out: (l) => void lines.push(l), err: (l) => void lines.push(l) });
  if (code !== 0) throw new Error(`altis-sign ${argv.join(' ')} → ${code}: ${lines.join('\n')}`);
}

/** Generic ESTree walk (acorn nodes). */
function walk(node: unknown, visit: (node: acorn.AnyNode) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof (node as { type?: unknown }).type === 'string') visit(node as acorn.AnyNode);
  for (const value of Object.values(node)) if (value !== null && typeof value === 'object') walk(value, visit);
}

/**
 * Every module specifier server.mjs can load at run time, read from the bundle itself: static imports, re-exports,
 * import() and calls of `require` or of esbuild's require shim (the variable whose initialiser throws "Dynamic require
 * of ..."). `dynamic` counts loads whose specifier is not a string literal.
 */
function runtimeSpecifiers(code: string): { specifiers: string[]; dynamic: number } {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
  const requireNames = new Set(['require']);
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      if (code.slice(node.init.start, node.init.end).includes('Dynamic require of')) requireNames.add(node.id.name);
    }
  });
  const specifiers: string[] = [];
  let dynamic = 0;
  const literal = (node: acorn.AnyNode | null | undefined): void => {
    if (node?.type === 'Literal' && typeof node.value === 'string') specifiers.push(node.value);
    else dynamic += 1;
  };
  walk(ast, (node) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') literal(node.source);
    else if (node.type === 'ExportNamedDeclaration' && node.source) literal(node.source);
    else if (node.type === 'ImportExpression') literal(node.source);
    else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && requireNames.has(node.callee.name)) {
      literal(node.arguments[0] as acorn.AnyNode | undefined);
    }
  });
  return { specifiers, dynamic };
}

/** Runs `node <args>` with exactly `env`; never rejects on a non-zero exit. */
function runNode(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { env, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      resolve({ code, stdout, stderr });
    });
  });
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '' };
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  return { ...env, ...extra };
}

describe('test-profile release 0.1.0-test', () => {
  let result: BuildReleaseResult;
  let out: string;
  let zip: Buffer;
  let entries: ZipEntry[];
  let appRoot: string;

  beforeAll(async () => {
    out = path.join(tmp, 'out-a');
    result = await buildRelease({ profile: 'test', version: VERSION, out });
    zip = await fsp.readFile(path.join(out, `altis-${VERSION}.zip`));
    entries = readZip(zip);
    appRoot = path.join(tmp, 'app');
    await extractZip(zip, appRoot);
  }, BUILD_TIMEOUT);

  it('writes <out>/altis-<v>.zip and <out>/build-report.json', () => {
    expect(result.zipFile).toBe(path.join(out, `altis-${VERSION}.zip`));
    expect(result.reportFile).toBe(path.join(out, 'build-report.json'));
  });

  it('the zip holds exactly the layout, in a fixed order', () => {
    const paths = entries.map((e) => e.path);
    const assets = adminAssets(paths);
    expect(paths.filter((p) => !assets.includes(p))).toEqual(LAYOUT);
    // Sorted by path, `.complete` last: the assets come right after public/THIRD_PARTY_NOTICES.txt.
    const at = LAYOUT.indexOf(`${RELEASE}/public/admin/index.html`);
    expect(paths).toEqual([...LAYOUT.slice(0, at), ...[...assets].sort(), ...LAYOUT.slice(at)]);
  });

  it('the admin SPA is in public/admin: index.html with the nonce placeholder, hashed assets the server will serve', () => {
    const paths = entries.map((e) => e.path);
    const assets = adminAssets(paths);
    expect(assets.some((p) => p.endsWith('.js'))).toBe(true);
    expect(assets.some((p) => p.endsWith('.css'))).toBe(true);
    for (const asset of assets) expect(path.posix.basename(asset), asset).toMatch(ADMIN_ASSET_NAME);
    expect(paths.filter((p) => p.startsWith(`${RELEASE}/public/admin/`) && !assets.includes(p))).toEqual([
      `${RELEASE}/public/admin/index.html`,
      `${RELEASE}/public/admin/install.html`,
    ]);

    const html = textOf(entries, `${RELEASE}/public/admin/index.html`);
    expect(html).toContain('<meta name="csp-nonce" content="__CSP_NONCE__"');
    // No inline script or style: every script and stylesheet comes from /admin/assets (CSP script-src/style-src).
    expect(html).not.toMatch(/<style/i);
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toMatch(/\ssrc="\/admin\/assets\/[^"]+\.js"/);
    // Every <link> names an asset too, but for the empty `data:` icon that spares the browser a /favicon.ico request.
    for (const [, href] of html.matchAll(/<link\b[^>]*\shref="([^"]+)"/gi)) expect(href).toMatch(/^(\/admin\/assets\/|data:,$)/);

    // Built for this release: the version the API answers with (X-Altis-Build) is the SPA's own (the minifier may quote
    // it with any of ' " `).
    const code = assets.filter((p) => p.endsWith('.js')).map((p) => textOf(entries, p));
    expect(code.some((text) => /[`'"]0\.1\.0-test[`'"]/.test(text))).toBe(true);
  });

  it('the install wizard is public/admin/install.html (1c Task 30): the nonce placeholder, no inline script without it', () => {
    const paths = entries.map((e) => e.path);
    const assets = adminAssets(paths);
    const html = textOf(entries, `${RELEASE}/public/admin/install.html`);
    expect(html).toContain('<meta name="csp-nonce" content="__CSP_NONCE__"');
    expect(html).not.toMatch(/<style/i);
    // Every <script> loads a hashed asset of this release; an inline one would need the request's nonce.
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [tag, body] of scripts) {
      if (body!.trim() !== '') expect(tag).toContain('nonce="__CSP_NONCE__"');
      else expect(tag).toMatch(/\ssrc="\/admin\/assets\/[^"]+\.js"/);
    }
    for (const [, src] of html.matchAll(/\ssrc="\/admin\/assets\/([^"]+)"/gi)) expect(assets).toContain(`${RELEASE}/public/admin/assets/${src}`);
    for (const [, href] of html.matchAll(/<link\b[^>]*\shref="([^"]+)"/gi)) expect(href).toMatch(/^(\/admin\/assets\/|data:,$)/);
    // Its own entry: not the admin SPA's script.
    const entry = (doc: string): string[] => [...doc.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/gi)].map((m) => m[1]!);
    expect(entry(html)).not.toEqual(entry(textOf(entries, `${RELEASE}/public/admin/index.html`)));
  });

  it('public/THIRD_PARTY_NOTICES.txt is the zip\'s THIRD_PARTY_NOTICES.txt', () => {
    expect(textOf(entries, `${RELEASE}/public/THIRD_PARTY_NOTICES.txt`)).toBe(textOf(entries, 'THIRD_PARTY_NOTICES.txt'));
  });

  it('every entry: mode 0644, mtime 2026-01-01 00:00, no extra field; text deflated within 10x (else stored), empty files stored', () => {
    for (const e of entries) {
      expect(e.mode, e.path).toBe(0o100644);
      expect([e.dosDate, e.dosTime], e.path).toEqual([((2026 - 1980) << 9) | (1 << 5) | 1, 0]);
      expect([e.extraLength, e.localExtraLength], e.path).toEqual([0, 0]);
      if (e.data.length === 0) expect(e.method, e.path).toBe(0);
      // No entry may expand more than MAX_DEFLATE_RATIO: every reader refuses that as a zip bomb (spec §7.5).
      if (e.method === 8) expect(e.data.length, e.path).toBeLessThanOrEqual(MAX_DEFLATE_RATIO * e.compressedSize);
    }
    expect(entries.filter((e) => e.method === 8).length).toBeGreaterThan(entries.length / 2);
    expect(entry(entries, `${RELEASE}/.complete`).data.length).toBe(0);
  });

  it("the unzipped bundled release verifies (check: 'all') from the dev root alone, as app.js on a fresh install", async () => {
    const dir = path.join(appRoot, RELEASE);
    const manifest = await verifyReleaseWithRoots(dir, await devRootKeys(), { check: 'all' });
    const releaseFiles = entries
      .map((e) => e.path)
      .filter((p) => p.startsWith(`${RELEASE}/`) && !/\/(manifest\.json|manifest\.sig|\.complete)$/.test(p))
      .map((p) => p.slice(RELEASE.length + 1));
    expect(releaseFiles).toContain('public/admin/index.html');
    expect(manifest.files.map((f) => f.path)).toEqual([...releaseFiles].sort());
    expect(JSON.parse(textOf(entries, `${RELEASE}/manifest.sig`))).toMatchObject({ typ: RELEASE_TYP, kid: 'dev-rel-1' });
    expect(result.manifest).toEqual(manifest);
    // The root never signs a release: without the shipped keyset nothing trusts dev-rel-1.
    await expect(verifyRelease(dir, await devRootKeys(), { check: 'all' })).rejects.toThrow(/^RELEASE_INVALID:signature/);
  });

  it('the manifest: version, git sha, bootProtocol 1, schema from PHASE1_MIGRATIONS, minimum Node and databases', () => {
    const manifest = JSON.parse(textOf(entries, `${RELEASE}/manifest.json`)) as ReleaseManifest;
    const names = Object.keys(PHASE1_MIGRATIONS).sort();
    const triple = (v: readonly number[]): string => v.join('.');
    expect(manifest).toMatchObject({
      version: VERSION,
      bootProtocol: 1,
      schemaLatest: names[names.length - 1]!.slice(0, 4),
      minCodeVersionAfter: '0.0.0', // no contract migration in Phase 1
      minUpgradeFrom: '0.0.0',
      minNode: '22.16.0',
      minDb: { mysql: triple(MIN_SERVER_VERSIONS.mysql), mariadb: triple(MIN_SERVER_VERSIONS.mariadb), postgres: triple(MIN_SERVER_VERSIONS.postgres) },
    });
    // The last migration's number, by name (Phase 2 appends 0020–0027; Phase 1d's 0010–0019 sort before them).
    expect(manifest.schemaLatest).toMatch(/^\d{4}$/);
    expect(manifest.schemaLatest >= '0009').toBe(true);
    expect(manifest.buildId).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.releasedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keyset.json is the dev keyset (tools/keys/dev/keyset.json, signed by dev-root-1), byte for byte', async () => {
    expect(entry(entries, `${RELEASE}/keyset.json`).data.equals(await fsp.readFile(path.join(DEV_KEYS, 'keyset.json')))).toBe(true);
  });

  it('package.json is the literal; ecosystem.config.cjs is the template, without PORT', async () => {
    expect(textOf(entries, 'package.json')).toBe(packageJsonLiteral(VERSION));
    const ecosystem = textOf(entries, 'ecosystem.config.cjs');
    expect(ecosystem).toBe(ECOSYSTEM_LITERAL);
    expect(ecosystem).toBe(await fsp.readFile(TEMPLATE, 'utf8'));
    expect(ecosystem).not.toMatch(/PORT/);
    const loaded = createRequire(import.meta.url)(path.join(appRoot, 'ecosystem.config.cjs')) as unknown;
    expect(loaded).toEqual({
      apps: [
        {
          name: 'altis',
          script: 'app.js',
          exec_mode: 'fork',
          instances: 1,
          autorestart: true,
          max_memory_restart: '450M',
          env: { NODE_ENV: 'production' },
        },
      ],
    });
  });

  it('LICENSE and NOTICE are the repository root\'s, byte for byte (AGPL-3.0-only), in place of the old placeholder', async () => {
    for (const name of ['LICENSE', 'NOTICE']) {
      expect(entry(entries, name).data.equals(await fsp.readFile(path.join(REPO_ROOT, name))), name).toBe(true);
    }
    expect(textOf(entries, 'LICENSE')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(textOf(entries, 'NOTICE')).toContain('AGPL-3.0-only');
    expect(entries.map((e) => e.path).filter((p) => /eula/i.test(p))).toEqual([]);
  });

  it('THIRD_PARTY_NOTICES.txt holds the licence texts of hono, kysely, mysql2, pg and zod', async () => {
    const notices = textOf(entries, 'THIRD_PARTY_NOTICES.txt');
    const holders: Record<string, string> = { hono: 'apps/server', zod: 'apps/server', kysely: 'packages/db', mysql2: 'packages/db', pg: 'packages/db' };
    for (const [name, holder] of Object.entries(holders)) {
      const dir = await fsp.realpath(path.join(REPO_ROOT, holder, 'node_modules', name));
      const file = (await fsp.readdir(dir)).find((f) => /^licen[cs]e/i.test(f));
      expect(file, name).toBeDefined();
      const text = (await fsp.readFile(path.join(dir, file!), 'utf8')).replace(/\r\n/g, '\n').trim();
      expect(notices, name).toContain(text);
      const version = (JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')) as { version: string }).version;
      expect(notices, name).toContain(`${name} ${version}`);
    }
  });

  it('THIRD_PARTY_NOTICES.txt holds the licence texts of the admin bundle too: react, its router, Radix, Tailwind', async () => {
    const notices = textOf(entries, 'THIRD_PARTY_NOTICES.txt');
    const adminDir = path.join(REPO_ROOT, 'apps', 'admin');
    for (const name of ['react', 'react-dom', '@tanstack/react-router', '@tanstack/react-query', 'cmdk', 'get-nonce', 'tailwindcss']) {
      const dir = await fsp.realpath(path.join(adminDir, 'node_modules', name));
      const version = (JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')) as { version: string }).version;
      expect(notices, name).toContain(`${name} ${version}`);
    }
    expect(result.report.notices.packages.some((p) => p.name.startsWith('@radix-ui/'))).toBe(true);
  });

  it('THIRD_PARTY_NOTICES.txt lists react and shadcn/ui (the admin UI primitives are adapted from it; S27)', () => {
    const notices = textOf(entries, 'THIRD_PARTY_NOTICES.txt');
    const header = notices.slice(0, notices.indexOf('='.repeat(80)));
    expect(header).toMatch(/^ {2}react \d+\.\d+\.\d+ \(MIT\)$/m);
    expect(header).toContain('  shadcn/ui components (apps/admin/src/components/ui) (MIT)');
    expect(notices).toContain('Sumber / Source: https://github.com/shadcn-ui/ui (apps/admin/src/components/ui/LICENSE-shadcn-ui.txt)');
    expect(notices).toContain('Copyright (c) 2023 shadcn');
  });

  it('notices and the report list only packages in the bundles: no dev tooling', () => {
    const names = result.report.notices.packages.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['hono', '@hono/node-server', 'kysely', 'mysql2', 'pg', 'zod', 'react', 'react-dom']));
    for (const tool of ['esbuild', 'vitest', 'acorn', 'typescript', 'tsx', 'eslint', '@types/node']) expect(names).not.toContain(tool);
    for (const tool of ['@vitejs/plugin-react', '@tailwindcss/vite', '@tailwindcss/oxide', 'lightningcss', 'jsdom', '@testing-library/react', '@types/react']) {
      expect(names).not.toContain(tool);
    }
    for (const p of result.report.notices.packages) expect(p.license, p.name).toMatch(/^(MIT|MIT-0|ISC|Apache-2\.0|BSD-[23]-Clause|0BSD)$/);
  });

  it('build-report.json: zipBytes (under 15 MB), adminBytes, the files and the notice packages', async () => {
    const report = JSON.parse(await fsp.readFile(path.join(out, 'build-report.json'), 'utf8')) as BuildReleaseResult['report'];
    expect(report).toEqual(result.report);
    expect(Object.keys(report).sort()).toEqual(['adminBytes', 'files', 'notices', 'zipBytes']);
    const admin = entries.filter((e) => e.path.startsWith(`${RELEASE}/public/admin/`));
    expect(report.adminBytes).toBe(admin.reduce((sum, e) => sum + e.data.length, 0));
    expect(report.adminBytes).toBeGreaterThan(0);
    expect(report.zipBytes).toBe(zip.length);
    expect(report.zipBytes).toBeLessThan(15_000_000);
    expect(report.files).toEqual(entries.map((e) => ({ path: e.path, size: e.data.length })));
  });

  it('source maps go to <out>/private/sourcemaps only, never into the zip or a sourceMappingURL', async () => {
    const maps = await fsp.readdir(path.join(out, 'private', 'sourcemaps'));
    expect(maps.sort()).toEqual(['app.js.map', 'server.mjs.map']);
    for (const map of maps) {
      expect((JSON.parse(await fsp.readFile(path.join(out, 'private', 'sourcemaps', map), 'utf8')) as { version: number }).version).toBe(3);
    }
    for (const e of entries) {
      expect(e.path).not.toMatch(/\.map$/);
      expect(e.data.toString('utf8')).not.toContain('sourceMappingURL');
    }
  });

  it('app.js is the test-profile bootloader built for this release: ES2017 script, the dev root key only, bundled 0.1.0-test', async () => {
    const app = textOf(entries, 'app.js');
    expect(app.startsWith('/* ALTIS app.js (bootloader v1, test) */')).toBe(true);
    expect(() => acorn.parse(app, { ecmaVersion: 2017, sourceType: 'script' })).not.toThrow();
    expect(app).toContain(JSON.stringify(VERSION));
    for (const key of await devTrustedKeys()) {
      if (key.use === 'root') expect(app).toContain(key.pub);
      else expect(app).not.toContain(key.pub);
    }
  });

  it('server.mjs is one self-contained bundle: only node built-ins are loaded at run time', () => {
    const server = textOf(entries, `${RELEASE}/server.mjs`);
    expect(server.startsWith(SERVER_BANNER)).toBe(true);
    const { specifiers, dynamic } = runtimeSpecifiers(server);
    expect(dynamic).toBe(0);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !isBuiltin(s))).toEqual([]);
    expect(specifiers).toContain('node:sqlite'); // external, loaded through import() only
    expect(result.runtimeImports.server.filter((s) => !isBuiltin(s))).toEqual([]);
    expect(result.runtimeImports.app.filter((s) => !isBuiltin(s))).toEqual([]);
  });

  it('server.mjs embeds the root keys app.js embeds (R62, R65), and no other key', async () => {
    const server = textOf(entries, `${RELEASE}/server.mjs`);
    for (const key of await devTrustedKeys()) {
      if (key.use === 'root') expect(server).toContain(key.pub);
      else expect(server).not.toContain(key.pub);
    }
  });

  it('nothing of the build host is in the bundles (repository path, temp folder, home)', () => {
    const admin = entries.map((e) => e.path).filter((p) => p.startsWith(`${RELEASE}/public/`));
    for (const name of ['app.js', `${RELEASE}/server.mjs`, 'THIRD_PARTY_NOTICES.txt', `${RELEASE}/manifest.json`, ...admin]) {
      const text = textOf(entries, name);
      for (const hostPath of [REPO_ROOT, tmp, os.homedir()]) expect(text, name).not.toContain(hostPath);
    }
  });

  it('`node app.js doctor --json` from the unzipped release reports the release verified by server.mjs itself (R62)', async () => {
    const home = path.join(tmp, 'home');
    await fsp.mkdir(home, { recursive: true });
    const run = await runNode([path.join(appRoot, 'app.js'), 'doctor', '--json'], childEnv({ HOME: home, ALTIS_DATA_DIR: path.join(tmp, 'data') }));
    const last = run.stdout.trim().split('\n').pop() ?? '';
    let report: { command?: string; checks?: Record<string, { ok: boolean; detail: string }> };
    try {
      report = JSON.parse(last) as typeof report;
    } catch {
      throw new Error(`doctor printed no JSON (exit ${String(run.code)}):\n${run.stdout}\n${run.stderr}`);
    }
    expect(report.command).toBe('doctor');
    expect(report.checks?.['release']).toEqual({
      ok: true,
      detail: expect.stringMatching(/^0\.1\.0-test \(bundled\): .*signature and every file match/),
    });
    expect([0, 1]).toContain(run.code); // not installed: other checks fail, the release one does not
  });

  it('a second build of the same commit and profile gives a byte-identical zip and report', async () => {
    const outB = path.join(tmp, 'out-b');
    const again = await buildRelease({ profile: 'test', version: VERSION, out: outB });
    const zipB = await fsp.readFile(again.zipFile);
    expect(sha256(zipB)).toBe(sha256(zip));
    expect(await fsp.readFile(again.reportFile, 'utf8')).toBe(await fsp.readFile(result.reportFile, 'utf8'));
  }, BUILD_TIMEOUT);
});

describe('test-profile release 0.2.0-test (fixture level 2, decision D1d-26)', () => {
  it('the manifest names schema 9001 (9001_test_expand) and the --min-upgrade-from given; the zip stays under 15 MB', async () => {
    const out = path.join(tmp, 'out-fixture-2');
    const result = await buildRelease({ profile: 'test', version: '0.2.0-test', out, minUpgradeFrom: '0.1.0-test' });
    expect(result.manifest).toMatchObject({ version: '0.2.0-test', schemaLatest: '9001', minCodeVersionAfter: '0.0.0', minUpgradeFrom: '0.1.0-test' });
    const entries = readZip(await fsp.readFile(result.zipFile));
    expect(JSON.parse(textOf(entries, 'bundled-release/0.2.0-test/manifest.json'))).toMatchObject({ schemaLatest: '9001', minUpgradeFrom: '0.1.0-test' });
    expect(textOf(entries, 'bundled-release/0.2.0-test/server.mjs')).toContain('9001_test_expand');
    expect(result.report.zipBytes).toBeLessThan(15_000_000);
  }, BUILD_TIMEOUT);
});

describe('production profile', () => {
  let keysDir: string;
  let offlineDir: string;
  let keyEnv: Record<string, string>;
  let rootKeys: TrustedKey[];
  let releaseKeys: TrustedKey[];

  beforeAll(async () => {
    // Throwaway production-style keys (not `dev-`), made with the signing tool the way release keys are made
    // offline (docs/ops/release-signing.md): two root keys (active + spare) whose private halves stay in offlineDir and are never handed to the build,
    // two release keys, the public roots, and a keyset (seq 1) signed by the active root that trusts the release keys.
    offlineDir = path.join(tmp, 'prod-root-offline');
    await altisSign(['keygen', '--use', 'root', '--kid', 'root-ci-1', '--out', offlineDir]);
    await altisSign(['keygen', '--use', 'root', '--kid', 'root-ci-2', '--out', offlineDir]);
    rootKeys = JSON.parse(await fsp.readFile(path.join(offlineDir, 'trusted.json'), 'utf8')) as TrustedKey[];
    keysDir = path.join(tmp, 'prod-keys');
    await altisSign(['keygen', '--use', 'release', '--kid', 'rel-ci-1', '--out', keysDir]);
    await altisSign(['keygen', '--use', 'release', '--kid', 'rel-ci-2', '--out', keysDir]);
    releaseKeys = JSON.parse(await fsp.readFile(path.join(keysDir, 'trusted.json'), 'utf8')) as TrustedKey[];
    await fsp.writeFile(path.join(keysDir, 'roots.json'), JSON.stringify(rootKeys));
    const payload = path.join(keysDir, 'keyset-payload.json');
    await fsp.writeFile(payload, JSON.stringify({ seq: 1, keys: releaseKeys, revokedKids: [] }));
    await altisSign([
      ...['keyset', 'sign', '--in', payload, '--key', path.join(offlineDir, 'root-ci-1.key.json')],
      ...['--root-keys', path.join(offlineDir, 'trusted.json'), '--out', path.join(keysDir, 'keyset.json')],
    ]);
    keyEnv = {
      [RELEASE_KEY_ENV.signingKey]: path.join(keysDir, 'rel-ci-1.key.json'),
      [RELEASE_KEY_ENV.rootKeys]: path.join(keysDir, 'roots.json'),
      [RELEASE_KEY_ENV.keyset]: path.join(keysDir, 'keyset.json'),
      // No ALTIS_RELEASE_FEED_URL: the feed URL is optional in production too (the build embeds '', no online check).
    };
  });

  /** A keyset file of `docs` signed by the offline root `kid` (or by any key file), as the key holder hands it over. */
  async function signedKeyset(name: string, payload: unknown, keyFile = path.join(offlineDir, 'root-ci-1.key.json')): Promise<string> {
    const input = path.join(keysDir, `${name}-payload.json`);
    await fsp.writeFile(input, JSON.stringify(payload));
    const out = path.join(keysDir, `${name}.json`);
    await altisSign(['keyset', 'sign', '--in', input, '--key', keyFile, '--root-keys', path.join(offlineDir, 'trusted.json'), '--out', out]);
    return out;
  }

  it('the production leak scan looks for the test hooks and the test-only permission (S28)', () => {
    expect(PRODUCTION_LEAK_NEEDLES).toEqual(expect.arrayContaining(['ALTIS_TEST_', 'test.branch.manage']));
  });

  it('without release keys the build fails MISSING_RELEASE_KEY and writes nothing', async () => {
    const out = path.join(tmp, 'prod-missing');
    const options = parseReleaseArgs(['--profile', 'production', '--version', '1.0.0', '--out', out, '--feed-url', 'https://feed.example/altis'], {}, tmp);
    await expect(buildRelease(options)).rejects.toThrow(/^MISSING_RELEASE_KEY/);
    expect(existsSync(out)).toBe(false);
  });

  it('each key file is required, the root keys and the keyset too: one missing fails MISSING_RELEASE_KEY:<that one>', async () => {
    expect(Object.values(RELEASE_KEY_ENV)).toEqual(['ALTIS_RELEASE_SIGNING_KEY', 'ALTIS_RELEASE_ROOT_KEYS', 'ALTIS_RELEASE_KEYSET']);
    for (const [name, variable] of Object.entries(RELEASE_KEY_ENV)) {
      const env = { ...keyEnv };
      delete env[variable];
      const options = parseReleaseArgs(['--profile', 'production', '--version', '1.0.0', '--out', path.join(tmp, 'prod-one')], env, tmp);
      await expect(buildRelease(options), name).rejects.toThrow(new RegExp(`^MISSING_RELEASE_KEY:${variable}`));
    }
  });

  it('the dev keys of tools/keys/dev fail DEV_KEY_IN_PRODUCTION, by path or by kid, the dev root included', async () => {
    const out = path.join(tmp, 'prod-dev');
    const dev = parseReleaseArgs(
      [
        ...['--profile', 'production', '--version', '1.0.0', '--out', out, '--feed-url', 'https://feed.example/altis'],
        ...['--signing-key', path.join(DEV_KEYS, 'dev-rel-1.key.json')],
        ...['--root-keys', path.join(DEV_KEYS, 'roots.json'), '--keyset', path.join(DEV_KEYS, 'keyset.json')],
      ],
      {},
      tmp,
    );
    await expect(buildRelease(dev)).rejects.toThrow(/^DEV_KEY_IN_PRODUCTION/);

    // The dev root copied elsewhere is still refused, by kid and by public key.
    const copy = path.join(tmp, 'copied-dev-keys');
    await fsp.mkdir(copy, { recursive: true });
    await fsp.copyFile(path.join(DEV_KEYS, 'roots.json'), path.join(copy, 'roots.json'));
    const mixed = parseReleaseArgs(
      ['--profile', 'production', '--version', '1.0.0', '--out', out],
      { ...keyEnv, [RELEASE_KEY_ENV.rootKeys]: path.join(copy, 'roots.json') },
      tmp,
    );
    await expect(buildRelease(mixed)).rejects.toThrow(/^DEV_KEY_IN_PRODUCTION:root key dev-root-1/);
    const renamed = path.join(copy, 'renamed-roots.json');
    await fsp.writeFile(renamed, JSON.stringify([...rootKeys, { ...(await devRootKeys())[0]!, kid: 'root-ci-9' }]));
    await expect(buildRelease(parseReleaseArgs(['--profile', 'production', '--version', '1.0.0', '--out', out], { ...keyEnv, [RELEASE_KEY_ENV.rootKeys]: renamed }, tmp))).rejects.toThrow(
      /^DEV_KEY_IN_PRODUCTION:root key root-ci-9/,
    );
    const devNamed = path.join(copy, 'dev-named-roots.json');
    await fsp.writeFile(devNamed, JSON.stringify([{ ...rootKeys[0]!, kid: 'dev-root-7' }]));
    await expect(buildRelease(parseReleaseArgs(['--profile', 'production', '--version', '1.0.0', '--out', out], { ...keyEnv, [RELEASE_KEY_ENV.rootKeys]: devNamed }, tmp))).rejects.toThrow(
      /^DEV_KEY_IN_PRODUCTION:root key dev-root-7/,
    );
    expect(existsSync(out)).toBe(false);
  });

  it('with keys from the environment and no feed URL: signed with them, app.js and server.mjs embed the roots only, no test hook, no dev key', async () => {
    const out = path.join(tmp, 'prod-ok');
    const options = parseReleaseArgs(['--profile', 'production', '--version', '1.0.0', '--out', out], keyEnv, tmp);
    // The build is handed public roots and a pre-signed keyset: never a root private key.
    expect(Object.values(options.keys ?? {}).some((file) => file.startsWith(offlineDir))).toBe(false);
    const result = await buildRelease({ ...options, source: CLEAN_SOURCE });
    const zip = await fsp.readFile(result.zipFile);
    const entries = readZip(zip);
    const prodPaths = entries.map((e) => e.path);
    const prodAssets = adminAssets(prodPaths, 'bundled-release/1.0.0');
    expect(prodAssets.length).toBeGreaterThan(0);
    expect(prodPaths.filter((p) => !prodAssets.includes(p))).toEqual(LAYOUT.map((p) => p.replace(VERSION, '1.0.0')));
    // The production admin bundle is built for 1.0.0 and has no test-profile text (the minifier dropped it).
    const adminCode = prodAssets.filter((p) => p.endsWith('.js')).map((p) => textOf(entries, p));
    expect(adminCode.some((text) => /[`'"]1\.0\.0[`'"]/.test(text))).toBe(true);
    expect(result.manifest.buildId).toBe(CLEAN_SOURCE.commit);
    expect(result.manifest.releasedAt).toBe('2026-10-27');
    const appRoot = path.join(tmp, 'prod-app');
    await extractZip(zip, appRoot);
    const dir = path.join(appRoot, 'bundled-release', '1.0.0');

    await verifyReleaseWithRoots(dir, rootKeys, { check: 'all' });
    await expect(verifyReleaseWithRoots(dir, await devRootKeys(), { check: 'all' })).rejects.toThrow(/^RELEASE_INVALID:signature/);
    expect(JSON.parse(textOf(entries, 'bundled-release/1.0.0/manifest.sig'))).toMatchObject({ kid: 'rel-ci-1' });
    expect(entry(entries, 'bundled-release/1.0.0/keyset.json').data.equals(await fsp.readFile(keyEnv[RELEASE_KEY_ENV.keyset]!))).toBe(true);

    const app = textOf(entries, 'app.js');
    const server = textOf(entries, 'bundled-release/1.0.0/server.mjs');
    expect(app.startsWith('/* ALTIS app.js (bootloader v1, production) */')).toBe(true);
    expect(server).not.toContain('feed.example');
    for (const key of rootKeys) {
      expect(app).toContain(key.pub);
      expect(server).toContain(key.pub);
    }
    for (const key of releaseKeys) {
      expect(app).not.toContain(key.pub);
      expect(server).not.toContain(key.pub);
    }
    const devNeedles = (await devTrustedKeys()).flatMap((k) => [k.kid, k.pub]);
    for (const e of entries) {
      const text = e.data.toString('utf8');
      for (const needle of PRODUCTION_LEAK_NEEDLES) expect(text, e.path).not.toContain(needle);
      for (const needle of devNeedles) expect(text, `${e.path} holds ${needle}`).not.toContain(needle);
    }
    expect(result.report.zipBytes).toBeLessThan(15_000_000);

    // R65b + R65f end to end: the production app.js and server.mjs ignore a root-signed document that trusts a dev-
    // key (altis-sign refuses to make one, so it is signed here directly), and doctor reports it.
    const root1 = JSON.parse(await fsp.readFile(path.join(offlineDir, 'root-ci-1.key.json'), 'utf8')) as { pkcs8: string };
    const rootKey = createPrivateKey({ key: Buffer.from(root1.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
    const devPayload = { seq: 2, keys: [{ kid: 'dev-rel-77', use: 'release', pub: generateKeyPair().pub }], revokedKids: [] };
    const dataDir = path.join(tmp, 'prod-data');
    await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
    await fsp.writeFile(
      path.join(dataDir, 'releases', 'keyset.json'),
      JSON.stringify([{ raw: JSON.stringify(devPayload), env: signDetached(devPayload, { typ: KEYSET_TYP, kid: 'root-ci-1', privateKey: rootKey }) }]),
    );
    const home = path.join(tmp, 'prod-home');
    await fsp.mkdir(home, { recursive: true });
    const run = await runNode([path.join(appRoot, 'app.js'), 'doctor', '--json'], childEnv({ HOME: home, ALTIS_DATA_DIR: dataDir }));
    const doctor = JSON.parse(run.stdout.trim().split('\n').pop() ?? '') as { checks: Record<string, { ok: boolean; detail: string }> };
    // 1d Task 29: then what current.json names, and the release bundled beside the real app.js (its own version).
    expect(doctor.checks['release']).toEqual({
      ok: true,
      detail: expect.stringMatching(
        /^1\.0\.0 \(bundled\): .*signature and every file match; 1 keyset document\(s\) ignored: DATA_DIR\/releases\/keyset\.json#0 dev; pending -, pinned -, terbundel \/ bundled 1\.0\.0 \(same\)$/,
      ),
    });
    expect(run.stderr).toContain('"reason":"dev"'); // app.js logged it too
  }, BUILD_TIMEOUT);

  it('a test build is only signed with a dev- key and embeds only dev- roots (NON_DEV_KEY_IN_TEST_BUILD), and never reads the production env', async () => {
    const out = path.join(tmp, 'test-prodkey');
    const signedByProduction = parseReleaseArgs(
      ['--profile', 'test', '--version', VERSION, '--out', out, '--signing-key', keyEnv[RELEASE_KEY_ENV.signingKey]!],
      {},
      tmp,
    );
    await expect(buildRelease(signedByProduction)).rejects.toThrow(/^NON_DEV_KEY_IN_TEST_BUILD:rel-ci-1\b/);
    const productionRoots = parseReleaseArgs(['--profile', 'test', '--version', VERSION, '--out', out, '--root-keys', keyEnv[RELEASE_KEY_ENV.rootKeys]!], {}, tmp);
    await expect(buildRelease(productionRoots)).rejects.toThrow(/^NON_DEV_KEY_IN_TEST_BUILD:root key root-ci-1\b/);
    expect(parseReleaseArgs(['--profile', 'test', '--version', VERSION], keyEnv, tmp).keys).toEqual({});
    expect(existsSync(out)).toBe(false);
  });

  it('the signer must be trusted through the root-signed keyset (SIGNING_KEY_NOT_TRUSTED)', async () => {
    const argv = ['--profile', 'production', '--version', '1.0.0', '--out', path.join(tmp, 'prod-untrusted')];
    const onlyFirst = await signedKeyset('keyset-rel-ci-1-only', { seq: 1, keys: releaseKeys.filter((k) => k.kid === 'rel-ci-1'), revokedKids: [] });
    const signedBySpare = { ...keyEnv, [RELEASE_KEY_ENV.signingKey]: path.join(keysDir, 'rel-ci-2.key.json'), [RELEASE_KEY_ENV.keyset]: onlyFirst };
    await expect(buildRelease(parseReleaseArgs(argv, signedBySpare, tmp))).rejects.toThrow(/^SIGNING_KEY_NOT_TRUSTED:rel-ci-2\b/);

    // A root-signed revocation of the signer: not trusted either (app.js would refuse the release).
    const revoking = await signedKeyset('keyset-revoking', { seq: 2, keys: releaseKeys, revokedKids: ['rel-ci-1'] });
    await expect(buildRelease(parseReleaseArgs(argv, { ...keyEnv, [RELEASE_KEY_ENV.keyset]: revoking }, tmp))).rejects.toThrow(
      /^SIGNING_KEY_NOT_TRUSTED:rel-ci-1\b/,
    );
  });

  it('every keyset document must count under the root keys (KEYSET_INVALID): a release key never signs one', async () => {
    const argv = ['--profile', 'production', '--version', '1.0.0', '--out', path.join(tmp, 'prod-bad-keyset')];
    // Signed by the release key itself: altis-sign refuses that, so it is forged here directly.
    const rel1 = JSON.parse(await fsp.readFile(path.join(keysDir, 'rel-ci-1.key.json'), 'utf8')) as { pkcs8: string };
    const privateKey = createPrivateKey({ key: Buffer.from(rel1.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
    const payload = { seq: 1, keys: releaseKeys, revokedKids: [] };
    const forged = path.join(keysDir, 'keyset-by-release-key.json');
    await fsp.writeFile(forged, JSON.stringify([{ raw: JSON.stringify(payload), env: signDetached(payload, { typ: KEYSET_TYP, kid: 'rel-ci-1', privateKey }) }]));
    await expect(buildRelease(parseReleaseArgs(argv, { ...keyEnv, [RELEASE_KEY_ENV.keyset]: forged }, tmp))).rejects.toThrow(
      /^KEYSET_INVALID:document 0: SIG_INVALID:kid/,
    );

    // Signed by a root that the build does not embed (root-ci-2 is left out of the embedded pair).
    const otherPair = path.join(keysDir, 'roots-other-pair.json');
    await fsp.writeFile(otherPair, JSON.stringify([rootKeys.find((k) => k.kid === 'root-ci-1'), { kid: 'root-ci-3', use: 'root', pub: generateKeyPair().pub }]));
    const bySpare = await signedKeyset('keyset-by-spare', payload, path.join(offlineDir, 'root-ci-2.key.json'));
    await expect(
      buildRelease(parseReleaseArgs(argv, { ...keyEnv, [RELEASE_KEY_ENV.rootKeys]: otherPair, [RELEASE_KEY_ENV.keyset]: bySpare }, tmp)),
    ).rejects.toThrow(/^KEYSET_INVALID:document 0: SIG_INVALID:kid/);

    // A bare document instead of a list, or more than KEYSET_MAX_DOCS documents: the frozen format (R65c).
    const bare = path.join(keysDir, 'keyset-bare.json');
    await fsp.writeFile(bare, JSON.stringify((JSON.parse(await fsp.readFile(keyEnv[RELEASE_KEY_ENV.keyset]!, 'utf8')) as unknown[])[0]));
    await expect(buildRelease(parseReleaseArgs(argv, { ...keyEnv, [RELEASE_KEY_ENV.keyset]: bare }, tmp))).rejects.toThrow(/^RELEASE_KEYS_INVALID:keyset/);
    const tooMany = path.join(keysDir, 'keyset-too-many.json');
    const first = (JSON.parse(await fsp.readFile(keyEnv[RELEASE_KEY_ENV.keyset]!, 'utf8')) as unknown[])[0];
    await fsp.writeFile(tooMany, JSON.stringify(new Array(KEYSET_MAX_DOCS + 1).fill(first)));
    await expect(buildRelease(parseReleaseArgs(argv, { ...keyEnv, [RELEASE_KEY_ENV.keyset]: tooMany }, tmp))).rejects.toThrow(/^RELEASE_KEYS_INVALID:keyset/);

    // One kid bound to two keys.
    const conflicting = await signedKeyset('keyset-conflict', { seq: 2, keys: [{ ...releaseKeys[1]!, kid: 'rel-ci-1' }], revokedKids: [] });
    const both = path.join(keysDir, 'keyset-both.json');
    await fsp.writeFile(both, JSON.stringify([...(JSON.parse(await fsp.readFile(keyEnv[RELEASE_KEY_ENV.keyset]!, 'utf8')) as unknown[]), ...(JSON.parse(await fsp.readFile(conflicting, 'utf8')) as unknown[])]));
    await expect(buildRelease(parseReleaseArgs(argv, { ...keyEnv, [RELEASE_KEY_ENV.keyset]: both }, tmp))).rejects.toThrow(
      /^KEYSET_INVALID:kid rel-ci-1 is bound to two keys/,
    );
  });

  it('the root key file holds two root keys or more, root keys only (RELEASE_KEYS_INVALID): a release key is never an anchor', async () => {
    const argv = ['--profile', 'production', '--version', '1.0.0', '--out', path.join(tmp, 'prod-bad-roots')];
    const [active, spare] = rootKeys as [TrustedKey, TrustedKey];
    const samePub = { ...spare, pub: active.pub };
    for (const content of [releaseKeys, [...rootKeys, releaseKeys[0]], [], [active, active], [active], [active, samePub]]) {
      const file = path.join(keysDir, 'roots-bad.json');
      await fsp.writeFile(file, JSON.stringify(content));
      await expect(buildRelease(parseReleaseArgs(argv, { ...keyEnv, [RELEASE_KEY_ENV.rootKeys]: file }, tmp)), JSON.stringify(content)).rejects.toThrow(
        /^RELEASE_KEYS_INVALID:root keys/,
      );
    }
  });

  it('refuses a dirty working tree (DIRTY_TREE), or an unknown one, and writes nothing', async () => {
    const out = path.join(tmp, 'prod-dirty');
    const options = parseReleaseArgs(['--profile', 'production', '--version', '1.0.0', '--out', out], keyEnv, tmp);
    await expect(buildRelease({ ...options, source: { ...CLEAN_SOURCE, dirty: true } })).rejects.toThrow(/^DIRTY_TREE/);
    await expect(buildRelease({ ...options, source: { ...CLEAN_SOURCE, dirty: undefined } })).rejects.toThrow(/^DIRTY_TREE/);
    expect(existsSync(out)).toBe(false);
  });

  it('with --allow-dirty a dirty production build is stamped <commit>-dirty', async () => {
    const out = path.join(tmp, 'prod-dirty-allowed');
    const options = parseReleaseArgs(['--profile', 'production', '--version', '1.0.0', '--out', out, '--allow-dirty'], keyEnv, tmp);
    expect(options.allowDirty).toBe(true);
    const result = await buildRelease({ ...options, source: { ...CLEAN_SOURCE, dirty: true } });
    expect(result.manifest.buildId).toBe(`${CLEAN_SOURCE.commit}-dirty`);
    const zip = await fsp.readFile(result.zipFile);
    expect(JSON.parse(textOf(readZip(zip), 'bundled-release/1.0.0/manifest.json'))).toMatchObject({ buildId: `${CLEAN_SOURCE.commit}-dirty` });
    // A clean tree is never stamped, even when dirt is allowed.
    const clean = await buildRelease({ ...options, out: path.join(tmp, 'prod-clean-allowed'), source: CLEAN_SOURCE });
    expect(clean.manifest.buildId).toBe(CLEAN_SOURCE.commit);
  }, BUILD_TIMEOUT);

  it('command-line key options win over the environment', () => {
    const options = parseReleaseArgs(
      ['--profile', 'production', '--version', '1.0.0', '--out', 'rel', '--signing-key', 'cli.key.json'],
      { ...keyEnv, INIT_CWD: path.join(tmp, 'init') },
      tmp,
    );
    expect(options.keys).toEqual({
      signingKey: path.join(tmp, 'init', 'cli.key.json'),
      rootKeys: keyEnv[RELEASE_KEY_ENV.rootKeys],
      keyset: keyEnv[RELEASE_KEY_ENV.keyset],
    });
    expect(options.out).toBe(path.join(tmp, 'init', 'rel'));
  });
});

describe('guards', () => {
  it('an admin page (index.html, install.html) without the nonce placeholder, or with an inline script without it, is refused', () => {
    const page = (head: string, body = ''): string =>
      `<!doctype html><html><head><meta name="csp-nonce" content="__CSP_NONCE__">${head}</head><body>${body}</body></html>`;
    const asset = '<script type="module" crossorigin src="/admin/assets/install-Ab12_cD.js"></script>';
    expect(() => checkAdminPage('install.html', page(asset))).not.toThrow();
    expect(() => checkAdminPage('install.html', page(asset, '<script nonce="__CSP_NONCE__">boot()</script>'))).not.toThrow();
    expect(() => checkAdminPage('install.html', page(asset).replace('__CSP_NONCE__', 'x'))).toThrow(
      'ADMIN_BUILD_INVALID:install.html (no __CSP_NONCE__ placeholder for the CSP nonce)',
    );
    expect(() => checkAdminPage('install.html', page(asset, '<script>boot()</script>'))).toThrow(
      'ADMIN_BUILD_INVALID:install.html (an inline <script> without the __CSP_NONCE__ nonce)',
    );
    expect(() => checkAdminPage('index.html', page('<style>p{}</style>'))).toThrow('ADMIN_BUILD_INVALID:index.html (an inline <style>)');
    expect(() => checkAdminPage('index.html', page('<script src="https://cdn.example/x.js"></script>'))).toThrow(
      'ADMIN_BUILD_INVALID:index.html (a script not served from /admin/assets: https://cdn.example/x.js)',
    );
  });

  it('a bundled package licensed GPL-3.0 fails LICENSE_NOT_ALLOWED:<pkg>, and no zip is written', async () => {
    const pkg = path.join(tmp, 'fake', 'node_modules', 'evil-gpl');
    await fsp.mkdir(pkg, { recursive: true });
    await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'evil-gpl', version: '6.6.6', license: 'GPL-3.0' }));
    await fsp.writeFile(path.join(pkg, 'LICENSE'), 'GNU GENERAL PUBLIC LICENSE\n');
    await fsp.writeFile(path.join(pkg, 'index.js'), 'module.exports = 1;\n');
    const out = path.join(tmp, 'out-gpl');
    await expect(buildRelease({ profile: 'test', version: VERSION, out, extraBundleInputs: [path.join(pkg, 'index.js')] })).rejects.toThrow(
      /^LICENSE_NOT_ALLOWED:evil-gpl\b/,
    );
    expect(existsSync(path.join(out, `altis-${VERSION}.zip`))).toBe(false);
    expect(existsSync(path.join(out, 'build-report.json'))).toBe(false);
  }, BUILD_TIMEOUT);

  it('a .node file among the bundle inputs fails NATIVE_MODULE:<path>', async () => {
    const addon = path.join(tmp, 'fake', 'node_modules', 'native-thing', 'build', 'Release', 'addon.node');
    await fsp.mkdir(path.dirname(addon), { recursive: true });
    await fsp.writeFile(addon, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    const out = path.join(tmp, 'out-native');
    await expect(buildRelease({ profile: 'test', version: VERSION, out, extraBundleInputs: [addon] })).rejects.toThrow(
      new RegExp(`^NATIVE_MODULE:${addon.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`),
    );
    expect(existsSync(path.join(out, `altis-${VERSION}.zip`))).toBe(false);
  }, BUILD_TIMEOUT);

  it('refuses a version that is not SemVer, and an unknown profile', async () => {
    await expect(buildRelease({ profile: 'test', version: '1.0', out: path.join(tmp, 'x') })).rejects.toThrow(/^VERSION_INVALID/);
    expect(() => parseReleaseArgs(['--profile', 'staging', '--version', '1.0.0'], {}, tmp)).toThrow(/^BUILD_PROFILE_INVALID/);
    expect(() => parseReleaseArgs(['--profile', 'test'], {}, tmp)).toThrow(/^USAGE/);
    expect(() => parseReleaseArgs(['--profile', 'test', '--version', '1.0.0', '--bogus', 'x'], {}, tmp)).toThrow(/^USAGE/);
  });

  it('the default --out is <repository>/dist', () => {
    expect(parseReleaseArgs(['--profile', 'test', '--version', '0.1.0-test'], {}, tmp)).toMatchObject({ profile: 'test', out: path.join(REPO_ROOT, 'dist') });
  });

  it('--profile is required: there is no default profile', () => {
    expect(() => parseReleaseArgs(['--version', '1.2.0'], {}, tmp)).toThrow(/^USAGE: --profile/);
    expect(() => parseReleaseArgs(['--version', '0.1.0-test'], {}, tmp)).toThrow(/^USAGE: --profile/);
  });

  it('the profile is bound to the version: test needs a `test` prerelease, production refuses one', async () => {
    const out = path.join(tmp, 'out-mismatch');
    for (const version of ['1.2.0', '1.2.0-rc.1', '1.2.0+test']) {
      await expect(buildRelease({ profile: 'test', version, out }), version).rejects.toThrow(/^VERSION_PROFILE_MISMATCH/);
    }
    for (const version of ['1.2.0-test', '0.2.0-test.1', '1.0.0-rc.test', '1.0.0-TEST']) {
      await expect(buildRelease({ profile: 'production', version, out }), version).rejects.toThrow(/^VERSION_PROFILE_MISMATCH/);
    }
    // Accepted pairs get past the check (production then stops at its missing keys).
    const feedUrl = 'https://feed.example/altis';
    await expect(buildRelease({ profile: 'production', version: '1.2.0-rc.1', out, feedUrl })).rejects.toThrow(/^MISSING_RELEASE_KEY/);
    await expect(buildRelease({ profile: 'production', version: '1.2.0+build.7', out, feedUrl })).rejects.toThrow(/^MISSING_RELEASE_KEY/);
    expect(existsSync(out)).toBe(false);
  });

  it('the shipped keyset decides what app.js trusts: a root-signed revocation of the signer fails the build', async () => {
    const dir = path.join(tmp, 'revoking');
    await fsp.mkdir(dir, { recursive: true });
    const keyset = path.join(dir, 'keyset.json');
    await fsp.copyFile(path.join(DEV_KEYS, 'keyset.json'), keyset); // seq 1, signed by dev-root-1
    const payload = path.join(dir, 'revoke-payload.json');
    await fsp.writeFile(payload, JSON.stringify({ seq: 2, keys: [], revokedKids: ['dev-rel-1'] }));
    await altisSign(['keyset', 'sign', '--in', payload, '--key', path.join(DEV_KEYS, 'dev-root-1.key.json'), '--root-keys', path.join(DEV_KEYS, 'roots.json'), '--out', keyset]);
    const out = path.join(tmp, 'out-revoked');
    await expect(buildRelease({ profile: 'test', version: VERSION, out, keys: { keyset } })).rejects.toThrow(/^SIGNING_KEY_NOT_TRUSTED:dev-rel-1\b/);
    expect(existsSync(path.join(out, `altis-${VERSION}.zip`))).toBe(false);

    // A dev release key cannot sign the keyset of a test build either.
    await expect(
      altisSign(['keyset', 'sign', '--in', payload, '--key', path.join(DEV_KEYS, 'dev-rel-2.key.json'), '--root-keys', path.join(DEV_KEYS, 'roots.json'), '--out', keyset]),
    ).rejects.toThrow(
      /"root"/,
    );
  }, BUILD_TIMEOUT);
});

describe('passphrase-encrypted signing key (Task 8, preflight S11)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a test build whose signing key file is encrypted (ALTIS_KEY_PASSPHRASE set) succeeds and is signed by that key', async () => {
    // An encrypted dev- release key, trusted through a second document signed by the dev root.
    const dir = path.join(tmp, 'encrypted-key');
    vi.stubEnv(PASSPHRASE_ENV, 'release-pass');
    await altisSign(['keygen', '--use', 'release', '--kid', 'dev-rel-enc', '--out', dir, '--encrypt']);
    const keyFile = path.join(dir, 'dev-rel-enc.key.json');
    expect(Object.keys(JSON.parse(await fsp.readFile(keyFile, 'utf8')) as object).sort()).toEqual(['enc', 'kid', 'use']);
    const trusted = (JSON.parse(await fsp.readFile(path.join(dir, 'trusted.json'), 'utf8')) as TrustedKey[])[0]!;
    const keyset = path.join(dir, 'keyset.json');
    await fsp.copyFile(path.join(DEV_KEYS, 'keyset.json'), keyset);
    const payload = path.join(dir, 'payload.json');
    await fsp.writeFile(payload, JSON.stringify({ seq: 2, keys: [trusted], revokedKids: [] }));
    await altisSign(['keyset', 'sign', '--in', payload, '--key', path.join(DEV_KEYS, 'dev-root-1.key.json'), '--root-keys', path.join(DEV_KEYS, 'roots.json'), '--out', keyset]);

    // A wrong passphrase stops the build before anything is bundled.
    vi.stubEnv(PASSPHRASE_ENV, 'not-the-pass');
    const refusedOut = path.join(tmp, 'out-encrypted-refused');
    await expect(buildRelease({ profile: 'test', version: VERSION, out: refusedOut, keys: { signingKey: keyFile, keyset } })).rejects.toThrow(
      /^KEY_PASSPHRASE_INVALID/,
    );
    expect(existsSync(refusedOut)).toBe(false);

    vi.stubEnv(PASSPHRASE_ENV, 'release-pass');
    const out = path.join(tmp, 'out-encrypted');
    const result = await buildRelease({ profile: 'test', version: VERSION, out, keys: { signingKey: keyFile, keyset } });
    const entries = readZip(await fsp.readFile(result.zipFile));
    expect(JSON.parse(textOf(entries, `${RELEASE}/manifest.sig`))).toMatchObject({ kid: 'dev-rel-enc', typ: RELEASE_TYP });
    const appRoot = path.join(tmp, 'app-encrypted');
    await extractZip(await fsp.readFile(result.zipFile), appRoot);
    await expect(verifyReleaseWithRoots(path.join(appRoot, RELEASE), await devRootKeys(), { check: 'all' })).resolves.toMatchObject({ version: VERSION });
    // The passphrase is in no shipped file.
    for (const e of entries) expect(e.data.toString('utf8'), e.path).not.toContain('release-pass');
  }, BUILD_TIMEOUT);
});

describe('gitSourceState', () => {
  it('reads the commit, its date, and whether tracked files changed (untracked files do not count)', async (ctx) => {
    const repo = path.join(tmp, 'git-repo');
    await fsp.mkdir(repo, { recursive: true });
    const git = (...args: string[]): Promise<unknown> =>
      new Promise((resolve, reject) =>
        execFile('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo }, (e, out) =>
          e === null ? resolve(out) : reject(e),
        ),
      );
    try {
      await git('init', '-q');
    } catch {
      return ctx.skip(); // no git on this machine
    }
    await fsp.writeFile(path.join(repo, 'a.txt'), 'one\n');
    await git('add', 'a.txt');
    await git('commit', '-q', '-m', 'one', '--date', '2026-10-27T10:00:00Z');
    const clean = gitSourceState(repo);
    expect(clean.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof clean.committedAt).toBe('number');
    expect(clean.dirty).toBe(false);

    await fsp.writeFile(path.join(repo, 'untracked.txt'), 'x');
    expect(gitSourceState(repo).dirty).toBe(false);

    await fsp.writeFile(path.join(repo, 'a.txt'), 'two\n');
    expect(gitSourceState(repo).dirty).toBe(true);
    await git('add', 'a.txt');
    expect(gitSourceState(repo).dirty).toBe(true); // staged but not committed

    expect(gitSourceState(path.join(tmp, 'not-a-repo-at-all'))).toEqual({ commit: undefined, committedAt: undefined, dirty: undefined });
  });
});
