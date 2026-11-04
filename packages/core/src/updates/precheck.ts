import type { FeedChannel } from '@altis/crypto/feed';
import { checkServer, type DbHandle } from '@altis/db';
import { ensureHeadroom } from '@altis/platform';
import { DomainError, compareSemver, isSemver } from '@altis/shared';
import type { PrecheckReportView } from '@altis/shared/api/updates';
import { backupHeadroomBytes } from '../backup/create-job.js';
import { backupEstimateMs } from '../backup/mode.js';
import type { EditionService } from '../edition/edition.js';
import { readSettings } from '../settings/service.js';
import { reachableFrom, type Candidate } from './candidate.js';
import { checkOfChannel, type StoredUpdateCheck } from './check-job.js';

// The prechecks of an update (spec §9.6 step 2; plan Task 21; decisions D1d-32, D1d-43; preflight 1D-17):
//
//   not_newer         the candidate is not SemVer above `active`;
//   min_upgrade_from  `active` < the candidate's `minUpgradeFrom`: a stepping-stone release must be installed first
//                     (offline chains are deferred, D1d-43, so the refusal names it);
//   boot_protocol     the candidate needs another `bootProtocol` than this app.js runs (contract v1, §9.2): only a
//                     manual upgrade with the full zip installs it;
//   min_node          the Node.js running is below the candidate's `minNode`;
//   min_db            the database server is below the candidate's floor for its engine (none for SQLite);
//   entitlement       the edition does not cover the candidate's `releasedAt` (the edition seam; the community
//                     edition covers every release): UPDATE_NOT_ENTITLED;
//   snapshot_backup   a snapshot backup is running (§9.6: "tidak ada backup snapshot yang sedang berjalan").
//
// Failures are listed in that order (§9.6's), and the first one decides the refusal (throwPrecheck): one
// UPDATE_PRECHECK_FAILED with the first failure as its reason and all of them in `meta.failures`, or
// UPDATE_NOT_ENTITLED when the entitlement comes first (D1d-32). Besides the verdict the report holds the maintenance
// estimate (the DB-only backup's C31 estimate plus 30 s per migration), the headroom to prove (the package twice plus
// a backup's headroom), the "pemulihan DB diperlukan bila gagal" label (`active` < `minCodeVersionAfter`), whether the
// candidate is a stepping stone below the latest release the last check saw, the candidate's version, bootProtocol
// and minUpgradeFrom (what a refusal names), and why the entitlement failed.
//
// Versions of Node.js and database servers are compared by their leading numbers (`22.16.0`, `v24.1.0`,
// `10.6.21-MariaDB-log`, `15.10 (Debian …)`); a version or a floor that cannot be read fails its check, so nothing is
// installed on a guess.

/** The bootProtocol of this app.js contract (§9.2, contract v1): the only one a one-click update installs. */
export const BOOT_PROTOCOL = 1;

/** Each pending migration adds this much to the maintenance estimate. */
export const PRECHECK_MIGRATION_MS = 30_000;

export type PrecheckFailure = 'not_newer' | 'min_upgrade_from' | 'boot_protocol' | 'min_node' | 'min_db' | 'snapshot_backup' | 'entitlement';

/** The order in which failures are listed (spec §9.6 step 2); the first one is the refusal's reason. */
export const PRECHECK_FAILURES: readonly PrecheckFailure[] = Object.freeze([
  'not_newer',
  'min_upgrade_from',
  'boot_protocol',
  'min_node',
  'min_db',
  'entitlement',
  'snapshot_backup',
]);

export interface PrecheckReport {
  ok: boolean;
  failures: PrecheckFailure[];
  /** `active` < the candidate's `minCodeVersionAfter`: a failed update needs the `pre_update` backup restored (§9.7). */
  dbRestoreNeeded: boolean;
  /** The expected maintenance time: the DB-only backup's estimate plus {@link PRECHECK_MIGRATION_MS} per migration. */
  estimateMs: number;
  /** The headroom to prove: the package's size twice plus a backup's headroom. */
  headroomBytes: number;
  /** The candidate is below the latest release the last update check saw: another update follows it. */
  steppingStone: boolean;
  /** What a refusal names: the candidate's version, its bootProtocol and its minUpgradeFrom (the stepping stone). */
  candidate: { version: string; bootProtocol: number; minUpgradeFrom: string };
  /** Why the entitlement failed (the reason of UPDATE_NOT_ENTITLED); null when it did not. */
  notEntitled: 'no_license' | 'released_after' | null;
}

