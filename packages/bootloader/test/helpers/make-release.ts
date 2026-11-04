import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  COMPLETE_FILE,
  KEYSET_FILE,
  KEYSET_TYP,
  MANIFEST_FILE,
  RELEASE_TYP,
  SIGNATURE_FILE,
  buildManifest,
  signDetached,
  type KeysetDoc,
  type ReleaseManifest,
  type TrustedKey,
} from '@altis/crypto';

// Test releases for the bootloader: a fixture server.mjs that honours the bootloader contract v1 (spec §9.2; it
// serves through ctx.serve and never listens, ruling R64), or any given server.mjs (the real server bundle), and the
// dev keyset.json (signed by dev-root-1: it trusts the dev release keys, ruling R65), listed in a manifest signed with
// a dev release key (tools/keys/dev, test only), plus `.complete`.

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
export const DEV_KEYS_DIR = path.join(REPO_ROOT, 'tools', 'keys', 'dev');

/**
 * What the fixture's start(ctx) does:
 * - `ok`: serves (see below) through ctx.serve, then calls ctx.markHealthy();
 * - `reject`: serves, then rejects (an explicit boot failure, like Task 14's start()); 200 ms later it calls
 *   ctx.serve once more, as stray code of a failed release might;
 * - `throw-on-import`: the module throws while it is being imported;
 * - `crash`: serves, then the process exits with code 1 a moment later;
 * - `slow`: the import takes 1.5 s (a top-level await), then it serves like `ok`;
 * - `no-serve`: resolves without ever calling ctx.serve (a broken release).
 *
 * What happens to its handlers is appended to `<DATA_DIR>/fixture-events.txt`, one line each:
 * `retired <version>` once ctx.serve's promise resolves, `late-serve <version> <outcome>` for the stray call.
 *
 * 1d Task 16 (the import spy): each time server.mjs is evaluated (imported), before anything else it does, the line
 * `imported <version>` is appended to `<ALTIS_DATA_DIR>/fixture-imports.txt` (see {@link fixtureImports}).
 */
export type StartBehaviour = 'ok' | 'reject' | 'throw-on-import' | 'crash' | 'slow' | 'no-serve';

export interface Signer {
  kid: string;
  privateKey: KeyObject;
}

export interface MakeReleaseOptions {
  version: string;
  startBehaviour?: StartBehaviour;
  /** What runCli() returns. Default 7. */
  cliExitCode?: number;
  /** The key that signs manifest.json. Default dev-rel-1. */
  signer?: Signer;
  /** A server.mjs to ship instead of the fixture (the real server bundle); `startBehaviour` is then ignored. */
  serverFile?: string;
  /**
   * The keyset.json the release ships: its text, or `null` for none. Default: tools/keys/dev/keyset.json (dev-root-1
   * trusts dev-rel-1, dev-rel-2 and the other dev keys).
   */
  keyset?: string | null;
}

/** The size of the fixture's `/__end-then-reject` body: far more than one socket write takes at once. */
export const END_THEN_REJECT_BYTES = 8 * 1024 * 1024;

