import { createHash, randomBytes } from 'node:crypto';
import { listCatalogTables, type DbHandle } from '@altis/db';
import { appPath, dataPath, readAppFile, readBytes, removeFile, writeBytesAtomic, type Runtime } from '@altis/platform';
import { DomainError, isUlid } from '@altis/shared';
import {
  EXPOSURE_READ_MAX_BYTES,
  INSTALL_STEP_STATES,
  type CronTestResponse,
  type ExposureBody,
  type ExposureCandidateKind,
  type InstallStep,
} from '@altis/shared/api/install';

// What the web wizard's steps decide without a framework (spec §9.5; plan Task 27): the step order, the exposure
// verdict, the scheduler test, the migrations' progress, the probe file of the exposure test and the aaPanel warning.
// apps/server/src/install/steps.ts runs the steps with them.

/** A scheduler call seen this recently counts as detected (spec §9.5 step 6 "Uji penjadwal"). */
export const CRON_SEEN_FRESH_MS = 15 * 60_000;
/** app.js is read up to this size, and its first 64 KiB hashed (a release's bootloader is far smaller). */
const APP_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** The probe file and the data-dir pointer are a few dozen bytes. */
const SMALL_FILE_MAX_BYTES = 64 * 1024;
/** aaPanel's own folder (cli/host-panels.ts PANEL_MARKERS). */
const AAPANEL_MARKER = '/www/server/panel';

/**
 * Refuses `step` unless config.json's `installState` (null: no config.json) allows it ({@link INSTALL_STEP_STATES}).
 *
 * @throws DomainError `INSTALL_STEP_ORDER` (409; `meta.step`, `meta.installState`)
 */