/** True when `A` and `B` are the same type (neither is merely assignable to the other). */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compiles only for `true`. */
type Assert<T extends true> = T;

/**
 * Task 28 (preflight M7): `PrecheckReportView` of `@altis/shared/api/updates`, which the browser bundles and which
 * cannot import core, is this report; the build (`tsc -b`) fails as soon as the two drift apart in either direction.
 */
export type PrecheckReportViewMatches = Assert<Same<PrecheckReportView, PrecheckReport>>;

export type PrecheckEngine = 'sqlite' | 'mysql' | 'mariadb' | 'postgres';

export interface PrecheckInput {
  /** The running release's version (SemVer). */
  active: string;
  candidate: Candidate;
  /** `process.versions.node` (a leading `v` is accepted). */
  nodeVersion: string;
  /** The database server as it reports itself. */
  db: { engine: PrecheckEngine; version: string };
  /** The edition covers the candidate's `releasedAt` (EditionCheck.notEntitled is null; community: always). */
  entitled: boolean;
  snapshotBackupRunning: boolean;
  /** A DB-only backup's headroom (bytes) and C31 estimate (ms). */
  backupEstimate: { bytes: number; ms: number };
  pendingMigrations: number;
  /** An unentitled release came out after what the edition covers (`released_after`), not `no_license`. */
  signed?: boolean;
  /** The latest version the last update check saw (`update.check.latest`): the candidate is a stepping stone below it. */
  latest?: string | null;
}

/** The leading `major[.minor[.patch]]` of a version text (a missing part counts 0), or null when it has none. */
function versionNumbers(text: string): [number, number, number] | null {
  const m = /^v?(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?/.exec(text.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2] ?? '0'), Number(m[3] ?? '0')];
}

/** Whether the version `have` is at least `floor`, number by number; false when either cannot be read. */
function atLeast(have: string, floor: string): boolean {
  const h = versionNumbers(have);
  const f = versionNumbers(floor);
  if (h === null || f === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (h[i]! !== f[i]!) return h[i]! > f[i]!;
  }
  return true;
}

/** Whether the database server meets the candidate's floor for its engine; SQLite has none (it comes with Node.js). */
function dbMeets(db: PrecheckInput['db'], minDb: Candidate['minDb']): boolean {
  if (db.engine === 'sqlite') return true;
  // MariaDB 10.x prefixes its version with `5.5.5-` for clients that speak the old handshake.
  const version = /^5\.5\.5-\d/.test(db.version) ? db.version.slice('5.5.5-'.length) : db.version;
  return atLeast(version, minDb[db.engine]);
}

function count(name: string, value: unknown, integer: boolean): number {
  const ok = typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value));
  if (!ok) throw new TypeError(`precheck: ${name} must be a ${integer ? 'whole number' : 'finite number'} of at least 0, got ${String(value)}`);
  return value as number;
}

/**
 * The prechecks of updating from `i.active` to `i.candidate` (see the module comment). Pure.
 *
 * @throws TypeError when `active` or the candidate's version is not SemVer, or a size, estimate or count is negative,
 *   not finite or (sizes and counts) not whole
 */
