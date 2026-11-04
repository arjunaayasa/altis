import { readKeysetWithBak, readReleaseKeyset, type KeysetSource, type TrustedKey } from '@altis/crypto';
import {
  createCommunityEdition,
  createGrantsCache,
  createOpsMachine,
  createPasswordHasher,
  createSettingsCache,
  createSmtpMailer,
  createUpdateSource,
  loadSmtpConfig,
  notify,
  persistKeysetDocs,
  runPrecheck,
  snapshotBackupRunning,
  type BootHooks,
  type Candidate,
  type EditionService,
  type GrantsCache,
  type Mailer,
  type OpKindHandler,
  type OpStatus,
  type OpsMachine,
  type PasswordHasher,
  type PrecheckReport,
  type RestoreRunner,
  type SettingsCache,
  type SmtpConfig,
  type UpdateKindDeps,
  type UpdateSource,
} from '@altis/core';
import { connect, releaseMigrations, withTx, type DbHandle } from '@altis/db';
import { dataPath, type Env, type Runtime } from '@altis/platform';
import { DomainError, OP_KIND_PERMISSION } from '@altis/shared';
import { adminAssetsOf, type AdminAssets } from './admin/serve.js';
import type { AppDeps, AppState } from './app.js';
import { applyEnvOverrides, feedBaseOf, updateConfigIfChanged, type Config } from './config.js';
import type { ConfigFence } from './http/config-fence.js';
import { csrfKey } from './http/csrf.js';
import { healthHandler, type HealthHandler } from './http/health.js';
import { communityEditionGate, type EditionGate } from './http/edition-gate.js';
import { createOpsFence, type OpsFence } from './http/ops-fence.js';
import { createInstallService, type InstallService } from './install/gate.js';
import { opKinds, updateRestoreRunner, type JobRuntime } from './jobs/runtime.js';
import type { Logger } from './logger.js';
import { createStreamCounter, type StreamCounter } from './realtime/streams.js';
import { embeddedRootKeys, installedKeysets, refusesDevKids } from './release-keys.js';

// What the routes of one app share, built once per app (createApp), never per request: the clock, the release
// version, the /_health checker with its single-flight cache (L48), the password hasher, the grants and settings
// caches, the config fence, the admin assets, the mailers and the config writer. Each may hold a per-process cache,
// which is only ever for data that is safe to serve stale (P6). (1c Task 18: the volatile sweeper of 1b's D19 is gone;
// the scheduled job `housekeeping.volatile` does its work.)

/**
 * Each phase of the email test's SMTP session (connecting, the greeting, a quiet socket) may take this long: a dead or
 * silent server fails the test within it.
 */
export const EMAIL_TEST_TIMEOUT_MS = 8_000;

/**
 * The email test's whole SMTP session may take this long, however quickly each step is answered (a tarpit): the request
 * stays inside its 30 s budget (P9), so the admin gets SMTP_FAILED rather than a proxy's 502/504.
 */
export const EMAIL_TEST_DEADLINE_MS = 20_000;

/**
 * config.json as the routes that change it see it (`PUT system/config`, `POST system/cron-token/rotate`; decision D42).
 */
export interface ConfigWriter {
  /**
   * The environment the server was started with (`deps.env`, default `process.env`): its `ALTIS_*` overrides win over
   * config.json, so the fields they set are locked (ENV_LOCKS of @altis/shared/api/system-config).
   */
  readonly env: Env;
  /**
   * Changes DATA_DIR/config.json with updateConfigIfChanged (ruling R58: the file read and written under config.lock,
   * never the overrides; outside any transaction) and applies the result to this process at once: `state.config`
   * becomes `applyEnvOverrides(written, env)` (S17: an `ALTIS_*` override keeps winning), `state.baseUrl` its baseUrl
   * (HSTS), and the fence is reset to it. Other processes follow through their fence within 2 s.
   *
   * When what `mutate` leaves is config.json as it is, nothing is written (config.json.bak keeps the real previous copy,
   * and no process reloads for nothing) and nothing is applied or reset.
   *
   * @returns the config now in use (the environment overrides applied), or null when nothing changed
   * @throws TypeError when the app has no DATA_DIR (`deps.dataDir`); updateConfig's errors (nothing is then applied)
   */
  update(mutate: (cfg: Config) => Config | void): Promise<Config | null>;
}

