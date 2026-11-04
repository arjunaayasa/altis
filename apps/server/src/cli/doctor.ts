import http from 'node:http';
import type net from 'node:net';
import { WASM_HINT, bundledRelation, bundledReleaseBeside, wasmProbe } from '@altis/core';
import { verifyReleaseWithRoots, type KeysetReport, type TrustedKey } from '@altis/crypto';
import { checkServer, connect, listCatalogTables, releaseMigrations, type DbHandle } from '@altis/db';
import {
  checkDocroot,
  dataPath,
  ensureHeadroom,
  parseCurrentState,
  readJsonWithBak,
  resolvePort,
  sqliteAllowed,
  type CurrentState,
  type Env,
} from '@altis/platform';
// 1d Task 32 (L8): SQLite refused under a PM2 cluster.
import { pm2ClusterSignals } from '@altis/platform';
import { compareSemver, isDomainError, isSemver } from '@altis/shared';
import { createAdaptorServer } from '@hono/node-server';
import { createApp, type AppState } from '../app.js';
import { feedSourceOf, inspectConfig, type Config, type FeedSource } from '../config.js';
import { HEALTH_PATH } from '../http/health.js';
import type { BootContext } from '../index.js';
import { describeKeysets, embeddedRootKeys, installedKeysets, refusesDevKids } from '../release-keys.js';
import { describeFailure, describeKey, homeDir, nodeSupported } from './common.js';

// `node app.js doctor [--smoke] [--json]` (spec §13.6): diagnostics in the terminal. Every check is `{ok, detail}`;
// details are short, bilingual where they are prose, and never hold a secret or a config value other than the
// DATA_DIR path, the port, the runtime and versions (the config check names config.json's unknown keys and the
// source of the update feed, never a value).
//
// doctor itself changes nothing it does not have to: it never migrates; its headroom probe writes, fsyncs and removes
// a file in DATA_DIR/tmp (creating that folder when DATA_DIR exists); with --smoke it starts the app in this process
// on 127.0.0.1 and an ephemeral port, asks GET /_health, and closes everything again.
//
// DATA_DIR is another matter: run as `node app.js doctor`, app.js has already resolved DATA_DIR, created it (with
// tmp/ and releases/current.json) and proven it writable before runCli runs (spec §9.2 step 1), as for any command.
// So the dataDir check's "does not exist" answer only comes when doctor runs without app.js (in-process); what the
// check does show is which folder this shell resolved, so a shell that misses the server's ALTIS_DATA_DIR (set only
// in the hosting panel, say) shows a DATA_DIR that is not the server's.
//
// 1d Task 29 (§11, §9.3, §9.8):
// - `release` adds what current.json names (`pending`, `pinned`) and the release bundled beside app.js with its
//   relation to `pending ?? active` (§9.8), when current.json can be read.

export const DOCTOR_CHECKS = [
  'node',
  'runtime',
  'port',
  'dataDir',
  'docroot',
  'config',
  'db',
  'migrations',
  'release',
  'headroom',
  'wasm',
] as const;

export type CheckName = (typeof DOCTOR_CHECKS)[number];

export interface Check {
  ok: boolean;
  detail: string;
}

/** The config check: with a config.json that loaded, also what doctor found in it (decision D1d-2, preflight M11). */
export interface ConfigCheck extends Check {
  /** The keys of config.json this release does not know (dotted paths, sorted): ignored, maybe a typo. */
  unknownKeys?: string[];
  /** Where the update feed base comes from (config.ts feedSourceOf); null: there is none. */
  feedSource?: FeedSource | null;
}

export interface DoctorReport {
  /** Every check passed (and the smoke test, when it ran). */
  ok: boolean;
  checks: Record<CheckName, Check> & { config: ConfigCheck };
  smoke?: Check;
}

export interface DoctorOptions {
  nodeVersion: string;
  /**
   * Root keys to verify `ctx.release.dir` from (`check: 'all'`), in place of the ones embedded at build time (rulings
   * R62, R65); the keyset documents are read as app.js reads them. BootContext v1 carries none.
   */
  rootKeys?: readonly TrustedKey[];
  /** Refuse keyset documents that add a `dev-` key; default: a production build does (R65b). Tests pass their own. */
  refuseDevKids?: boolean;
  smoke: boolean;
}

