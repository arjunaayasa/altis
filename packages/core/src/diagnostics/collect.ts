import os from 'node:os';
import { KEYSET_FILE, readKeysetWithBak, resolveTrustedKeys, type KeysetSource, type TrustedKey } from '@altis/crypto';
import { checkServer, countRows, editionLaneState, withTx, type DB, type DbHandle } from '@altis/db';
import {
  dataDirUsage,
  dataPath,
  parseCurrentState,
  readJsonWithBak,
  releaseDirExists,
  type CurrentState,
  type Env,
  type ReleaseRef,
  type Runtime,
} from '@altis/platform';
import { compareSemver, isSemver, type EditionView, type IpTrust } from '@altis/shared';
import type {
  BundledNoteView,
  BundledRelationView,
  DiagnosticsBundled,
  DiagnosticsReport,
} from '@altis/shared/api/diagnostics';
import type { Kysely } from 'kysely';
import { newestBackup } from '../backup/catalog.js';
import type { EditionService } from '../edition/edition.js';
import { searchHealth } from '../search/health.js';
import { lastRuns } from '../jobs/run-records.js';
import { runnerMode } from '../jobs/runner.js';
import type { JobHandler } from '../jobs/types.js';
import { readOpFile, type OpFile } from '../ops/files.js';
import { scheduleWindowSchema, type ScheduleWindow } from '../scheduler/registry.js';
import { readSettings, writeSettings } from '../settings/service.js';
import { stocktakeDiagnostics } from '../stocktake/diagnostics.js';
import { failedBefore } from '../updates/bundled.js';
import { releaseSourceMode } from '../updates/source-mode.js';
import { exposureJob, type ExposureJobDeps } from './exposure.js';
import { ipTrustJob } from './ip-trust.js';
import type { StoredProbe } from './probes.js';
import { wasmProbe } from './wasm.js';

// Diagnostik (spec §11; plan Task 23): the report of `GET diagnostics`, and the jobs that measure what is too slow to
// measure per request.
//
// collectDiagnostics makes cheap reads only: settings rows (one query for the machine state the jobs and the browser
// test leave: the audit chain's last verification, Task 18; the DATA_DIR size, `diagnostics.usage`; the exposure
// check; the probe; the clock anomaly; ip_trust), four counts on `jobs`, the newest backup row, the newest `disk_low`
// notification, releases/current.json and its folders, and the server's version and full-text support (asked once
// per database handle: they change only with a restart of the server).
//
// 1d Task 29 (§11 "edisi", "rilis yang hilang atau tidak teradopsi"; §9.8; preflight S13, B7):
// - `edition`: what the edition service's check names (the community edition: `{ edition: 'community', status:
//   'active' }`, with no database read);
// - `release`: current.json's `pending` and `pinned`; the release bundled beside app.js (`bundled-release/<app.js's
//   version>`, as app.js finds it) against `pending ?? active` (app.js's classification, §9.8), with what became of it
//   (BundledNoteView: the decisions of Task 27's bundledUpdatePlan; a `releases_log` row or op.json for
//   `failed_before`, `update.bundled_blocked` for `blocked`); DATA_DIR/releases/keyset.json (its documents, the
//   highest `seq` among those that verify against the embedded roots, and `system.keyset_full`).
// Diagnostik itself raises no alert (preflight S13): the dashboard does (dashboard/summary.ts).
//
// Komunitas K1 (edition lane): `editionLane.applied`, the migrations of another lane the database records (a count of
// `schema_migrations_edition`), shown as "Migrasi jalur lain terpasang: N".
//
// Komunitas K4 (stocktake): `stocktakes`, the sessions under way and their jobs (stocktake/diagnostics.ts).

/** The search provider interface (spec §10.10). Phase 1 brings the interface and the full-text detection only. */
export interface SearchProvider {
  id: string;
  capabilities(): { fullText: boolean };
  index(doc: unknown): Promise<void>;
  remove(id: string): Promise<void>;
  search(q: unknown): Promise<unknown>;
  health(): Promise<{ ok: boolean }>;
}

/** What one database handle's server said (P6: safe to keep, it changes only with the server process). */
const serverFacts = new WeakMap<DbHandle, Promise<{ version: string; fullText: boolean }>>();

function factsOf(h: DbHandle): Promise<{ version: string; fullText: boolean }> {
  let facts = serverFacts.get(h);
  if (facts === undefined) {
    facts = checkServer(h).then((s) => ({ version: s.version, fullText: !s.problems.includes('NO_FULLTEXT') }));
    serverFacts.set(h, facts);
    facts.catch(() => serverFacts.delete(h)); // a failed look is asked again next time
  }
  return facts;
}

/** Whether the database offers full-text search (checkServer's `NO_FULLTEXT`: InnoDB FTS, `to_tsvector`, FTS5). */
export async function fullTextCapability(h: DbHandle): Promise<boolean> {
  return (await factsOf(h)).fullText;
}

