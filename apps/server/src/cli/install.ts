import {
  PASSWORD_MIN_LENGTH,
  bumpAuthzVersion,
  checkPasswordPolicy,
  createPasswordHasher,
  ensureSystemRoles,
  failedChecks,
  preflightChecks,
  revokeSubject,
  txCtx,
  type TxCtx,
} from '@altis/core';
import { parseStrictJson } from '@altis/crypto';
import { FRESH_INSTALL_ACCENT } from '@altis/opac-theme';
import {
  checkServer,
  connect,
  listCatalogTables,
  releaseMigrations,
  runMigrations,
  upsert,
  withTx,
  type DbHandle,
} from '@altis/db';
import {
  RUNTIMES,
  appPath,
  atomicWriteJson,
  checkDocroot,
  dataPath,
  ensureDir,
  ensureHeadroom,
  readCliInputFile,
  readJsonWithBak,
  realPathOf,
  sqliteAllowed,
  withFileLock,
  writeAppFileAtomic,
  type Env,
  type Runtime,
} from '@altis/platform';
import { DomainError, isDomainError, newId, normalizeKey, type Locale } from '@altis/shared';
import { emailField, localeField, passwordField, personNameField, timezoneField, usernameField } from '@altis/shared/api/common';
import { z } from 'zod';
import { ConfigSchema, applyEnvOverrides, loadConfig, updateConfig, validateBaseUrl, writeConfig, type Config } from '../config.js';
import type { BootContext } from '../index.js';
import { generateInstallSecrets } from '../secrets.js';
import { CliError, describeKey, homeDir, nodeSupported, nodeTooOld, testFault } from './common.js';
import { PANEL_MARKERS, detectPanelMarkers } from './host-panels.js';

// `node app.js install --config <file> [--runtime <runtime>]`: the headless install (spec §13.6, §9.5 steps 1–2 and
// 7 without the browser parts, §7.7). Steps, in this order:
//
//   1. installed check: install.lock exists, or config.json says installState 'complete' → ALREADY_INSTALLED (exit 2)
//   -  the input file: read (platform readCliInputFile, ruling R1), strict JSON, InstallInputSchema, baseUrl (P13);
//      the first super admin (D33): the password policy (PASSWORD_TOO_WEAK) and keys that fit their columns
//      (VALIDATION_FAILED), so a refused admin leaves no trace, not even config.json
//   -  the runtime (ruling R66): --runtime, else the input's `runtime`, else what this shell detected; the server's
//      runtime-dependent settings (P20 SQLite, P15 default hops) are decided for it, and it is recorded as
//      config.json install.runtime. A shell sees none of the markers Passenger, lsnode or PM2 set in the processes
//      they start, so when ALTIS_RUNTIME is unset, the shell detected only 'standalone' and the host runs a hosting
//      panel (cPanel, LiteSpeed, aaPanel, Plesk), install refuses to guess: RUNTIME_REQUIRED, asking for --runtime
//   2. platform checks, before anything is created: Node ≥ 22.16; DATA_DIR and the app outside any document root
//      (P16); SQLite only where the runtime allows it (P20); then DATA_DIR is created and proven writable; then the
//      wizard's checks (1c Task 27, L51: core preflightChecks): an `error` refuses (PREFLIGHT_FAILED), the warnings
//      (WASM, RAM) come back to be printed
//   -  from here on under DATA_DIR/tmp/install-run.lock, so two installs never interleave (1 is checked again)
//   3. connect + checkServer (version, engine, full-text)
//   4. empty database (ruling R55): the catalog lists nothing; or a resume (config.json exists, installState not
//      complete, and schema_meta.install_id is NULL or this install's id)
//   5. config.json: written with installState 'migrate' (writeConfig), or on a resume updated (updateConfig, R58)
//   6. runMigrations (releaseMigrations(): PHASE1_MIGRATIONS, plus a test build's fixture migrations, D1d-26)
//   7. the admin's password hashed (scrypt never runs inside a transaction, S18), then the seeds in one withTx
//      (ruling R54): schema_meta.install_id, the default branch, the library settings, the system roles
//      (ensureSystemRoles, D5) and the first super admin (createFirstSuperAdmin); idempotent upserts, so a resumed
//      install never duplicates a row (nor a users.create entry). The web wizard (1c Task 27, install/steps.ts) writes
//      the same seeds through the same pieces (claimSchemaMeta, seedLibrary, createFirstSuperAdmin), spread over its
//      steps
//   8. installState 'complete' (updateConfig), then DATA_DIR/install.lock {installId, at}, then the install marker
//      <appRoot>/.altis/installed.json as the wizard writes it (writeInstalledMarker: spec §7.7, ruling R1c-5; not
//      under docker/service, nothing when the app folder is not writable, a failure only a warning)
//
// The process may die at any step (P7): running the command again continues from where it stopped, with the same
// install identity. The connection settings are the input's with the environment overrides applied (what the
// server will use), but only the input's are ever written (R58).

/** The default branch every install starts with (spec §9.5 step 3 "cabang default"). */
export const DEFAULT_BRANCH_CODE = 'PUSAT';
const DEFAULT_LIBRARY_NAME = 'Perpustakaan';
const DEFAULT_TIMEZONE = 'Asia/Jakarta';
const DEFAULT_LOCALE: Locale = 'id';

/** Written to prove DATA_DIR is writable and has room for config, logs and a small SQLite database. */
const INSTALL_HEADROOM_BYTES = 16 * 1024 * 1024;
/** How long a second install waits for the first one (a migration may wait 10 minutes for its own lock). */
const INSTALL_LOCK_WAIT_MS = 15 * 60 * 1000;

