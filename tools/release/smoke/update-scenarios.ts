import { createHash, createHmac, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonicalize, signDetached } from '@altis/crypto';
import { FEED_TYP, FRESHNESS_TYP } from '@altis/crypto/feed';
import { connect, type DbConfig, type DbHandle } from '@altis/db';
import { readCurrentState } from '@altis/platform';
import type { OpView } from '@altis/shared/api/ops';
import type { UpdateOpResponse, UpdateUploadDryRun, UpdatesView } from '@altis/shared/api/updates';
import { buildFeed } from '../feed/build.js';
import { startFeedDev, type FeedDev } from '../feed/serve.js';
import { extractZip, readZip } from '../src/zip.js';
import {
  CookieJar,
  HEALTH_TIMEOUT_MS,
  REPO_ROOT,
  SmokeError,
  SmokeSession,
  UPDATE_DONE_BUDGET_MS,
  UPDATE_SIM_IDLE_MS,
  baseEnv,
  composeCommand,
  execCommand,
  httpSend,
  isStartingPage,
  messageOf,
  mustRun,
  pm2Command,
  problemCode,
  provisionDb,
  say,
  sleep,
  startProcess,
  startScenarioSim,
  stopTracked,
  waitHealthy,
  writePrivateFile,
  type Command,
  type HttpReply,
  type RunContext,
  type UpdateScenario,
} from './run.js';

// The update scenarios of the smoke run (1d Task 35; acceptance A7, A9, §12.7; Review Focus 1, 3 and 4):
//
//   pnpm smoke --zip <N−1 zip> --to-zip <N zip> --target <t> --db <engine> --scenario <s>
//
// After the smoke run's install and measurements, the install of release N−1 (`--zip`) is seeded through its API (the
// library profile, two branches, a role, two staff, one of them with 2FA) and updated to release N (`--to-zip`). The
// feed is the one `buildFeed` (tools/release/feed) signs with the dev keys from N's zip, served on 127.0.0.1 by
// feed-dev (`--feed <dir>` serves a feed built beforehand instead), and the install is pointed at it with
// `node app.js config:set update.feedUrl <url>`, as a field tester would. The admin acts as the SPA does: `POST
// updates/check`, `GET updates`, a re-authentication, `POST updates/apply`. From there only what `/admin/_update`
// does moves the op: `GET /api/v1/ops/current` every 2 s and, while the op is driveable and the server has no worker
// (`external`: passenger-sim), `POST ops/drive`, both with the `altis_ops` cookie alone (and the op's CSRF token);
// mid-update the page is loaded again (`GET /admin/_update`), as a reload or a second tab would. The data checksums
// (every `data` and `config` table, `settings` of scope `data`; notifications, the scheduler's run times and sign-in
// times aside) are taken right before the apply and compared at the end. On passenger-sim the sim runs with no cron and an idle time of 5 s
// (UPDATE_SIM_IDLE_MS): a worker that served nothing for 5 s is stopped, whatever it was doing in the background.
//
//   update            A7, §12.7: N−1 → N; `done` within UPDATE_DONE_BUDGET_MS (120 s) of the apply, N serving, the
//                     data checksums equal. The report's `applyToDoneMs` is what `pnpm perf` takes (perf/measure.ts).
//   update-faults     A7: for each of `migrate:<N's first new migration>`, `health:<N>`, `boot-crash:<N>`,
//                     `download-corrupt`, `disk-full:releases:1` (ALTIS_TEST_FAULT of the served app, which is
//                     restarted with it): the op ends `rolled_back` (the first three, past the point of no return) or
//                     `aborted` (`UPDATE_PACKAGE_INVALID`, `DISK_QUOTA`), N−1 serves again, maintenance is off and the
//                     data checksums are equal.
//   update-kill       Review Focus 1 (nightly, passenger-sim, max-pool 6): `migrate-slow:160`, cumulative across the
//                     processes that hold the migration (Task 9, preflight S22), with the 5 s idle time and bursts of
//                     6 concurrent requests that make the sim spawn workers: the op never reverts, then `done`.
//   rollback-restore  §9.7 "terlalu lama": `--zip` N (0.2) → `--to-zip` N+1 (0.3, whose contract migration raises
//                     `min_code_version` past N) with `health:<N+1>`: N reverts by restoring the `pre_update` backup
//                     (`restoring` → `restored`); the data checksums are equal and the seeded 2FA user signs in.
//   rollback-manual   §9.7, D1d-33: N−1 → N, then `POST updates/rollback` (N−1 again, N pinned), `release:unpin`, N
//                     again, then `node app.js release:rollback`: N−1 serves, the data checksums equal throughout.
//   update-offline    §9.6 offline: N's zip uploaded in chunks (`files/uploads`, context `update`), `POST
//                     updates/upload {dryRun: true}` (N, prechecks ok), a re-authentication, the real call → `done`.
//   rejections        A7, Review Focus 3: a feed with a bad signature, a feed signed as `altis-license/1` (a typ
//                     of another key use), a feed signed by `dev-rel-2` that the same feed revokes, a feed whose
//                     freshness has expired → each check stored `FEED_INVALID` and offers nothing; a feed listing
//                     only N−1 → nothing offered, `POST updates/apply` → `UPDATE_NONE`. The community edition
//                     entitles every release, so no precheck refuses N for `entitlement` here. The version stays N−1
//                     throughout. Checks are throttled to one a minute, so this takes ~5 min.
//   docker-pull       A7 "image lama sudah tidak ada", preflight 1D-15, §9.8. Two legs, each release delivered whole:
//                     on Docker a new image (`up` of the app container on it), on standalone (the local proof of the
//                     same boot path, no Docker needed) the zip unpacked over the app folder.
//                     1. Data mode: N−1 → release N (`--to-zip` #1): the running release updates the install from
//                        `verified` with a `pre_update` backup (`done`); then N+1 (`--to-zip` #2) with `health:<N+1>`
//                        after its contract migration, N's image deleted: N, from DATA_DIR/releases, reverts through
//                        `restoring` → `restored` (op.json); the data and the 2FA user as before.
//                     2. Image mode (`ALTIS_RELEASE_SOURCE=image` from a fresh install of N−1 on): one-click hidden,
//                        nothing copied or adopted into DATA_DIR/releases; release N boots in schemaHold and updates
//                        the install itself (`self`, `pre_update` backup, `previous` null); N+1 with `health:<N+1>`, N's
//                        image deleted: `restore_failed`, UPDATE_SCHEMA_HOLD_FAILED naming the backup, maintenance kept;
//                        N again ("re-pull"), then what the instruction says, `node app.js maintenance:off` and
//                        `node app.js backup:restore <id>`: the data and the 2FA user as before.
//   zip-reupload      §9.8 (standalone): N's zip unpacked over the app folder of the N−1 install while it is stopped,
//                     then started: the bundled release updates the install by itself (no feed, no page) → N serving,
//                     the data checksums equal.
//
// On Docker the data checksums are not taken (the database has no published port); the scenario compares what the API
// shows of the seeded data instead (users, roles, branches, the library profile). Everything else is as above.

const DEV_KEYS = path.join(REPO_ROOT, 'tools', 'keys', 'dev');
const devKeyFile = (kid: string): string => path.join(DEV_KEYS, `${kid}.key.json`);
const DEV_KEYSET = path.join(DEV_KEYS, 'keyset.json');
const DEV_ROOTS = path.join(DEV_KEYS, 'roots.json');

/** How often the page polls `ops/current` (apps/server ops/update-script.ts POLL_MS). */
const PAGE_POLL_MS = 2000;
/** What the page waits after a drive that changed nothing (update-script.ts PACE_MS). */
const PAGE_PACE_MS = 1500;
/** How long an update scenario may take (a CI job has 30 minutes). */
const UPDATE_SCENARIO_TIMEOUT_MS = 20 * 60_000;
/** How long one op may take from its begin to its end (update-kill: a 160 s migration plus the boot protocol). */
const OP_TIMEOUT_MS = 10 * 60_000;
/** update-kill: the cumulative migration hold (§12.5 "menahan migrasi > 150 detik"). */
export const UPDATE_KILL_FAULT = 'migrate-slow:160';
/** update-kill: the requests of one burst (Passenger's max pool of the nightly). */
export const UPDATE_KILL_BURST = 6;
/** The states of an update op after which it has left the release that began it (a page reload is simulated there). */
const MID_UPDATE_STATES = new Set(['frozen', 'backed_up', 'staged', 'switched', 'booting', 'migrating', 'verifying']);
/** The states of an update op that revert it (update-kill must never see one). */
const REVERT_STATES = new Set(['reverting', 'rolled_back', 'restoring', 'restored', 'restore_failed']);