export interface CollectOptions {
  h: DbHandle;
  dataDir: string;
  /** The app folder (bundled releases live there); without it a bundled release is never reported missing. */
  appRoot: string | undefined;
  runtime: Runtime;
  env: Env;
  /** The running release. */
  version: string;
  /** app.js's version (BootContext.appJsVersion), null when the bootloader gave none. */
  appJsVersion: string | null;
  /** The realtime transport this process serves (realtime.sse and the runtime). */
  transport: 'polling' | 'sse';
  /** config.json's trustProxy.hops. */
  hops: number;
  /** config.json's sessionKey as bytes: the backups' manifest HMAC (the newest backup's `sameInstall`). */
  sessionKey: Uint8Array;
  now: number;
  /** The edition seam (ruling R1): its check names the running edition. */
  edition: Pick<EditionService, 'check'>;
  /** 1d Task 29: the root keys the build embeds: the keyset store's documents verify against them (none: maxSeq 0). */
  roots: readonly TrustedKey[];
  /** 1d Task 29: a production build counts no document that adds a `dev-` key (R65b). */
  refuseDevKids: boolean;
}

/** A count or a minimum as the drivers return it (number, numeric string, bigint), or null. */
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** releases/current.json, or null when it is missing or unusable (the bootloader repairs it; Diagnostik only reads). */
async function currentState(dataDir: string): Promise<CurrentState | null> {
  try {
    return await readJsonWithBak(dataPath(dataDir, 'releases', 'current.json'), parseCurrentState);
  } catch {
    return null;
  }
}

/** §11 "rilis yang hilang atau tidak teradopsi": versions whose folder is gone, versions run from the app folder. */
async function releaseFacts(
  dataDir: string,
  appRoot: string | undefined,
  state: CurrentState | null,
): Promise<{ missing: string[]; unadopted: string[] }> {
  if (state === null) return { missing: [], unadopted: [] };
  const refs: ReleaseRef[] = [state.active, ...(state.previous === null ? [] : [state.previous])];
  const missing: string[] = [];
  const unadopted: string[] = [];
  for (const ref of refs) {
    if (ref.source === 'bundled' && !unadopted.includes(ref.version)) unadopted.push(ref.version);
    if (ref.source === 'bundled' && appRoot === undefined) continue;
    if (!(await releaseDirExists(appRoot ?? '', dataDir, ref)) && !missing.includes(ref.version)) missing.push(ref.version);
  }
  return { missing, unadopted };
}

async function queueFacts(h: DbHandle, now: number): Promise<DiagnosticsReport['queue']> {
  const count = (status: string): Promise<number> => countRows(h.db.selectFrom('jobs').where('status', '=', status).select('id'));
  const queued = await count('queued');
  const running = await count('running');
  const dead = await count('dead');
  // How long the oldest due job has waited: a job whose time has not come waits for its time, not for a runner.
  const oldest = await h.db
    .selectFrom('jobs')
    .select((eb) => eb.fn.min('run_at').as('m'))
    .where('status', '=', 'queued')
    .where('run_at', '<=', now)
    .executeTakeFirst();
  const runAt = numberOrNull(oldest?.m);
  return { queued, running, dead, oldestQueuedMs: runAt === null ? null : Math.max(0, now - runAt) };
}

/** The newest `disk_low` notification's time (P21: the warning Diagnostik shows, S25), or null. */
async function diskLowAt(h: DbHandle): Promise<number | null> {
  const row = await h.db
    .selectFrom('notifications')
    .select((eb) => eb.fn.max('created_at').as('m'))
    .where('title_key', '=', 'notification.disk_low.title')
    .executeTakeFirst();
  return numberOrNull(row?.m);
}

type Audited = { at: number; ok: boolean; head: number; headHash: string; brokenAt: number | null } | null;
type Exposure = { at: number; ok: boolean; url: string | null } | null;
type Usage = { at: number; bytes: number; files: number; truncated: boolean } | null;
type Anomaly = { detectedAt: number; maxSeen: number } | null;

// ---- 1d Task 29 ---------------------------------------------------------------------------------------------------

/** The edition section: what the running edition is, as plain data (the check's `notEntitled` is not shown). */
async function editionFacts(o: CollectOptions): Promise<EditionView> {
  const check = await o.edition.check();
  return { edition: check.edition, status: check.status };
}

/** How `version` compares with `pending ?? active` of `state`, as app.js classifies the bundled release (§9.8). */
export function bundledRelation(version: string, state: CurrentState): BundledRelationView {
  const order = compareSemver(version, (state.pending ?? state.active).version);
  return order < 0 ? 'older' : order === 0 ? 'same' : 'newer';
}