/**
 * Written by the headroom check (L51, decision C23): 4 MiB, not the 32 MiB of 1a, which a host with a tight LVE I/O
 * limit (cPanel) notices; backups, uploads and updates prove their own sizes with ensureHeadroom when they run.
 */
export const DOCTOR_HEADROOM_BYTES = 4 * 1024 * 1024;
const SMOKE_TIMEOUT_MS = 10_000;

const pass = (detail: string): Check => ({ ok: true, detail });
const fail = (detail: string): Check => ({ ok: false, detail });
const SKIPPED = fail('dilewati: belum terpasang atau config.json tak terpakai / skipped: not installed or config.json unusable');

/** `CODE: detail` of a failure, safe to show (see describeFailure). */
function failed(error: unknown): Check {
  const { code, detail } = describeFailure(error);
  return fail(detail === '' ? code : `${code}: ${detail}`);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function nodeCheck(version: string): Check {
  return nodeSupported(version)
    ? pass(`Node ${version}`)
    : fail(`Node ${version}; perlu 22.16 atau lebih baru / needs 22.16 or newer`);
}

/**
 * The runtime this shell detected and, when config.json records another one (install.runtime, ruling R66), the one
 * the install was for: the server may run under that one (a shell never sees Passenger's or lsnode's markers). SQLite
 * fails the check when either of them cannot use it (P20), and (1d Task 32) under runtime pm2 when this process's
 * environment shows PM2's cluster signals.
 */
function runtimeCheck(runtime: BootContext['runtime'], config: Config | null, env: Env): Check {
  const installed = config?.install.runtime;
  const detail =
    installed === undefined || installed === runtime
      ? runtime
      : `${runtime} (shell ini / this shell); dipasang untuk / installed for ${installed}`;
  if (config?.db.dialect === 'sqlite') {
    const refused = [runtime, installed].find((r) => r !== undefined && !sqliteAllowed(r));
    if (refused !== undefined) {
      return fail(`${detail}: SQLite tidak dapat dipakai di runtime ${refused} / SQLite cannot be used on runtime ${refused}`);
    }
    const cluster = pm2ClusterRefusal(runtime, env);
    if (cluster !== null) return fail(`${detail}: ${cluster}`);
  }
  return pass(detail);
}

// 1d Task 32 (L8, decision D1d-36) -----------------------------------------------------------------------------

/**
 * SQLite under runtime pm2 with PM2's cluster signals in this process's environment (cluster mode, more than one
 * instance, an instance index other than 0): the reason the runtime check fails, naming them; null otherwise. The
 * boot refuses the same (apps/server/src/index.ts), which is where it matters: a doctor run from a terminal does not
 * get PM2's variables, so the PM2 guide (docs/install/pm2.md) also shows how to read the mode with `pm2 describe`.
 */
function pm2ClusterRefusal(runtime: BootContext['runtime'], env: Env): string | null {
  if (runtime !== 'pm2') return null;
  const signals = pm2ClusterSignals(env);
  if (signals.length === 0) return null;
  const named = signals.join(', ');
  return (
    `SQLite tidak dapat dipakai di PM2 mode cluster atau dengan lebih dari 1 instance (${named}); pakai mode fork dengan instances: 1 / ` +
    `SQLite cannot be used under PM2 cluster mode or with more than 1 instance (${named}); use fork mode with instances: 1`
  );
}

function portCheck(env: Env, config: Config | null): Check {
  try {
    const { port, source } = resolvePort(env, config?.port);
    return pass(`${port} (${source})`);
  } catch (error) {
    return failed(error);
  }
}

/**
 * dataDir and headroom from one probe: a file written, fsynced and removed in DATA_DIR/tmp. Under app.js DATA_DIR
 * always exists by now (app.js created it); ENOENT means doctor runs without app.js.
 */
async function storageChecks(dataDir: string): Promise<{ dataDir: Check; headroom: Check }> {
  const mb = DOCTOR_HEADROOM_BYTES / (1024 * 1024);
  try {
    await ensureHeadroom(dataDir, DOCTOR_HEADROOM_BYTES);
    return { dataDir: pass(`${dataDir} (dapat ditulis / writable)`), headroom: pass(`${mb} MB dapat ditulis / ${mb} MB writable`) };
  } catch (error) {
    if (isDomainError(error) && error.code === 'DISK_QUOTA') {
      return { dataDir: pass(`${dataDir} (dapat ditulis / writable)`), headroom: failed(error) };
    }
    const code = errorCode(error);
    const why =
      code === 'ENOENT'
        ? 'tidak ada / does not exist'
        : `tidak dapat ditulis / not writable${code === undefined ? '' : ` (${code})`}`;
    return { dataDir: fail(`${dataDir}: ${why}`), headroom: fail('tidak diuji: DATA_DIR tidak dapat ditulis / not tested: DATA_DIR is not writable') };
  }
}

function docrootCheck(ctx: BootContext, env: Env): Check {
  const result = checkDocroot({ dataDir: ctx.dataDir, appRoot: ctx.appRoot, home: homeDir(env) });
  if (result.ok) return pass('di luar document root / outside any document root');
  return result.reason === 'DATA_IN_APPROOT'
    ? fail(`DATA_DIR ada di dalam folder aplikasi / DATA_DIR lies inside the app folder: ${result.matched}`)
    : fail(`di dalam document root / inside the document root: ${result.matched}`);
}

/** How many unknown keys the config check's detail names; the JSON's `unknownKeys` has them all. */
const UNKNOWN_KEYS_SHOWN = 10;

const FEED_SOURCE_TEXT: Readonly<Record<FeedSource, string>> = { env: 'env', config: 'config.json', build: 'build' };

/**
 * The config check. A config.json that loaded also tells the feed source and the keys this release does not know
 * (D1d-2): they keep the check ok, as a newer release may have written them, and the detail ends with a warning that
 * names them, since a hand edit with a typo looks the same: each as describeKey shows a key of the operator's (L51:
 * `<key>` for anything but `[A-Za-z0-9_.-]{1,64}`). The detail names the source of the feed, never its URL.
 */
function configCheck(loaded: { config: Config; unknownKeys: string[] } | null, env: Env): ConfigCheck {
  if (loaded === null) return fail('belum terpasang (config.json tidak ada) / not installed (no config.json)');
  const { config, unknownKeys } = loaded;
  const feedSource = feedSourceOf(config, env);
  const notes = [`sumber feed / feed source: ${feedSource === null ? 'tidak ada / none' : FEED_SOURCE_TEXT[feedSource]}`];
  if (unknownKeys.length > 0) {
    const shown = unknownKeys.slice(0, UNKNOWN_KEYS_SHOWN).map(describeKey).join(', ') + (unknownKeys.length > UNKNOWN_KEYS_SHOWN ? ', …' : '');
    notes.push(`PERINGATAN / WARNING: kunci tak dikenal diabaikan / unknown keys ignored: ${shown}`);
  }
  const found = { unknownKeys, feedSource };
  if (config.installState !== 'complete') {
    return { ...fail(`instalasi belum selesai (${config.installState}) / the install did not finish (${config.installState}); ${notes.join('; ')}`), ...found };
  }
  return { ...pass(`terpasang, database ${config.db.dialect} / installed, database ${config.db.dialect}; ${notes.join('; ')}`), ...found };
}

/** The migration state, read without migrating; `tooOld` when this release is older than min_code_version. */
async function migrationsCheck(h: DbHandle, appVersion: string): Promise<{ check: Check; tooOld: boolean }> {
  const tables = await listCatalogTables(h);
  if (!tables.includes('schema_meta') || !tables.includes('schema_migrations')) {
    return { check: fail('belum ada skema; jalankan install / no schema yet; run install'), tooOld: false };
  }
  const meta = await h.db.selectFrom('schema_meta').select(['schema_version', 'min_code_version']).where('id', '=', 1).executeTakeFirst();
  if (meta === undefined || !isSemver(meta.min_code_version)) {
    return { check: fail('schema_meta tidak ada atau tidak valid / schema_meta is missing or invalid'), tooOld: false };
  }
  const schema = meta.schema_version;
  if (isSemver(appVersion) && compareSemver(appVersion, meta.min_code_version) < 0) {
    return {
      check: fail(`skema ${schema} memerlukan ALTIS ${meta.min_code_version}; ini ${appVersion} / schema ${schema} needs ALTIS ${meta.min_code_version}; this is ${appVersion}`),
      tooOld: true,
    };
  }
  const applied = new Set((await h.db.selectFrom('schema_migrations').select('name').execute()).map((row) => row.name));
  const known = Object.keys(releaseMigrations());
  const pending = known.filter((name) => !applied.has(name)).length;
  if (pending > 0) {
    return {
      check: fail(`skema ${schema}, ${pending} migrasi tertunda; jalankan migrate / schema ${schema}, ${pending} migration(s) pending; run migrate`),
      tooOld: false,
    };
  }
  const ahead = [...applied].some((name) => !known.includes(name));
  return {
    check: pass(
      ahead
        ? `skema ${schema}, lebih baru dari rilis ini (didukung) / schema ${schema}, newer than this release (supported)`
        : `skema ${schema}, mutakhir / schema ${schema}, up to date`,
    ),
    tooOld: false,
  };
}

/**
 * The release check: `ctx.release.dir` verified as a whole (`check: 'all'`: signature, every file, no extra file) with
 * the keys app.js trusts for it (rulings R62, R65): the root keys handed in, else those embedded at build time, plus
 * the keys that root-signed documents add: those of every keyset.json of the installation (R65a) and of the release
 * itself. Keyset documents that were ignored, kids bound to two keys and unusable keyset.json files are appended to
 * the detail (R65f). A server.mjs not bundled by the release build has no embedded keys: it reports app.js's check at
 * start.
 */
async function releaseCheck(ctx: BootContext, given: readonly TrustedKey[] | undefined, refuseDevKids: boolean): Promise<Check> {
  const { version, source, dir } = ctx.release;
  const roots = given ?? embeddedRootKeys();
  if (roots === undefined) {
    return pass(`${version} (${source}): diverifikasi oleh app.js saat mulai / verified by app.js at start`);
  }
  let report: KeysetReport | undefined;
  let skipped: Awaited<ReturnType<typeof installedKeysets>>['skipped'] = [];
  const withKeysets = (detail: string): string => {
    const notes = describeKeysets(report, skipped);
    return notes === '' ? detail : `${detail}; ${notes}`;
  };
  try {
    const installed = await installedKeysets(ctx.appRoot, ctx.dataDir);
    skipped = installed.skipped;
    await verifyReleaseWithRoots(dir, [...roots], {
      check: 'all',
      sources: installed.sources,
      refuseDevKids,
      onResolved: (resolved) => void (report = resolved),
    });
    return pass(withKeysets(`${version} (${source}): tanda tangan dan semua berkas cocok / signature and every file match`));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('RELEASE_INVALID:')) return fail(withKeysets(`${version} (${source}): ${error.message}`));
    return failed(error);
  }
}