export interface AppServices {
  /** Epoch ms; every request reads it once (`rc.now`). */
  clock(): number;
  /** The release version (`deps.version`): `/_health` and `auth/me`'s `build`. */
  version: string;
  /** The /_health handler (the `health` route), with its single-flight live check reused for 1 s. */
  health: HealthHandler;
  /**
   * Settings served from memory for up to 30 s (P6), on the services clock. Step 3 reads `system.ip_trust` through
   * it (S8); a route that writes settings calls `invalidate()` in `afterCommit` (M17).
   */
  settings: SettingsCache;
  /**
   * Grants per staff user and `authz_version` (an LRU of 500, P6: a rights change bumps the version, so an entry is
   * never served stale); step 7 reads the request's grants through it. 1c Task 15: cleared when the data epoch moves
   * (a restore: the restored database's versions may name other grants).
   */
  grants: GrantsCache;
  /**
   * The config fence (D34) start() creates once config.json has been read (`state.fence`); null before that and in
   * an app built without start(). Step 4 checks it on every request.
   */
  readonly fence: ConfigFence | null;
  /**
   * 1c Task 15: the ops fence (http/ops-fence.ts): ops/maintenance.json, ops/data-epoch and the active op, looked at
   * every 2 s at most by step 4 (and by the worker loop); step 5 (the maintenance gate), `opsAuth` and /_health read
   * it. start() passes its own (`deps.services.opsFence`), whose callbacks restart the process after a restore and end
   * `ops_wait`; otherwise an app with a DATA_DIR gets one whose data-epoch change drops `settings` and `grants`; null
   * without a DATA_DIR.
   */
  readonly opsFence: OpsFence | null;
  /** The admin SPA files of the running release (`deps.release`), with the previous release's assets as fallback. */
  adminAssets: AdminAssets;
  /**
   * The password hasher of this process (§7.1: 2 hashes at a time, 8 waiting, then AUTH_BUSY): its queue bounds this
   * process's memory, so there is exactly one per app.
   */
  hasher: PasswordHasher;
  /**
   * The library's mail over its own SMTP server (Task 9): the SMTP settings are read at every send (loadSmtpConfig
   * over `state.db` with the config's keyring), so a change an admin saved applies to the next mail in every process
   * (P6). 1c Task 18: the password-reset mail goes through the job queue (`mail.password_reset`), whose handlers get
   * their own mailer ({@link jobMailer}); this one is what the forgot route's fallback registry is built with.
   */
  mailer: Mailer;
  /**
   * The mailer of `POST system/config/email-test`: `mailer`'s SMTP settings, but answered within the request, so each
   * phase of the session is bounded by {@link EMAIL_TEST_TIMEOUT_MS} and the whole session by
   * {@link EMAIL_TEST_DEADLINE_MS} (SMTP_FAILED with the stage it had reached).
   */
  emailTestMailer: Mailer;
  /** config.json's writer for the routes that change it (Task 22). */
  configWriter: ConfigWriter;
  /**
   * DATA_DIR (`deps.dataDir`; start() always passes it), for the routes that keep files there (1c: uploads stage under
   * `tmp/` and store under `uploads/`).
   * @throws TypeError when the app has none
   */
  readonly dataDir: string;
  /**
   * The install wizard's state (1c Task 10, install/gate.ts): the install gate the phase gate and every wizard route
   * look at, the wizard's own database handle (`db()`, what an `install` route's rc.db uses), the `altis_install`
   * cookie rule and the wizard's page.
   */
  install: InstallService;
  /**
   * 1c Task 8: the runtime this process runs under (`deps.runtime`, M12; default `standalone`), which decides whether
   * SSE is on while `realtime.sse` is null (realtime/streams.ts sseEnabled).
   */
  readonly runtime: Runtime;
  /** 1c Task 8: this process's open SSE streams, at most four (`realtime.maxStreams`, decision C6). */
  streams: StreamCounter;
  /** 1c Task 23 (M12, C29): the running app.js's version (`deps.appJsVersion`), null when the bootloader gave none. */
  readonly appJsVersion: string | null;
  /**
   * 1c Task 13 (S11): the app's one OpsMachine, created with the app (not once it is ready), so the wizard can begin
   * and step `install-migrate` before the install completes: its database is `state.db`, else the wizard's handle
   * (services.install.db()); an op that needs attention notifies the holders of its kind's permission (M34). start()
   * passes its own (`deps.services.ops`), which it also gives the job runtime.
   * @throws TypeError when the app has no DATA_DIR (`deps.dataDir`)
   */
  readonly ops: OpsMachine;
  /**
   * 1c Task 13: the job runtime start() creates once the app is ready (`state.jobs`): `POST /_cron`, drive, piggyback
   * and the worker loop. Null before that, and in an app built without one.
   */
  readonly jobs: JobRuntime | null;
  /**
   * 1c Task 13: true once start() has retired this app's handler (`state.retired`): the job runtime drains and the
   * database closes, so a request still on its way starts no work.
   */
  readonly retired: boolean;
  /**
   * 1c Task 27 (L45, S12): the install's files changed (the wizard wrote config.json or finished, in this process or
   * another): while the app is `not_installed`, start() makes a new boot attempt, so that a finished install is served
   * without a restart. Returns at once (the attempt runs on its own); a no-op in an app built without start().
   */
  installDone(): void;
  /**
   * The edition of this process (the edition seam, ruling R1): what the dashboard, Diagnostik and the update prechecks
   * ask of it, and where the update feed's signed time goes. The community edition ({@link createAppEdition}) needs no
   * DATA_DIR and never refuses anything.
   */
  readonly edition: EditionService;
  /**
   * Step 10 of the route chain (http/edition-gate.ts, ruling R2): default {@link communityEditionGate}, which lets every
   * route through.
   */
  readonly editionGate: EditionGate;
  /**
   * 1d Task 20: the update machinery of this process. `source` is the feed client ({@link createAppUpdateSource}); 1d
   * Task 28: `packageKeys` is there whenever the app has a DATA_DIR (the app's own unless given).
   * @throws TypeError when the app has no DATA_DIR (`deps.dataDir`)
   */
  readonly updates: AppUpdates;
}