/**
 * The version of the release bundled beside app.js: app.js's own (`appJsVersion`, its `__BUNDLED_VERSION__`) when
 * `<appRoot>/bundled-release/<that version>` is a folder, as app.js looks for it; else null (no app folder, an app.js
 * that named no version, no such folder).
 */
export async function bundledReleaseBeside(appRoot: string | undefined, dataDir: string, appJsVersion: string | null): Promise<string | null> {
  if (appRoot === undefined || appJsVersion === null || !isSemver(appJsVersion)) return null;
  return (await releaseDirExists(appRoot, dataDir, { version: appJsVersion, source: 'bundled' })) ? appJsVersion : null;
}

/** What {@link bundledReleaseFact} reads. */
export interface BundledFactOptions {
  db: Kysely<DB>;
  dataDir: string;
  appRoot: string | undefined;
  /** app.js's version (BootContext.appJsVersion): the release bundled beside it carries that version. */
  appJsVersion: string | null;
  state: CurrentState;
  /** releaseSourceMode: `image` begins no update of a bundled release (§9.8). */
  mode: 'data' | 'image';
  /** The version `update.bundled_blocked` names, or null. */
  blockedVersion: string | null;
}

/** op.json as failedBefore reads it; one that cannot be read at all counts as unreadable. */
async function opFileOrCorrupt(dataDir: string): Promise<OpFile | 'corrupt' | null> {
  try {
    return await readOpFile(dataDir);
  } catch {
    return 'corrupt';
  }
}

/**
 * The release bundled beside app.js and what became of it (BundledNoteView: for a newer one the decisions of Task 27's
 * bundledUpdatePlan, a pin first, then a failure, then failed prechecks); null without one.
 */
export async function bundledReleaseFact(o: BundledFactOptions): Promise<DiagnosticsBundled | null> {
  const version = await bundledReleaseBeside(o.appRoot, o.dataDir, o.appJsVersion);
  if (version === null) return null;
  const relation = bundledRelation(version, o.state);
  let note: BundledNoteView;
  if (relation !== 'newer') note = 'ignored';
  else if (o.state.pinned === version) note = 'pinned';
  else if ((await failedBefore(o.db, version, await opFileOrCorrupt(o.dataDir))).failed) note = 'failed_before';
  else if (o.blockedVersion === version) note = 'blocked';
  else note = o.mode === 'image' ? 'ignored' : 'offered';
  return { version, relation, note };
}

/**
 * DATA_DIR/releases/keyset.json (R65c): its documents (the more of the file's and its `.bak`'s: the writer keeps a
 * union), the highest `seq` among them that verifies against the roots, and `full` as given. A store that cannot be
 * read counts nothing: the boot and the update steps report it (STATE_CORRUPT); Diagnostik only reads. The writer
 * appends only verified documents (D1d-27), so verifying them here costs a few milliseconds for a store ALTIS wrote.
 */
async function keysetFacts(o: CollectOptions, full: boolean): Promise<DiagnosticsReport['release']['keyset']> {
  let sources: KeysetSource[];
  try {
    sources = (await readKeysetWithBak(dataPath(o.dataDir, 'releases', KEYSET_FILE), `DATA_DIR/releases/${KEYSET_FILE}`)).sources;
  } catch {
    return { docs: 0, maxSeq: 0, full };
  }
  const docs = sources.reduce((most, source) => Math.max(most, source.docs.length), 0);
  let maxSeq = 0;
  if (o.roots.length > 0) {
    try {
      maxSeq = resolveTrustedKeys([...o.roots], sources.flatMap((source) => source.docs), { refuseDevKids: o.refuseDevKids }).maxSeq;
    } catch {
      maxSeq = 0; // roots that are not root keys verify nothing
    }
  }
  return { docs, maxSeq, full };
}