/** A private key from tools/keys/dev (`{kid, use, pkcs8}`). */
export function loadDevKey(kid: string): Signer {
  const file = JSON.parse(readFileSync(path.join(DEV_KEYS_DIR, `${kid}.key.json`), 'utf8')) as { kid: string; pkcs8: string };
  return { kid: file.kid, privateKey: createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' }) };
}

/** Every public dev key (tools/keys/dev/trusted.json): the dev root and the keys the dev keyset trusts. */
export function devTrustedKeys(): TrustedKey[] {
  return JSON.parse(readFileSync(path.join(DEV_KEYS_DIR, 'trusted.json'), 'utf8')) as TrustedKey[];
}

/** The dev trust anchors (tools/keys/dev/roots.json): what a test build of app.js embeds. */
export function devRootKeys(): TrustedKey[] {
  return JSON.parse(readFileSync(path.join(DEV_KEYS_DIR, 'roots.json'), 'utf8')) as TrustedKey[];
}

/** The text of the dev keyset (tools/keys/dev/keyset.json). */
export function devKeysetText(): string {
  return readFileSync(path.join(DEV_KEYS_DIR, 'keyset.json'), 'utf8');
}

/** An `altis-keyset/1` document `{raw, env}` over `payload`, signed by `signer` (dev-root-1 unless told otherwise). */
export function keysetDoc(payload: unknown, signer: Signer = loadDevKey('dev-root-1')): KeysetDoc {
  return { raw: JSON.stringify(payload), env: signDetached(payload, { typ: KEYSET_TYP, kid: signer.kid, privateKey: signer.privateKey }) };
}

/**
 * The fixture server. Routes:
 * - `/_health`: 200 `{status:'ok', version, source, pid, runtime}`;
 * - `/__ctx`: what the bootloader handed over (no functions; 1d Task 16: `pendingBoot`, `bootMode`, `bundledRelease`, and
 *   `bootMarker`'s member names);
 * - `/__restart`: calls ctx.requestRestart('fixture'), then 202;
 * - `/__exit?code=<n>`: answers 202, then process.exit(n);
 * - `/__throw`: the handler throws (app.js must answer 500 and keep serving);
 * - `POST /_cron`: 200 `{cron: 'ran', version}` (the release took a cron call app.js held while it loaded, R1c-14);
 * - `/__end-then-reject`: ends a 200 response of END_THEN_REJECT_BYTES bytes, then returns a rejected promise (app.js
 *   must log it and leave the response alone).
 * SIGTERM exits 0. runCli() prints `{argv, version, runtime, serve}` (`serve`: what ctx.serve did, `missing`,
 * `accepted` or `refused`; a command has no server) and returns `cliExitCode`.
 */
function serverSource(behaviour: StartBehaviour, cliExitCode: number, version: string): string {
  return `import fs from 'node:fs';
import path from 'node:path';

export const bootProtocol = 1;
const BEHAVIOUR = ${JSON.stringify(behaviour)};
const CLI_EXIT = ${JSON.stringify(cliExitCode)};
const VERSION = ${JSON.stringify(version)};

if (typeof process.env.ALTIS_DATA_DIR === 'string' && process.env.ALTIS_DATA_DIR !== '') {
  fs.mkdirSync(process.env.ALTIS_DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(process.env.ALTIS_DATA_DIR, 'fixture-imports.txt'), 'imported ' + VERSION + '\\n');
}

if (BEHAVIOUR === 'throw-on-import') throw new Error('fixture: import failed');
if (BEHAVIOUR === 'slow') await new Promise((resolve) => setTimeout(resolve, 1500));

function event(ctx, line) {
  fs.appendFileSync(path.join(ctx.dataDir, 'fixture-events.txt'), line + '\\n');
}

export async function start(ctx) {
  if (BEHAVIOUR === 'no-serve') return;
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/_health') {
      return send(200, { status: 'ok', version: ctx.release.version, source: ctx.release.source, pid: process.pid, runtime: ctx.runtime });
    }
    if (url.pathname === '/__ctx') {
      return send(200, {
        keys: Object.keys(ctx).sort(),
        bootProtocol: ctx.bootProtocol,
        appRoot: ctx.appRoot,
        dataDir: ctx.dataDir,
        release: ctx.release,
        runtime: ctx.runtime,
        port: ctx.port,
        appJsVersion: ctx.appJsVersion,
        pendingBoot: ctx.pendingBoot,
        bootMode: ctx.bootMode,
        bundledRelease: ctx.bundledRelease,
        bootMarker: Object.keys(ctx.bootMarker).sort(),
      });
    }
    if (url.pathname === '/__restart') {
      ctx.requestRestart('fixture').then(
        () => send(202, { ok: true }),
        (error) => send(500, { error: String(error) }),
      );
      return;
    }
    if (url.pathname === '/__exit') {
      const code = Number(url.searchParams.get('code'));
      res.writeHead(202);
      res.end(() => process.exit(code));
      return;
    }
    if (url.pathname === '/__throw') throw new Error('fixture: handler failed');
    if (url.pathname === '/_cron' && req.method === 'POST') return send(200, { cron: 'ran', version: ctx.release.version });
    if (url.pathname === '/__end-then-reject') {
      const body = 'x'.repeat(${END_THEN_REJECT_BYTES});
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(body.length) });
      res.end(body);
      return Promise.reject(new Error('fixture: failed after the response ended'));
    }
    send(404, {});
  };
  ctx.serve(handler).then(() => event(ctx, 'retired ' + ctx.release.version));
  ctx.bootMarker.phase('listening');
  process.on('SIGTERM', () => process.exit(0));
  if (BEHAVIOUR === 'reject') {
    setTimeout(() => {
      try {
        const late = ctx.serve((req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', hijackedBy: ctx.release.version }));
        });
        late.then(() => event(ctx, 'late-serve ' + ctx.release.version + ' resolved'));
      } catch (error) {
        event(ctx, 'late-serve ' + ctx.release.version + ' threw');
      }
    }, 200);
    throw new Error('fixture: start failed');
  }
  if (BEHAVIOUR === 'crash') setTimeout(() => process.exit(1), 50);
  await ctx.markHealthy();
}

export async function runCli(argv, ctx) {
  let serve = 'missing';
  if (typeof ctx.serve === 'function') {
    try {
      ctx.serve(() => {});
      serve = 'accepted';
    } catch {
      serve = 'refused';
    }
  }
  process.stdout.write(JSON.stringify({ argv, version: ctx.release.version, runtime: ctx.runtime, serve }) + '\\n');
  return CLI_EXIT;
}
`;
}

/**
 * Writes a complete, signed release into `dir` (created when missing): `server.mjs` (the fixture, or a copy of
 * `serverFile`), `keyset.json` (the dev keyset unless `keyset` says otherwise), `manifest.json`, `manifest.sig`
 * (signed with dev-rel-1 unless `signer` says otherwise) and `.complete`.
 */
export async function makeRelease(dir: string, o: MakeReleaseOptions): Promise<ReleaseManifest> {
  await fsp.mkdir(dir, { recursive: true });
  if (o.serverFile !== undefined) await fsp.copyFile(o.serverFile, path.join(dir, 'server.mjs'));
  else await fsp.writeFile(path.join(dir, 'server.mjs'), serverSource(o.startBehaviour ?? 'ok', o.cliExitCode ?? 7, o.version));
  const keyset = o.keyset === undefined ? devKeysetText() : o.keyset;
  if (keyset !== null) await fsp.writeFile(path.join(dir, KEYSET_FILE), keyset);
  const manifest = await buildManifest(dir, {
    version: o.version,
    buildId: 'fixture',
    bootProtocol: 1,
    releasedAt: '2026-10-27',
    schemaLatest: '0003',
    minCodeVersionAfter: '0.1.0-test',
    minUpgradeFrom: '0.0.0',
    minNode: '22.16.0',
    minDb: { mysql: '8.0', mariadb: '10.6', postgres: '15' },
  });
  const signer = o.signer ?? loadDevKey('dev-rel-1');
  const envelope = signDetached(manifest, { typ: RELEASE_TYP, kid: signer.kid, privateKey: signer.privateKey });
  await fsp.writeFile(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, SIGNATURE_FILE), `${JSON.stringify(envelope, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, COMPLETE_FILE), '');
  return manifest;
}

/** The versions whose server.mjs was imported in this DATA_DIR, in order (the fixture's import spy, see above). */
export async function fixtureImports(dataDir: string): Promise<string[]> {
  const text = await fsp.readFile(path.join(dataDir, 'fixture-imports.txt'), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.replace(/^imported /, ''));
}