/** 1d: the update services of an app (Task 20: the feed client). */
export interface AppUpdates {
  /** The feed client of spec §13.8: the verified feed of a channel, and resumable package downloads. */
  readonly source: UpdateSource;
  /**
   * 1d Task 28: the keys an uploaded release package is verified with (`POST updates/upload`), as the update kind
   * verifies it: the embedded root keys, the installation's root-signed keyset documents, dev keys refused in a
   * production build (R65b). Given without it (start(), most tests), createServices adds the app's own
   * ({@link appPackageKeys}).
   */
  readonly packageKeys?: () => Promise<PackageKeys>;
}

/** 1d Task 28: what a release package's signature is checked with (readPackageManifest's keys). */
export interface PackageKeys {
  /** The trust anchors: the root keys the build embeds. */
  roots: readonly TrustedKey[];
  /** The installation's root-signed keyset documents (R65a). */
  sources: KeysetSource[];
  /** Documents that trust a `dev-` kid count for nothing (a production build, R65b). */
  refuseDevKids: boolean;
}

/**
 * 1d Task 28: the package keys of an app (the update kind's own, {@link appUpdateKindDeps}): the embedded root keys
 * (none in a server.mjs the release build did not bundle, which therefore trusts no package), the keyset documents of
 * DATA_DIR/releases/keyset.json, the installed releases and the running release, dev keys refused in production.
 */
export function appPackageKeys(d: { dataDir: string; appRoot?: string | undefined; releaseDir?: string | undefined }): () => Promise<PackageKeys> {
  return async () => ({
    roots: embeddedRootKeys() ?? [],
    sources: await installationKeysetSources(d),
    refuseDevKids: refusesDevKids(),
  });
}

/** Where a notification about an op that needs attention leads (the operations page, Task 19). */
const OPS_PAGE = '/admin/_update';

/** What {@link createAppOps} needs besides the state. */
export interface AppOpsDeps {
  dataDir: string;
  /** The running release: the version of the ops it begins, and of the migrations its kinds apply. */
  version: string;
  log: Logger;
  /** Epoch ms (services.clock). */
  clock(): number;
  /** Default `standalone`: the runtime of an op's dedicated connection. */
  runtime?: Runtime;
  /** The wizard's own handle, used while `state.db` is absent (before the install completes). */
  installDb?(): DbHandle | undefined;
  /** Default the kinds of this release (jobs/runtime.ts opKinds). */
  kinds?: readonly OpKindHandler[];
  /**
   * 1d Task 24 (preflight S6): the update kind's deps for the default kinds ({@link appUpdateKindDeps}); without them the
   * default kinds have no `update` kind. Ignored when `kinds` is given.
   */
  update?: () => UpdateKindDeps;
}