/** The §11 report (see the top of this file). */
export async function collectDiagnostics(o: CollectOptions): Promise<DiagnosticsReport> {
  const { h, now } = o;
  const edition = await editionFacts(o);
  const s = await readSettings(
    h.db,
    [
      'system.ip_trust',
      'system.probe',
      'system.exposure',
      'system.data_usage',
      'audit.verified',
      'system.clock_anomaly',
      'update.bundled_blocked',
      'system.keyset_full',
      // ---- Phase 2 (catalog): Task 15 (the OAI block) ----
      'opac.oai.enabled',
      'opac.oai.adminEmail',
    ],
    [],
  );
  const probe = s['system.probe'] as StoredProbe | null;
  const exposure = s['system.exposure'] as Exposure;
  const usage = s['system.data_usage'] as Usage;
  const audited = s['audit.verified'] as Audited;
  const anomaly = s['system.clock_anomaly'] as Anomaly;
  const facts = await factsOf(h);
  const last = await newestBackup(h.db, o.dataDir, o.sessionKey); // its manifest only, not every kept backup's
  const memory = process.memoryUsage();
  const state = await currentState(o.dataDir);
  const blocked = s['update.bundled_blocked'] as { version: string } | null;
  const bundled =
    state === null
      ? null
      : await bundledReleaseFact({
          db: h.db,
          dataDir: o.dataDir,
          appRoot: o.appRoot,
          appJsVersion: o.appJsVersion,
          state,
          mode: releaseSourceMode(o.env),
          blockedVersion: blocked?.version ?? null,
        });
  return {
    release: {
      version: o.version,
      appJsVersion: o.appJsVersion,
      bootProtocol: 1,
      ...(await releaseFacts(o.dataDir, o.appRoot, state)),
      pending: state?.pending?.version ?? null,
      pinned: state?.pinned ?? null,
      bundled,
      keyset: await keysetFacts(o, s['system.keyset_full'] !== null),
    },
    runtime: {
      runtime: o.runtime,
      transport: o.transport,
      runner: { mode: runnerMode(o.runtime, o.env), lastRuns: await lastRuns(h.db) },
    },
    queue: await queueFacts(h, now),
    backup: { last },
    edition,
    database: {
      dialect: h.dialect,
      version: facts.version,
      fullText: facts.fullText,
      limits: { maxUserConnections: h.limits.maxUserConnections, maxConnections: h.limits.maxConnections },
      poolSize: h.poolSize,
    },
    dataDir: usage === null ? null : { bytes: usage.bytes, files: usage.files, truncated: usage.truncated, measuredAt: usage.at },
    memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, totalBytes: os.totalmem(), freeBytes: os.freemem() },
    network: { ipTrust: s['system.ip_trust'] as IpTrust, hops: o.hops, suggestedHops: probe?.xff.suggestedHops ?? null },
    wasm: wasmProbe(),
    http: {
      methods: probe === null ? null : { ...probe.methods },
      methodOverride: probe !== null && !(probe.methods.put && probe.methods.patch && probe.methods.delete),
      chunkBytes: probe?.chunkBytes ?? null,
      probedAt: probe?.at ?? null,
    },
    audit: {
      chain: audited === null ? null : { ok: audited.ok, head: audited.head, brokenAt: audited.brokenAt, checkedAt: audited.at },
    },
    clock: { anomaly: anomaly === null ? null : { detectedAt: anomaly.detectedAt, maxSeen: anomaly.maxSeen } },
    exposure: exposure === null ? null : { ok: exposure.ok, url: exposure.url, checkedAt: exposure.at },
    disk: { lowAt: await diskLowAt(h) },
    // ---- Phase 2 (catalog): Task 3 (B2), filled by Task 15: the index's health, and whether OAI-PMH can answer ----
    search: await searchHealth(h.db),
    oai: {
      enabled: s['opac.oai.enabled'] === true,
      adminEmailSet: typeof s['opac.oai.adminEmail'] === 'string' && s['opac.oai.adminEmail'].trim() !== '',
    },
    // ---- Komunitas K1 (edition lane) ----
    editionLane: { applied: (await editionLaneState(h.db)).rows },
    // ---- Komunitas K4 (stocktake) ----
    stocktakes: await stocktakeDiagnostics(h.db, now),
  };
}

/** The usage walk's own bound inside a slice (dataDirUsage's default): it never takes the whole budget. */
const USAGE_MAX_MS = 5000;

/**
 * The daily job `diagnostics.usage` (schedule `diagnostics.usage`): what DATA_DIR holds (dataDirUsage, bounded in
 * time and entries, so one slice; `truncated` says the numbers are a lower bound) into `system.data_usage`.
 */
export function usageJob(deps: { dataDir: string }): JobHandler<ScheduleWindow> {
  return {
    type: 'diagnostics.usage',
    permission: 'system.diagnostics.read',
    retryable: 'api',
    payload: scheduleWindowSchema,
    async run(ctx) {
      const maxMs = Math.max(250, Math.min(USAGE_MAX_MS, ctx.budgetLeftMs() - 1000));
      const usage = await dataDirUsage(deps.dataDir, { maxMs });
      const now = ctx.now();
      await withTx(ctx.handle, (trx) =>
        writeSettings(trx, { 'system.data_usage': { at: now, ...usage } }, { keyring: [], now, actorId: null }),
      );
      return { done: true };
    },
  };
}

/** What the three Diagnostik jobs need: DATA_DIR, the app folder, the base URL and, for tests, the exposure fetch. */
export type DiagnosticsJobDeps = ExposureJobDeps;

/** The Diagnostik jobs: `diagnostics.exposure` (daily), `diagnostics.ip_trust` (hourly), `diagnostics.usage` (daily). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function diagnosticsJobs(deps: DiagnosticsJobDeps): JobHandler<any>[] {
  return [exposureJob(deps), ipTrustJob(), usageJob(deps)];
}
