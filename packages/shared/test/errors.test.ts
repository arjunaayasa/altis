import { describe, expect, it } from 'vitest';
import { DomainError, ERROR_CODES, isDomainError, type ErrorCode } from '../src/errors.js';

describe('ERROR_CODES', () => {
  const phase1a: Record<string, number> = {
    INTERNAL: 500,
    NOT_INSTALLED: 503,
    ALREADY_INSTALLED: 409,
    DB_UNAVAILABLE: 503,
    DB_NOT_EMPTY: 409,
    DB_UNSUPPORTED: 422,
    INVALID_CONFIG: 422,
    INVALID_BASE_URL: 422,
    DOCROOT_EXPOSED: 422,
    SQLITE_NOT_ALLOWED: 422,
    DISK_QUOTA: 507,
    STATE_CORRUPT: 500,
    RELEASE_INVALID: 500,
    SCHEMA_TOO_NEW: 503,
    UNIQUE_VIOLATION: 409,
    INVALID_PATH_SEGMENT: 500,
    SCHEMA_CONFLICT: 500,
    TX_CONFLICT: 409,
    NOT_FOUND: 404,
  };

  // Phase 1b (Task 1), in the order the plan lists them.
  const phase1b: Record<string, number> = {
    // authentication
    AUTH_REQUIRED: 401,
    AUTH_INVALID_CREDENTIALS: 401,
    AUTH_TOO_MANY_ATTEMPTS: 429,
    AUTH_BUSY: 429,
    AUTH_MFA_REQUIRED: 401,
    AUTH_MFA_INVALID: 401,
    AUTH_REAUTH_REQUIRED: 401,
    AUTH_PASSWORD_CHANGE_REQUIRED: 403,
    AUTH_ACCOUNT_DISABLED: 403,
    AUTH_RESET_TOKEN_INVALID: 400,
    // passwords and 2FA
    PASSWORD_TOO_WEAK: 422,
    MFA_ALREADY_ENABLED: 409,
    MFA_NOT_ENABLED: 409,
    MFA_REQUIRED_BY_POLICY: 409,
    // authorization
    AUTHZ_DENIED: 403,
    AUTHZ_ESCALATION: 403,
    LAST_SUPER_ADMIN: 409,
    ROLE_SYSTEM_READONLY: 409,
    ROLE_IN_USE: 409,
    ROLE_SCOPE_INVALID: 422,
    BRANCH_DEFAULT_ARCHIVE: 409,
    // request handling
    CSRF_INVALID: 403,
    ORIGIN_DENIED: 403,
    VALIDATION_FAILED: 422,
    INVALID_JSON: 400,
    PAYLOAD_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415,
    CONFLICT_STALE: 409,
    // idempotency
    IDEMPOTENCY_KEY_INVALID: 400,
    IDEMPOTENCY_IN_PROGRESS: 409,
    IDEMPOTENCY_KEY_REUSED: 422,
    // configuration and mail
    CONFIG_LOCKED_BY_ENV: 409,
    TRUST_PROXY_INVALID: 422,
    SMTP_NOT_CONFIGURED: 409,
    SMTP_FAILED: 422,
    // internal
    SECRET_UNREADABLE: 500,
    ADMIN_UNAVAILABLE: 503,
    AUDIT_MISSING: 500,
  };

  // Phase 1c (Task 1), in the order the plan lists them: ops, jobs, cron, events, realtime, uploads, backup and
  // restore, installer, host state, and the two late additions (M4, M33).
  const phase1c: Record<string, number> = {
    // ops and maintenance
    OPS_IN_PROGRESS: 409,
    OPS_BLOCKED_BY_BACKUP: 409,
    OPS_NONE: 404,
    OPS_POINT_OF_NO_RETURN: 409,
    OPS_FREEZE_TIMEOUT: 409,
    OPS_AUTH_REQUIRED: 401,
    MAINTENANCE: 503,
    // jobs and cron
    JOB_NOT_RETRYABLE: 409,
    JOB_NOT_CANCELLABLE: 409,
    JOB_LEASE_LOST: 409,
    CRON_TOKEN_INVALID: 401,
    // events and realtime
    EVENTS_CURSOR_EXPIRED: 410,
    REALTIME_SSE_DISABLED: 409,
    REALTIME_PROBE_REQUIRED: 409,
    // uploads
    UPLOAD_LIMIT: 429,
    UPLOAD_TOO_LARGE: 413,
    UPLOAD_CHUNK_INVALID: 409,
    UPLOAD_INCOMPLETE: 409,
    UPLOAD_MISMATCH: 422,
    UPLOAD_TYPE_REFUSED: 415,
    UPLOAD_EXPIRED: 410,
    METHOD_OVERRIDE_DENIED: 403,
    // backup and restore
    BACKUP_NOT_READY: 409,
    BACKUP_INVALID: 422,
    BACKUP_SCHEMA_TOO_NEW: 422,
    BACKUP_PASSPHRASE_REQUIRED: 422,
    BACKUP_PASSPHRASE_INVALID: 422,
    BACKUP_CONFIRM_REQUIRED: 409,
    RESTORE_CONFLICTS: 409,
    // installer
    INSTALL_CLAIM_REQUIRED: 403,
    INSTALL_CODE_INVALID: 403,
    INSTALL_STEP_ORDER: 409,
    INSTALL_EXPOSED: 422,
    CRON_NOT_DETECTED: 409,
    // host state
    DATA_VOLUME_MISSING: 503,
    DATA_DIR_MISMATCH: 503,
    // preflight M4 and M33
    RANGE_NOT_SATISFIABLE: 416,
    JOB_NOT_INTERACTIVE: 409,
    // Task 21's fix round: a differing second prepare-download while the first is live
    BACKUP_PREPARE_IN_PROGRESS: 409,
    // Final review G2 (R1c-15): a frozen op whose flag was forced off and whose kind cannot redo its work
    OPS_FREEZE_BROKEN: 409,
  };

  // Phase 1d (Task 1), in the order the plan lists them: updates, feeds and releases. The draft's KEYSET_FILE_FULL is
  // not among them (preflight M6): a full keyset file is a setting and a dashboard alert. The community edition has no
  // licence codes.
  const phase1d: Record<string, number> = {
    // updates (§9.6-9.8)
    UPDATE_NONE: 404,
    UPDATE_NOT_ENTITLED: 409,
    UPDATE_PRECHECK_FAILED: 409,
    UPDATE_PACKAGE_INVALID: 422,
    UPDATE_DOWNLOAD_FAILED: 502,
    UPDATE_HIDDEN: 409,
    UPDATE_SCHEMA_HOLD_FAILED: 409,
    UPDATE_BOOT_FAILED: 500,
    UPDATE_CHECK_THROTTLED: 429,
    // feeds, rollback, releases
    FEED_INVALID: 502,
    FEED_UNREACHABLE: 502,
    ROLLBACK_UNAVAILABLE: 409,
    RELEASE_PENDING: 409,
  };

  // Phase 2 "Katalog & Jelajah" (its spec §12.5), in the spec's order. Field errors stay VALIDATION_FAILED.
  const phase2: Record<string, number> = {
    CATALOG_RECORD_HAS_ITEMS: 409,
    CATALOG_IN_USE: 409,
    CATALOG_MERGE_INVALID: 422,
    ITEM_STATUS_TRANSITION: 409,
    CATALOG_IMPORT_FORMAT: 422,
    CATALOG_RUN_EXPIRED: 410,
    CATALOG_LABEL_LIMIT: 422,
    CATALOG_OUTBOUND_BLOCKED: 422,
    CATALOG_OUTBOUND_FAILED: 502,
    CATALOG_SRU_INVALID: 502,
    MIGRATION_SOURCE_UNREACHABLE: 502,
    MIGRATION_SOURCE_UNSUPPORTED: 422,
    MIGRATION_TARGET_NOT_EMPTY: 409,
  };

  // ---- Komunitas K1 (edition lane) ----
  // A restore or an update revert onto a database holding tables of another migration lane.
  const k1EditionLane: Record<string, number> = {
    BACKUP_EDITION_TABLES: 409,
  };

  // ---- Komunitas K1 (reports and accreditation) ----
  // Reports and accreditation, in this order. Field errors stay VALIDATION_FAILED.
  const komunitasK1: Record<string, number> = {
    REPORT_TOO_LARGE: 422,
    REPORT_RUN_EXPIRED: 410,
    ACCRED_PERIOD_FROZEN: 409,
    ACCRED_INSTRUMENT_MISMATCH: 422,
    ACCRED_PERIOD_SPAN: 422,
    ACCRED_RESULTS_STALE: 409,
    MIGRATION_PRECHECK_FAILED: 422,
  };

  // ---- Komunitas (members and circulation) ----
  // Members, then the desk, in this order. Field errors stay VALIDATION_FAILED.
  const membersCirculation: Record<string, number> = {
    MEMBER_IN_USE: 409,
    MEMBER_TYPE_IN_USE: 409,
    MEMBER_EXPIRED: 409,
    MEMBER_SUSPENDED: 409,
    MEMBER_IMPORT_FORMAT: 422,
    CIRC_NO_POLICY: 422,
    CIRC_NOT_LOANABLE: 409,
    CIRC_ITEM_ON_LOAN: 409,
    CIRC_LIMIT_REACHED: 409,
    CIRC_OTHER_BRANCH: 409,
    CIRC_LOAN_NOT_OPEN: 409,
    CIRC_RENEW_REFUSED: 409,
  };

  // ---- Komunitas (circulation core) ----
  const circulationCore: Record<string, number> = {
    CIRC_VOID_REFUSED: 409,
    CIRC_CALENDAR_CLOSED: 422,
  };

  const expected: Record<ErrorCode, number> = {
    ...phase1a,
    ...phase1b,
    ...phase1c,
    ...phase1d,
    ...phase2,
    ...k1EditionLane,
    ...komunitasK1,
    ...membersCirculation,
    ...circulationCore,
  } as Record<ErrorCode, number>;

  it('registers exactly the Phase 1a, 1b, 1c, 1d, 2 and Komunitas codes (edition lane, reports and accreditation, members and circulation) with their HTTP status', () => {
    expect(Object.keys(ERROR_CODES).sort()).toEqual(Object.keys(expected).sort());
    for (const [code, status] of Object.entries(expected)) {
      expect(ERROR_CODES[code as ErrorCode].status, code).toBe(status);
    }
  });

  it('keeps the 19 Phase 1a codes unchanged, and appends the 1b, the 1c, the 1d, the Phase 2 and then the Komunitas codes (edition lane, reports and accreditation, members and circulation) after them in order', () => {
    expect(Object.keys(phase1a)).toHaveLength(19);
    expect(Object.keys(phase1b)).toHaveLength(38);
    expect(Object.keys(phase1c)).toHaveLength(40);
    expect(Object.keys(phase1d)).toHaveLength(13);
    expect(Object.keys(phase2)).toHaveLength(13);
    expect(Object.keys(komunitasK1)).toHaveLength(7);
    expect(Object.keys(membersCirculation)).toHaveLength(12);
    expect(Object.keys(circulationCore)).toHaveLength(2);
    expect(Object.keys(ERROR_CODES)).toEqual([
      ...Object.keys(phase1a),
      ...Object.keys(phase1b),
      ...Object.keys(phase1c),
      ...Object.keys(phase1d),
      ...Object.keys(phase2),
      ...Object.keys(k1EditionLane),
      ...Object.keys(komunitasK1),
      ...Object.keys(membersCirculation),
      ...Object.keys(circulationCore),
    ]);
    for (const [code, status] of Object.entries(phase1a)) {
      expect(ERROR_CODES[code as ErrorCode].status, code).toBe(status);
    }
    for (const [code, status] of Object.entries(phase1b)) {
      expect(ERROR_CODES[code as ErrorCode].status, code).toBe(status);
    }
  });

  it('the community edition registers no licence code, keeps UPDATE_NOT_ENTITLED (the edition seam), and KEYSET_FILE_FULL is not a code', () => {
    expect(Object.keys(ERROR_CODES).filter((code) => code.startsWith('LICENSE_'))).toEqual([]);
    expect(Object.keys(ERROR_CODES)).toContain('UPDATE_NOT_ENTITLED');
    expect(Object.keys(ERROR_CODES)).not.toContain('KEYSET_FILE_FULL');
  });

  it('a DomainError of a 1d code takes its status from the registry', () => {
    expect(new DomainError('UPDATE_NOT_ENTITLED', { meta: { reason: 'released_after' } }).status).toBe(409);
    expect(new DomainError('UPDATE_NONE').status).toBe(404);
    expect(new DomainError('UPDATE_DOWNLOAD_FAILED').status).toBe(502);
    expect(new DomainError('UPDATE_BOOT_FAILED').status).toBe(500);
    expect(new DomainError('UPDATE_CHECK_THROTTLED', { meta: { retryAfterS: 60 } }).status).toBe(429);
    expect(new DomainError('RELEASE_PENDING').status).toBe(409);
  });

  it('a DomainError of a reports or accreditation code takes its status from the registry and keeps its meta', () => {
    const zip = new DomainError('REPORT_TOO_LARGE', { meta: { rows: 5001, max: 5000, format: 'zip', limit: 'entries' } });
    expect([zip.status, zip.meta]).toEqual([422, { rows: 5001, max: 5000, format: 'zip', limit: 'entries' }]);
    expect(new DomainError('REPORT_RUN_EXPIRED').status).toBe(410);
    expect(new DomainError('ACCRED_PERIOD_FROZEN').status).toBe(409);
    expect(new DomainError('ACCRED_RESULTS_STALE', { meta: { computedAt: 1, changedAt: 2 } }).status).toBe(409);
    expect(new DomainError('MIGRATION_PRECHECK_FAILED', { meta: { reason: 'catalog_changed', count: 3 } }).status).toBe(422);
  });

  it('a DomainError of a Phase 2 code takes its status from the registry', () => {
    expect(new DomainError('CATALOG_IN_USE', { meta: { count: 1 } }).status).toBe(409);
    expect(new DomainError('CATALOG_RUN_EXPIRED').status).toBe(410);
    expect(new DomainError('CATALOG_OUTBOUND_FAILED', { meta: { reason: 'timeout' } }).status).toBe(502);
    expect(new DomainError('MIGRATION_SOURCE_UNSUPPORTED').status).toBe(422);
  });

  it('a DomainError of the other migration lane takes its status from the registry', () => {
    const e = new DomainError('BACKUP_EDITION_TABLES', { meta: { count: 2 } });
    expect(e.status).toBe(409);
    expect(e.meta).toEqual({ count: 2 });
  });

  it('a DomainError of a 1c code takes its status from the registry', () => {
    expect(new DomainError('MAINTENANCE', { meta: { retryAfterS: 30, reason: 'restore' } }).status).toBe(503);
    expect(new DomainError('UPLOAD_LIMIT').status).toBe(429);
    expect(new DomainError('RANGE_NOT_SATISFIABLE').status).toBe(416);
    expect(new DomainError('EVENTS_CURSOR_EXPIRED').status).toBe(410);
    expect(new DomainError('OPS_AUTH_REQUIRED').status).toBe(401);
    expect(new DomainError('DATA_VOLUME_MISSING').status).toBe(503);
  });

  it('a DomainError of a 1b code takes its status from the registry', () => {
    expect(new DomainError('AUTH_TOO_MANY_ATTEMPTS').status).toBe(429);
    expect(new DomainError('PAYLOAD_TOO_LARGE').status).toBe(413);
    expect(new DomainError('UNSUPPORTED_MEDIA_TYPE').status).toBe(415);
    expect(new DomainError('ADMIN_UNAVAILABLE').status).toBe(503);
  });

  it('TX_CONFLICT is 409: a transaction kept losing to deadlocks or serialization failures, however often withTx ran it', () => {
    const e = new DomainError('TX_CONFLICT', { meta: { attempts: 3, code: 'ER_LOCK_DEADLOCK' } });
    expect(e.status).toBe(409);
    expect(e.meta).toEqual({ attempts: 3, code: 'ER_LOCK_DEADLOCK' });
  });

  it('NOT_FOUND is 404: no route answers the path (problem+json of the HTTP app)', () => {
    expect(new DomainError('NOT_FOUND').status).toBe(404);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(ERROR_CODES.INTERNAL)).toBe(true);
  });
});