/**
 * The OpsMachine of an app over `state` (S11): `db()` = `state.db ?? installDb()`; a dedicated connection opens the
 * database of `state.config` (purpose `cli`, pool 1, P17); `onAttention` notifies the holders of the kind's
 * permission (`system.config.manage` for an op whose kind cannot be read), linking to the operations page (M34).
 */
export function createAppOps(state: AppState, d: AppOpsDeps): OpsMachine {
  const db = (): DbHandle | undefined => state.db ?? d.installDb?.();
  return createOpsMachine({
    dataDir: d.dataDir,
    kinds: d.kinds ?? opKinds({ appVersion: d.version, config: () => state.config, ...(d.update === undefined ? {} : { update: d.update }) }),
    db,
    async connect() {
      const config = state.config;
      if (config === undefined) throw new DomainError('DB_UNAVAILABLE');
      return connect(config.db, { runtime: d.runtime ?? 'standalone', purpose: 'cli', dataDir: d.dataDir });
    },
    keyring: () => state.config?.keyring ?? [],
    clock: d.clock,
    log: d.log,
    async snapshotBackupRunning() {
      // Task 20: the named lock `backup:snapshot`, held while a snapshot backup runs; claimLock dates its leases by
      // the wall clock.
      const h = db();
      return h !== undefined && snapshotBackupRunning(h, Date.now());
    },
    async onAttention(op: OpStatus) {
      // Final review (T34, ops minor): no notification row where nobody can read it or it would land in tables being
      // replaced: the wizard's install-migrate (the wizard shows the op itself; its database may have no tables yet),
      // any op before the install completes, and a restore past its point of no return (as the machine's progress
      // hint, machine.ts flushHint). The op's own page and the warning in the log still report it.
      if (op.kind === 'install-migrate' || state.config?.installState !== 'complete') return;
      if (op.kind === 'restore' && op.pointOfNoReturn) return;
      const h = db();
      if (h === undefined) return;
      const permission = op.kind === null ? 'system.config.manage' : OP_KIND_PERMISSION[op.kind];
      await withTx(h, (trx) =>
        notify(
          trx,
          {
            audience: { permission },
            type: 'ops.attention',
            titleKey: 'notification.ops_attention.title',
            params: { name: op.kind ?? 'ops' },
            link: OPS_PAGE,
          },
          d.clock(),
        ),
      );
    },
    appVersion: d.version,
  });
}

/** What {@link createAppEdition} needs besides the state. */
export interface AppEditionDeps {
  /** Epoch ms (services.clock). */
  clock(): number;
  log: Logger;
  /** The wizard's own handle, used while `state.db` is absent (before the install completes). */
  installDb?(): DbHandle | undefined;
}

/**
 * The community edition of an app over `state` (createCommunityEdition): its signed times clear clock_anomaly on the
 * database `state.db ?? installDb()`, when there is one. It needs no DATA_DIR and no config.
 */
export function createAppEdition(state: AppState, d: AppEditionDeps): EditionService {
  return createCommunityEdition({ db: () => state.db ?? d.installDb?.(), clock: d.clock, log: d.log });
}

/** What {@link createAppUpdateSource} needs besides the state. */
export interface AppUpdateSourceDeps {
  dataDir: string;
  /** The folder of app.js: its bundled releases' keyset.json count among the keyset documents. */
  appRoot?: string | undefined;
  /** The running release's folder (its keyset.json counts too). */
  releaseDir?: string | undefined;
  /** The environment (`deps.env`): ALTIS_UPDATE_FEED_URL, and the test faults of a test build. */
  env: Env;
  /** Epoch ms (services.clock). */
  clock(): number;
  log: Logger;
  /** The wizard's own handle, used while `state.db` is absent (before the install completes). */
  installDb?(): DbHandle | undefined;
  /** The edition the freshness `issuedAt` is reported to (signed time, D1d-7); undefined: not reported. */
  edition(): EditionService | undefined;
}