// ---- 1d Task 29: pending, pinned and the bundled release in the release check -------------------------------------

/**
 * What the release check adds (see the top of this file): `pending …, pinned …, terbundel / bundled <v> (<relation>)`,
 * `-` for none; null when current.json cannot be read (app.js creates it: doctor run without app.js may find none).
 */
async function releaseFacts(ctx: BootContext): Promise<string | null> {
  let state: CurrentState | null;
  try {
    state = await readJsonWithBak(dataPath(ctx.dataDir, 'releases', 'current.json'), parseCurrentState);
  } catch {
    return null;
  }
  if (state === null) return null;
  const bundled = await bundledReleaseBeside(ctx.appRoot, ctx.dataDir, ctx.appJsVersion ?? null);
  const named = (version: string | null | undefined): string => version ?? '-';
  const beside = bundled === null ? '-' : `${bundled} (${bundledRelation(bundled, state)})`;
  return `pending ${named(state.pending?.version)}, pinned ${named(state.pinned)}, terbundel / bundled ${beside}`;
}

/** `check` with {@link releaseFacts} appended to its detail. */
async function withReleaseFacts(ctx: BootContext, check: Check): Promise<Check> {
  const facts = await releaseFacts(ctx);
  return facts === null ? check : { ...check, detail: `${check.detail}; ${facts}` };
}