describe('DomainError', () => {
  it('takes its status from the registry', () => {
    expect(new DomainError('DB_NOT_EMPTY').status).toBe(409);
    expect(new DomainError('DISK_QUOTA').status).toBe(507);
  });

  it('is an Error carrying the code, a name and a message that names the code', () => {
    const e = new DomainError('INVALID_CONFIG');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe('INVALID_CONFIG');
    expect(e.name).toBe('DomainError');
    expect(e.message).toBe('INVALID_CONFIG');
    expect(e.detail).toBeUndefined();
    expect(e.meta).toBeUndefined();
    expect(e.stack).toContain('DomainError');
  });

  it('keeps detail, meta and cause', () => {
    const cause = new Error('boom');
    const e = new DomainError('STATE_CORRUPT', {
      detail: 'current.json is truncated',
      meta: { reason: 'lock_timeout' },
      cause,
    });
    expect(e.detail).toBe('current.json is truncated');
    expect(e.meta).toEqual({ reason: 'lock_timeout' });
    expect(e.cause).toBe(cause);
    expect(e.message).toBe('STATE_CORRUPT: current.json is truncated');
  });
});

describe('isDomainError', () => {
  it('recognises DomainError instances', () => {
    expect(isDomainError(new DomainError('INTERNAL'))).toBe(true);
  });

  it('recognises a DomainError raised by another bundled copy of this module', () => {
    // app.js and server.mjs each bundle their own copy of the class, so instanceof alone is not enough.
    const foreign = Object.assign(new Error('DB_UNAVAILABLE'), { code: 'DB_UNAVAILABLE', status: 503 });
    foreign.name = 'DomainError';
    expect(foreign).not.toBeInstanceOf(DomainError);
    expect(isDomainError(foreign)).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isDomainError(new Error('x'))).toBe(false);
    expect(isDomainError({ code: 'INTERNAL', status: 500 })).toBe(false);
    const unknownCode = Object.assign(new Error('x'), { code: 'NOT_A_CODE', status: 500 });
    unknownCode.name = 'DomainError';
    expect(isDomainError(unknownCode)).toBe(false);
    expect(isDomainError(null)).toBe(false);
    expect(isDomainError('INTERNAL')).toBe(false);
  });
});