/**
 * The root-signed keyset documents of the installation a feed is verified with (R65a): DATA_DIR/releases/keyset.json
 * with its `.bak`, the bundled releases next to app.js and the data releases current.json names
 * ({@link installedKeysets}), and the running release's own keyset.json. Without an app.js folder (an app built
 * without start()), the DATA_DIR store alone.
 *
 * @throws DomainError `STATE_CORRUPT` when the store and its `.bak` are both unusable (fails closed, as app.js does)
 */
async function installationKeysetSources(d: Pick<AppUpdateSourceDeps, 'dataDir' | 'appRoot' | 'releaseDir'>): Promise<KeysetSource[]> {
  let sources: KeysetSource[];
  if (d.appRoot !== undefined) {
    sources = [...(await installedKeysets(d.appRoot, d.dataDir)).sources];
  } else {
    try {
      sources = [...(await readKeysetWithBak(dataPath(d.dataDir, 'releases', 'keyset.json'), 'DATA_DIR/releases/keyset.json')).sources];
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('KEYSET_CORRUPT')) throw error;
      throw new DomainError('STATE_CORRUPT', {
        detail:
          'DATA_DIR/releases/keyset.json dan salinan .bak-nya tidak dapat dipakai; pulihkan dari cadangan / ' +
          'DATA_DIR/releases/keyset.json and its .bak copy are not usable; restore them from a backup',
        meta: { reason: 'state_unreadable', path: 'releases/keyset.json' },
        cause: error,
      });
    }
  }
  if (d.releaseDir !== undefined) {
    try {
      sources.push({ name: 'release keyset.json', docs: await readReleaseKeyset(d.releaseDir) });
    } catch {
      // A release without a usable keyset.json adds nothing: app.js refuses to run such a release anyway.
    }
  }
  return sources;
}

/**
 * 1d Task 20: the feed client of an app over `state` (spec §9.6, §13.8): the feed base of `feedBaseOf` (the
 * environment's ALTIS_UPDATE_FEED_URL, config.json's `update.feedUrl`, the build's; none before a config is loaded),
 * the embedded root keys and the installation's keyset documents, dev keys refused in production (R65b), plain http to
 * loopback only in a test build (feed-dev). The feed's keyset documents go to the keyset store (with the
 * `system.keyset_full` alert when a database is open); the freshness `issuedAt` goes to the edition as signed time
 * (the community edition: it may clear clock_anomaly, spec §10.4).
 */
export function createAppUpdateSource(state: AppState, d: AppUpdateSourceDeps): UpdateSource {
  const roots = embeddedRootKeys() ?? [];
  const refuseDevKids = refusesDevKids();
  return createUpdateSource({
    feedBase: () => (state.config === undefined ? null : feedBaseOf(state.config, d.env)),
    dataDir: d.dataDir,
    roots,
    sources: () => installationKeysetSources(d),
    refuseDevKids,
    allowLoopbackHttp: typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test',
    clock: d.clock,
    log: d.log,
    async persistKeysets(docs) {
      await persistKeysetDocs({ dataDir: d.dataDir, roots, docs, refuseDevKids, log: d.log, db: state.db ?? d.installDb?.(), now: d.clock() });
    },
    async onSignedTime(t) {
      await d.edition()?.observeSignedTime(t);
    },
    env: d.env,
  });
}

/** What {@link appUpdateKindDeps} needs besides the state. */
export interface AppUpdateKindOptions {
  dataDir: string;
  /** The folder of app.js (its bundled releases); none: no bundled release can be installed. */
  appRoot?: string | undefined;
  /** The running release's folder (its keyset.json counts among the keyset documents). */
  releaseDir?: string | undefined;
  /** The running release's version. */
  version: string;
  /** The environment: ALTIS_UPDATE_FEED_URL and the test faults of the feed client this makes when `source` is absent. */
  env: Env;
  /** Epoch ms (services.clock). */
  clock(): number;
  log: Logger;
  /** The wizard's own handle, used while `state.db` is absent. */
  installDb?(): DbHandle | undefined;
  /** The process's edition; absent: one is made over `state` on first use ({@link createAppEdition}). */
  edition?(): EditionService;
  /** The process's feed client; absent: one is made over `state` on first use ({@link createAppUpdateSource}). */
  source?(): UpdateSource;
  /** The restore runner of the update revert (jobs/runtime.ts updateRestoreRunner), or null. */
  restore(): RestoreRunner | null;
  requestRestart(reason: string): Promise<void>;
  /** Task 25: the boot hooks of the process that boots the target; default none. */
  boot?(): BootHooks | null;
}