export function assertInstallStep(step: InstallStep, installState: string | null): void {
  const allowed = INSTALL_STEP_STATES[step] as readonly (string | null)[];
  if (allowed.includes(installState)) return;
  throw new DomainError('INSTALL_STEP_ORDER', {
    detail:
      `Langkah ini tidak dapat dijalankan sekarang (tahap instalasi: ${installState ?? 'belum dimulai'}) / ` +
      `This step cannot run now (install stage: ${installState ?? 'not started'})`,
    meta: { step, installState },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Exposure (spec §9.5 step 1.2)

/** A file whose bytes a fetched URL must not return. */
export interface ExposureTarget {
  kind: ExposureCandidateKind;
  /** SHA-256 of the file's first {@link EXPOSURE_READ_MAX_BYTES} (all of a smaller file), lower-case hex. */
  sha256: string;
}

/** The digest the browser reports for a served copy of `bytes`: it reads at most 64 KiB of a body. */
const prefixSha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes.subarray(0, EXPOSURE_READ_MAX_BYTES)).digest('hex');

/** The probe file of the exposure test. */
function probePath(dataDir: string, probeId: string) {
  if (!isUlid(probeId)) throw new TypeError('the probe id must be a ULID');
  return dataPath(dataDir, 'tmp', probeId);
}

/**
 * The exposure probe file `DATA_DIR/tmp/<probeId>` (32 random bytes as hex), written when it is not there (mode 644,
 * so that a web server running as another user could serve it, which is what the test looks for).
 *
 * @returns its content
 */
export async function ensureInstallProbe(dataDir: string, probeId: string): Promise<Buffer> {
  const file = probePath(dataDir, probeId);
  const existing = await readBytes(file, SMALL_FILE_MAX_BYTES);
  if (existing !== null && existing.length > 0) return existing;
  const content = Buffer.from(randomBytes(32).toString('hex'), 'utf8');
  await writeBytesAtomic(file, content, 0o644);
  return content;
}

/** Removes the exposure probe file (finish). */
export async function removeInstallProbe(dataDir: string, probeId: string): Promise<void> {
  await removeFile(probePath(dataDir, probeId));
}

/**
 * What the exposure test compares against: the probe file (when it exists), `<appRoot>/app.js` and
 * `<appRoot>/altis-data-dir.txt` (each when present and readable), each as the digest of its first 64 KiB, the part of
 * a served copy the browser reads (as the daily `diagnostics.exposure` job compares).
 */
export async function exposureTargets(o: { dataDir: string; appRoot: string; probeId: string | null }): Promise<ExposureTarget[]> {
  const targets: ExposureTarget[] = [];
  if (o.probeId !== null) {
    const probe = await readBytes(probePath(o.dataDir, o.probeId), SMALL_FILE_MAX_BYTES).catch(() => null);
    if (probe !== null && probe.length > 0) targets.push({ kind: 'probe', sha256: prefixSha256(probe) });
  }
  const files: [ExposureCandidateKind, 'app.js' | 'altis-data-dir.txt', number][] = [
    ['app', 'app.js', APP_FILE_MAX_BYTES],
    ['pointer', 'altis-data-dir.txt', SMALL_FILE_MAX_BYTES],
  ];
  for (const [kind, name, max] of files) {
    const bytes = await readAppFile(appPath(o.appRoot, name), max).catch(() => null);
    if (bytes !== null && bytes.length > 0) targets.push({ kind, sha256: prefixSha256(bytes) });
  }
  return targets;
}

/**
 * The first result whose body is one of `targets` (whatever its status: only the file itself has its digest), or null
 * when the browser fetched none of them.
 */
export function exposedBy(results: ExposureBody['results'], targets: readonly ExposureTarget[]): { kind: ExposureCandidateKind; path: string } | null {
  for (const r of results) {
    if (r.sha256 === null) continue;
    const hit = targets.find((t) => t.sha256 === r.sha256);
    if (hit !== undefined) return { kind: hit.kind, path: r.path };
  }
  return null;
}

/** `aapanel_default` when aaPanel runs on this host and ALTIS does not run under PM2 (spec §9.5 step 1). */
export function panelWarningFor(runtime: Runtime, panelMarkers: readonly string[]): 'aapanel_default' | null {
  return panelMarkers.includes(AAPANEL_MARKER) && runtime !== 'pm2' ? 'aapanel_default' : null;
}

// ---------------------------------------------------------------------------------------------------------------
// The scheduler test (spec §9.5 step 6)

export interface CronStatusOptions {
  runtime: Runtime;
  /** The runner of this runtime is the worker (runnerMode: not Passenger/LiteSpeed, not ALTIS_RUNNER=off). */
  worker: boolean;
  /** tmp/cron-seen.json (readCronSeen). */
  seen: { mode: 'cron_cli' | 'cron_http'; at: number } | null;
  now: number;
  /** The Node binary of this process (`process.execPath`: the nodevenv one on cPanel). */
  execPath: string;
  appRoot: string;
  /** config.json's baseUrl (environment overrides applied). */
  baseUrl: string;
  cronToken: string;
}

/** `text` as one shell word: as it is when it needs no quoting, else in single quotes. */
function shellWord(text: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The answer of `POST cron/test`: required on Passenger and LiteSpeed (no worker there); detected when a scheduler
 * call was seen in the last 15 minutes (`cron_cli` from `jobs:run`, `cron_http` from `POST /_cron`), or when this
 * runtime runs the worker; and the two lines to paste.
 */
export function cronStatus(o: CronStatusOptions): CronTestResponse {
  const fresh = o.seen !== null && o.now - o.seen.at <= CRON_SEEN_FRESH_MS && o.seen.at <= o.now + 60_000;
  const appJs = `${o.appRoot.replace(/[\\/]+$/, '')}/app.js`;
  return {
    required: o.runtime === 'passenger' || o.runtime === 'litespeed',
    detected: fresh || o.worker,
    mode: fresh ? o.seen!.mode : o.worker ? 'worker' : null,
    at: fresh ? o.seen!.at : null,
    cronLine: `*/5 * * * * ${shellWord(o.execPath)} ${shellWord(appJs)} jobs:run`,
    // Ruling R1c-14: curl treats a 503 as transient; a process that could not finish its boot within the call's wait
    // still answers one, and the retry then meets it warm.
    curlLine: `curl -fsS --retry 3 --retry-delay 10 -X POST -H "Authorization: Bearer ${o.cronToken}" ${o.baseUrl}/_cron`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Migrations

/** The names in schema_migrations (none before the migrator's tables exist), sorted. */
export async function appliedMigrationNames(h: DbHandle): Promise<string[]> {
  if (!(await listCatalogTables(h)).includes('schema_migrations')) return [];
  return (await h.db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name).sort();
}

/** How many of `known` (this code's migration names) are applied, and how many there are. */
export function migrationCounts(applied: readonly string[], known: readonly string[]): { applied: number; total: number } {
  const done = new Set(applied);
  return { applied: known.filter((n) => done.has(n)).length, total: known.length };
}
