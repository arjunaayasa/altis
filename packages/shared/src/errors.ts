/**
 * Registry of domain error codes and their HTTP status (spec §11).
 *
 * Codes are stable identifiers: they travel in problem+json bodies, in logs and in CLI output.
 * Later sub-milestones append their own codes here; never renumber or repurpose an existing one.
 */
export const ERROR_CODES = Object.freeze({
  INTERNAL: Object.freeze({ status: 500 }),
  NOT_INSTALLED: Object.freeze({ status: 503 }),
  ALREADY_INSTALLED: Object.freeze({ status: 409 }),
  DB_UNAVAILABLE: Object.freeze({ status: 503 }),
  DB_NOT_EMPTY: Object.freeze({ status: 409 }),
  DB_UNSUPPORTED: Object.freeze({ status: 422 }),
  INVALID_CONFIG: Object.freeze({ status: 422 }),
  INVALID_BASE_URL: Object.freeze({ status: 422 }),
  DOCROOT_EXPOSED: Object.freeze({ status: 422 }),
  SQLITE_NOT_ALLOWED: Object.freeze({ status: 422 }),
  DISK_QUOTA: Object.freeze({ status: 507 }),
  STATE_CORRUPT: Object.freeze({ status: 500 }),
  RELEASE_INVALID: Object.freeze({ status: 500 }),
  SCHEMA_TOO_NEW: Object.freeze({ status: 503 }),
  UNIQUE_VIOLATION: Object.freeze({ status: 409 }),
  INVALID_PATH_SEGMENT: Object.freeze({ status: 500 }),
  /**
   * The database schema disagrees with what the DDL helpers are asked to do (a table registered under another
   * class, a name another table uses, a missing foreign key target, ...); `meta.reason` says which.
   */
  SCHEMA_CONFLICT: Object.freeze({ status: 500 }),
  /**
   * A transaction lost to a deadlock or a serialization failure (MySQL/MariaDB 1213, PostgreSQL 40P01/40001) and
   * kept losing when withTx ran it again; `meta.attempts`, `meta.code`. Retrying later may succeed.
   */
  TX_CONFLICT: Object.freeze({ status: 409 }),
  /** No route answers the request's path (the HTTP app's problem+json for an unknown path). */
  NOT_FOUND: Object.freeze({ status: 404 }),

  // ---- Phase 1b (access): spec §7, §11 ----------------------------------------------------------------------

  // Authentication (§7.1). The messages for AUTH_INVALID_CREDENTIALS and AUTH_TOO_MANY_ATTEMPTS never say whether
  // the account exists.
  /** No valid session (or no session at all) on a route that needs one. */
  AUTH_REQUIRED: Object.freeze({ status: 401 }),
  /** Wrong username or password: one answer for an unknown account and for a wrong password. */
  AUTH_INVALID_CREDENTIALS: Object.freeze({ status: 401 }),
  /** A login, 2FA, recovery, reauth or reset bucket is spent; `meta.retryAfterS` carries the wait. */
  AUTH_TOO_MANY_ATTEMPTS: Object.freeze({ status: 429 }),
  /** The password-hash queue of this process is full; `meta.retryAfterS`. */
  AUTH_BUSY: Object.freeze({ status: 429 }),
  /** The password was right and a second factor is still owed. */
  AUTH_MFA_REQUIRED: Object.freeze({ status: 401 }),
  /** The TOTP or recovery code was wrong, already used or outside the +-1 step window. */
  AUTH_MFA_INVALID: Object.freeze({ status: 401 }),
  /** A sensitive action needs a password confirmation made within the last five minutes (§7.3). */
  AUTH_REAUTH_REQUIRED: Object.freeze({ status: 401 }),
  /** The account must change its password first; only `auth.password.change` passes until it has. */
  AUTH_PASSWORD_CHANGE_REQUIRED: Object.freeze({ status: 403 }),
  /** The account is `disabled`. */
  AUTH_ACCOUNT_DISABLED: Object.freeze({ status: 403 }),
  /** The password-reset token is unknown, expired or already used. */
  AUTH_RESET_TOKEN_INVALID: Object.freeze({ status: 400 }),

  // Passwords and 2FA
  /** The password breaks the policy; `meta.reason` is `too_short`, `too_long` or `common`. */
  PASSWORD_TOO_WEAK: Object.freeze({ status: 422 }),
  MFA_ALREADY_ENABLED: Object.freeze({ status: 409 }),
  MFA_NOT_ENABLED: Object.freeze({ status: 409 }),
  /** A role of the account requires 2FA, so it cannot be switched off. */
  MFA_REQUIRED_BY_POLICY: Object.freeze({ status: 409 }),

  // Authorization (§7.2)
  /** The subject lacks the permission the route declares. */
  AUTHZ_DENIED: Object.freeze({ status: 403 }),
  /** An anti-escalation rule (§7.2, rules 1-5) refuses the change. */
  AUTHZ_ESCALATION: Object.freeze({ status: 403 }),
  /** The change would leave the instance without an active super admin (rule 6). */
  LAST_SUPER_ADMIN: Object.freeze({ status: 409 }),
  /** `super_admin` and `admin` cannot be edited or deleted. */
  ROLE_SYSTEM_READONLY: Object.freeze({ status: 409 }),
  /** The role is still assigned to someone. */
  ROLE_IN_USE: Object.freeze({ status: 409 }),
  /** A global permission was given a branch scope, or the other way round. */
  ROLE_SCOPE_INVALID: Object.freeze({ status: 422 }),
  /** The default branch cannot be archived. */
  BRANCH_DEFAULT_ARCHIVE: Object.freeze({ status: 409 }),

  // Request handling (§4.7, §7.4)
  CSRF_INVALID: Object.freeze({ status: 403 }),
  ORIGIN_DENIED: Object.freeze({ status: 403 }),
  /** The input broke its Zod schema or a service rule; the problem body lists the offending fields. */
  VALIDATION_FAILED: Object.freeze({ status: 422 }),
  INVALID_JSON: Object.freeze({ status: 400 }),
  /** The JSON body is over 1 000 000 bytes. */
  PAYLOAD_TOO_LARGE: Object.freeze({ status: 413 }),
  UNSUPPORTED_MEDIA_TYPE: Object.freeze({ status: 415 }),
  /** The `version` of the PATCH or PUT is not the row's current one. */
  CONFLICT_STALE: Object.freeze({ status: 409 }),

  // Idempotency (§7.9)
  IDEMPOTENCY_KEY_INVALID: Object.freeze({ status: 400 }),
  /** The same key is still being processed (the lock lasts 30 s). */
  IDEMPOTENCY_IN_PROGRESS: Object.freeze({ status: 409 }),
  /** The same key arrived with a different method, route or body. */
  IDEMPOTENCY_KEY_REUSED: Object.freeze({ status: 422 }),

  // Configuration and mail
  /** The setting is fixed by an environment variable and cannot be saved. */
  CONFIG_LOCKED_BY_ENV: Object.freeze({ status: 409 }),
  /** The `trustProxy.hops` the admin saves does not fit the request it came in on (`reason`: collapsed or chain_short). */
  TRUST_PROXY_INVALID: Object.freeze({ status: 422 }),
  SMTP_NOT_CONFIGURED: Object.freeze({ status: 409 }),
  /** The mail server refused or could not be reached; the problem never carries the SMTP secret. */
  SMTP_FAILED: Object.freeze({ status: 422 }),

  // Internal
  /** A stored secret is malformed or its key is unknown or wrong (AES-GCM tag failure). */
  SECRET_UNREADABLE: Object.freeze({ status: 500 }),
  /** The admin SPA has not been built: no `index.html` to serve. */
  ADMIN_UNAVAILABLE: Object.freeze({ status: 503 }),
  /** A route that declares `audit` finished without writing exactly one entry (§7.8). */
  AUDIT_MISSING: Object.freeze({ status: 500 }),

  // ---- Phase 1c (operations): spec §5, §7.5, §7.7, §9.4-9.10, §10, §11 --------------------------------------

  // Ops and maintenance (§9.4)
  /** Another op already holds the ops lock (`DATA_DIR/ops/op.json`). */
  OPS_IN_PROGRESS: Object.freeze({ status: 409 }),
  /** A running snapshot backup (`longRunning`) blocks an op that needs the freeze; refused before the freeze. */
  OPS_BLOCKED_BY_BACKUP: Object.freeze({ status: 409 }),
  /** `ops/*` was asked about an op and there is none (or it is not the one the cookie belongs to). */
  OPS_NONE: Object.freeze({ status: 404 }),
  /** The op is past its point of no return and cannot be cancelled any more. */
  OPS_POINT_OF_NO_RETURN: Object.freeze({ status: 409 }),
  /** A live job lease outlasted the 60 s the freeze may wait; the op is aborted and maintenance cleared. */
  OPS_FREEZE_TIMEOUT: Object.freeze({ status: 409 }),
  /** An `opsAuth` route got neither a session with the op kind's permission nor a valid `altis_ops` cookie. */
  OPS_AUTH_REQUIRED: Object.freeze({ status: 401 }),
  /** The maintenance flag is on; `meta.reason` (restore, backup, update, manual, install, migrate, reset) and `meta.retryAfterS`. */
  MAINTENANCE: Object.freeze({ status: 503 }),

  // Jobs and cron (§10.1-10.4)
  /** Retry was asked of a job that is not dead or failed, or of one only its origin may retry; `reason` origin_only or state. */
  JOB_NOT_RETRYABLE: Object.freeze({ status: 409 }),
  /** Cancel was asked of a job that has already finished. */
  JOB_NOT_CANCELLABLE: Object.freeze({ status: 409 }),
  /** The job's lease was taken over by another process; the handler of this one must stop (fencing). */
  JOB_LEASE_LOST: Object.freeze({ status: 409 }),
  /** `POST /_cron` without the right bearer token. */
  CRON_TOKEN_INVALID: Object.freeze({ status: 401 }),

  // Events and realtime (§10.6-10.8)
  /** The cursor belongs to another data epoch, lies above the newest event, or is older than retention. */
  EVENTS_CURSOR_EXPIRED: Object.freeze({ status: 410 }),
  /** `GET events/stream` while SSE is off for this installation (it is polling only on Passenger/LiteSpeed by default). */
  REALTIME_SSE_DISABLED: Object.freeze({ status: 409 }),
  /** SSE cannot be turned on until the browser test has shown that it works through this host's proxy. */
  REALTIME_PROBE_REQUIRED: Object.freeze({ status: 409 }),

  // Uploads and method override (§7.5, P10)
  /** Too many upload sessions open for this subject (at most 3). */
  UPLOAD_LIMIT: Object.freeze({ status: 429 }),
  /** The declared size is over the limit of the upload's context. */
  UPLOAD_TOO_LARGE: Object.freeze({ status: 413 }),
  /** A chunk does not follow the ones stored, or has the wrong size; `reason` order or size. */
  UPLOAD_CHUNK_INVALID: Object.freeze({ status: 409 }),
  /** `complete` came before every chunk had arrived. */
  UPLOAD_INCOMPLETE: Object.freeze({ status: 409 }),
  /** The finished file is not the declared one; `reason` size or sha256. */
  UPLOAD_MISMATCH: Object.freeze({ status: 422 }),
  /** The type found from the magic bytes is not allowed for the upload's context (SVG is never an image). */
  UPLOAD_TYPE_REFUSED: Object.freeze({ status: 415 }),
  /** The upload session expired (24 h) or was cleaned up. */
  UPLOAD_EXPIRED: Object.freeze({ status: 410 }),
  /** `X-HTTP-Method-Override` on a request that may not use it (unauthenticated, no CSRF, a probe or Bearer route, or a method it does not name). */
  METHOD_OVERRIDE_DENIED: Object.freeze({ status: 403 }),

  // Backup and restore (§9.9-9.10)
  /** The backup is not `ok` yet, or has no archive prepared for this subject. */
  BACKUP_NOT_READY: Object.freeze({ status: 409 }),
  /** The archive is damaged or hostile; `reason` format, checksum, signature, path, bomb, schema or entry. */
  BACKUP_INVALID: Object.freeze({ status: 422 }),
  /** The archive's `schemaVersion` is above what this ALTIS knows. */
  BACKUP_SCHEMA_TOO_NEW: Object.freeze({ status: 422 }),
  /** The archive is encrypted and no passphrase was given. */
  BACKUP_PASSPHRASE_REQUIRED: Object.freeze({ status: 422 }),
  /** The passphrase does not open the archive. */
  BACKUP_PASSPHRASE_INVALID: Object.freeze({ status: 422 }),
  /** An archive from another installation (`external`) needs the typed confirmation before it replaces data. */
  BACKUP_CONFIRM_REQUIRED: Object.freeze({ status: 409 }),
  /** The read-only pre-pass found rows that cannot load into the target database; a conflict report can be downloaded. */
  RESTORE_CONFLICTS: Object.freeze({ status: 409 }),

  // Installer (§7.7, §9.5)
  /** A wizard call that needs a claimed session came without one. */
  INSTALL_CLAIM_REQUIRED: Object.freeze({ status: 403 }),
  /** The install code is wrong, expired, or has the wrong shape. */
  INSTALL_CODE_INVALID: Object.freeze({ status: 403 }),
  /** The wizard step is not the one `installState` allows next. */
  INSTALL_STEP_ORDER: Object.freeze({ status: 409 }),
  /** The browser fetched a file of the data or app folder through the web: the install is blocked. */
  INSTALL_EXPOSED: Object.freeze({ status: 422 }),
  /** `finish` on a host whose scheduler is required (Passenger/LiteSpeed) before a cron run was detected. */
  CRON_NOT_DETECTED: Object.freeze({ status: 409 }),

  // Host state
  /** Docker (or another host) lost the data volume: no config, yet the database has an install id. Never the wizard. */
  DATA_VOLUME_MISSING: Object.freeze({ status: 503 }),
  /** The install marker exists while `DATA_DIR` is not installed (another path, or the same one recreated, R1c-5). Never the wizard. */
  DATA_DIR_MISMATCH: Object.freeze({ status: 503 }),

  // Late additions (preflight M4, M33)
  /** A `Range` header that no part of the file satisfies. */
  RANGE_NOT_SATISFIABLE: Object.freeze({ status: 416 }),
  /** `jobs/:id/drive` on a job that is not `interactive`. */
  JOB_NOT_INTERACTIVE: Object.freeze({ status: 409 }),
  /**
   * `prepare-download` while the subject's preparation of that backup is still live and the request differs from it
   * (another encryption choice or secrets, or any passphrase: each request draws its own salt); `meta.jobId` is the live
   * job, which the detail names too. Only an unencrypted request with the same secrets joins the live job.
   */
  BACKUP_PREPARE_IN_PROGRESS: Object.freeze({ status: 409 }),
  /**
   * Final review G2 (R1c-15): the maintenance flag of a frozen op was down (forced off, or removed by hand) before its
   * point of no return, and its kind cannot do its work again under a new freeze: the op ended, the data untouched.
   */
  OPS_FREEZE_BROKEN: Object.freeze({ status: 409 }),

  // ---- Phase 1d (updates): spec §9.2-9.8, §11 ----------------------------------------------------------------
  // A full `DATA_DIR/releases/keyset.json` is not an error code: it is the setting `system.keyset_full` and the dashboard
  // alert `keyset_full` (preflight M6). The `reason` words of these codes live in PROBLEM_REASONS (apps/server); a
  // 5xx never sends its reason or detail to a client, they stay in `op.json` and in the setting `update.check`.

  // Updates (§9.6-9.8)
  /** The version asked for is not the one the last check found (or no check found one). */
  UPDATE_NONE: Object.freeze({ status: 404 }),
  /**
   * This edition does not cover this release (the edition seam; the community edition never sends it); `reason`
   * no_license or released_after.
   */
  UPDATE_NOT_ENTITLED: Object.freeze({ status: 409 }),
  /** A precheck failed; `reason` is the first failure, `meta.failures` all of them. */
  UPDATE_PRECHECK_FAILED: Object.freeze({ status: 409 }),
  /** The package or the extracted release is refused; `reason` hash, signature, manifest, mismatch, entry, bomb, size, version or keyset. */
  UPDATE_PACKAGE_INVALID: Object.freeze({ status: 422 }),
  /** The package could not be downloaded from the update server. */
  UPDATE_DOWNLOAD_FAILED: Object.freeze({ status: 502 }),
  /** One-click update, upload and rollback are hidden in image mode (`ALTIS_RELEASE_SOURCE=image`, §9.8); `reason` image. */
  UPDATE_HIDDEN: Object.freeze({ status: 409 }),
  /** The `schemaHold` update of a bundled release failed after its point of no return; the detail names the `pre_update` backup. */
  UPDATE_SCHEMA_HOLD_FAILED: Object.freeze({ status: 409 }),
  /**
   * The pending release failed to boot (§9.2 step 3, §9.3); kept in `op.json` and the boot marker. Its reason (verify,
   * import, start, migration, health, stalled, repeated, operator) never reaches a client (a 5xx).
   */
  UPDATE_BOOT_FAILED: Object.freeze({ status: 500 }),
  /** `POST updates/check` came within 60 s of the last check; `meta.retryAfterS`. */
  UPDATE_CHECK_THROTTLED: Object.freeze({ status: 429 }),

  // Feeds, rollback, releases
  /** The feed, its signature or its freshness document is refused; the reason stays server-side (a 5xx). */
  FEED_INVALID: Object.freeze({ status: 502 }),
  /** The update server could not be reached, or no feed URL is set; the reason stays server-side (a 5xx). */
  FEED_UNREACHABLE: Object.freeze({ status: 502 }),
  /** No manual rollback is possible (§9.7); `reason` no_previous, incompatible, missing or pending. */
  ROLLBACK_UNAVAILABLE: Object.freeze({ status: 409 }),
  /** A pending release is booting or migrating (`release:rollback` while a live holder migrates, the CLI while `pending` is set). */
  RELEASE_PENDING: Object.freeze({ status: 409 }),

  // ---- Phase 2 (catalog): Task 2 ----
  // Phase 2 spec §12.5, in its order. Field errors stay VALIDATION_FAILED with errors[{path, code}] (`taken`,
  // `isbn_not_barcode`, `invalid_transition`, ...). No 5xx reason reaches a client (a connection test answers 200 with
  // its own code instead), so none is added to PROBLEM_REASONS.

  /** A record that still has live items cannot be archived. */
  CATALOG_RECORD_HAS_ITEMS: Object.freeze({ status: 409 }),
  /** An authority, master or location that live records or items point to cannot be archived; `meta.count`. */
  CATALOG_IN_USE: Object.freeze({ status: 409 }),
  /** A merge into itself, into an archived object, or one that would close a chain into a loop. */
  CATALOG_MERGE_INVALID: Object.freeze({ status: 422 }),
  /** The item status change is not in the lifecycle table (§2.5). */
  ITEM_STATUS_TRANSITION: Object.freeze({ status: 409 }),
  /** The import file is not of the declared format (MARC, MARCXML, CSV), or cannot be read as one. */
  CATALOG_IMPORT_FORMAT: Object.freeze({ status: 422 }),
  /** The run's output (an export or a report) has expired and was removed. */
  CATALOG_RUN_EXPIRED: Object.freeze({ status: 410 }),
  /** More labels than one request may print (1 000 items or records). */
  CATALOG_LABEL_LIMIT: Object.freeze({ status: 422 }),
  /** The outbound address resolves to a private, loopback, link-local or metadata address (SSRF guard, §6.1). */
  CATALOG_OUTBOUND_BLOCKED: Object.freeze({ status: 422 }),
  /** The outbound request failed (connection, timeout, size, redirect, encoding); `meta.reason`. */
  CATALOG_OUTBOUND_FAILED: Object.freeze({ status: 502 }),
  /** The SRU server answered something that is not a valid SRU response. */
  CATALOG_SRU_INVALID: Object.freeze({ status: 502 }),
  /** The SLiMS source database cannot be reached or refused the connection. */
  MIGRATION_SOURCE_UNREACHABLE: Object.freeze({ status: 502 }),
  /** The SLiMS source is not a version or shape the migrator reads. */
  MIGRATION_SOURCE_UNSUPPORTED: Object.freeze({ status: 422 }),
  /** The target catalog already holds data and the migration was not allowed to add to it. */
  MIGRATION_TARGET_NOT_EMPTY: Object.freeze({ status: 409 }),
  // ---- Komunitas K1 (edition lane) ----
  /**
   * A restore or an update revert onto a database that holds migrations or tables of another migration lane, which
   * this code does not ship; `meta.count`.
   */
  BACKUP_EDITION_TABLES: Object.freeze({ status: 409 }),

  // ---- Komunitas K1 (reports and accreditation) ----
  // Field errors stay VALIDATION_FAILED with errors[{path, code}] (`branch_scope_not_available`, `export_only`, ...).

  /**
   * A report export is over its format's row limit; `meta {rows, max, format}`. For a ZIP the limit is named:
   * `limit: 'entries'` (`rows` = entries, `max` 5 000) or `limit: 'bytes'` (`rows` = bytes, `max` 2 147 483 648).
   */
  REPORT_TOO_LARGE: Object.freeze({ status: 422 }),
  /** The report run's file has expired and was removed. */
  REPORT_RUN_EXPIRED: Object.freeze({ status: 410 }),
  /** The accreditation period is frozen: its data no longer changes until it is unfrozen. */
  ACCRED_PERIOD_FROZEN: Object.freeze({ status: 409 }),
  /** The instrument does not fit the library's type or school level; `meta {libraryType, schoolLevel}`. */
  ACCRED_INSTRUMENT_MISMATCH: Object.freeze({ status: 422 }),
  /** A scored instrument needs one school year or twelve months; `meta {kind, months}`. */
  ACCRED_PERIOD_SPAN: Object.freeze({ status: 422 }),
  /** The period's data changed after its results were computed; `meta {computedAt, changedAt}`. */
  ACCRED_RESULTS_STALE: Object.freeze({ status: 409 }),
  /** A migration precheck refused the run; `meta {reason, count}` (`catalog_changed`: the catalogue differs). */
  MIGRATION_PRECHECK_FAILED: Object.freeze({ status: 422 }),

  // ---- Komunitas (members and circulation) ----
  // Field errors stay VALIDATION_FAILED with errors[{path, code}] (`taken`, `isbn_not_barcode`, `branch_scope_not_available`, ...).

  /** The member cannot be archived: open loans or an unpaid balance; `meta {openLoans, balanceMinor}`. */
  MEMBER_IN_USE: Object.freeze({ status: 409 }),
  /** The member type cannot be archived: live members have it; `meta {count}`. */
  MEMBER_TYPE_IN_USE: Object.freeze({ status: 409 }),
  /** The membership has expired (valid up to and including `meta.expiresOn`). */
  MEMBER_EXPIRED: Object.freeze({ status: 409 }),
  /** The member is suspended. */
  MEMBER_SUSPENDED: Object.freeze({ status: 409 }),
  /** The member import file cannot be read as the declared format; `meta {reason}`. */
  MEMBER_IMPORT_FORMAT: Object.freeze({ status: 422 }),
  /** No loan rule applies to this member and item. */
  CIRC_NO_POLICY: Object.freeze({ status: 422 }),
  /** The item may not be lent; `meta {reason: status | collection_type | policy, status?}`. */
  CIRC_NOT_LOANABLE: Object.freeze({ status: 409 }),
  /** The item is already on loan; `meta {sameMember}`. */
  CIRC_ITEM_ON_LOAN: Object.freeze({ status: 409 }),
  /** The member holds as many open loans as allowed; `meta {scope: member_type | policy, limit}`. */
  CIRC_LIMIT_REACHED: Object.freeze({ status: 409 }),
  /** The item belongs to another branch than the desk's; `meta {branchCode}`. */
  CIRC_OTHER_BRANCH: Object.freeze({ status: 409 }),
  /** The item has no open loan (it was returned already, or another desk closed the loan). */
  CIRC_LOAN_NOT_OPEN: Object.freeze({ status: 409 }),
  /** The loan cannot be renewed; `meta {reason}` (RENEW_REFUSALS). */
  CIRC_RENEW_REFUSED: Object.freeze({ status: 409 }),

  // ---- Komunitas (holds) ----
  /** The item is kept on the hold shelf for another member; `meta {holdId}`. */
  CIRC_ITEM_ON_HOLD: Object.freeze({ status: 409 }),
  /** The hold cannot be placed or changed; `meta {reason}` (HOLD_REFUSALS). */
  CIRC_HOLD_REFUSED: Object.freeze({ status: 409 }),
  // ---- Komunitas (circulation core) ----
  /** The last loan cannot be voided; `meta {reason}` (VOID_REFUSALS: too late, another staff member's, renewed, charged). */
  CIRC_VOID_REFUSED: Object.freeze({ status: 409 }),
  /** No open day within a year after the due date the rule gives: the library calendar closes every day. */
  CIRC_CALENDAR_CLOSED: Object.freeze({ status: 422 }),

  // ---- Komunitas K2 (members extended and visits) ----
  /** The member was anonymised: nothing more can be done with the row. */
  MEMBER_ANONYMIZED: Object.freeze({ status: 409 }),
  /** Too many members for one card sheet request; `meta {max}`. */
  MEMBER_CARD_LIMIT: Object.freeze({ status: 422 }),
  /** The guestbook page has no valid station cookie (never activated, revoked, or replaced by a newer code). */
  VISIT_STATION_UNPAIRED: Object.freeze({ status: 401 }),
  /** The activation code is wrong, used already or expired. */
  VISIT_ACTIVATION_INVALID: Object.freeze({ status: 422 }),
});