/** The 4-digit schema version `schema_meta` records, or null (the prechecks' migration estimate). */
async function schemaVersionOf(h: DbHandle): Promise<string | null> {
  const row = await h.db.selectFrom('schema_meta').select('schema_version').where('id', '=', 1).executeTakeFirst();
  const version = row?.schema_version;
  return typeof version === 'string' && /^\d{4}$/.test(version) ? version : null;
}

/**
 * The prechecks of a candidate (runPrecheck) on database `h` for the running release `version`: the edition's
 * entitlement (the community edition entitles every release), the snapshot backup lock, this Node.js, and one migration
 * in the estimate when the candidate's schema is ahead of the database's (a feed entry does not say how many it
 * brings). What the update kind runs at `checking`; 1d Task 28: the updates routes run it too (`o.proveHeadroom: false`
 * for `GET updates`).
 */
export async function appPrecheck(
  d: { dataDir: string; h: DbHandle; edition: Pick<EditionService, 'check'>; version: string },
  c: Candidate,
  o: { proveHeadroom?: boolean } = {},
): Promise<PrecheckReport> {
  const current = await schemaVersionOf(d.h);
  return runPrecheck(
    {
      dataDir: d.dataDir,
      db: d.h,
      edition: d.edition,
      snapshotBackupRunning: () => snapshotBackupRunning(d.h, Date.now()),
      nodeVersion: process.versions.node,
      appVersion: d.version,
      migrationsAhead: (cand) => (cand.schemaLatest !== undefined && current !== null && Number(cand.schemaLatest) > Number(current) ? 1 : 0),
    },
    c,
    o,
  );
}

/**
 * 1d Task 24 (preflight S6): the update kind's deps of a process over `state`, read at every step (the config of the
 * moment): the prechecks (runPrecheck with the edition and the snapshot lock), the feed client,
 * the embedded roots and the installation's keyset documents, the `pre_update` backup's manifest facts from config.json,
 * this release's migrations, the restore runner and the restart of the caller, the boot hooks (null outside start()'s
 * update boot). A process without a loaded config cannot step an update: `DB_UNAVAILABLE` leaves the op for one that has
 * it.
 */
export function appUpdateKindDeps(state: AppState, d: AppUpdateKindOptions): () => UpdateKindDeps {
  const roots = embeddedRootKeys() ?? [];
  const refuseDevKids = refusesDevKids();
  const db = (): DbHandle | undefined => state.db ?? d.installDb?.();
  let ownEdition: EditionService | undefined;
  let ownSource: UpdateSource | undefined;
  const edition = (): EditionService =>
    d.edition?.() ??
    (ownEdition ??= createAppEdition(state, {
      clock: d.clock,
      log: d.log,
      ...(d.installDb === undefined ? {} : { installDb: d.installDb }),
    }));
  const source = (): UpdateSource =>
    d.source?.() ??
    (ownSource ??= createAppUpdateSource(state, {
      dataDir: d.dataDir,
      appRoot: d.appRoot,
      releaseDir: d.releaseDir,
      env: d.env,
      clock: d.clock,
      log: d.log,
      ...(d.installDb === undefined ? {} : { installDb: d.installDb }),
      edition,
    }));
  const snapshotRunning = async (): Promise<boolean> => {
    const h = db();
    return h !== undefined && snapshotBackupRunning(h, Date.now());
  };
  return () => {
    const config = state.config;
    if (config === undefined) throw new DomainError('DB_UNAVAILABLE', { meta: { reason: 'no_config' } });
    return {
      dataDir: d.dataDir,
      appRoot: d.appRoot ?? '',
      appVersion: d.version,
      source: source(),
      async precheck(c) {
        const h = db();
        if (h === undefined) throw new DomainError('DB_UNAVAILABLE');
        return appPrecheck({ dataDir: d.dataDir, h, edition: edition(), version: d.version }, c);
      },
      roots,
      sources: () => installationKeysetSources({ dataDir: d.dataDir, appRoot: d.appRoot, releaseDir: d.releaseDir }),
      refuseDevKids,
      backup: { dataDir: d.dataDir, installId: config.install.id, appVersion: d.version, sessionKey: csrfKey(config), kids: config.keyring.map((k) => k.kid) },
      migrations: releaseMigrations(),
      restore: d.restore(),
      requestRestart: d.requestRestart,
      boot: d.boot ?? (() => null),
      snapshotBackupRunning: snapshotRunning,
      notify,
      log: d.log,
    };
  };
}