const MAX_PROXY_HOPS = 10;
/** The width of `username_key` and `email_key`, in code points (spec §6.1). */
const KEY_MAX = 191;

/** The library profile: the shared fields of the API (S26), so the install, the wizard and the SPA agree. */
const LibrarySchema = z.strictObject({
  /** branches.name is VARCHAR(191): trimmed, no control character. */
  name: personNameField.optional(),
  /** An IANA time zone; branches.timezone is VARCHAR(64). */
  timezone: timezoneField.optional(),
  locale: localeField.optional(),
});

/**
 * The first super admin (decision D33: an install without a staff user is unusable), with the fields of the users API:
 * the username NFKC'd and trimmed, the password never trimmed (the policy is checked before anything is written).
 */
const AdminSchema = z.strictObject({
  username: usernameField,
  name: personNameField,
  password: passwordField,
  email: emailField.optional(),
});

/** What `install --config <file>` reads (strict at every level). `library` defaults: Perpustakaan, Asia/Jakarta, id. */
export const InstallInputSchema = z.strictObject({
  baseUrl: z.string(),
  // config.json's db accepts unknown keys (decision D1d-2); this input does not, so a typo is refused, not dropped.
  db: z.strictObject(ConfigSchema.shape.db.shape),
  library: LibrarySchema.optional(),
  trustProxy: z.strictObject({ hops: z.number().int().min(0).max(MAX_PROXY_HOPS) }).optional(),
  /** The runtime the server will run under (ruling R66), as --runtime says it; default: what the shell detects. */
  runtime: z.enum(RUNTIMES).optional(),
  admin: AdminSchema,
});

export type InstallInput = z.infer<typeof InstallInputSchema>;

export interface Library {
  name: string;
  timezone: string;
  locale: Locale;
}

/** The first super admin as {@link createFirstSuperAdmin} takes it; the password is passed in hashed. */
export interface FirstSuperAdmin {
  /** As typed, after NFKC and trim (usernameField). */
  username: string;
  name: string;
  email?: string | undefined;
}

interface Plan {
  baseUrl: string;
  db: Config['db'];
  hops: number;
  library: Library;
  /** The runtime the settings are decided for, recorded as install.runtime (ruling R66). */
  runtime: Runtime;
  admin: FirstSuperAdmin;
  /** The admin's password as typed: hashed before the seeds, never written or printed. */
  password: string;
}

/** P15: `passenger`, `litespeed` and aaPanel's `pm2` sit behind one proxy; Docker and a PC behind none. */
export function defaultProxyHops(runtime: Runtime): number {
  return runtime === 'passenger' || runtime === 'litespeed' || runtime === 'pm2' ? 1 : 0;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(root)' : path.map(String).join('.');
}

/** The path of an input key Zod did not recognize, the key as describeKey shows it (L51). */
function unrecognizedPath(path: readonly PropertyKey[], key: string): string {
  return formatPath([...path, describeKey(key)]);
}

function invalidInput(where: string, meta: Record<string, unknown>): DomainError {
  return new DomainError('INVALID_CONFIG', {
    detail: `berkas input tidak valid: ${where} / the input file is invalid: ${where}`,
    meta,
  });
}

/**
 * Parses the input file's text against InstallInputSchema. Errors name fields (paths) and never their values.
 *
 * @throws DomainError `INVALID_CONFIG` (not JSON, a duplicate key, or not InstallInputSchema)
 */
export function parseInstallInput(text: string): InstallInput {
  let raw: unknown;
  try {
    raw = parseStrictJson(text);
  } catch (error) {
    const syntax = error instanceof SyntaxError ? /^JSON_SYNTAX:(\d+)$/.exec(error.message) : null;
    if (syntax !== null) throw invalidInput(`bukan JSON (posisi ${syntax[1]}) / not JSON (at offset ${syntax[1]})`, { reason: 'not_json' });
    const duplicate = error instanceof Error && error.message.startsWith('DUPLICATE_KEY:');
    throw invalidInput(duplicate ? 'kunci ganda / a duplicate key' : 'bukan JSON / not JSON', { reason: duplicate ? 'duplicate_key' : 'not_json' });
  }
  const result = InstallInputSchema.safeParse(raw);
  if (!result.success) {
    const issues: { path: string; code: string }[] = [];
    for (const issue of result.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) issues.push({ path: unrecognizedPath(issue.path, key), code: issue.code });
      } else {
        issues.push({ path: formatPath(issue.path), code: issue.code });
      }
    }
    const where = [...new Set(issues.map((issue) => issue.path))];
    throw invalidInput(where.slice(0, 10).join(', ') + (where.length > 10 ? ', …' : ''), { reason: 'schema', issues });
  }
  return result.data;
}

/** `normalizeKey(value)` (spec §6.1), or null when it is longer than its key column (upper-casing can lengthen it). */
function keyOf(value: string): string | null {
  const key = normalizeKey(value);
  // Code points, as the column counts them (M21); a key of at most KEY_MAX UTF-16 units always fits.
  return key.length > KEY_MAX && Array.from(key).length > KEY_MAX ? null : key;
}

function keyTooBig(path: string): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail:
      `${path} terlalu panjang setelah dinormalisasi (maks. ${KEY_MAX} karakter) / ` +
      `${path} is too long once normalized (at most ${KEY_MAX} characters)`,
    meta: { errors: [{ path, code: 'too_big' }] },
  });
}

