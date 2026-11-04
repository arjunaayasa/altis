/**
 * The install wizard's API vocabulary shared by the server and the wizard page (spec §7.7, §9.5; plan Tasks 10 and
 * 27). No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/install`.
 *
 * Step 0, the claim: `POST /install/api/claim` with the install code as the person typed it (any case, spaces or
 * dashes; the server normalizes it). It answers the wizard's CSRF token, which every later non-GET wizard request
 * sends as `X-CSRF-Token`, and the `installState` to resume at (null for a new install); the claim itself travels in
 * the HttpOnly `altis_install` cookie.
 *
 * The steps (Task 27), each open only to the claim's holder; every POST runs under `DATA_DIR/tmp/install-run.lock`
 * (shared with the headless `install`) and answers 409 `INSTALL_STEP_ORDER` when config.json's `installState` does
 * not allow it ({@link INSTALL_STEP_STATES}):
 *
 * | Step | Call | Allowed at | Moves to |
 * |---|---|---|---|
 * | 1 | `GET checks` → {@link InstallChecksResponse} | any | – |
 * | 1 | `POST exposure` {@link ExposureBody} → {@link ExposureResponse} (422 `INSTALL_EXPOSED`) | none, `migrate` | – |
 * | 1 | the browser probes under `/install/api/probe` (`@altis/shared/api/diagnostics`) | any | – |
 * | 2 | `POST db/test` {@link DbTestBody} → {@link DbTestResponse} | none, `migrate` | – |
 * | 2 | `POST config` {@link ConfigBody} → {@link InstallStateResponse} | none, `migrate` | `migrate` |
 * | 2 | `POST migrate` (no body) → {@link MigrateResponse}, called until `done` | `migrate` | `profile` |
 * | 2 | `GET progress` → {@link ProgressResponse} | any | – |
 * | 3 | `POST profile` {@link ProfileBody} → {@link InstallStateResponse} | `profile` | `admin` |
 * | 4 | `POST admin` {@link AdminBody} → {@link InstallStateResponse} | `admin` | `cron` |
 * | 5 | `POST cron/test` (no body) → {@link CronTestResponse} | `cron` | – |
 * | 6 | `POST finish` (no body) → {@link FinishResponse} (409 `CRON_NOT_DETECTED`) | `cron` | `complete` |
 */
import { z } from 'zod';
import { branchCodeField, emailField, localeField, passwordField, personNameField, timezoneField, usernameField } from './common.js';
import { PROBE_NONCE, ProbeResultBody } from './diagnostics.js';
import { LIBRARY_TYPES } from './settings.js';

/** `POST /install/api/claim`. 64 characters leave room for spaces and dashes around the 26 of the code. */
export const ClaimBody = z.strictObject({
  code: z.string().max(64),
});

export type ClaimBody = z.infer<typeof ClaimBody>;