/**
 * The SMTP configuration of whatever database and config `state` holds when a mail is sent (start() opens the
 * database after createApp).
 */
function stateSmtpConfig(state: AppState): () => Promise<SmtpConfig | null> {
  return async () => {
    if (state.db === undefined) throw new DomainError('DB_UNAVAILABLE');
    if (state.config === undefined) throw new TypeError('mailer: no config is loaded');
    return loadSmtpConfig(state.db.db, state.config.keyring);
  };
}

/** 1c Task 18: each phase of a mail job's SMTP session (connecting, the greeting, a quiet socket) may take this long. */
export const JOB_MAIL_TIMEOUT_MS = 8_000;
/**
 * 1c Task 18: a mail job's whole SMTP session may take this long, so that a send fits the forgot route's drive slice
 * of 10 s (decision C28) and any slice of 20 s (P9), and never outlives the job's lease.
 */
export const JOB_MAIL_DEADLINE_MS = 9_000;

/**
 * 1c Task 18: the mailer of the job handlers (`mail.password_reset`), over whatever database and config `state` holds
 * when a mail is sent, bounded by {@link JOB_MAIL_TIMEOUT_MS} per phase and {@link JOB_MAIL_DEADLINE_MS} in all.
 */
export function jobMailer(state: AppState): Mailer {
  return createSmtpMailer(stateSmtpConfig(state), { timeoutMs: JOB_MAIL_TIMEOUT_MS, deadlineMs: JOB_MAIL_DEADLINE_MS });
}

/**
 * The {@link ConfigWriter} of an app over `state`, writing `deps.dataDir`'s config.json; `fence` is the app's.
 * `onApplied` runs after a written config is applied (the edition's invalidate: a cached check may follow config.json).
 */
function stateConfigWriter(state: AppState, deps: AppDeps, fence: () => ConfigFence | null, onApplied: () => void = () => {}): ConfigWriter {
  const env = deps.env ?? process.env;
  return {
    env,
    async update(mutate) {
      if (deps.dataDir === undefined) throw new TypeError('configWriter: the app has no DATA_DIR (AppDeps.dataDir)');
      const { config: written, changed } = await updateConfigIfChanged(deps.dataDir, mutate);
      if (!changed) return null;
      const applied = applyEnvOverrides(written, env);
      state.config = applied;
      state.baseUrl = applied.baseUrl;
      fence()?.reset(applied);
      onApplied();
      return applied;
    },
  };
}