export type ErrorCode = keyof typeof ERROR_CODES;

export interface DomainErrorOptions {
  /** Human-readable explanation, safe to show to an operator. Appended to `message`. */
  detail?: string;
  /** Structured data for callers and logs (for example `{ reason: 'lock_timeout' }`). */
  meta?: Record<string, unknown>;
  /** The lower-level error that caused this one. */
  cause?: unknown;
}

/** An expected failure with a registered `code`; `status` is the HTTP status taken from {@link ERROR_CODES}. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail?: string;
  readonly meta?: Record<string, unknown>;

  constructor(code: ErrorCode, options: DomainErrorOptions = {}) {
    super(
      options.detail === undefined ? code : `${code}: ${options.detail}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'DomainError';
    this.code = code;
    this.status = ERROR_CODES[code].status;
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.meta !== undefined) this.meta = options.meta;
  }
}

/**
 * True for a `DomainError`, including one created by another bundled copy of this module.
 * `app.js` and `server.mjs` each bundle their own `DomainError`, so `instanceof` alone is not reliable
 * across the bootloader contract; the check falls back to the error's shape.
 */
export function isDomainError(e: unknown): e is DomainError {
  if (e instanceof DomainError) return true;
  if (!(e instanceof Error) || e.name !== 'DomainError') return false;
  const { code, status } = e as { code?: unknown; status?: unknown };
  return (
    typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(ERROR_CODES, code) &&
    typeof status === 'number'
  );
}