/**
 * The install's settings from its input, for `runtime` (P15: the default proxy hops depend on it). Everything about
 * the admin that can be refused is refused here, before anything is written (D33): the password policy (at least
 * PASSWORD_MIN_LENGTH; `security.password_min_length` does not exist yet) and keys that would not fit their columns.
 *
 * @throws DomainError `INVALID_BASE_URL`, `PASSWORD_TOO_WEAK`, `VALIDATION_FAILED` (`admin.username`/`admin.email`
 *   `too_big`)
 */
function planInstall(input: InstallInput, runtime: Runtime): Plan {
  const timezone = input.library?.timezone ?? DEFAULT_TIMEZONE;
  const baseUrl = validateBaseUrl(input.baseUrl);
  const { password, ...admin } = input.admin;
  if (keyOf(admin.username) === null) throw keyTooBig('admin.username');
  if (admin.email !== undefined && keyOf(admin.email) === null) throw keyTooBig('admin.email');
  checkPasswordPolicy(password, { minLength: PASSWORD_MIN_LENGTH });
  return {
    baseUrl,
    db: input.db,
    hops: input.trustProxy?.hops ?? defaultProxyHops(runtime),
    library: {
      name: input.library?.name ?? DEFAULT_LIBRARY_NAME,
      // The canonical spelling (`asia/jakarta` → `Asia/Jakarta`).
      timezone: new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone,
      locale: input.library?.locale ?? DEFAULT_LOCALE,
    },
    runtime,
    admin,
    password,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The runtime (ruling R66)

export interface RuntimeChoice {
  /** --runtime. */
  flag?: Runtime | undefined;
  /** The input file's `runtime`. */
  input?: Runtime | undefined;
  /** What app.js detected in this shell (ctx.runtime). */
  detected: Runtime;
  env: Env;
  /** The hosting-panel marker folders on this host (host-panels.ts). */
  hostPanels: () => readonly string[];
}

function runtimeRequired(found: readonly string[]): CliError {
  const panels = PANEL_MARKERS.filter((m) => found.includes(m.path));
  const seen = panels.map((m) => `${m.panel}: ${m.path}`).join(', ');
  const hints = panels.map((m) => `${m.panel}: --runtime ${m.runtime}`).join(', ');
  const choices = `--runtime <${RUNTIMES.join('|')}>`;
  return new CliError(
    'RUNTIME_REQUIRED',
    `runtime server tidak dapat dipastikan dari shell ini: host ini memakai panel hosting (${seen}), sedangkan shell ` +
      `hanya mendeteksi standalone. Jalankan ulang dengan ${choices} (${hints}), atau isi "runtime" di berkas input / ` +
      `the server's runtime cannot be determined from this shell: this host runs a hosting panel (${seen}), but the ` +
      `shell only detects standalone. Run again with ${choices} (${hints}), or set "runtime" in the input file`,
  );
}

/**
 * The runtime an install decides its settings for (ruling R66): --runtime, else the input's `runtime` (the two must
 * agree when both are given), else the one app.js detected. A detected 'standalone' is only trusted when ALTIS_RUNTIME
 * says so or the host runs no hosting panel: a shell never carries the markers that Passenger, lsnode or PM2 set.
 *
 * @throws CliError `USAGE` when --runtime and the input disagree; `RUNTIME_REQUIRED` when a hosting panel is found and
 *   nothing says which runtime the server has
 */
export function installRuntime(o: RuntimeChoice): Runtime {
  if (o.flag !== undefined && o.input !== undefined && o.flag !== o.input) {
    throw new CliError(
      'USAGE',
      `--runtime ${o.flag} dan "runtime" di berkas input (${o.input}) berbeda / ` +
        `--runtime ${o.flag} and the input file's "runtime" (${o.input}) differ`,
    );
  }
  const explicit = o.flag ?? o.input;
  if (explicit !== undefined) return explicit;
  const forced = o.env['ALTIS_RUNTIME'];
  const forcedValid = typeof forced === 'string' && (RUNTIMES as readonly string[]).includes(forced);
  if (o.detected !== 'standalone' || forcedValid) return o.detected;
  const found = o.hostPanels();
  if (found.length > 0) throw runtimeRequired(found);
  return 'standalone';
}

/** Today's date (`YYYY-MM-DD`) in `timeZone`: the install date (config.json `install.trialStartedAt`). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** What an install writes into config.json besides its identity and secrets (the headless input or the wizard's). */
export interface InstallSettings {
  /** Canonical (validateBaseUrl). */
  baseUrl: string;
  hops: number;
  db: Config['db'];
  /** Recorded as install.runtime (ruling R66). */
  runtime: Runtime;
  /** The time zone of the install date `trialStartedAt` (today there). */
  timezone: string;
  /**
   * The installer's clock (epoch ms) that dates `trialStartedAt`; default `Date.now()`. The wizard passes the app clock
   * (rc.now), which dates its claim and install code too (1d Task 35: the test hook ALTIS_TEST_CLOCK_OFFSET_MS moves it).
   */
  now?: number;
}

/** A new config (new identity and secrets) for `o`, installState 'migrate'. */
export function freshInstallConfig(o: InstallSettings): Config {
  const made = generateInstallSecrets(todayIn(o.timezone, o.now === undefined ? undefined : new Date(o.now)));
  return {
    version: 1,
    baseUrl: o.baseUrl,
    trustProxy: { hops: o.hops },
    allowedOrigins: [],
    db: o.db,
    ...made,
    install: { ...made.install, runtime: o.runtime },
    installState: 'migrate',
    log: { level: 'info' },
  };
}

/** `existing` (an unfinished install's config.json) with the settings of `o`; identity and secrets kept. */
export function resumedInstallConfig(existing: Config, o: Omit<InstallSettings, 'timezone'>): Config {
  const copy = structuredClone(existing);
  return {
    ...copy,
    baseUrl: o.baseUrl,
    trustProxy: { hops: o.hops },
    db: o.db,
    install: { ...copy.install, runtime: o.runtime },
    installState: 'migrate',
  };
}

const settingsOf = (plan: Plan): InstallSettings => ({
  baseUrl: plan.baseUrl,
  hops: plan.hops,
  db: plan.db,
  runtime: plan.runtime,
  timezone: plan.library.timezone,
});

function freshConfig(plan: Plan): Config {
  return freshInstallConfig(settingsOf(plan));
}

function resumedConfig(existing: Config, plan: Plan): Config {
  return resumedInstallConfig(existing, settingsOf(plan));
}

// ---------------------------------------------------------------------------------------------------------------
// Step 1: installed?

function alreadyInstalled(): DomainError {
  return new DomainError('ALREADY_INSTALLED', {
    detail:
      'ALTIS sudah terpasang di DATA_DIR ini; untuk memasang ulang pakai install:reset / ' +
      'ALTIS is already installed in this DATA_DIR; to install again use install:reset',
  });
}

const lockPath = (dataDir: string) => dataPath(dataDir, 'root', 'install.lock');

/** DATA_DIR/tmp/install-run.lock: one install step at a time, the headless install's and the wizard's alike. */
export const installRunLockPath = (dataDir: string) => dataPath(dataDir, 'tmp', 'install-run.lock');

/** Whether DATA_DIR/install.lock exists. Its content does not matter: a damaged marker still marks an install. */
async function installLockExists(dataDir: string): Promise<boolean> {
  try {
    return (await readJsonWithBak(lockPath(dataDir), (raw) => ({ raw }))) !== null;
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return true;
    throw error;
  }
}

/** Writes DATA_DIR/install.lock `{installId, at}` (mode 600): the install is complete (spec §7.7). */
export async function writeInstallLock(dataDir: string, installId: string, now: number = Date.now()): Promise<void> {
  await atomicWriteJson(lockPath(dataDir), { installId, at: new Date(now).toISOString() }, { mode: 0o600 });
}

/**
 * Writes the install marker `<appRoot>/.altis/installed.json` `{installId, dataDir}` (DATA_DIR's real path; spec §7.7,
 * ruling R1c-5) after install.lock, for the wizard's `finish` and the headless install alike: only where the runtime is
 * not docker/service, and only when the app folder is writable. A marker whose DATA_DIR is not installed makes the
 * install gate answer 503 DATA_DIR_MISMATCH instead of the wizard.
 *
 * @returns whether it was written (false: docker/service, or the app folder is not writable)
 * @throws a file system error other than an app folder that is not writable
 */
export async function writeInstalledMarker(o: { appRoot: string; dataDir: string; installId: string; runtime: Runtime }): Promise<boolean> {
  if (o.runtime === 'docker' || o.runtime === 'service') return false;
  const dataDir = (await realPathOf(o.dataDir).catch(() => null)) ?? o.dataDir;
  return writeAppFileAtomic(appPath(o.appRoot, 'installed-marker'), JSON.stringify({ installId: o.installId, dataDir }));
}

/** The warning `install` prints when the marker could not be written (the install itself is complete). */
function markerWarning(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const shown = typeof code === 'string' && /^[A-Z_]{1,32}$/.test(code) ? ` (${code})` : '';
  return (
    `Penanda instalasi <appRoot>/.altis/installed.json tidak dapat ditulis${shown} / ` +
    `The install marker <appRoot>/.altis/installed.json could not be written${shown}`
  );
}

/**
 * Step 1 (spec §7.7: installed ⇔ install.lock exists or config.json says installState 'complete'). Returns the
 * config.json of an unfinished install, as written (no environment override), or null when there is none.
 *
 * An install that died between its last two steps (installState complete, no install.lock) gets its install.lock
 * now: the last step is completed even though the answer is ALREADY_INSTALLED.
 *
 * @throws DomainError `ALREADY_INSTALLED`; `STATE_CORRUPT`/`INVALID_CONFIG` for an unusable config.json
 */
async function unfinishedConfig(dataDir: string): Promise<Config | null> {
  if (await installLockExists(dataDir)) throw alreadyInstalled();
  const existing = await loadConfig(dataDir, {});
  if (existing?.installState === 'complete') {
    await writeInstallLock(dataDir, existing.install.id);
    throw alreadyInstalled();
  }
  return existing;
}

// ---------------------------------------------------------------------------------------------------------------
// Step 2: platform checks

function checkPlatform(ctx: BootContext, env: Env, nodeVersion: string): void {
  if (!nodeSupported(nodeVersion)) throw nodeTooOld(nodeVersion);
  const docroot = checkDocroot({ dataDir: ctx.dataDir, appRoot: ctx.appRoot, home: homeDir(env) });
  if (!docroot.ok) {
    const what =
      docroot.reason === 'DATA_IN_APPROOT'
        ? `DATA_DIR ada di dalam folder aplikasi ${docroot.matched} / DATA_DIR lies inside the app folder ${docroot.matched}`
        : `DATA_DIR atau folder aplikasi ada di dalam document root ${docroot.matched} / ` +
          `DATA_DIR or the app folder lies inside the document root ${docroot.matched}`;
    throw new DomainError('DOCROOT_EXPOSED', {
      detail: `${what}; pindahkan ke luar (mis. ~/altis/app dan ~/altis-data) / move it outside (e.g. ~/altis/app and ~/altis-data)`,
      meta: { reason: docroot.reason },
    });
  }
}

/**
 * P20: SQLite only where the runtime allows it.
 *
 * @throws DomainError `SQLITE_NOT_ALLOWED`
 */
export function checkSqlite(dialect: Config['db']['dialect'], runtime: Runtime): void {
  if (dialect === 'sqlite' && !sqliteAllowed(runtime)) {
    throw new DomainError('SQLITE_NOT_ALLOWED', {
      detail:
        `SQLite tidak dapat dipakai pada runtime ${runtime} (beberapa proses pekerja); gunakan MySQL/MariaDB atau PostgreSQL / ` +
        `SQLite cannot be used on runtime ${runtime} (several worker processes); use MySQL/MariaDB or PostgreSQL`,
      meta: { runtime },
    });
  }
}

/** Creates DATA_DIR (and its tmp area) and proves that it can be written. */
async function prepareDataDir(dataDir: string): Promise<void> {
  try {
    await ensureDir(dataPath(dataDir, 'root'));
    await ensureDir(dataPath(dataDir, 'tmp'));
    await ensureHeadroom(dataDir, INSTALL_HEADROOM_BYTES);
  } catch (error) {
    if (isDomainError(error)) throw error; // DISK_QUOTA, INVALID_PATH_SEGMENT
    const code = (error as { code?: unknown } | null)?.code;
    throw new CliError(
      'DATA_DIR_UNWRITABLE',
      `DATA_DIR ${dataDir} tidak dapat dibuat atau ditulis (${typeof code === 'string' ? code : 'galat I/O'}) / ` +
        `DATA_DIR ${dataDir} cannot be created or written (${typeof code === 'string' ? code : 'I/O error'})`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Steps 3–4: the database

export function dbUnsupported(problems: readonly string[], version: string): DomainError {
  return new DomainError('DB_UNSUPPORTED', {
    detail:
      `Server database tidak memenuhi syarat (${problems.join(', ')}; versi ${version}); minimal MySQL 8.0, MariaDB 10.6, PostgreSQL 15 / ` +
      `The database server does not qualify (${problems.join(', ')}; version ${version}); at least MySQL 8.0, MariaDB 10.6, PostgreSQL 15`,
    meta: { problems },
  });
}

function dbNotEmpty(tables: number): DomainError {
  return new DomainError('DB_NOT_EMPTY', {
    detail:
      `Database tidak kosong (${tables} tabel); ALTIS wajib dipasang pada database kosong / ` +
      `The database is not empty (${tables} tables); ALTIS must be installed into an empty database`,
    meta: { tables },
  });
}

/** schema_meta.install_id: `absent` when there is no schema_meta table, null when it is NULL or there is no row. */
async function schemaInstallId(h: DbHandle, tables: readonly string[]): Promise<string | null | 'absent'> {
  if (!tables.includes('schema_meta')) return 'absent';
  const row = await h.db.selectFrom('schema_meta').select('install_id').where('id', '=', 1).executeTakeFirst();
  return row?.install_id ?? null;
}

/**
 * What step 4 (ruling R55) sees in the database: `empty` when its catalog lists nothing; otherwise `resumable` when it
 * can only be the database of this very install, interrupted: config.json exists (unfinished, `existing`) and
 * schema_meta.install_id is NULL or this install's id. (A database holding only `schema_tables` is one where the very
 * first migration step was cut short before schema_meta existed.)
 */
export async function installDatabaseState(h: DbHandle, existing: Config | null): Promise<{ empty: boolean; resumable: boolean; tables: number }> {
  const tables = await listCatalogTables(h);
  if (tables.length === 0) return { empty: true, resumable: false, tables: 0 };
  if (existing === null) return { empty: false, resumable: false, tables: tables.length };
  const installId = await schemaInstallId(h, tables);
  const ours =
    installId === 'absent' ? tables.every((name) => name === 'schema_tables') : installId === null || installId === existing.install.id;
  return { empty: false, resumable: ours, tables: tables.length };
}

/**
 * Step 4 (ruling R55): an empty database, or a resume of this install ({@link installDatabaseState}).
 *
 * @returns whether the install resumes (config.json exists)
 * @throws DomainError `DB_NOT_EMPTY`
 */
export async function checkEmpty(h: DbHandle, existing: Config | null): Promise<boolean> {
  const state = await installDatabaseState(h, existing);
  if (state.empty) return existing !== null;
  if (!state.resumable) throw dbNotEmpty(state.tables);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Step 7: seeds

type Trx = TxCtx['trx'];

/** Who writes the first super admin's `users.create`: the install itself (spec §7.8 actor `system`). */
const SYSTEM_ACTOR = { type: 'system', id: null, ip: null } as const;

/**
 * Creates the first super admin, or brings an earlier attempt's row up to date (decision D33), in the caller's
 * transaction: an idempotent upsert by `username_key` (normalizeKey of the username), so a resumed install or a
 * repeated wizard step never makes a second account. Exported for the 1c install wizard.
 *
 * - The account: `username_display` as given, `name`, the e-mail (when given), `passwordHash` (hashed by the caller
 *   before the transaction, S18; the caller checks the password policy), `status = 'active'`,
 *   `must_change_password = 0` (the operator chose the password).
 * - One global `super_admin` assignment (`scope_key = ''`); the system roles are made first (ensureSystemRoles).
 * - Created: `users.create` (`meta.username`) with actor `{type: 'system'}` (through `o.tx` when given: the wizard's
 *   route TxCtx over the same transaction, so that its audit-once check counts it). Updated: no audit entry; the user's
 *   sessions and remember-me tokens are revoked (the password may have changed, §7.1), and an assignment added to an
 *   existing account bumps its `authz_version`.
 *
 * Lock order (the users service's row lock, Task 19): the first statement on `staff_users` locks the row of the
 * username (a write that changes nothing, a gap lock when there is none yet) before anything is read, so a revocation
 * here and a login of that account never miss each other.
 *
 * @throws DomainError VALIDATION_FAILED (`username`/`email`: `too_big` when the key exceeds 191 code points, before any
 *   write; `email`: `taken` by another account)
 */
export async function createFirstSuperAdmin(
  trx: Trx,
  o: { admin: FirstSuperAdmin; passwordHash: string; now: number; tx?: TxCtx },
): Promise<{ userId: string; created: boolean }> {
  const { admin, passwordHash, now } = o;
  const usernameKey = keyOf(admin.username);
  const email = admin.email ?? null;
  const emailKey = email === null ? null : keyOf(email);
  const tooBig = [
    ...(usernameKey === null ? [{ path: 'username', code: 'too_big' }] : []),
    ...(email !== null && emailKey === null ? [{ path: 'email', code: 'too_big' }] : []),
  ];
  if (tooBig.length > 0 || usernameKey === null) {
    throw new DomainError('VALIDATION_FAILED', {
      detail: 'Data admin pertama tidak valid / The first admin is not valid',
      meta: { errors: tooBig },
    });
  }

  // The row lock first (see above), then the reads.
  await trx
    .updateTable('staff_users')
    .set((eb) => ({ updated_at: eb.ref('updated_at') }))
    .where('username_key', '=', usernameKey)
    .execute();
  await ensureSystemRoles(trx, now);
  const existing = await trx.selectFrom('staff_users').select(['id', 'version']).where('username_key', '=', usernameKey).executeTakeFirst();
  if (emailKey !== null) {
    const holder = await trx.selectFrom('staff_users').select('id').where('email_key', '=', emailKey).executeTakeFirst();
    if (holder !== undefined && holder.id !== existing?.id) {
      throw new DomainError('VALIDATION_FAILED', {
        detail: 'E-mail admin pertama sudah dipakai / The first admin e-mail is already taken',
        meta: { errors: [{ path: 'email', code: 'taken' }] },
      });
    }
  }

  const fields = {
    username_display: admin.username,
    name: admin.name,
    email_key: emailKey,
    email_display: email,
    password_hash: passwordHash,
    status: 'active',
    must_change_password: 0,
    updated_at: now,
    updated_by: null,
  };
  let userId: string;
  if (existing === undefined) {
    userId = newId();
    await trx
      .insertInto('staff_users')
      .values({ id: userId, username_key: usernameKey, ...fields, mfa_required: 0, locale: null, created_at: now, created_by: null })
      .execute();
  } else {
    userId = existing.id;
    await trx
      .updateTable('staff_users')
      .set({ ...fields, version: Number(existing.version) + 1 })
      .where('id', '=', userId)
      .execute();
    await revokeSubject(trx, userId);
  }

  const role = await trx.selectFrom('roles').select('id').where('key', '=', 'super_admin').executeTakeFirstOrThrow();
  const assigned = await trx
    .selectFrom('user_roles')
    .select('id')
    .where('user_id', '=', userId)
    .where('role_id', '=', role.id)
    .where('scope_key', '=', '')
    .executeTakeFirst();
  if (assigned === undefined) {
    await trx
      .insertInto('user_roles')
      .values({ id: newId(), user_id: userId, role_id: role.id, branch_id: null, scope_key: '', created_at: now, created_by: null })
      .execute();
    if (existing !== undefined) await bumpAuthzVersion(trx, [userId]);
  }

  const created = existing === undefined;
  if (created) {
    // The wizard passes its route's TxCtx over this transaction (`o.tx`), so that the entry counts for the route.
    await (o.tx ?? txCtx(trx, now, SYSTEM_ACTOR)).audit({
      action: 'users.create',
      entity: 'staff_users',
      entityId: userId,
      meta: { username: admin.username },
    });
  }
  return { userId, created };
}

/** The first super admin the seeds create: {@link FirstSuperAdmin} with the hash of its password. */
export type SeedAdmin = FirstSuperAdmin & { passwordHash: string };

/**
 * schema_meta (one row, id 1, made by the migrations) now belongs to install `installId`, in the caller's transaction.
 *
 * @throws DomainError `STATE_CORRUPT` (`meta.reason: 'schema_meta_install_id'`) when schema_meta has no row or already
 *   belongs to another install id
 */
export async function claimSchemaMeta(trx: Trx, installId: string): Promise<void> {
  const claimed = await trx
    .updateTable('schema_meta')
    .set({ install_id: installId })
    .where('id', '=', 1)
    .where((eb) => eb.or([eb('install_id', 'is', null), eb('install_id', '=', installId)]))
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows) !== 1) {
    throw new DomainError('STATE_CORRUPT', {
      detail: 'schema_meta milik instalasi lain atau tidak ada / schema_meta belongs to another installation or is missing',
      meta: { reason: 'schema_meta_install_id' },
    });
  }
}

/** What an install seeds of its identity: config.json's install.id. */
export type SeedIdentity = Pick<Config['install'], 'id'>;

/** The library profile the wizard adds to {@link Library} (spec §9.5 step 3). */
export interface LibraryProfile extends Library {
  type?: string | undefined;
  address?: string | undefined;
}

/**
 * The default branch and the library settings, in the caller's transaction (idempotent, ruling R54). The default
 * branch (`is_default = 1`) keeps the id it was created with: an earlier attempt's row is brought up to date (code,
 * name, time zone), else the branch of `branch.code` (default {@link DEFAULT_BRANCH_CODE}) is upserted. The settings
 * `library.name`, `.timezone`, `.locale`, and `.type`/`.address` when given, hold JSON text (scope data).
 *
 * @throws DomainError `VALIDATION_FAILED` (`branch.code` `taken`) when another branch holds the code
 */
export async function seedLibrary(
  trx: Trx,
  library: LibraryProfile,
  o: { now: number; branch?: { code?: string | undefined; name?: string | undefined } },
): Promise<void> {
  const { now } = o;
  const display = o.branch?.code ?? DEFAULT_BRANCH_CODE;
  const codeKey = normalizeKey(display);
  const branchName = o.branch?.name ?? library.name;
  const current = await trx.selectFrom('branches').select(['id', 'code_key']).where('is_default', '=', 1).orderBy('created_at').executeTakeFirst();
  if (current !== undefined && current.code_key !== codeKey) {
    const taken = await trx.selectFrom('branches').select('id').where('code_key', '=', codeKey).executeTakeFirst();
    if (taken !== undefined) {
      throw new DomainError('VALIDATION_FAILED', {
        detail: 'Kode cabang sudah dipakai / The branch code is taken',
        meta: { errors: [{ path: 'branch.code', code: 'taken' }] },
      });
    }
    await trx
      .updateTable('branches')
      .set({ code_key: codeKey, code_display: display, name: branchName, timezone: library.timezone, updated_at: now })
      .where('id', '=', current.id)
      .execute();
  } else {
    await upsert(
      trx,
      'branches',
      { code_key: codeKey },
      {
        id: newId(),
        code_display: display,
        name: branchName,
        address: null,
        timezone: library.timezone,
        is_default: 1,
        archived_at: null,
        created_at: now,
        created_by: null,
        updated_at: now,
        updated_by: null,
      },
      { code_display: display, name: branchName, timezone: library.timezone, updated_at: now },
    );
  }

  const settings: [string, string][] = [
    ['library.name', library.name],
    ['library.timezone', library.timezone],
    ['library.locale', library.locale],
  ];
  if (library.type !== undefined) settings.push(['library.type', library.type]);
  if (library.address !== undefined) settings.push(['library.address', library.address]);
  for (const [key, value] of settings) {
    // settings.value holds JSON text (R54); these rows are library data (scope data), not secrets.
    const row = { value: JSON.stringify(value), is_secret: 0, scope: 'data', updated_at: now, updated_by: null };
    await upsert(trx, 'settings', { key }, row, row);
  }
  // ---- Komunitas (OPAC look) ----
  // A fresh install starts with the design's blue accent. Only an absent row is written: an accent already stored (a
  // resumed install after the library chose one) is never changed.
  const accent = await trx.selectFrom('settings').select('key').where('key', '=', 'opac.accent').executeTakeFirst();
  if (accent === undefined) {
    await trx
      .insertInto('settings')
      .values({ key: 'opac.accent', value: JSON.stringify(FRESH_INSTALL_ACCENT), is_secret: 0, scope: 'data', updated_at: now, updated_by: null })
      .execute();
  }
}

/**
 * The rows every install starts with (ruling R54), in one transaction. Idempotent: every row is an upsert, so a
 * resumed install updates what an earlier attempt wrote instead of failing or duplicating it; the default branch
 * keeps the id it was created with. The system roles are always made (ensureSystemRoles, D5); `admin` (the headless
 * install's first super admin, hashed before this transaction) through {@link createFirstSuperAdmin}. Without it (the
 * 1c wizard creates the admin in a later step) the seeds make no account.
 *
 * @throws DomainError `STATE_CORRUPT` (`meta.reason: 'schema_meta_install_id'`, nothing written) when schema_meta has
 *   no row or already belongs to another install id; what createFirstSuperAdmin throws (nothing written)
 */
export async function seedInstall(h: DbHandle, install: SeedIdentity, library: Library, admin?: SeedAdmin): Promise<void> {
  await withTx(h, async (trx) => {
    // schema_meta (one row, id 1, made by the migrations): this database now belongs to this install.
    await claimSchemaMeta(trx, install.id);
    const now = Date.now();
    await seedLibrary(trx, library, { now });

    // The system roles (D5), and the first super admin with them (createFirstSuperAdmin makes the roles after its
    // row lock).
    if (admin === undefined) {
      await ensureSystemRoles(trx, now);
    } else {
      const { passwordHash, ...profile } = admin;
      await createFirstSuperAdmin(trx, { admin: profile, passwordHash, now });
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------

export interface InstallResult {
  /** True when an earlier, unfinished install of this DATA_DIR was continued. */
  resumed: boolean;
  /** 1c Task 27 (L51): the details of the preflight checks that warned (WASM, RAM), to be printed. */
  warnings: string[];
}

export interface InstallOptions {
  /** --runtime (ruling R66). */
  runtime?: Runtime | undefined;
  /** The hosting-panel marker folders on this host; default: {@link detectPanelMarkers}. */
  hostPanels?: (() => readonly string[]) | undefined;
}

/**
 * Runs `install --config <file> [--runtime <runtime>]` (see the steps at the top of this file).
 *
 * @throws DomainError `ALREADY_INSTALLED` (exit 2), `SCHEMA_TOO_NEW` (exit 3), or any other failure (exit 1):
 *   `INVALID_CONFIG`, `INVALID_BASE_URL`, `PASSWORD_TOO_WEAK`, `VALIDATION_FAILED`, `DOCROOT_EXPOSED`, `SQLITE_NOT_ALLOWED`, `DISK_QUOTA`, `DB_UNAVAILABLE`,
 *   `DB_UNSUPPORTED`, `DB_NOT_EMPTY`, `STATE_CORRUPT`, a migration's failure; CliError `NODE_TOO_OLD`,
 *   `DATA_DIR_UNWRITABLE`, `RUNTIME_REQUIRED`, `USAGE` (--runtime and the input disagree)
 */
export async function install(file: string, ctx: BootContext, env: Env, nodeVersion: string, o: InstallOptions = {}): Promise<InstallResult> {
  const { dataDir } = ctx;
  await unfinishedConfig(dataDir); // 1 (checked again under the lock)
  const input = parseInstallInput(await readCliInputFile(file));
  const runtime = installRuntime({
    flag: o.runtime,
    input: input.runtime,
    detected: ctx.runtime,
    env,
    hostPanels: o.hostPanels ?? detectPanelMarkers,
  });
  const plan = planInstall(input, runtime);
  checkPlatform(ctx, env, nodeVersion); // 2
  // What the server will connect with: the input plus the environment overrides (ALTIS_DB_*). Checked now, before
  // anything is created, so a bad override or SQLite on the wrong runtime leaves no trace.
  checkSqlite(applyEnvOverrides(freshConfig(plan), env).db.dialect, runtime);
  await prepareDataDir(dataDir);
  // 1c Task 27 (L51): the wizard's checks; node, docroot and dataDir passed above, so an error here is the time zone.
  const preflight = await preflightChecks({ nodeVersion, dataDir, appRoot: ctx.appRoot, home: homeDir(env), runtime, env });
  const errors = failedChecks(preflight, 'error');
  if (errors.length > 0) {
    throw new CliError('PREFLIGHT_FAILED', errors.map((name) => `${name}: ${preflight.checks[name].detail}`).join('; '));
  }
  const warnings = failedChecks(preflight, 'warn').map((name) => preflight.checks[name].detail);

  return withFileLock(
    installRunLockPath(dataDir),
    async () => {
      const existing = await unfinishedConfig(dataDir);
      const config = existing === null ? freshConfig(plan) : resumedConfig(existing, plan);
      const effective = applyEnvOverrides(config, env);
      checkSqlite(effective.db.dialect, runtime);

      const h = await connect(effective.db, { runtime, purpose: 'cli', dataDir }); // 3
      try {
        const server = await checkServer(h);
        if (!server.ok) throw dbUnsupported(server.problems, server.version);
        const resumed = await checkEmpty(h, existing); // 4

        if (existing === null) {
          await writeConfig(dataDir, config); // 5
        } else {
          await updateConfig(dataDir, (current) => {
            // Thrown inside mutate, so nothing is written: the identity checked against the database must not change.
            if (current.install.id !== existing.install.id) {
              throw new DomainError('STATE_CORRUPT', {
                detail: 'config.json berubah selama instalasi / config.json changed during the install',
                meta: { reason: 'install_id_changed' },
              });
            }
            return resumedConfig(current, plan);
          });
        }
        testFault(env, 'after-config');

        const outcome = await runMigrations(h, { appVersion: ctx.release.version, dataDir, migrations: releaseMigrations() }); // 6
        if (outcome.mode === 'too-old') {
          throw new DomainError('SCHEMA_TOO_NEW', {
            detail:
              `Skema database (${outcome.schemaVersion}) memerlukan ALTIS ${outcome.minCodeVersion} atau lebih baru; versi ini ${ctx.release.version} / ` +
              `The database schema (${outcome.schemaVersion}) needs ALTIS ${outcome.minCodeVersion} or newer; this is ${ctx.release.version}`,
            meta: { schemaVersion: outcome.schemaVersion, minCodeVersion: outcome.minCodeVersion },
          });
        }
        testFault(env, 'after-migrate');

        // 7: the admin's password hashed outside any transaction (S18; on SQLite a transaction holds the only
        // connection), then the seeds.
        const passwordHash = await createPasswordHasher().hash(plan.password);
        await seedInstall(h, config.install, plan.library, { ...plan.admin, passwordHash });
        testFault(env, 'after-seed');

        await updateConfig(dataDir, (current) => {
          current.installState = 'complete';
        }); // 8
        testFault(env, 'after-complete');
        await writeInstallLock(dataDir, config.install.id);
        await writeInstalledMarker({ appRoot: ctx.appRoot, dataDir, installId: config.install.id, runtime }).catch((error: unknown) => {
          warnings.push(markerWarning(error));
        });
        return { resumed, warnings };
      } finally {
        await h.close();
      }
    },
    { waitMs: INSTALL_LOCK_WAIT_MS },
  );
}