/** The services of an app over `state`; `deps.services` replaces any of them (tests), `deps.clock` the clock. */
export function createServices(state: AppState, deps: AppDeps): AppServices {
  const given = deps.services ?? {};
  const clock = given.clock ?? deps.clock ?? (() => Date.now());
  const fence = (): ConfigFence | null => given.fence ?? state.fence ?? null;
  const install = given.install ?? createInstallService(state, deps);
  // 1c Task 13: made with the app when it has a DATA_DIR; an app without one (tests, tools) has none.
  const dataDir = deps.dataDir;
  const settings = given.settings ?? createSettingsCache({ clock });
  const grants = given.grants ?? createGrantsCache();
  // 1c Task 15: the ops fence (start() passes its own); `opsFence: null` given means none.
  const opsFence: OpsFence | null =
    given.opsFence !== undefined
      ? given.opsFence
      : dataDir === undefined
        ? null
        : createOpsFence({
            dataDir,
            clock: () => Date.now(),
            log: deps.log,
            onEpoch() {
              settings.invalidate();
              grants.clear();
            },
            onOpEnded() {},
          });
  const ops: OpsMachine | undefined =
    given.ops ??
    (dataDir === undefined
      ? undefined
      : createAppOps(state, {
          dataDir,
          version: deps.version,
          log: deps.log,
          clock,
          runtime: deps.runtime ?? 'standalone',
          installDb: () => install.db(),
          // 1d Task 24 (S6): the update kind over this app's edition and feed client (both made below; read at step
          // time). An app without start() has no restart to ask for and no SQLite swap.
          update: appUpdateKindDeps(state, {
            dataDir,
            appRoot: deps.appRoot,
            releaseDir: deps.release?.dir,
            version: deps.version,
            env: deps.env ?? process.env,
            clock,
            log: deps.log,
            installDb: () => install.db(),
            edition: () => services.edition,
            source: () => services.updates.source,
            restore: updateRestoreRunner({ appVersion: deps.version, config: () => state.config, dataDir }),
            requestRestart: async () => {},
          }),
        }));
  // The edition seam (ruling R1): made with every app, DATA_DIR or not (start() passes its own).
  const edition: EditionService = given.edition ?? createAppEdition(state, { clock, log: deps.log, installDb: () => install.db() });
  // 1d Task 20: made with the app when it has a DATA_DIR. 1d Task 28: with the app's package keys unless given some.
  const packageKeys =
    dataDir === undefined ? undefined : appPackageKeys({ dataDir, appRoot: deps.appRoot, releaseDir: deps.release?.dir });
  const givenUpdates = given.updates;
  const updates: AppUpdates | undefined =
    givenUpdates !== undefined
      ? givenUpdates.packageKeys !== undefined || packageKeys === undefined
        ? givenUpdates
        : { ...givenUpdates, packageKeys }
      : dataDir === undefined
        ? undefined
        : {
            source: createAppUpdateSource(state, {
              dataDir,
              appRoot: deps.appRoot,
              releaseDir: deps.release?.dir,
              env: deps.env ?? process.env,
              clock,
              log: deps.log,
              installDb: () => install.db(),
              edition: () => edition,
            }),
            ...(packageKeys === undefined ? {} : { packageKeys }),
          };
  const services: AppServices = {
    clock,
    version: given.version ?? deps.version,
    health: given.health ?? healthHandler(state, deps.version, { fence: () => opsFence }),
    settings,
    grants,
    get fence(): ConfigFence | null {
      return fence();
    },
    opsFence,
    adminAssets: given.adminAssets ?? adminAssetsOf(deps.release),
    hasher: given.hasher ?? createPasswordHasher(),
    mailer: given.mailer ?? createSmtpMailer(stateSmtpConfig(state)),
    emailTestMailer:
      given.emailTestMailer ??
      createSmtpMailer(stateSmtpConfig(state), { timeoutMs: EMAIL_TEST_TIMEOUT_MS, deadlineMs: EMAIL_TEST_DEADLINE_MS }),
    configWriter: given.configWriter ?? stateConfigWriter(state, deps, fence, () => edition.invalidate()),
    get dataDir(): string {
      const dir = given.dataDir ?? deps.dataDir;
      if (dir === undefined) throw new TypeError('services.dataDir: the app has no DATA_DIR (AppDeps.dataDir)');
      return dir;
    },
    install,
    // 1c Task 8.
    runtime: given.runtime ?? deps.runtime ?? 'standalone',
    streams: given.streams ?? createStreamCounter(),
    // 1c Task 23.
    appJsVersion: given.appJsVersion !== undefined ? given.appJsVersion : (deps.appJsVersion ?? null),
    // 1c Task 13.
    get ops(): OpsMachine {
      if (ops === undefined) throw new TypeError('services.ops: the app has no DATA_DIR (AppDeps.dataDir)');
      return ops;
    },
    get jobs(): JobRuntime | null {
      return given.jobs ?? state.jobs ?? null;
    },
    get retired(): boolean {
      return given.retired ?? state.retired === true;
    },
    // 1c Task 27: start() passes its own (a new boot attempt).
    installDone: given.installDone ?? (() => {}),
    // The edition seam (rulings R1, R2).
    edition,
    editionGate: given.editionGate ?? communityEditionGate,
    // 1d Task 20.
    get updates(): AppUpdates {
      if (updates === undefined) throw new TypeError('services.updates: the app has no DATA_DIR (AppDeps.dataDir)');
      return updates;
    },
  };
  return services;
}