export function precheck(i: PrecheckInput): PrecheckReport {
  const c = i.candidate;
  if (!isSemver(i.active)) throw new TypeError(`precheck: active must be SemVer, got ${JSON.stringify(i.active)}`);
  if (!isSemver(c.version)) throw new TypeError(`precheck: the candidate's version must be SemVer, got ${JSON.stringify(c.version)}`);
  const size = count('candidate.size', c.size, true);
  const backupBytes = count('backupEstimate.bytes', i.backupEstimate.bytes, false);
  const backupMs = count('backupEstimate.ms', i.backupEstimate.ms, false);
  const migrations = count('pendingMigrations', i.pendingMigrations, true);

  const failed = new Set<PrecheckFailure>();
  if (compareSemver(c.version, i.active) <= 0) failed.add('not_newer');
  if (!reachableFrom(c.minUpgradeFrom, i.active)) failed.add('min_upgrade_from');
  if (c.bootProtocol !== BOOT_PROTOCOL) failed.add('boot_protocol');
  if (!atLeast(i.nodeVersion, c.minNode)) failed.add('min_node');
  if (!dbMeets(i.db, c.minDb)) failed.add('min_db');
  if (!i.entitled) failed.add('entitlement');
  if (i.snapshotBackupRunning) failed.add('snapshot_backup');
  const failures = PRECHECK_FAILURES.filter((f) => failed.has(f));

  const latest = i.latest ?? null;
  return {
    ok: failures.length === 0,
    failures,
    dbRestoreNeeded: !isSemver(c.minCodeVersionAfter) || compareSemver(i.active, c.minCodeVersionAfter) < 0,
    estimateMs: backupMs + PRECHECK_MIGRATION_MS * migrations,
    headroomBytes: size * 2 + backupBytes,
    steppingStone: latest !== null && isSemver(latest) && compareSemver(c.version, latest) < 0,
    candidate: { version: c.version, bootProtocol: c.bootProtocol, minUpgradeFrom: c.minUpgradeFrom },
    notEntitled: i.entitled ? null : i.signed === true ? 'released_after' : 'no_license',
  };
}

export interface RunPrecheckDeps {
  /** DATA_DIR: the backup estimate reads its manifests, and the headroom is proven there. */
  dataDir: string;
  db: DbHandle;
  /** The edition seam (only `check` is read): its `notEntitled` decides the entitlement. */
  edition: Pick<EditionService, 'check'>;
  snapshotBackupRunning(): Promise<boolean>;
  nodeVersion: string;
  /** The running release's version: `active`. */
  appVersion: string;
  /** How many migrations the candidate would run on this database. */
  migrationsAhead(c: Candidate): number;
}

/**
 * The prechecks of updating this installation to `c`: it reads the database server (engine and version), the edition
 * (whether it covers `c.releasedAt`, and why not), whether a snapshot backup runs, a DB-only backup's headroom and
 * C31 estimate, the pending migrations and the latest version of the last update check (of the current channel: 1d
 * review L14), then runs {@link precheck}.
 * When every check passed it proves the headroom with ensureHeadroom (a refused report proves nothing: there is
 * nothing to install yet), unless `o.proveHeadroom` is false (Task 28: `GET updates` shows the report and writes
 * nothing; the apply, the upload and the op's `checking` step prove it).
 *
 * @throws DomainError `DISK_QUOTA` when the headroom cannot be written (P21); `DB_UNAVAILABLE` and the like from the
 *   reads
 */
export async function runPrecheck(deps: RunPrecheckDeps, c: Candidate, o: { proveHeadroom?: boolean } = {}): Promise<PrecheckReport> {
  const server = await checkServer(deps.db);
  const edition = await deps.edition.check();
  const snapshotBackupRunning = await deps.snapshotBackupRunning();
  const bytes = await backupHeadroomBytes(deps.db.db);
  const ms = await backupEstimateMs(deps.db.db, deps.dataDir, { includeFiles: false });
  // 1d review L14: the latest version a check of another channel saw (before a channel switch) says nothing of this one.
  const s = await readSettings(deps.db.db, ['update.check', 'update.channel'], []);
  const check = checkOfChannel(s['update.check'] as StoredUpdateCheck | null, s['update.channel'] as FeedChannel);
  const report = precheck({
    active: deps.appVersion,
    candidate: c,
    nodeVersion: deps.nodeVersion,
    db: { engine: server.flavor, version: server.version },
    entitled: edition.notEntitled(c.releasedAt) === null,
    signed: edition.notEntitled(c.releasedAt) !== 'no_license',
    snapshotBackupRunning,
    backupEstimate: { bytes, ms },
    pendingMigrations: deps.migrationsAhead(c),
    latest: check?.latest ?? null,
  });
  if (report.ok && o.proveHeadroom !== false) await ensureHeadroom(deps.dataDir, report.headroomBytes);
  return report;
}

/**
 * The refusal of a release whose bootProtocol this app.js does not run (§9.2: "Rilis yang membutuhkan `bootProtocol`
 * lain ditolak pra-cek, disertai langkah upgrade zip manual"): 409 UPDATE_PRECHECK_FAILED reason `boot_protocol`, its
 * detail the manual zip upgrade. Also what a signed package declaring another bootProtocol is refused with
 * (preflight S10, 1D-19).
 */