/** The answer of `POST /install/api/claim`. */
export interface ClaimResponse {
  /** `X-CSRF-Token` of every later non-GET wizard request. */
  csrfToken: string;
  /** config.json's `installState` of an unfinished install (the step to resume at), or null. */
  installState: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Step order

/** config.json's `installState` values before the install completes, in the order the wizard moves through them. */
export const WIZARD_INSTALL_STATES = Object.freeze(['migrate', 'profile', 'admin', 'cron'] as const);

export type WizardInstallState = (typeof WIZARD_INSTALL_STATES)[number];

/** The wizard's steps that `installState` gates. */
export const INSTALL_STEPS = Object.freeze(['exposure', 'db_test', 'config', 'migrate', 'profile', 'admin', 'cron_test', 'finish'] as const);

export type InstallStep = (typeof INSTALL_STEPS)[number];

/**
 * The `installState` values at which each step may run (null: no config.json yet). `config` may run again while the
 * migrations have not started (a resume of the same install, as the headless install does); every later step runs at
 * exactly its own state, so a step that already moved on answers 409 and the wizard asks `GET checks` where it stands.
 */
export const INSTALL_STEP_STATES: Readonly<Record<InstallStep, readonly (WizardInstallState | null)[]>> = Object.freeze({
  exposure: [null, 'migrate'],
  db_test: [null, 'migrate'],
  config: [null, 'migrate'],
  migrate: ['migrate'],
  profile: ['profile'],
  admin: ['admin'],
  cron_test: ['cron'],
  finish: ['cron'],
});

/** The answer of the steps that move `installState` on. */
export interface InstallStateResponse {
  installState: WizardInstallState | 'complete';
}

// ---------------------------------------------------------------------------------------------------------------
// Step 1: checks and exposure

/** The wizard's mandatory checks (spec §9.5 step 1: Node, DATA_DIR writable, P16, WASM, time zone, RAM). */
export const PREFLIGHT_CHECKS = Object.freeze(['node', 'dataDir', 'docroot', 'wasm', 'timezone', 'ram'] as const);

export type PreflightCheckName = (typeof PREFLIGHT_CHECKS)[number];

/** One check: `ok`, and how bad a failure is (`error` blocks the install, `warn` is shown). */
export interface PreflightCheck {
  ok: boolean;
  level: 'error' | 'warn';
  /** Short, bilingual, never a secret. */
  detail: string;
}

export interface PreflightReport {
  /** No check of level `error` failed. */
  ok: boolean;
  checks: Record<PreflightCheckName, PreflightCheck>;
}

/** Which file a candidate URL path would serve. */
export type ExposureCandidateKind = 'probe' | 'app' | 'pointer';

export interface ExposureCandidateItem {
  kind: ExposureCandidateKind;
  /** `/seg/…/file`, each segment percent-encoded: the browser fetches `location.origin + path`. */
  path: string;
}

/** The answer of `GET /install/api/checks`. */
export interface InstallChecksResponse {
  /** config.json's `installState` as written (null: no config.json yet). */
  installState: string | null;
  preflight: PreflightReport;
  /** The runtime this server runs under (spec P14). */
  runtime: string;
  /** `aapanel_default`: aaPanel runs ALTIS as a project of type Default, not PM2 (spec §9.5 step 1). */
  panelWarning: 'aapanel_default' | null;
  /** The wizard's CSRF token again (a reloaded page lost it). */
  csrfToken: string;
  /**
   * The exposure test (spec §9.5 step 1.2): the browser fetches every candidate path and reports what came back with
   * `POST exposure`. The probe file `DATA_DIR/tmp/<probeId>` holds 32 random bytes as hex.
   */
  exposure: { probeId: string; candidates: ExposureCandidateItem[] };
}

/**
 * How much of a fetched exposure candidate is read and hashed (64 KiB): by the wizard's browser test, and by the server
 * (the wizard's verdict and the daily `diagnostics.exposure` job), which therefore compare the digest of a file's first
 * 64 KiB. A larger file (a release's app.js is) can only match that way.
 */
export const EXPOSURE_READ_MAX_BYTES = 64 * 1024;

/** A path as a candidate gives it, or as the browser fetched it. */
const urlPath = z.string().min(1).max(2048);

/**
 * `POST /install/api/exposure`: what each fetch returned (`sha256` of the body's first {@link EXPOSURE_READ_MAX_BYTES},
 * lower-case hex; null without one).
 */
export const ExposureBody = z.strictObject({
  results: z
    .array(
      z.strictObject({
        path: urlPath,
        status: z.int().min(0).max(999),
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
      }),
    )
    .max(64),
});

export type ExposureBody = z.infer<typeof ExposureBody>;

/** The answer of `POST /install/api/exposure` when nothing was served (otherwise 422 `INSTALL_EXPOSED`). */
export interface ExposureResponse {
  ok: true;
}

// ---------------------------------------------------------------------------------------------------------------
// Step 2: database, config, migrations

/** The database dialects of @altis/db (DIALECTS). */
export const DB_DIALECTS = Object.freeze(['mysql', 'mariadb', 'postgres', 'sqlite'] as const);

/** config.json's `db` as the wizard sends it (SQLite: only `file`, which may only be `altis.sqlite`). */
export const DbConfigBody = z.strictObject({
  dialect: z.enum(DB_DIALECTS),
  host: z.string().max(255).optional(),
  port: z.int().min(1).max(65535).optional(),
  user: z.string().max(255).optional(),
  password: z.string().max(1024).optional(),
  database: z.string().max(255).optional(),
  file: z.string().max(255).optional(),
});

export type DbConfigBody = z.infer<typeof DbConfigBody>;

/** `POST /install/api/db/test`. */
export const DbTestBody = z.strictObject({ db: DbConfigBody });

export type DbTestBody = z.infer<typeof DbTestBody>;

/** The answer of `POST /install/api/db/test` (a connection that fails answers its problem instead). */
export interface DbTestResponse {
  /** The server qualifies (no `problems`). */
  ok: boolean;
  /** What the server turned out to be (`mysql` vs `mariadb` may differ from the dialect chosen). */
  flavor: 'mysql' | 'mariadb' | 'postgres' | 'sqlite';
  version: string;
  /** `VERSION_TOO_OLD`, `ENGINE_NOT_INNODB`, `NO_FULLTEXT`. */
  problems: string[];
  /** The connections each server process would open (P17). */
  poolSize: number;
  /** The database holds no table. */
  empty: boolean;
  /** Not empty, but the database of this very install, interrupted: `config` may continue it. */
  resumable: boolean;
}

/** `POST /install/api/config`. */
export const ConfigBody = z.strictObject({
  /** `location.origin` as the person confirmed it; it must be the claim's origin. */
  baseUrl: z.string().max(2048),
  db: DbConfigBody,
  trustProxy: z.strictObject({ hops: z.int().min(0).max(10) }),
  /** The base URL probe (§9.5 step 1.1): the nonce sent to `GET probe/<nonce>` and the HMAC it answered. */
  probe: z.strictObject({
    nonce: z.string().regex(PROBE_NONCE),
    hmac: z.string().max(128),
    /** The browser test's results, written to `system.probe` with the seeds after the migrations. */
    results: ProbeResultBody,
  }),
});

export type ConfigBody = z.infer<typeof ConfigBody>;

/** The answer of `POST /install/api/migrate`: one migration per call (§9.5: "satu migrateUp() per panggilan"). */
export interface MigrateResponse {
  /** Every migration is applied and the seeds are written: `installState` is `profile`. */
  done: boolean;
  /** The migration this call applied, or null (none was left, or another process held the migration lock). */
  applied: string | null;
  /** Migrations still to apply. */
  remaining: number;
}

/** The answer of `GET /install/api/progress`. */
export interface ProgressResponse {
  installState: string | null;
  migrations: { applied: number; total: number };
}

// ---------------------------------------------------------------------------------------------------------------
// Steps 3-6

/** `POST /install/api/profile` (spec §9.5 step 3): the library, and the default branch (`PUSAT` unless given). */
export const ProfileBody = z.strictObject({
  library: z.strictObject({
    name: personNameField,
    type: z.enum(LIBRARY_TYPES).optional(),
    address: z.string().max(1000).optional(),
    timezone: timezoneField,
    locale: localeField,
  }),
  branch: z.strictObject({
    code: branchCodeField.optional(),
    /** Default: the library's name. */
    name: personNameField.optional(),
  }),
});

export type ProfileBody = z.infer<typeof ProfileBody>;

/** `POST /install/api/admin` (spec §9.5 step 4): the first super admin; the password policy is the server's. */
export const AdminBody = z.strictObject({
  username: usernameField,
  name: personNameField,
  email: emailField.optional(),
  password: passwordField,
});

export type AdminBody = z.infer<typeof AdminBody>;

/** The answer of `POST /install/api/cron/test` (step 5; spec §9.5 step 6). */
export interface CronTestResponse {
  /** Passenger and LiteSpeed run no worker: a scheduler is required before `finish`. */
  required: boolean;
  /** A scheduler call was seen in the last 15 minutes, or this runtime runs the worker. */
  detected: boolean;
  /** What was seen: the CLI line, the URL, or the worker; null when nothing was. */
  mode: 'cron_cli' | 'cron_http' | 'worker' | null;
  /** When the call was seen (epoch ms); null for the worker or nothing. */
  at: number | null;
  /** The crontab line of the CLI form, with this Node binary (the nodevenv one on cPanel). */
  cronLine: string;
  /** The URL form, with the cron token. */
  curlLine: string;
}

/** The answer of `POST /install/api/finish`; `altis_install` is cleared. */
export interface FinishResponse {
  next: '/admin/login';
}