/** P19: allocating WebAssembly memory fails on some hosts (virtual-memory limits) unless the trap handler is off. */
function wasmCheck(): Check {
  const probe = wasmProbe(); // 1c Task 23: the probe Diagnostik and the wizard use too
  if (probe.ok) return pass('WebAssembly.Memory 64 KiB');
  return fail(`WebAssembly.Memory gagal; coba ${probe.hint ?? WASM_HINT} / WebAssembly.Memory failed; try ${probe.hint ?? WASM_HINT}`);
}

// ---------------------------------------------------------------------------------------------------------------
// --smoke

function listenLocal(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      server.on('error', () => {}); // a late server error must not crash the CLI; the request then fails instead
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** GET http://127.0.0.1:<port><path> over node:http (P18), on a connection of its own. */
function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < 4096) body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.setTimeout(SMOKE_TIMEOUT_MS, () => req.destroy(new Error('smoke request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function healthStatus(body: string): string {
  try {
    const status = (JSON.parse(body) as { status?: unknown }).status;
    return typeof status === 'string' ? status : '?';
  } catch {
    return '?';
  }
}

/**
 * The smoke test (spec §12.4): the app of this release, in this process, on 127.0.0.1 and an ephemeral port, over the
 * open database; `GET /_health` must answer 200 `ok`. The server is closed before it returns, whatever happened.
 */
async function smokeCheck(ctx: BootContext, config: Config, h: DbHandle, tooOld: boolean): Promise<Check> {
  const state: AppState = { phase: tooOld ? 'too_old' : 'ready', db: h, baseUrl: config.baseUrl };
  const app = createApp({ state, version: ctx.release.version, buildId: ctx.release.version, log: ctx.log });
  const server = createAdaptorServer({ fetch: app.fetch }) as http.Server;
  try {
    const port = await listenLocal(server);
    const reply = await get(port, HEALTH_PATH);
    const status = healthStatus(reply.body);
    const line = `GET ${HEALTH_PATH} ${reply.status} ${status} (127.0.0.1:${port})`;
    return reply.status === 200 && status === 'ok' ? pass(line) : fail(line);
  } catch (error) {
    return failed(error);
  } finally {
    await closeServer(server);
  }
}

// ---------------------------------------------------------------------------------------------------------------

/** Runs every check (and the smoke test with `o.smoke`). Never throws for a failed check: that is in the report. */
export async function doctor(ctx: BootContext, env: Env, o: DoctorOptions): Promise<DoctorReport> {
  let config: Config | null = null;
  let configResult: ConfigCheck;
  try {
    const loaded = await inspectConfig(ctx.dataDir, env);
    config = loaded?.config ?? null;
    configResult = configCheck(loaded, env);
  } catch (error) {
    configResult = failed(error);
  }

  const storage = await storageChecks(ctx.dataDir);
  let db: Check = SKIPPED;
  let migrations: Check = SKIPPED;
  let smoke: Check | undefined;

  let h: DbHandle | undefined;
  try {
    if (config !== null) {
      try {
        h = await connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
        const server = await checkServer(h);
        const what = `${server.flavor} ${server.version}`;
        db = server.ok ? pass(what) : fail(`${what}: ${server.problems.join(', ')}`);
      } catch (error) {
        db = failed(error);
      }
    }
    let tooOld = false;
    if (h !== undefined) {
      try {
        ({ check: migrations, tooOld } = await migrationsCheck(h, ctx.release.version));
      } catch (error) {
        migrations = failed(error);
      }
      if (o.smoke && config?.installState === 'complete') smoke = await smokeCheck(ctx, config, h, tooOld);
    }
    if (o.smoke && smoke === undefined) {
      smoke =
        config?.installState === 'complete'
          ? fail('dilewati: database tidak tersedia / skipped: the database is not available')
          : fail('dilewati: belum terpasang / skipped: not installed');
    }
  } finally {
    await h?.close();
  }

  const results: Record<CheckName, Check> = {
    node: nodeCheck(o.nodeVersion),
    runtime: runtimeCheck(ctx.runtime, config, env),
    port: portCheck(env, config),
    dataDir: storage.dataDir,
    docroot: docrootCheck(ctx, env),
    config: configResult,
    db,
    migrations,
    release: await withReleaseFacts(ctx, await releaseCheck(ctx, o.rootKeys, o.refuseDevKids ?? refusesDevKids())), // 1d Task 29: facts
    headroom: storage.headroom,
    wasm: wasmCheck(),
  };
  const checks = Object.fromEntries(DOCTOR_CHECKS.map((name) => [name, results[name]])) as DoctorReport['checks'];
  const ok = DOCTOR_CHECKS.every((name) => checks[name].ok) && (smoke === undefined || smoke.ok);
  return smoke === undefined ? { ok, checks } : { ok, checks, smoke };
}