export function bootProtocolRefusal(version: string, bootProtocol: unknown, failures: readonly PrecheckFailure[] = ['boot_protocol']): DomainError {
  const v = String(version);
  const n = String(bootProtocol);
  return new DomainError('UPDATE_PRECHECK_FAILED', {
    detail:
      `Rilis ${v} memerlukan bootProtocol ${n}, sedangkan app.js yang terpasang menjalankan bootProtocol ${BOOT_PROTOCOL}: ` +
      `pembaruan satu klik maupun unggah paket tidak dapat memasangnya. Perbarui secara manual dengan zip lengkapnya: ` +
      `hentikan aplikasi, ganti app.js dan folder bundled-release/ dengan isi zip rilis ${v}, lalu jalankan lagi / ` +
      `Release ${v} needs bootProtocol ${n}, but the installed app.js runs bootProtocol ${BOOT_PROTOCOL}: neither the ` +
      `one-click update nor a package upload can install it. Upgrade manually with its full zip: stop the application, ` +
      `replace app.js and the bundled-release/ folder with the contents of the zip of release ${v}, then start it again`,
    meta: { reason: 'boot_protocol', failures: [...failures] },
  });
}

function failureDetail(f: Exclude<PrecheckFailure, 'boot_protocol' | 'entitlement'>, r: PrecheckReport): string {
  const v = r.candidate.version;
  const from = r.candidate.minUpgradeFrom;
  switch (f) {
    case 'not_newer':
      return `Rilis ${v} tidak lebih baru daripada versi yang sedang berjalan / Release ${v} is not newer than the running version`;
    case 'min_upgrade_from':
      return (
        `Rilis ${v} hanya dapat dipasang di atas versi ${from} atau yang lebih baru. Pasang dulu rilis batu loncatan ` +
        `${from} (lewat pembaruan atau dengan mengunggah paketnya), lalu perbarui lagi ke ${v} / Release ${v} installs ` +
        `only over version ${from} or later. Install the stepping-stone release ${from} first (as an update or by ` +
        `uploading its package), then update to ${v} again`
      );
    case 'min_node':
      return `Versi Node.js di server terlalu lama untuk rilis ${v} / The Node.js version on the server is too old for release ${v}`;
    case 'min_db':
      return `Versi server database terlalu lama untuk rilis ${v} / The database server version is too old for release ${v}`;
    case 'snapshot_backup':
      return (
        'Sedang ada pencadangan snapshot yang berjalan; coba lagi setelah selesai / ' +
        'A snapshot backup is running; try again once it has finished'
      );
  }
}

/**
 * Throws the refusal of a report that failed (nothing for one without failures). The first failure decides: the
 * entitlement → 409 UPDATE_NOT_ENTITLED, reason the report's `notEntitled` (`no_license` when it names none); any other
 * → 409 UPDATE_PRECHECK_FAILED with that failure as its reason. `meta.failures` lists them all. A `boot_protocol`
 * refusal's detail is the manual zip upgrade (§9.2), a `min_upgrade_from` one names the stepping stone, the candidate's
 * `minUpgradeFrom` (D1d-43).
 *
 * @throws DomainError `UPDATE_NOT_ENTITLED` or `UPDATE_PRECHECK_FAILED`
 */
export function throwPrecheck(r: PrecheckReport): void {
  const first = r.failures[0];
  if (first === undefined) return;
  const failures = [...r.failures];
  const v = r.candidate.version;
  if (first === 'entitlement') {
    const reason = r.notEntitled ?? 'no_license';
    throw new DomainError('UPDATE_NOT_ENTITLED', {
      detail:
        reason === 'released_after'
          ? `Rilis ${v} terbit setelah rilis terakhir yang tercakup edisi ini / Release ${v} came out after the last release this edition covers`
          : `Rilis ${v} tidak tercakup edisi ini / This edition does not cover release ${v}`,
      meta: { reason, failures },
    });
  }
  if (first === 'boot_protocol') throw bootProtocolRefusal(v, r.candidate.bootProtocol, failures);
  throw new DomainError('UPDATE_PRECHECK_FAILED', { detail: failureDetail(first, r), meta: { reason: first, failures } });
}