/** The update faults of update-faults for an update to `to` whose first new migration is `migration`, and their ends. */
export function updateFaults(to: string, migration: string): { fault: string; state: 'rolled_back' | 'aborted'; code: string | null }[] {
  return [
    { fault: `migrate:${migration}`, state: 'rolled_back', code: null },
    { fault: `health:${to}`, state: 'rolled_back', code: null },
    { fault: `boot-crash:${to}`, state: 'rolled_back', code: null },
    { fault: 'download-corrupt', state: 'aborted', code: 'UPDATE_PACKAGE_INVALID' },
    { fault: 'disk-full:releases:1', state: 'aborted', code: 'DISK_QUOTA' },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// What a scenario has at hand

interface Release {
  zip: string;
  version: string;
}

interface UpdateRun {
  ctx: RunContext;
  port: number;
  from: Release;
  to: Release[];
  detail: Record<string, unknown>;
  admin: SmokeSession;
  password: string;
  /** The seeded 2FA user: its password and TOTP secret. */
  totpUser: { username: string; password: string; secret: Uint8Array } | null;
  /** The feed folder feed-dev serves and its base URL. */
  feed: { dir: string; url: string; dev: FeedDev } | null;
  /** Docker: the image the app container runs when it is not the run's own (docker-pull); null: the run's. */
  image: string | null;
  checkTime(what: string): void;
}

// ---------------------------------------------------------------------------------------------------------------
// The served app: restarts with a test fault, and `node app.js <command>` as the install ran it

/** The runtime the install ran under (run.ts planSmoke): `node app.js` commands run under it too. */
function runtimeEnv(u: UpdateRun): Record<string, string> {
  const t = u.ctx.o.target;
  return t === 'passenger-sim' ? { ALTIS_RUNTIME: 'passenger' } : t === 'pm2' ? { ALTIS_RUNTIME: 'pm2' } : {};
}

/** `node app.js <args>` of the install (Docker: inside the running app container). */
function cliCommand(u: UpdateRun, label: string, args: readonly string[], env: Record<string, string> = {}): Command {
  const { layout, plan, o } = u.ctx;
  if (o.target === 'docker') {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]);
    return composeCommand(layout, o.db, plan.start.env, label, ['exec', '-T', ...envArgs, 'app', 'node', '/app/app.js', ...args]);
  }
  return { label, file: process.execPath, args: ['app.js', ...args], cwd: layout.appRoot, env: { ...baseEnv(), ALTIS_DATA_DIR: layout.dataDir, ...runtimeEnv(u), ...env } };
}

/** `node app.js <args>` to its end, exit 0 required; its stdout. */
async function appCli(u: UpdateRun, label: string, args: readonly string[], env: Record<string, string> = {}): Promise<string> {
  say(`node app.js ${args.join(' ')}…`);
  return (await mustRun(cliCommand(u, label, args, env), u.ctx.layout.logDir)).stdout.trim();
}

let restarts = 0;

/**
 * Starts the served app again with `env` added to the plan's environment (a test fault), and waits until /_health
 * answers `ok` (with `version`, when given). standalone: `node app.js` again; passenger-sim: the sim again (5 s idle
 * time); pm2: `pm2 restart --update-env`; Docker: the app container recreated with an override that adds `env`.
 */
async function restartServed(u: UpdateRun, env: Record<string, string>, version: string | null): Promise<void> {
  await startServed(u, env);
  await waitServing(u, version);
}

/** {@link restartServed} without the wait: the caller watches what the boot does (a schemaHold boot never says `ok`). */
async function startServed(u: UpdateRun, env: Record<string, string>): Promise<void> {
  const { ctx } = u;
  const { layout, plan, o } = ctx;
  restarts += 1;
  say(`restarting the ${o.target} app${Object.keys(env).length === 0 ? '' : ` with ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}`}…`);
  if (o.target === 'standalone') {
    await ctx.stopServer?.();
    const proc = startProcess({ ...plan.start, label: `start-${restarts}`, env: { ...plan.start.env, ...env } }, layout.logDir);
    const stop = (): Promise<void> => stopTracked(proc);
    ctx.onCleanup(stop);
    ctx.stopServer = stop;
  } else if (o.target === 'passenger-sim') {
    const start = plan.start;
    plan.start = { ...start, env: { ...start.env, ...env } };
    try {
      await startScenarioSim(ctx, UPDATE_SIM_IDLE_MS);
    } finally {
      plan.start = start;
    }
  } else if (o.target === 'pm2') {
    await mustRun(pm2Command(layout, { ...plan.start.env, ...env }, `pm2-restart-${restarts}`, ['restart', 'ecosystem.config.cjs', '--update-env']), layout.logDir);
  } else {
    await writeDockerEnvOverride(u, env, u.image ?? undefined);
    await mustRun(dockerCompose(u, `docker-up-${restarts}`, ['up', '--detach', '--no-deps', '--force-recreate', 'app']), layout.logDir);
    // The feed server lives in the app container (dockerFeed): a new container needs it started again.
    if (u.feed !== null) await startDockerFeedServer(u);
  }
}

/** The extra compose file of the Docker scenarios: the app's environment (a test fault, the release source). */
function dockerEnvFile(u: UpdateRun): string {
  return path.join(u.ctx.layout.root, 'compose.update.yml');
}

async function writeDockerEnvOverride(u: UpdateRun, env: Record<string, string>, image?: string): Promise<void> {
  const lines = ['# Generated by tools/release/smoke/update-scenarios.ts.', 'services:', '  app:'];
  if (image !== undefined) lines.push(`    image: ${image}`);
  lines.push('    environment:');
  for (const [k, v] of Object.entries({ ALTIS_TEST_FAULT: '', ...env })) lines.push(`      ${k}: ${JSON.stringify(v)}`);
  await fsp.writeFile(dockerEnvFile(u), `${lines.join('\n')}\n`);
}

/** `docker compose …` of the run with the scenario's override last (which must exist: writeDockerEnvOverride). */
function dockerCompose(u: UpdateRun, label: string, args: string[], stdin?: string): Command {
  const base = composeCommand(u.ctx.layout, u.ctx.o.db, u.ctx.plan.start.env, label, [], stdin);
  return { ...base, args: [...base.args, '-f', dockerEnvFile(u), ...args] };
}

/** /_health answers `ok` (with `version` when given) within HEALTH_TIMEOUT_MS. */
async function waitServing(u: UpdateRun, version: string | null): Promise<void> {
  const t0 = performance.now();
  for (;;) {
    const healthy = await waitHealthy(u.port, HEALTH_TIMEOUT_MS);
    if (version === null || healthy.version === version) return;
    if (performance.now() - t0 > HEALTH_TIMEOUT_MS) throw new SmokeError(`/_health reports ${String(healthy.version)}, expected ${version}`);
    await sleep(500);
  }
}

/** The version /_health reports now (null: not `ok`). */
async function servedVersion(u: UpdateRun): Promise<string | null> {
  try {
    const reply = await httpSend(u.port, 'GET', '/_health', {}, undefined, 10_000);
    const body = JSON.parse(reply.body) as { status?: unknown; version?: unknown };
    return reply.status === 200 && body.status === 'ok' && typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The feed

/** Starts feed-dev on an empty folder of the run (or on `--feed`'s folder) and points the install at it. */
async function startFeed(u: UpdateRun): Promise<{ dir: string; url: string; dev: FeedDev }> {
  const dir = u.ctx.o.feed ?? path.join(u.ctx.layout.root, 'feed');
  await fsp.mkdir(dir, { recursive: true });
  const dev = await startFeedDev({ dir });
  u.ctx.onCleanup(() => dev.close());
  u.feed = { dir, url: dev.url, dev };
  if (u.ctx.o.target === 'docker') {
    // The container cannot reach this host's 127.0.0.1: the feed folder is copied into /data and served there by a
    // plain static server on the container's loopback (plain http to loopback is what a test build allows).
    u.feed.url = await dockerFeed(u, dir);
  }
  await appCli(u, 'config-set-feed', ['config:set', 'update.feedUrl', u.feed.url]);
  // The running app sees the new config.json through its config fence, which looks at the file on a request at most
  // every 2 s (D34): a check queued sooner would still have no feed URL. Wait out one look, then make a request.
  await sleep(2500);
  await u.admin.me();
  await u.admin.me();
  u.detail['feed'] = u.ctx.o.feed === null ? 'built by the run' : `--feed ${u.ctx.o.feed}`;
  return u.feed;
}

/** The signed feed of `zips` (dev keys) in the feed folder, `seq` given; the install's check reads it next. */
async function publishFeed(u: UpdateRun, zips: string[], seq: number, o: { releaseKey?: string } = {}): Promise<Awaited<ReturnType<typeof buildFeed>>> {
  const feed = u.feed!;
  const built = await buildFeed({
    zips,
    channel: 'stable',
    baseUrl: u.ctx.o.target === 'docker' ? feed.url : feed.dev.url,
    out: feed.dir,
    releaseKey: o.releaseKey ?? devKeyFile('dev-rel-1'),
    timestampKey: devKeyFile('dev-ts-1'),
    keyset: DEV_KEYSET,
    seq,
    expiresInDays: 14,
    ...(o.releaseKey === undefined ? { rootKeys: DEV_ROOTS } : {}),
  });
  if (u.ctx.o.target === 'docker') await dockerFeedSync(u);
  return built;
}

const DOCKER_FEED_PORT = 8790;
/** A static file server for the container's loopback (plain CommonJS for the image's Node; GET and Range only). */
const DOCKER_FEED_SERVER = `'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2], port = Number(process.argv[3]);
http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep) || rel.includes('..')) { res.writeHead(404); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    const m = /^bytes=(\\d+)-$/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    if (start >= st.size && st.size > 0) { res.writeHead(416, { 'content-range': 'bytes */' + st.size }); return res.end(); }
    res.writeHead(m ? 206 : 200, Object.assign({ 'content-length': st.size - start, 'accept-ranges': 'bytes', 'cache-control': 'no-store' },
      m ? { 'content-range': 'bytes ' + start + '-' + (st.size - 1) + '/' + st.size } : {}));
    fs.createReadStream(file, { start }).pipe(res);
  });
}).on('error', () => process.exit(0)).listen(port, '127.0.0.1');
`;

/** Docker: the feed server inside the app container (detached), serving /data/smoke-feed. */
async function dockerFeed(u: UpdateRun, dir: string): Promise<string> {
  await fsp.writeFile(path.join(dir, '.server.cjs'), DOCKER_FEED_SERVER);
  await dockerFeedSync(u);
  await startDockerFeedServer(u);
  return `http://127.0.0.1:${DOCKER_FEED_PORT}`;
}

/**
 * Starts the feed server of {@link dockerFeed} in the running app container (the files stay on the /data volume). A
 * container restarted by the app itself (P14: an update, a revert) loses it, so every check and apply starts it again;
 * a second one finds the port taken and exits quietly.
 */
async function startDockerFeedServer(u: UpdateRun): Promise<void> {
  await mustRun(dockerCompose(u, 'docker-feed-server', ['exec', '-d', '-T', 'app', 'node', '/data/smoke-feed/.server.cjs', '/data/smoke-feed', String(DOCKER_FEED_PORT)]), u.ctx.layout.logDir);
}

async function dockerFeedSync(u: UpdateRun): Promise<void> {
  await mustRun(dockerCompose(u, 'docker-feed-cp', ['cp', `${u.feed!.dir}/.`, 'app:/data/smoke-feed']), u.ctx.layout.logDir);
}

// ---------------------------------------------------------------------------------------------------------------
// TOTP (RFC 6238, as the server's packages/core auth/totp.ts: SHA-1, 6 digits, 30 s): the seeded 2FA user's app

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index === -1) throw new Error('base32Decode: not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** The TOTP code of `secret` for time step `step`. */
export function totpCode(secret: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

const usedSteps = new Map<string, number>();

/** A code the server has not seen for `user` yet (the server refuses a step at or before the last one used). */
async function nextTotp(user: string, secret: Uint8Array): Promise<string> {
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    const last = usedSteps.get(user) ?? -1;
    const pick = step > last ? step : step + 1 > last ? step + 1 : null;
    if (pick !== null) {
      usedSteps.set(user, pick);
      return totpCode(secret, pick);
    }
    await sleep(30_000 - (Date.now() % 30_000) + 250);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The seed and what is compared

/** A fresh sign-in of the first super admin (a restarted app, or sessions a restore replaced). */
async function signInAdmin(u: UpdateRun): Promise<void> {
  u.admin = new SmokeSession(u.port);
  await u.admin.signIn(u.ctx.plan.installInput.admin.username, u.password);
}

/** The seed of an update scenario, through the API as the first super admin (and the 2FA user as itself). */
async function seed(u: UpdateRun): Promise<void> {
  const s = u.admin;
  await s.call('POST', 'auth/reauth', { password: u.password });
  await s.call('PUT', 'settings/library', { name: 'Perpustakaan Uji Pembaruan', address: 'Jalan Rilis 2' });
  for (const [code, name] of [
    ['UTARA', 'Cabang Utara'],
    ['SELATAN', 'Cabang Selatan ✓'],
  ] as const) {
    await s.call('POST', 'branches', { code, name, address: `Jalan ${name}`, timezone: 'Asia/Jakarta' });
  }
  const role = await s.call<{ id: string }>('POST', 'roles', { name: 'Petugas Uji Pembaruan', description: 'Peran uji pembaruan', permissions: ['system.users.read'] });
  const users: { username: string; password: string }[] = [];
  for (const i of [1, 2]) {
    const password = `${randomBytes(12).toString('hex')}-Uji`;
    const username = `staf_upd_${i}`;
    const user = await s.call<{ id: string }>('POST', 'users', { username, name: `Staf Uji ${i}`, email: `staf${i}@update.test`, password });
    await s.call('PUT', `users/${user.id}/roles`, { assignments: [{ roleId: role.id, branchId: null }] });
    users.push({ username, password });
  }
  // The second staff member enables 2FA, as a person does (setup, then a code of the secret).
  const staff = users[1]!;
  const own = new SmokeSession(u.port);
  await own.signIn(staff.username, staff.password);
  const setup = await own.call<{ secret: string }>('POST', 'auth/2fa/setup');
  const secret = base32Decode(setup.secret);
  await own.call('POST', 'auth/2fa/enable', { code: await nextTotp(staff.username, secret) });
  u.totpUser = { ...staff, secret };
  u.detail['seeded'] = { branches: 2, roles: 1, staff: 2, totp: 1 };
}

/** The seeded 2FA user signs in with its password and a code of its secret (the secret survived the update). */
async function totpStillVerifies(u: UpdateRun): Promise<void> {
  const t = u.totpUser!;
  const s = new SmokeSession(u.port);
  await s.me();
  const first = await s.call<{ stage: string }>('POST', 'auth/login', { username: t.username, password: t.password });
  if (first.stage !== 'mfa') throw new SmokeError(`the 2FA user's sign-in went to stage ${first.stage}, expected mfa`);
  const second = await s.call<{ stage: string }>('POST', 'auth/2fa/verify', { code: await nextTotp(t.username, t.secret) });
  if (second.stage !== 'full') throw new SmokeError(`the 2FA user's code was answered with stage ${second.stage}`);
  u.detail['totpVerifies'] = true;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function canonicalValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return `hex:${Buffer.from(value).toString('hex')}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === 'bigint' || typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return value;
}

/** The tables compared: `data` and `config` of schema_tables, notifications aside (an update notifies its outcome). */
const NOT_COMPARED = new Set(['notifications', 'notification_reads']);
/**
 * Columns that move without any change of the data: the scheduler's bookkeeping of when each schedule runs, and what
 * a sign-in records (the scenarios sign in again after a restart: the last sign-in, the last TOTP step used).
 */
const NOT_COMPARED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  schedules: ['next_run_at', 'last_run_at'],
  staff_users: ['last_login_at', 'totp_last_step'],
});

type Checksums = Record<string, string>;

async function withDb<T>(u: UpdateRun, fn: (h: DbHandle) => Promise<T>): Promise<T> {
  const db: DbConfig = u.ctx.plan.installInput.db;
  const h = await connect(db, { runtime: 'standalone', purpose: 'cli', dataDir: u.ctx.layout.dataDir });
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
}

/**
 * SHA-256 per compared table: its rows (`settings` of scope `data` only), each a JSON array of its columns, sorted.
 * `scope` (from an earlier call) fixes the tables and columns, so a table a newer release adds is not compared.
 */
async function dataChecksums(u: UpdateRun, scope?: Record<string, string[]>): Promise<{ scope: Record<string, string[]>; sums: Checksums }> {
  if (u.ctx.o.target === 'docker') return { scope: {}, sums: await apiFingerprint(u) };
  return withDb(u, async (h) => {
    let tables = scope;
    if (tables === undefined) {
      const listed = await h.db.selectFrom('schema_tables').select(['name', 'class']).execute();
      const wanted = new Set(listed.filter((r) => (r.class === 'data' || r.class === 'config') && !NOT_COMPARED.has(r.name)).map((r) => r.name));
      tables = {};
      for (const t of await h.db.introspection.getTables()) {
        if (!wanted.has(t.name)) continue;
        const skip = NOT_COMPARED_COLUMNS[t.name] ?? [];
        tables[t.name] = t.columns.map((c) => c.name).filter((c) => !skip.includes(c)).sort(byText);
      }
    }
    const sums: Checksums = {};
    for (const table of Object.keys(tables).sort(byText)) {
      const columns = tables[table]!;
      // The table and its columns come from the database's own catalog; Kysely quotes them as identifiers.
      let query = h.db.selectFrom(table as never).select(columns as never);
      if (table === 'settings') query = query.where('scope' as never, '=', 'data' as never);
      const rows = (await query.execute()) as Record<string, unknown>[];
      const lines = rows.map((row) => JSON.stringify(columns.map((c) => canonicalValue(row[c])))).sort(byText);
      sums[table] = createHash('sha256').update(lines.join('\n')).digest('hex');
    }
    return { scope: tables, sums };
  });
}

/** Docker: what the API shows of the seeded data (no database port to read the tables through). */
async function apiFingerprint(u: UpdateRun): Promise<Checksums> {
  const s = u.admin;
  const out: Checksums = {};
  for (const [name, apiPath] of [
    ['users', 'users?limit=100'],
    ['roles', 'roles'],
    ['branches', 'branches'],
    ['library', 'settings/library'],
  ] as const) {
    const body = await s.call<unknown>('GET', apiPath);
    out[name] = createHash('sha256').update(canonicalize(stripVolatile(body))).digest('hex');
  }
  return out;
}

/** The answer without what changes by itself (sign-in times, ETags). */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/^(lastLoginAt|lastSeenAt|updatedAt|etag|version)$/i.test(k)) continue;
    out[k] = stripVolatile(v);
  }
  return out;
}

function changedTables(a: Checksums, b: Checksums): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((t) => a[t] !== b[t]).sort(byText);
}

/** Fails naming the tables whose checksums changed since `before`. */
async function expectDataAsBefore(u: UpdateRun, before: { scope: Record<string, string[]>; sums: Checksums }, when: string): Promise<void> {
  const after = await dataChecksums(u, u.ctx.o.target === 'docker' ? undefined : before.scope);
  const changed = changedTables(before.sums, after.sums);
  u.detail[`checksums ${when}`] = changed.length === 0 ? 'equal' : { changed };
  if (changed.length > 0) throw new SmokeError(`${when}: the data changed in ${changed.join(', ')}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The admin's side: check, apply, rollback, upload

/** `POST updates/check` (waiting out the throttle), then `GET updates` until the check it queued has run. */
async function check(u: UpdateRun): Promise<UpdatesView> {
  if (u.ctx.o.target === 'docker' && u.feed !== null) await startDockerFeedServer(u);
  const t0 = Date.now();
  for (;;) {
    const reply = await u.admin.request('POST', '/api/v1/updates/check');
    if (reply.status === 202) break;
    if (reply.status === 429 && problemCode(reply.body) === 'UPDATE_CHECK_THROTTLED') {
      const retry = (JSON.parse(reply.body) as { meta?: { retryAfterS?: number } }).meta?.retryAfterS ?? 60;
      say(`update check throttled; waiting ${retry} s`);
      await sleep(retry * 1000 + 1000);
      continue;
    }
    throw new SmokeError(`POST updates/check → ${reply.status} ${problemCode(reply.body)}`);
  }
  for (const deadline = Date.now() + 60_000; ; ) {
    const view = await u.admin.call<UpdatesView>('GET', 'updates');
    if (view.check !== null && view.check.at >= t0 - 1000) return view;
    if (Date.now() > deadline) throw new SmokeError('the update check queued by POST updates/check did not run within 60 s');
    await sleep(1000);
  }
}

/** Why the last update check failed, for the error message: its job's last error and feed-dev's last requests. */
async function checkFailureDetail(u: UpdateRun): Promise<string> {
  const parts: string[] = [];
  try {
    const jobs = await u.admin.call<{ items: { type: string; status: string; lastError: string | null }[] }>('GET', 'jobs?limit=20');
    const last = jobs.items.find((j) => j.type === 'update.check');
    if (last !== undefined) parts.push(`job ${last.status}${last.lastError === null ? '' : `: ${last.lastError}`}`);
  } catch (error) {
    parts.push(`jobs not read: ${messageOf(error)}`);
  }
  const requests = u.feed?.dev.requests.slice(-6).map((r) => r.path) ?? [];
  parts.push(`feed-dev ${u.feed?.url ?? 'not started'} saw ${requests.length === 0 ? 'no request' : requests.join(', ')}`);
  return parts.join('; ');
}

/** The check finds `version` with its prechecks passing. */
async function checkFinds(u: UpdateRun, version: string): Promise<UpdatesView> {
  const view = await check(u);
  u.detail['check'] = { ok: view.check?.ok, error: view.check?.error, available: view.available?.version ?? null, precheck: view.precheck?.ok ?? null };
  if (view.check?.ok !== true) throw new SmokeError(`the update check failed: ${String(view.check?.error)} (${await checkFailureDetail(u)})`);
  if (view.available?.version !== version) throw new SmokeError(`the update check offers ${String(view.available?.version)}, expected ${version}`);
  if (view.precheck?.ok !== true) throw new SmokeError(`the prechecks of ${version} fail: ${view.precheck?.failures.join(', ')}`);
  return view;
}

/** A call that begins an op (reauth first): the op id, and the page's cookie jar (the `altis_ops` cookie alone). */
async function beginOp(u: UpdateRun, apiPath: string, body: unknown): Promise<{ opId: string; page: OpsPage }> {
  await u.admin.call('POST', 'auth/reauth', { password: u.password });
  const reply = await u.admin.request('POST', `/api/v1/${apiPath}`, { json: body });
  if (reply.status !== 200) throw new SmokeError(`POST ${apiPath} → ${reply.status} ${problemCode(reply.body)}`);
  const { opId } = JSON.parse(reply.body) as UpdateOpResponse;
  const page = new OpsPage(u.port);
  page.jar.store(reply.headers['set-cookie']);
  if (page.jar.get('altis_ops') === undefined && page.jar.get('__Host-altis_ops') === undefined) throw new SmokeError(`POST ${apiPath} set no altis_ops cookie`);
  return { opId, page };
}

/**
 * The page `/admin/_update` as a browser holds it after the apply: the `altis_ops` cookie alone (no session), the op's
 * CSRF token for its drives (from `ops/current`).
 */
class OpsPage {
  readonly jar = new CookieJar();
  #csrf: string | null = null;

  constructor(readonly port: number) {}

  #headers(write: boolean): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', 'x-altis-background': '1', cookie: this.jar.header() };
    if (write) {
      headers['origin'] = `http://127.0.0.1:${this.port}`;
      headers['content-type'] = 'application/json';
      if (this.#csrf !== null) headers['x-csrf-token'] = this.#csrf;
    }
    return headers;
  }

  /** `GET ops/current`: the view, who answered (`X-Altis-Serving`), or what came instead (null view). */
  async current(): Promise<{ status: number; view: OpView | null; serving: string | null; note: string }> {
    let reply: HttpReply;
    try {
      reply = await httpSend(this.port, 'GET', '/api/v1/ops/current', this.#headers(false), undefined, 30_000);
    } catch (error) {
      return { status: 0, view: null, serving: null, note: messageOf(error) };
    }
    this.jar.store(reply.headers['set-cookie']);
    const serving = typeof reply.headers['x-altis-serving'] === 'string' ? reply.headers['x-altis-serving'] : null;
    if (reply.status !== 200) return { status: reply.status, view: null, serving, note: isStartingPage(reply) ? 'starting' : problemCode(reply.body) };
    const view = JSON.parse(reply.body) as OpView;
    if (view.csrfToken !== null) this.#csrf = view.csrfToken;
    return { status: 200, view, serving, note: '' };
  }

  /** `POST ops/drive` (`resume` for an op in needs_attention): the view after, or null when it was not answered 200. */
  async drive(resume = false): Promise<OpView | null> {
    const body = JSON.stringify(resume ? { resume: true } : {});
    try {
      const reply = await httpSend(this.port, 'POST', '/api/v1/ops/drive', { ...this.#headers(true), 'content-length': String(Buffer.byteLength(body)) }, body, 60_000);
      this.jar.store(reply.headers['set-cookie']);
      return reply.status === 200 ? (JSON.parse(reply.body) as OpView) : null;
    } catch {
      return null;
    }
  }

  /** `GET /admin/_update` (a reload of the page): its status and who served it. */
  async reload(): Promise<{ status: number; serving: string | null }> {
    const reply = await httpSend(this.port, 'GET', '/admin/_update', { accept: 'text/html', cookie: this.jar.header() }, undefined, 30_000);
    this.jar.store(reply.headers['set-cookie']);
    return { status: reply.status, serving: typeof reply.headers['x-altis-serving'] === 'string' ? reply.headers['x-altis-serving'] : null };
  }
}

interface Followed {
  view: OpView;
  states: string[];
  ms: number;
  polls: number;
  drives: number;
  serving: string[];
}

/**
 * What `/admin/_update` does until the op `opId` ends (see the top of this file): polls `ops/current` every 2 s and,
 * while the op is driveable in `external` mode, drives it; reloads the page once mid-update; `during` runs after every
 * poll (update-kill's bursts). Fails on a state in `forbid`, or after OP_TIMEOUT_MS.
 */
async function followOp(u: UpdateRun, page: OpsPage, opId: string, o: { forbid?: ReadonlySet<string>; during?: (view: OpView | null) => Promise<void> } = {}): Promise<Followed> {
  const t0 = performance.now();
  const states: string[] = [];
  const serving = new Set<string>();
  let polls = 0;
  let drives = 0;
  let reloaded = false;
  for (;;) {
    if (performance.now() - t0 > OP_TIMEOUT_MS) throw new SmokeError(`the op did not end within ${OP_TIMEOUT_MS / 60_000} minutes (states: ${states.join(' → ')})`);
    u.checkTime('the op');
    const current = await page.current();
    polls += 1;
    if (current.serving !== null) serving.add(current.serving);
    const view = current.view;
    if (view !== null) {
      if (view.opId !== opId) throw new SmokeError(`ops/current shows op ${String(view.opId)}, expected ${opId}`);
      const state = view.needsAttention ? `needs_attention(${view.state})` : view.state;
      if (states.at(-1) !== state) {
        states.push(state);
        say(`op ${view.kind} ${state} ${view.progress}%${current.serving === null ? '' : ` (served by ${current.serving})`}`);
      }
      if (o.forbid?.has(view.state) === true) throw new SmokeError(`the op went to ${view.state} (states: ${states.join(' → ')})`);
      if (view.terminal) return { view, states, ms: Math.round(performance.now() - t0), polls, drives, serving: [...serving] };
      if (!reloaded && MID_UPDATE_STATES.has(view.state)) {
        reloaded = true;
        const r = await page.reload();
        u.detail['pageReload'] = { state: view.state, status: r.status, serving: r.serving };
        if (r.status !== 200) throw new SmokeError(`a reload of /admin/_update mid-update (${view.state}) answered ${r.status}`);
      }
      if (view.needsAttention) {
        throw new SmokeError(`the op needs attention in ${view.state}: ${view.error?.code ?? ''} ${view.error?.detail ?? ''}`.trimEnd());
      }
    } else if (current.status === 401 || current.status === 403) {
      throw new SmokeError(`ops/current refused the page's cookie: ${current.status} ${current.note}`);
    }
    await o.during?.(view);
    if (view !== null && view.driveable && view.mode === 'external') {
      const before = JSON.stringify([view.state, view.progress, view.message, view.heartbeatAt]);
      const t1 = performance.now();
      const after = await page.drive();
      drives += 1;
      const same = after === null || JSON.stringify([after.state, after.progress, after.message, after.heartbeatAt]) === before;
      if (same || performance.now() - t1 < 1000) await sleep(PAGE_PACE_MS);
      continue;
    }
    await sleep(PAGE_POLL_MS);
  }
}

/** Fails unless `followed` ended in `state` (and with `code`). */
function expectEnd(followed: Followed, state: string, code: string | null = null): void {
  const { view } = followed;
  if (view.state !== state) throw new SmokeError(`the op ended ${view.state} (${view.error?.code ?? 'no error'}: ${view.error?.detail ?? ''}), expected ${state}; states ${followed.states.join(' → ')}`);
  if (code !== null && view.error?.code !== code) throw new SmokeError(`the op ended ${state} with ${String(view.error?.code)}, expected ${code}`);
}

/** current.json now (host targets; Docker: through `updates/status`, which needs the ops cookie, so not read). */
async function pointers(u: UpdateRun): Promise<{ active: string; previous: string | null; pending: string | null; pinned: string | null } | null> {
  if (u.ctx.o.target === 'docker') return null;
  const s = await readCurrentState(u.ctx.layout.dataDir, u.from.version);
  return { active: s.active.version, previous: s.previous?.version ?? null, pending: s.pending?.version ?? null, pinned: s.pinned };
}

async function maintenanceOff(u: UpdateRun): Promise<boolean> {
  if (u.ctx.o.target === 'docker') return true;
  return fsp.stat(path.join(u.ctx.layout.dataDir, 'ops', 'maintenance.json')).then(
    () => false,
    () => true,
  );
}

/** The served app is `version`, `pending` is clear and maintenance is off. */
async function expectServing(u: UpdateRun, version: string, when: string): Promise<void> {
  await waitServing(u, version);
  const p = await pointers(u);
  if (p !== null && (p.active !== version || p.pending !== null)) throw new SmokeError(`${when}: current.json says active ${p.active}, pending ${String(p.pending)}; expected ${version}`);
  for (const deadline = Date.now() + 10_000; !(await maintenanceOff(u)); ) {
    if (Date.now() > deadline) throw new SmokeError(`${when}: DATA_DIR/ops/maintenance.json is still there`);
    await sleep(500);
  }
  // Each process learns that the flag is gone through its ops fence, which looks at the file on a request at most every
  // 2 s (http/ops-fence.ts): until then the API may still answer 503 MAINTENANCE. Wait out one look, then ask again.
  await sleep(2500);
  await waitServing(u, version);
}

/** apply → the op followed to its end, with its time from the apply. */
async function applyAndFollow(u: UpdateRun, version: string, o: Parameters<typeof followOp>[3] = {}): Promise<Followed & { opId: string; applyToEndMs: number }> {
  if (u.ctx.o.target === 'docker' && u.feed !== null) await startDockerFeedServer(u);
  const t0 = performance.now();
  const { opId, page } = await beginOp(u, 'updates/apply', { version });
  const followed = await followOp(u, page, opId, o);
  return { ...followed, opId, applyToEndMs: Math.round(performance.now() - t0) };
}

// ---------------------------------------------------------------------------------------------------------------
// The scenarios

async function scenarioUpdate(u: UpdateRun): Promise<void> {
  const to = u.to[0]!;
  await startFeed(u);
  if (u.ctx.o.feed === null) await publishFeed(u, [to.zip], 1);
  await seed(u);
  await checkFinds(u, to.version);
  const before = await dataChecksums(u);
  const run = await applyAndFollow(u, to.version, { forbid: REVERT_STATES });
  expectEnd(run, 'done');
  u.detail['applyToDoneMs'] = run.applyToEndMs;
  u.detail['states'] = run.states;
  u.detail['polls'] = run.polls;
  u.detail['drives'] = run.drives;
  u.detail['servedBy'] = run.serving;
  await expectServing(u, to.version, 'after the update');
  u.detail['pointers'] = await pointers(u);
  await expectDataAsBefore(u, before, 'after the update');
  if (u.ctx.o.target === 'passenger-sim' && run.applyToEndMs >= UPDATE_DONE_BUDGET_MS) {
    throw new SmokeError(`apply → done took ${run.applyToEndMs} ms on passenger-sim (budget < ${UPDATE_DONE_BUDGET_MS} ms, §12.7)`);
  }
}

/** The first migration `to` brings that `from` lacks (the release manifests' schemaLatest are not names). */
function firstNewMigration(to: string): string {
  // The release fixtures (decision D1d-26): 0.2.0-test brings 9001_test_expand, 0.3.0-test 9002_test_contract.
  if (to.startsWith('0.2.0-test')) return '9001_test_expand';
  if (to.startsWith('0.3.0-test')) return '9002_test_contract';
  throw new SmokeError(`update-faults knows the migrations of the release fixtures 0.2.0-test and 0.3.0-test only, not ${to}`);
}

async function scenarioUpdateFaults(u: UpdateRun): Promise<void> {
  const to = u.to[0]!;
  await startFeed(u);
  if (u.ctx.o.feed === null) await publishFeed(u, [to.zip], 1);
  await seed(u);
  await checkFinds(u, to.version);
  const results: Record<string, unknown> = {};
  u.detail['faults'] = results;
  for (const f of updateFaults(to.version, firstNewMigration(to.version))) {
    await restartServed(u, { ALTIS_TEST_FAULT: f.fault }, u.from.version);
    // A fresh session: the restart may have dropped nothing, but the page of a new process is what a person opens.
    await signInAdmin(u);
    const before = await dataChecksums(u);
    const run = await applyAndFollow(u, to.version);
    results[f.fault] = { state: run.view.state, error: run.view.error?.code ?? null, states: run.states, ms: run.applyToEndMs };
    expectEnd(run, f.state, f.code);
    await restartServed(u, {}, u.from.version);
    await expectServing(u, u.from.version, `after ${f.fault}`);
    await expectDataAsBefore(u, before, `after ${f.fault}`);
    await signInAdmin(u);
  }
}

async function scenarioUpdateKill(u: UpdateRun): Promise<void> {
  const to = u.to[0]!;
  await startFeed(u);
  if (u.ctx.o.feed === null) await publishFeed(u, [to.zip], 1);
  await seed(u);
  await checkFinds(u, to.version);
  await restartServed(u, { ALTIS_TEST_FAULT: UPDATE_KILL_FAULT }, u.from.version);
  await signInAdmin(u);
  const before = await dataChecksums(u);
  let bursts = 0;
  let lastBurst = 0;
  const run = await applyAndFollow(u, to.version, {
    forbid: REVERT_STATES,
    // While the pending release migrates: every 20 s a burst of concurrent requests, so passenger-sim spawns workers
    // (up to its max pool) that meet the boot lock while the holder migrates; between bursts its 5 s idle time stops
    // them, the holder among them when it served nothing.
    during: async (view) => {
      if (view === null || !['switched', 'booting', 'migrating'].includes(view.state) || Date.now() - lastBurst < 20_000) return;
      lastBurst = Date.now();
      bursts += 1;
      await Promise.all(Array.from({ length: 6 }, () => httpSend(u.port, 'GET', '/admin/login', { accept: 'text/html' }, undefined, 30_000).catch(() => null)));
    },
  });
  expectEnd(run, 'done');
  u.detail['bursts'] = bursts;
  u.detail['states'] = run.states;
  u.detail['applyToDoneMs'] = run.applyToEndMs;
  await restartServed(u, {}, to.version);
  await expectServing(u, to.version, 'after update-kill');
  await expectDataAsBefore(u, before, 'after update-kill');
}

async function scenarioRollbackRestore(u: UpdateRun): Promise<void> {
  const to = u.to[0]!;
  await startFeed(u);
  if (u.ctx.o.feed === null) await publishFeed(u, [to.zip], 1);
  await seed(u);
  const view = await checkFinds(u, to.version);
  u.detail['dbRestoreNeeded'] = view.precheck?.dbRestoreNeeded ?? null;
  if (view.precheck?.dbRestoreNeeded !== true) throw new SmokeError(`the prechecks of ${to.version} do not say "pemulihan DB diperlukan bila gagal": is its contract migration above ${u.from.version}?`);
  await restartServed(u, { ALTIS_TEST_FAULT: `health:${to.version}` }, u.from.version);
  await signInAdmin(u);
  const before = await dataChecksums(u);
  const run = await applyAndFollow(u, to.version);
  u.detail['states'] = run.states;
  expectEnd(run, 'restored');
  if (!run.states.includes('restoring')) throw new SmokeError(`the revert did not go through restoring: ${run.states.join(' → ')}`);
  await restartServed(u, {}, u.from.version);
  await expectServing(u, u.from.version, 'after the restore');
  await expectDataAsBefore(u, before, 'after the restore');
  await totpStillVerifies(u);
}

async function scenarioRollbackManual(u: UpdateRun): Promise<void> {
  const to = u.to[0]!;
  await startFeed(u);
  if (u.ctx.o.feed === null) await publishFeed(u, [to.zip], 1);
  await seed(u);
  await checkFinds(u, to.version);
  const before = await dataChecksums(u);
  const first = await applyAndFollow(u, to.version, { forbid: REVERT_STATES });
  expectEnd(first, 'done');
  await expectServing(u, to.version, 'after the update');
  await signInAdmin(u);

  // 1. POST updates/rollback (the Pembaruan screen's "Kembali ke versi sebelumnya"): pointer only, N pinned.
  const offered = await u.admin.call<UpdatesView>('GET', 'updates');
  if (offered.rollback.available !== true || offered.rollback.target !== u.from.version) {
    throw new SmokeError(`GET updates offers no rollback to ${u.from.version}: ${JSON.stringify(offered.rollback)}`);
  }
  const { opId, page } = await beginOp(u, 'updates/rollback', {});
  const back = await followOp(u, page, opId);
  expectEnd(back, 'done');
  await expectServing(u, u.from.version, 'after POST updates/rollback');
  const pinned = await pointers(u);
  u.detail['afterRollback'] = pinned;
  if (pinned !== null && pinned.pinned !== to.version) throw new SmokeError(`after the rollback current.json pins ${String(pinned.pinned)}, expected ${to.version}`);
  await expectDataAsBefore(u, before, 'after POST updates/rollback');

  // 2. `release:unpin`, N again, then the CLI rollback `release:rollback` (D1d-33: without `pending`, the manual one).
  await appCli(u, 'release-unpin', ['release:unpin']);
  await signInAdmin(u);
  await checkFinds(u, to.version);
  const again = await applyAndFollow(u, to.version, { forbid: REVERT_STATES });
  expectEnd(again, 'done');
  await expectServing(u, to.version, 'after the second update');
  u.detail['releaseRollback'] = await appCli(u, 'release-rollback', ['release:rollback']);
  // The CLI asks the server for a restart (restart.txt, exit 75 or the service); a target that is not restarted by it
  // is restarted here.
  if ((await servedVersion(u)) === to.version) await sleep(5000);
  if ((await servedVersion(u)) !== u.from.version) await restartServed(u, {}, u.from.version);
  await expectServing(u, u.from.version, 'after release:rollback');
  await expectDataAsBefore(u, before, 'after release:rollback');
}

/** `files/uploads` of context `update`: declared, sent in the chunks the server fixed (multipart), completed. */
async function uploadPackage(u: UpdateRun, zip: Buffer): Promise<string> {
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const created = await u.admin.call<{ id: string; chunkSize: number; chunks: number }>('POST', 'files/uploads', { context: 'update', size: zip.length, sha256 });
  for (let n = 0; n < created.chunks; n += 1) {
    const chunk = zip.subarray(n * created.chunkSize, Math.min(zip.length, (n + 1) * created.chunkSize));
    const boundary = `----altis-smoke-${randomBytes(8).toString('hex')}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="chunk"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, chunk, tail]);
    const headers = { ...u.admin.headers(true), 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
    const reply = await httpSend(u.port, 'POST', `/api/v1/files/uploads/${created.id}/chunks/${n}`, headers, body, 60_000);
    u.admin.take(reply.headers);
    if (reply.status !== 200) throw new SmokeError(`chunk ${n} of the package → ${reply.status} ${problemCode(reply.body)}`);
  }
  await u.admin.call('POST', `files/uploads/${created.id}/complete`, { originalName: path.basename(u.to[0]!.zip) });
  return created.id;
}

async function scenarioUpdateOffline(u: UpdateRun): Promise<void> {
  const to = u.to[0]!;
  await seed(u);
  const uploadId = await uploadPackage(u, await fsp.readFile(to.zip));
  await u.admin.call('POST', 'auth/reauth', { password: u.password });
  const dry = await u.admin.call<UpdateUploadDryRun>('POST', 'updates/upload', { uploadId, dryRun: true });
  u.detail['dryRun'] = { version: dry.version, precheck: dry.precheck.ok, failures: dry.precheck.failures };
  if (dry.version !== to.version || !dry.precheck.ok) throw new SmokeError(`the dry run of the upload says ${dry.version}, prechecks ${dry.precheck.failures.join(', ') || 'ok'}`);
  const before = await dataChecksums(u);
  const t0 = performance.now();
  const { opId, page } = await beginOp(u, 'updates/upload', { uploadId });
  const run = await followOp(u, page, opId, { forbid: REVERT_STATES });
  expectEnd(run, 'done');
  u.detail['states'] = run.states;
  u.detail['uploadToDoneMs'] = Math.round(performance.now() - t0);
  await expectServing(u, to.version, 'after the offline update');
  await expectDataAsBefore(u, before, 'after the offline update');
}

/** A feed folder's three files written from parts (the rejection feeds are made by hand, not by buildFeed). */
async function writeFeedFiles(dir: string, payload: Record<string, unknown>, sig: unknown, freshness: { seq: number; issuedAt: number; expiresAt: number }): Promise<void> {
  const feedText = canonicalize(payload);
  const fresh = { feedSha256: createHash('sha256').update(feedText, 'utf8').digest('hex'), ...freshness };
  const ts = await devPrivateKey('dev-ts-1');
  const freshnessText = JSON.stringify({ raw: canonicalize(fresh), env: signDetached(fresh, { typ: FRESHNESS_TYP, kid: 'dev-ts-1', privateKey: ts }) });
  const channel = path.join(dir, 'stable');
  await fsp.mkdir(channel, { recursive: true });
  await fsp.writeFile(path.join(channel, 'feed.json'), feedText);
  await fsp.writeFile(path.join(channel, 'feed.sig'), JSON.stringify(sig));
  await fsp.writeFile(path.join(channel, 'freshness.json'), freshnessText);
}

async function devPrivateKey(kid: string): Promise<import('node:crypto').KeyObject> {
  const { createPrivateKey } = await import('node:crypto');
  const file = JSON.parse(await fsp.readFile(devKeyFile(kid), 'utf8')) as { pkcs8: string };
  return createPrivateKey({ key: Buffer.from(file.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
}

/** A root-signed keyset document (dev-root-1). */
async function rootDoc(payload: { seq: number; keys: unknown[]; revokedKids: string[] }): Promise<{ raw: string; env: unknown }> {
  return { raw: canonicalize(payload), env: signDetached(payload, { typ: 'altis-keyset/1', kid: 'dev-root-1', privateKey: await devPrivateKey('dev-root-1') }) };
}

const DAY_MS = 86_400_000;

async function scenarioRejections(u: UpdateRun): Promise<void> {
  const to = u.to[0]!;
  const feed = await startFeed(u);
  await seed(u);
  // A valid feed of N (its entry and package), from which each refused one is made.
  const built = await publishFeed(u, [to.zip], 1);
  if (!built.entries.some((e) => e.version === to.version)) throw new SmokeError(`the feed built from ${to.zip} has no entry of ${to.version}`);
  const valid = JSON.parse(await fsp.readFile(path.join(feed.dir, 'stable', 'feed.json'), 'utf8')) as Record<string, unknown>;
  const keyset = JSON.parse(await fsp.readFile(DEV_KEYSET, 'utf8')) as unknown[];
  const rel1 = await devPrivateKey('dev-rel-1');
  const rel2 = await devPrivateKey('dev-rel-2');
  const now = Date.now();
  const fresh = (seq: number) => ({ seq, issuedAt: now - 60_000, expiresAt: now + 7 * DAY_MS });
  const sign = (payload: Record<string, unknown>, typ: string, kid: string, key: import('node:crypto').KeyObject) => signDetached(payload, { typ, kid, privateKey: key });
  const results: Record<string, unknown> = {};
  u.detail['rejections'] = results;
  const before = await dataChecksums(u);

  const feedCases: { name: string; write: () => Promise<void> }[] = [
    {
      name: 'signature',
      write: async () => {
        const env = sign(valid, FEED_TYP, 'dev-rel-1', rel1) as { sig: string };
        const flipped = `${env.sig.slice(0, 10)}${env.sig[10] === 'A' ? 'B' : 'A'}${env.sig.slice(11)}`;
        await writeFeedFiles(feed.dir, valid, { ...env, sig: flipped }, fresh(2));
      },
    },
    { name: 'typ altis-license/1', write: () => writeFeedFiles(feed.dir, valid, sign(valid, 'altis-license/1', 'dev-rel-1', rel1), fresh(3)) },
    {
      name: 'kid dev-rel-2 revoked by the feed',
      write: async () => {
        const revoking = { ...valid, keyset: [...keyset, await rootDoc({ seq: 2, keys: [], revokedKids: ['dev-rel-2'] })] };
        await writeFeedFiles(feed.dir, revoking, sign(revoking, FEED_TYP, 'dev-rel-2', rel2), fresh(4));
      },
    },
    { name: 'freshness expired', write: () => writeFeedFiles(feed.dir, valid, sign(valid, FEED_TYP, 'dev-rel-1', rel1), { seq: 5, issuedAt: now - 15 * DAY_MS, expiresAt: now - DAY_MS }) },
  ];
  for (const c of feedCases) {
    await c.write();
    if (u.ctx.o.target === 'docker') await dockerFeedSync(u);
    const view = await check(u);
    results[c.name] = { check: view.check, available: view.available?.version ?? null };
    if (view.check?.ok !== false || view.check.error !== 'FEED_INVALID') throw new SmokeError(`${c.name}: the check stored ${JSON.stringify(view.check)}, expected FEED_INVALID`);
    if (view.available !== null) throw new SmokeError(`${c.name}: the refused feed still offers ${view.available.version}`);
    if ((await servedVersion(u)) !== u.from.version) throw new SmokeError(`${c.name}: the version changed`);
  }

  // version ≤ active: a valid feed that lists only N−1.
  await publishFeed(u, [u.from.zip], 6);
  const old = await check(u);
  const apply = await u.admin.request('POST', '/api/v1/updates/apply', { json: { version: u.from.version } });
  results['version <= active'] = { check: old.check, available: old.available?.version ?? null, apply: `${apply.status} ${problemCode(apply.body)}` };
  if (old.check?.ok !== true || old.available !== null) throw new SmokeError(`version ≤ active: the check stored ${JSON.stringify(old.check)} and offers ${String(old.available?.version)}`);
  if (apply.status !== 404 || problemCode(apply.body) !== 'UPDATE_NONE') throw new SmokeError(`version ≤ active: POST updates/apply → ${apply.status} ${problemCode(apply.body)}, expected 404 UPDATE_NONE`);

  await expectServing(u, u.from.version, 'after the rejections');
  await expectDataAsBefore(u, before, 'after the rejections');
}

/** Replaces the app folder's release by `zip`'s (its `tmp/` kept), as an owner unpacks a newer zip over it (§9.8). */
async function replaceAppFolder(u: UpdateRun, zip: string): Promise<void> {
  const { appRoot } = u.ctx.layout;
  for (const entry of await fsp.readdir(appRoot)) {
    if (entry === 'tmp') continue;
    await fsp.rm(path.join(appRoot, entry), { recursive: true, force: true });
  }
  await extractZip(await fsp.readFile(zip), appRoot);
}

async function scenarioZipReupload(u: UpdateRun): Promise<void> {
  const to = u.to[0]!;
  await seed(u);
  const before = await dataChecksums(u);
  // A deployed install's release is adopted (Task 27), so the newer zip meets §9.8 row 1 (the update path).
  await waitAdopted(u, u.from.version);
  await u.ctx.stopServer?.();
  // The owner's way on a host without the one-click update: the newer zip unpacked over the app folder (§9.8).
  await replaceAppFolder(u, to.zip);
  const t0 = performance.now();
  await restartServed(u, {}, null);
  for (;;) {
    u.checkTime('the bundled release taking over');
    const version = await servedVersion(u);
    const op = await readOpFile(u);
    if (version === to.version && (op === null || op.terminal)) {
      u.detail['op'] = op;
      break;
    }
    if (op !== null && REVERT_STATES.has(op.state)) throw new SmokeError(`the bundled update reverted: ${op.state}`);
    await sleep(2000);
  }
  u.detail['reuploadToServingMs'] = Math.round(performance.now() - t0);
  await expectServing(u, to.version, 'after the zip re-upload');
  await expectDataAsBefore(u, before, 'after the zip re-upload');
}

/** A file of DATA_DIR as it stands (Docker: read inside the app container); null when it cannot be read. */
async function readDataFile(u: UpdateRun, rel: string): Promise<string | null> {
  if (u.ctx.o.target === 'docker') {
    const read = await execCommand(dockerCompose(u, 'docker-cat', ['exec', '-T', 'app', 'cat', `/data/${rel}`]), u.ctx.layout.logDir, 60_000);
    return read.code === 0 ? read.stdout : null;
  }
  return fsp.readFile(path.join(u.ctx.layout.dataDir, ...rel.split('/')), 'utf8').catch(() => null);
}

/** What a scenario reads of DATA_DIR/ops/op.json. */
interface OpSeen {
  opId: string;
  kind: string;
  /** The release the op is about (an update's target). */
  version: string;
  state: string;
  error: string | null;
  detail: string | null;
  backupId: string | null;
  /** An update's `params.source` (`feed`, `upload`, `bundled`, `self`). */
  source: string | null;
  terminal: boolean;
}

const OP_END_STATES = new Set(['done', 'aborted', 'rolled_back', 'restored', 'restore_failed', 'failed']);

/** DATA_DIR/ops/op.json as it stands (Docker: inside the app container); null without a readable one. */
async function readOpFile(u: UpdateRun): Promise<OpSeen | null> {
  const text = await readDataFile(u, 'ops/op.json');
  if (text === null) return null;
  try {
    const op = JSON.parse(text) as {
      opId?: string;
      kind?: string;
      version?: string;
      state?: string;
      error?: { code?: string; detail?: string } | null;
      backupId?: string | null;
      params?: { source?: unknown };
    };
    const state = op.state ?? '';
    return {
      opId: op.opId ?? '',
      kind: op.kind ?? '',
      version: op.version ?? '',
      state,
      error: op.error?.code ?? null,
      detail: op.error?.detail ?? null,
      backupId: op.backupId ?? null,
      source: typeof op.params?.source === 'string' ? op.params.source : null,
      terminal: OP_END_STATES.has(state),
    };
  } catch {
    return null;
  }
}

/** Waits until op.json holds an `update` op to `version`, other than `notOpId`, that has ended. */
async function waitForUpdateEnd(u: UpdateRun, version: string, notOpId: string | null, what: string): Promise<OpSeen & { ms: number }> {
  const t0 = performance.now();
  for (;;) {
    u.checkTime(what);
    const op = await readOpFile(u);
    if (op !== null && op.kind === 'update' && op.version === version && op.opId !== notOpId && op.terminal) {
      say(`${what}: op ${op.opId} ended ${op.state}${op.error === null ? '' : ` (${op.error})`}`);
      return { ...op, ms: Math.round(performance.now() - t0) };
    }
    await sleep(2000);
  }
}

/** Fails unless the update op `op` ended `state` (and with `code`). */
function expectOpEnd(op: OpSeen, state: string, what: string, code: string | null = null): void {
  if (op.state !== state || (code !== null && op.error !== code)) {
    throw new SmokeError(`${what}: the update op ended ${op.state} (${op.error ?? 'no error'}: ${op.detail ?? ''}), expected ${state}${code === null ? '' : ` with ${code}`}`);
  }
}

/**
 * Waits until current.json names `version` active from DATA_DIR/releases (`source: 'data'`): the release the install
 * runs has been adopted (Task 27), so a newer release delivered whole meets §9.8 row 1 (its active folder is there), not
 * row 3, whatever the timing of the adoption job.
 */
async function waitAdopted(u: UpdateRun, version: string): Promise<void> {
  for (;;) {
    u.checkTime(`the adoption of ${version}`);
    const text = await readDataFile(u, 'releases/current.json');
    try {
      const active = text === null ? null : (JSON.parse(text) as { active?: { version?: string; source?: string } }).active;
      if (active?.version === version && active.source === 'data') return;
    } catch {
      // being written
    }
    await sleep(1000);
  }
}

/** The run's own image with `suffix` (Docker: one image per release a docker-pull leg delivers). */
const imageTag = (u: UpdateRun, suffix: string): string => `${u.ctx.layout.image}-${suffix}`;

/**
 * Release `r` delivered whole, as §9.8 meets it, with `env` (the release source, a test fault) in the app's
 * environment: Docker builds a new image of r's zip (`imageTag(suffix)`), deletes the image `drop` when given ("image
 * lama sudah tidak ada"), and recreates the app container on the new one; standalone (the local proof of the same
 * path) stops the app, replaces its folder by r's zip and starts it again. Waits for nothing: the caller watches what
 * the boot does (a schemaHold boot never answers `ok` while it updates).
 */
async function deliver(u: UpdateRun, r: Release, env: Record<string, string>, suffix: string, drop?: string): Promise<void> {
  say(`release ${r.version} delivered as a new ${u.ctx.o.target === 'docker' ? 'image' : 'app folder'}…`);
  if (u.ctx.o.target === 'docker') {
    const image = imageTag(u, suffix);
    await dockerImage(u, r.zip, image);
    if (drop !== undefined) await removeImage(u, imageTag(u, drop));
    u.image = image;
  } else {
    await u.ctx.stopServer?.();
    await replaceAppFolder(u, r.zip);
  }
  await startServed(u, env);
}

/**
 * docker-pull, the data mode (§9.8 rows 1 and 2, preflight 1D-15): N−1 → release N delivered whole (its active folder
 * is on the volume: the running release updates the install from `verified`, with a `pre_update` backup) → release
 * N+1 with `health:<N+1>`, N's image gone: N+1's contract migration raised `min_code_version` past N, so N, from
 * DATA_DIR/releases, reverts by restoring the backup (`restoring` → `restored`).
 */
async function pullDataMode(u: UpdateRun, mid: Release, last: Release): Promise<void> {
  const leg: Record<string, unknown> = {};
  u.detail['dataMode'] = leg;
  await seed(u);
  const before = await dataChecksums(u);
  await waitAdopted(u, u.from.version);
  await deliver(u, mid, {}, 'n');
  const first = await waitForUpdateEnd(u, mid.version, null, `the bundled update to ${mid.version}`);
  leg['update'] = { state: first.state, source: first.source, backup: first.backupId !== null, ms: first.ms };
  expectOpEnd(first, 'done', `the bundled update to ${mid.version}`);
  if (first.backupId === null) throw new SmokeError(`the bundled update to ${mid.version} took no pre_update backup`);
  await expectServing(u, mid.version, `after release ${mid.version} (data mode)`);
  await signInAdmin(u);
  await expectDataAsBefore(u, before, `after release ${mid.version} (data mode)`);

  await waitAdopted(u, mid.version);
  await deliver(u, last, { ALTIS_TEST_FAULT: `health:${last.version}` }, 'n1', 'n');
  const revert = await waitForUpdateEnd(u, last.version, first.opId, `the revert of ${last.version}`);
  leg['revert'] = { state: revert.state, error: revert.error, ms: revert.ms };
  // `restored` is reached through `restoring` only: N is too old for N+1's contract migration (§9.7 "terlalu lama").
  expectOpEnd(revert, 'restored', `the revert of ${last.version}`);
  await expectServing(u, mid.version, `after the revert of ${last.version} (data mode)`);
  await signInAdmin(u);
  await expectDataAsBefore(u, before, `after the revert of ${last.version} (data mode)`);
  await totpStillVerifies(u);
}

/** The environment of the image mode (§9.8): nothing is installed into or adopted from DATA_DIR/releases. */
const IMAGE_MODE: Readonly<Record<string, string>> = Object.freeze({ ALTIS_RELEASE_SOURCE: 'image' });

/**
 * A fresh install of N−1 with `env` from its first start (the image-mode leg): Docker removes the project's
 * containers and volumes and installs again on the run's own image; standalone empties DATA_DIR (and takes a fresh
 * server database), unpacks N−1 again and installs with `env`. Signed in as the first super admin afterwards.
 */
async function freshInstall(u: UpdateRun, env: Record<string, string>): Promise<void> {
  const { layout, plan, o } = u.ctx;
  say(`a fresh install of ${u.from.version} with ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}…`);
  if (o.target === 'docker') {
    u.image = null;
    await writeDockerEnvOverride(u, env);
    await mustRun(dockerCompose(u, 'docker-down-fresh', ['down', '--volumes', '--remove-orphans', '--timeout', '20']), layout.logDir);
    if (o.db !== 'sqlite') await mustRun(dockerCompose(u, 'docker-db-fresh', ['up', '--detach', '--wait', 'db']), layout.logDir);
    const run = ['run', '--rm', '-T', '--no-deps', 'app'];
    await mustRun(dockerCompose(u, 'docker-install-input-fresh', [...run, 'sh', '-c', 'cat > /data/install.json'], `${JSON.stringify(plan.installInput)}\n`), layout.logDir);
    await mustRun(dockerCompose(u, 'install-fresh', [...run, 'node', '/app/app.js', 'install', '--config', '/data/install.json']), layout.logDir);
    await mustRun(dockerCompose(u, 'docker-rm-install-input-fresh', [...run, 'rm', '-f', '/data/install.json']), layout.logDir);
    await mustRun(dockerCompose(u, 'docker-up-fresh', ['up', '--detach', '--no-deps', 'app']), layout.logDir);
  } else {
    await u.ctx.stopServer?.();
    await fsp.rm(layout.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await fsp.mkdir(layout.dataDir, { mode: 0o700 });
    if (o.db !== 'sqlite') plan.installInput = { ...plan.installInput, db: await provisionDb(o.db, `${randomBytes(4).toString('hex')}_img`, (drop) => u.ctx.onCleanup(drop)) };
    await replaceAppFolder(u, u.from.zip);
    await fsp.rm(layout.installFile, { force: true });
    writePrivateFile(layout.installFile, `${JSON.stringify(plan.installInput)}\n`);
    try {
      await mustRun({ ...plan.install, label: 'install-fresh', env: { ...plan.install.env, ...env } }, layout.logDir);
    } finally {
      await fsp.rm(layout.installFile, { force: true });
    }
    await startServed(u, env);
  }
  await waitServing(u, u.from.version);
  usedSteps.clear();
  u.totpUser = null;
  await signInAdmin(u);
}

/**
 * docker-pull, the image mode (`ALTIS_RELEASE_SOURCE=image`, §9.8 row 3, D1d-24, preflight 1D-15): a fresh install of
 * N−1 in image mode (no release folder on the volume, one-click update hidden) → release N delivered whole boots in
 * `schemaHold` and updates the install itself (`self`, `pre_update` backup, `previous` null) → N+1 with `health:<N+1>`,
 * N's image gone: the same failure in schemaHold ends `restore_failed`, UPDATE_SCHEMA_HOLD_FAILED naming the
 * `pre_update` backup, maintenance kept → N delivered again ("re-pull"), `node app.js maintenance:off` and `node app.js
 * backup:restore <id>`, as the instruction says → N serves with the data as before and the 2FA user signs in.
 */
async function pullImageMode(u: UpdateRun, mid: Release, last: Release): Promise<void> {
  const leg: Record<string, unknown> = {};
  u.detail['imageMode'] = leg;
  await freshInstall(u, IMAGE_MODE);
  const view = await u.admin.call<UpdatesView>('GET', 'updates');
  leg['oneClick'] = view.oneClick;
  if (view.oneClick !== false) throw new SmokeError('image mode: GET updates still offers the one-click update');
  await seed(u);
  if ((await readDataFile(u, `releases/${u.from.version}/manifest.json`)) !== null) {
    throw new SmokeError(`image mode: release ${u.from.version} was copied or adopted into DATA_DIR/releases`);
  }
  const before = await dataChecksums(u);

  await deliver(u, mid, IMAGE_MODE, 'img-n');
  const first = await waitForUpdateEnd(u, mid.version, null, `the schemaHold update to ${mid.version}`);
  leg['update'] = { state: first.state, source: first.source, backup: first.backupId !== null, ms: first.ms };
  expectOpEnd(first, 'done', `the schemaHold update to ${mid.version}`);
  if (first.source !== 'self' || first.backupId === null) throw new SmokeError(`the schemaHold update to ${mid.version} ran as ${String(first.source)}, backup ${String(first.backupId)}; expected self with a pre_update backup`);
  await expectServing(u, mid.version, `after release ${mid.version} (image mode)`);
  const p = await pointers(u);
  leg['pointers'] = p;
  if (p !== null && p.previous !== null) throw new SmokeError(`image mode: current.json keeps previous ${p.previous} after the schemaHold update (§9.8: previous = null)`);
  await signInAdmin(u);
  await expectDataAsBefore(u, before, `after release ${mid.version} (image mode)`);

  await deliver(u, last, { ...IMAGE_MODE, ALTIS_TEST_FAULT: `health:${last.version}` }, 'img-n1', 'img-n');
  const failed = await waitForUpdateEnd(u, last.version, first.opId, `the schemaHold update to ${last.version}`);
  leg['failure'] = { state: failed.state, error: failed.error, backupId: failed.backupId, ms: failed.ms };
  expectOpEnd(failed, 'restore_failed', `the schemaHold update to ${last.version}`, 'UPDATE_SCHEMA_HOLD_FAILED');
  // The instruction names the commands this leg runs next, in that order.
  const restoreLine = `node app.js backup:restore ${String(failed.backupId)}`;
  const detail = failed.detail ?? '';
  if (failed.backupId === null || !detail.includes(restoreLine) || !(detail.indexOf('node app.js maintenance:off') < detail.indexOf(restoreLine))) {
    throw new SmokeError(`UPDATE_SCHEMA_HOLD_FAILED does not say maintenance:off, then backup:restore of the pre_update backup ${String(failed.backupId)}: ${detail}`);
  }
  if ((await readDataFile(u, 'ops/maintenance.json')) === null) throw new SmokeError('image mode: maintenance is off after the failed schemaHold update');
  if ((await servedVersion(u)) !== null) throw new SmokeError('image mode: /_health answers ok after the failed schemaHold update');

  // The instruction: run the previous image again ("re-pull"), switch maintenance off, restore the named backup.
  await deliver(u, mid, IMAGE_MODE, 'img-n');
  await waitAnswering(u);
  leg['maintenanceOff'] = await appCli(u, 'maintenance-off', ['maintenance:off'], IMAGE_MODE);
  leg['restore'] = await appCli(u, 'backup-restore', ['backup:restore', failed.backupId], IMAGE_MODE);
  await restartServed(u, IMAGE_MODE, mid.version);
  await expectServing(u, mid.version, 'after backup:restore (image mode)');
  await signInAdmin(u);
  await expectDataAsBefore(u, before, 'after backup:restore (image mode)');
  await totpStillVerifies(u);
}

/** /_health answers at all (any status): the app process is up. */
async function waitAnswering(u: UpdateRun): Promise<void> {
  for (const deadline = performance.now() + HEALTH_TIMEOUT_MS; ; ) {
    try {
      const reply = await httpSend(u.port, 'GET', '/_health', {}, undefined, 10_000);
      if (reply.status > 0) return;
    } catch {
      // not listening yet
    }
    if (performance.now() > deadline) throw new SmokeError(`/_health did not answer within ${HEALTH_TIMEOUT_MS / 1000} s`);
    await sleep(500);
  }
}

async function scenarioDockerPull(u: UpdateRun): Promise<void> {
  const [mid, last] = u.to as [Release, Release];
  await pullDataMode(u, mid, last);
  await pullImageMode(u, mid, last);
}

/** `docker build` of `zip`'s release as `tag` (docker/Dockerfile, the release as build context). */
async function dockerImage(u: UpdateRun, zip: string, tag: string): Promise<void> {
  const dir = path.join(u.ctx.layout.root, `release-${tag.replace(/[^a-z0-9]+/gi, '-')}`);
  await fsp.rm(dir, { recursive: true, force: true });
  await extractZip(await fsp.readFile(zip), dir);
  await mustRun(
    { label: `docker-build-${tag.split(':').at(-1)}`, file: 'docker', args: ['build', '--build-context', `release=${dir}`, '--tag', tag, path.join(REPO_ROOT, 'docker')], cwd: REPO_ROOT, env: u.ctx.plan.start.env },
    u.ctx.layout.logDir,
  );
  u.ctx.onCleanup(() => removeImage(u, tag));
}

/** `docker image rm --force tag` (best effort). */
async function removeImage(u: UpdateRun, tag: string): Promise<void> {
  await execCommand({ label: 'docker-image-rm', file: 'docker', args: ['image', 'rm', '--force', tag], cwd: REPO_ROOT, env: u.ctx.plan.start.env }, u.ctx.layout.logDir, 60_000);
}

const RUNNERS: Readonly<Record<UpdateScenario, (u: UpdateRun) => Promise<void>>> = {
  update: scenarioUpdate,
  'update-faults': scenarioUpdateFaults,
  'update-kill': scenarioUpdateKill,
  'rollback-restore': scenarioRollbackRestore,
  'rollback-manual': scenarioRollbackManual,
  'update-offline': scenarioUpdateOffline,
  rejections: scenarioRejections,
  'docker-pull': scenarioDockerPull,
  'zip-reupload': scenarioZipReupload,
};

/** The version of a release zip (its package.json). */
async function releaseOf(zip: string): Promise<Release> {
  const entries = readZip(await fsp.readFile(zip));
  const pkg = entries.find((e) => e.path === 'package.json');
  if (pkg === undefined) throw new SmokeError(`${zip} holds no package.json`);
  return { zip, version: (JSON.parse(Buffer.from(pkg.data).toString('utf8')) as { version: string }).version };
}

/**
 * Runs the update scenario `scenario` against the healthy install of `ctx` (run.ts runScenario), signed in as its first
 * super admin; fills `detail`.
 */
export async function runUpdateScenario(ctx: RunContext, scenario: UpdateScenario, detail: Record<string, unknown>): Promise<void> {
  const t0 = performance.now();
  if (ctx.o.target === 'passenger-sim') {
    // No cron, Passenger's workers stopped after 5 s without a request (A7 "passenger-sim tanpa cron").
    await startScenarioSim(ctx, UPDATE_SIM_IDLE_MS);
    detail['simIdleMs'] = UPDATE_SIM_IDLE_MS;
  }
  const u: UpdateRun = {
    ctx,
    port: ctx.layout.port,
    from: { zip: ctx.o.zip, version: ctx.version },
    to: await Promise.all(ctx.o.toZips.map(releaseOf)),
    detail,
    admin: new SmokeSession(ctx.layout.port),
    password: ctx.plan.installInput.admin.password,
    totpUser: null,
    feed: null,
    image: null,
    checkTime: (what) => {
      if (performance.now() - t0 > UPDATE_SCENARIO_TIMEOUT_MS) throw new SmokeError(`${scenario}: ${what} took more than ${UPDATE_SCENARIO_TIMEOUT_MS / 60_000} minutes`);
    },
  };
  detail['from'] = u.from.version;
  detail['to'] = u.to.map((r) => r.version);
  // Docker: every compose command of a scenario names the scenario's override (dockerCompose); it starts empty.
  if (ctx.o.target === 'docker') await writeDockerEnvOverride(u, {});
  await u.admin.signIn(ctx.plan.installInput.admin.username, u.password);
  await RUNNERS[scenario](u);
  detail['totalSeconds'] = Math.round((performance.now() - t0) / 1000);
}

