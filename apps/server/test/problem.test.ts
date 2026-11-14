import { DomainError, MESSAGES, type ErrorCode } from '@altis/shared';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  DATA_DIR_MISMATCH_DETAIL,
  DATA_VOLUME_MISSING_DETAIL,
  MAX_PROBLEM_ERRORS,
  NOT_INSTALLED_DETAIL,
  PROBLEM_REASONS,
} from '../src/http/problem.js';
import { recordingLogger } from './support.js';

// problem+json as amended by decision D10 (R53 otherwise holds): `errors` for VALIDATION_FAILED only, a registered
// `reason` for the codes of PROBLEM_REASONS only, Retry-After for 429 codes and for MAINTENANCE (never for
// DB_UNAVAILABLE, L32), Hono HTTPExceptions mapped to registered codes (L48). `meta` itself is never sent.
// 1c (S7) amends R53 once more: a 5xx shows its `reason` only for 503 MAINTENANCE, and its `detail` only for the three
// fixed texts NOT_INSTALLED, DATA_VOLUME_MISSING and DATA_DIR_MISMATCH. Phase 2 (L09): 502 CATALOG_SRU_INVALID shows the
// detail it carries, an SRU server's diagnostic (spec §6.2).

const PROBLEM_TYPE = 'application/problem+json';

/** An app whose GET /x throws `error` (a raw route added after createApp, so after the route check). */
function throwing(error: unknown) {
  const log = recordingLogger();
  const app = createApp({ state: { phase: 'ready' }, version: '0.1.0', buildId: 'b', log });
  app.get('/x', () => {
    throw error;
  });
  return { app, log };
}

async function reply(error: unknown) {
  const { app, log } = throwing(error);
  const res = await app.request('/x');
  const text = await res.text();
  return { res, text, body: JSON.parse(text) as Record<string, unknown>, log };
}

describe('VALIDATION_FAILED: errors', () => {
  it('lists {path, code} only, never an input value', async () => {
    const { res, text, body } = await reply(
      new DomainError('VALIDATION_FAILED', {
        detail: 'Data tidak valid / Invalid data',
        meta: {
          errors: [
            { path: 'name', code: 'too_small', input: 'hunter2-secret' },
            { path: '', code: 'unrecognized_keys', keys: ['hunter2-key'] },
          ],
          input: { password: 'hunter2-secret' },
        },
      }),
    );
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toBe(PROBLEM_TYPE);
    expect(body).toEqual({
      type: 'about:blank',
      title: expect.any(String),
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: 'Data tidak valid / Invalid data',
      errors: [
        { path: 'name', code: 'too_small' },
        { path: '', code: 'unrecognized_keys' },
      ],
      traceId: res.headers.get('x-request-id'),
    });
    expect(text).not.toContain('hunter2');
  });

  it('an entry that is not {path: string, code: string} is dropped; no errors at all gives []', async () => {
    const { body } = await reply(
      new DomainError('VALIDATION_FAILED', { meta: { errors: [{ path: 'a', code: 1 }, 'x', null, { path: 'b', code: 'taken' }] } }),
    );
    expect(body['errors']).toEqual([{ path: 'b', code: 'taken' }]);
    expect((await reply(new DomainError('VALIDATION_FAILED'))).body['errors']).toEqual([]);
  });

  it(`sends at most ${MAX_PROBLEM_ERRORS} entries`, async () => {
    const errors = Array.from({ length: 150 }, (_, i) => ({ path: `items.${i}`, code: 'invalid_type' }));
    const { body } = await reply(new DomainError('VALIDATION_FAILED', { meta: { errors } }));
    expect(body['errors']).toEqual(errors.slice(0, MAX_PROBLEM_ERRORS));
  });

  it('another code never carries errors', async () => {
    const { body } = await reply(new DomainError('INVALID_CONFIG', { meta: { errors: [{ path: 'db.port', code: 'too_big' }] } }));
    expect(body).not.toHaveProperty('errors');
    const internal = await reply(new DomainError('AUDIT_MISSING', { meta: { errors: [{ path: 'x', code: 'y' }] } }));
    expect(Object.keys(internal.body).sort()).toEqual(['code', 'status', 'title', 'traceId', 'type']);
  });
});

describe('reason (PROBLEM_REASONS, S30)', () => {
  it('lists the registered words', () => {
    expect(PROBLEM_REASONS).toEqual({
      INVALID_BASE_URL: [
        'not_a_string',
        'empty',
        'invalid_characters',
        'not_a_url',
        'scheme',
        'userinfo',
        'path',
        'query',
        'fragment',
        'invalid_host',
        'port',
        'origin_mismatch',
        'probe_failed',
      ],
      PASSWORD_TOO_WEAK: ['too_short', 'too_long', 'common'],
      SMTP_FAILED: ['connect', 'tls', 'auth', 'send'],
      TRUST_PROXY_INVALID: ['collapsed', 'chain_short'],
      MAINTENANCE: ['restore', 'backup', 'update', 'manual', 'install', 'migrate', 'reset'],
      BACKUP_INVALID: ['format', 'checksum', 'signature', 'path', 'bomb', 'schema', 'entry'],
      UPLOAD_CHUNK_INVALID: ['order', 'size'],
      UPLOAD_MISMATCH: ['size', 'sha256'],
      JOB_NOT_RETRYABLE: ['origin_only', 'state'],
      TX_CONFLICT: ['upload_busy'],
      // 1d (Task 1; preflight M6)
      UPDATE_NOT_ENTITLED: ['no_license', 'released_after'],
      UPDATE_PRECHECK_FAILED: ['not_newer', 'min_upgrade_from', 'boot_protocol', 'min_node', 'min_db', 'snapshot_backup'],
      UPDATE_PACKAGE_INVALID: ['hash', 'signature', 'manifest', 'mismatch', 'entry', 'bomb', 'size', 'version', 'keyset'],
      UPDATE_BOOT_FAILED: ['verify', 'import', 'start', 'migration', 'health', 'stalled', 'repeated', 'operator'],
      FEED_INVALID: ['signature', 'freshness', 'expired', 'seq', 'hash', 'shape', 'channel'],
      FEED_UNREACHABLE: ['no_feed_url', 'network', 'status', 'timeout', 'too_large', 'insecure'],
      ROLLBACK_UNAVAILABLE: ['no_previous', 'incompatible', 'missing', 'pending'],
      UPDATE_HIDDEN: ['image'],
      // Komunitas K1 (catalogue re-sync)
      MIGRATION_PRECHECK_FAILED: ['catalog_changed'],
      // Komunitas (members and circulation)
      NOT_FOUND: ['member_no'],
      MEMBER_IMPORT_FORMAT: ['empty', 'header', 'unreadable', 'too_many_rows'],
      CIRC_NOT_LOANABLE: ['status', 'collection_type', 'policy'],
      CIRC_ITEM_ON_LOAN: ['same_member', 'other_member'],
      CIRC_LIMIT_REACHED: ['member_type', 'policy'],
      CIRC_RENEW_REFUSED: ['changed', 'suspended', 'expired', 'same_day', 'limit', 'hold', 'blocked', 'not_online'],
      // Komunitas (circulation core)
      CIRC_LOAN_NOT_OPEN: ['lost_item'],
      CIRC_VOID_REFUSED: ['too_late', 'other_staff', 'renewed', 'charged'],
    });
  });

  it('every code with registered reasons has its error.<CODE> message in both languages, with no placeholder', () => {
    for (const code of Object.keys(PROBLEM_REASONS) as ErrorCode[]) {
      for (const locale of ['id', 'en'] as const) {
        const text = MESSAGES[locale][`error.${code}`];
        expect(text, `${locale}:${code}`).toBeTruthy();
        expect(text, `${locale}:${code}`).not.toMatch(/\{[A-Za-z_][A-Za-z0-9_]*\}/);
      }
    }
  });

  it('1d: UPDATE_PACKAGE_INVALID with meta.reason signature → 422 with reason signature, and nothing of meta', async () => {
    const { res, body } = await reply(new DomainError('UPDATE_PACKAGE_INVALID', { meta: { reason: 'signature', kid: 'kid-secret' } }));
    expect(res.status).toBe(422);
    expect(body).toEqual({
      type: 'about:blank',
      title: expect.any(String),
      status: 422,
      code: 'UPDATE_PACKAGE_INVALID',
      reason: 'signature',
      traceId: res.headers.get('x-request-id'),
    });
  });

  it('1d: UPDATE_BOOT_FAILED → 500 without detail or reason (S7), whatever it carries', async () => {
    const { res, body, text } = await reply(
      new DomainError('UPDATE_BOOT_FAILED', { detail: 'import failed at /srv/secret/releases/0.2.0', meta: { reason: 'import' } }),
    );
    expect(res.status).toBe(500);
    expect(Object.keys(body).sort()).toEqual(['code', 'status', 'title', 'traceId', 'type']);
    expect(text).not.toContain('secret');
  });

  it('1d: the 502 feed and download codes keep their reasons and details server-side (M6)', async () => {
    for (const error of [
      new DomainError('FEED_INVALID', { detail: 'secret', meta: { reason: 'signature' } }),
      new DomainError('FEED_UNREACHABLE', { detail: 'secret host feed.internal', meta: { reason: 'network' } }),
      new DomainError('UPDATE_DOWNLOAD_FAILED', { detail: 'secret', meta: { reason: 'network' } }),
    ]) {
      const { res, body, text } = await reply(error);
      expect(res.status, error.code).toBe(502);
      expect(Object.keys(body).sort(), error.code).toEqual(['code', 'status', 'title', 'traceId', 'type']);
      expect(body['title'], error.code).not.toBe('Galat server / Server Error');
      expect(text).not.toContain('secret');
    }
  });

  it('PASSWORD_TOO_WEAK with meta.reason "common" → body reason "common"', async () => {
    const { res, body } = await reply(new DomainError('PASSWORD_TOO_WEAK', { meta: { reason: 'common', password: 'hunter2' } }));
    expect(res.status).toBe(422);
    expect(body).toEqual({
      type: 'about:blank',
      title: expect.any(String),
      status: 422,
      code: 'PASSWORD_TOO_WEAK',
      reason: 'common',
      traceId: res.headers.get('x-request-id'),
    });
  });

  it.each<[ErrorCode, string]>([
    ['INVALID_BASE_URL', 'origin_mismatch'],
    ['INVALID_BASE_URL', 'scheme'],
    ['INVALID_BASE_URL', 'probe_failed'],
    ['SMTP_FAILED', 'tls'],
    ['TRUST_PROXY_INVALID', 'collapsed'],
    ['TRUST_PROXY_INVALID', 'chain_short'],
    ['MAINTENANCE', 'restore'],
    ['MAINTENANCE', 'install'],
    ['BACKUP_INVALID', 'checksum'],
    ['BACKUP_INVALID', 'bomb'],
    ['UPLOAD_CHUNK_INVALID', 'order'],
    ['UPLOAD_MISMATCH', 'sha256'],
    ['JOB_NOT_RETRYABLE', 'origin_only'],
    ['JOB_NOT_RETRYABLE', 'state'],
    ['TX_CONFLICT', 'upload_busy'],
    // 1d
    ['UPDATE_NOT_ENTITLED', 'no_license'],
    ['UPDATE_NOT_ENTITLED', 'released_after'],
    ['UPDATE_PRECHECK_FAILED', 'min_upgrade_from'],
    ['UPDATE_PRECHECK_FAILED', 'snapshot_backup'],
    ['UPDATE_PACKAGE_INVALID', 'bomb'],
    ['UPDATE_PACKAGE_INVALID', 'keyset'],
    ['ROLLBACK_UNAVAILABLE', 'incompatible'],
    ['UPDATE_HIDDEN', 'image'],
  ])('%s with reason %s → reason', async (code, reason) => {
    expect((await reply(new DomainError(code, { meta: { reason } }))).body['reason']).toBe(reason);
  });

  it('a reason outside the list, or on another code, is dropped', async () => {
    for (const error of [
      new DomainError('PASSWORD_TOO_WEAK', { meta: { reason: 'hunter2' } }),
      new DomainError('PASSWORD_TOO_WEAK', { meta: { reason: ['common'] } }),
      new DomainError('SMTP_FAILED', { meta: { reason: 'common' } }),
      new DomainError('CONFLICT_STALE', { meta: { reason: 'too_short' } }),
      new DomainError('DB_UNAVAILABLE', { meta: { reason: 'packet_too_large' } }),
      // 1c: the new lists are closed too, and a word of one code means nothing on another.
      new DomainError('MAINTENANCE', { meta: { reason: 'hunter2' } }),
      new DomainError('MAINTENANCE', { meta: { reason: 'format' } }),
      new DomainError('BACKUP_INVALID', { meta: { reason: 'restore' } }),
      new DomainError('UPLOAD_MISMATCH', { meta: { reason: 'order' } }),
      new DomainError('UPLOAD_CHUNK_INVALID', { meta: { reason: 'sha256' } }),
      new DomainError('JOB_NOT_RETRYABLE', { meta: { reason: 'dead' } }),
      new DomainError('OPS_IN_PROGRESS', { meta: { reason: 'restore' } }),
      new DomainError('TX_CONFLICT', { meta: { reason: 'order' } }),
      // 1d: closed lists too, and a word of one code means nothing on another.
      new DomainError('UPDATE_NOT_ENTITLED', { meta: { reason: 'nonce' } }),
      new DomainError('UPDATE_PRECHECK_FAILED', { meta: { reason: 'entitlement' } }),
      new DomainError('UPDATE_PACKAGE_INVALID', { meta: { reason: 'hunter2' } }),
      new DomainError('ROLLBACK_UNAVAILABLE', { meta: { reason: 'image' } }),
      new DomainError('RELEASE_PENDING', { meta: { reason: 'pending' } }),
      new DomainError('AUTHZ_DENIED', { meta: { reason: 'grace_over' } }),
    ]) {
      const { body, text } = await reply(error);
      expect(body, error.code).not.toHaveProperty('reason');
      expect(text).not.toContain('hunter2');
    }
  });

  it('S7: 503 MAINTENANCE sends its registered reason (the admin client reads it); no other 5xx sends one', async () => {
    const { res, body } = await reply(new DomainError('MAINTENANCE', { meta: { retryAfterS: 30, reason: 'restore' } }));
    expect(res.status).toBe(503);
    expect(body).toEqual({
      type: 'about:blank',
      title: expect.any(String),
      status: 503,
      code: 'MAINTENANCE',
      reason: 'restore',
      traceId: res.headers.get('x-request-id'),
    });
    for (const error of [
      new DomainError('INTERNAL', { meta: { reason: 'restore' } }),
      new DomainError('DB_UNAVAILABLE', { meta: { reason: 'restore' } }),
      new DomainError('DATA_VOLUME_MISSING', { meta: { reason: 'restore' } }),
      new DomainError('DATA_DIR_MISMATCH', { meta: { reason: 'restore' } }),
      new DomainError('NOT_INSTALLED', { meta: { reason: 'install' } }),
      new DomainError('SCHEMA_TOO_NEW', { meta: { reason: 'restore' } }),
    ]) {
      expect((await reply(error)).body, error.code).not.toHaveProperty('reason');
    }
  });
});

describe('detail (S7: R53 amended for 1c)', () => {
  it('a 5xx never shows a detail, with the three fixed texts as the only exceptions', async () => {
    for (const error of [
      new DomainError('INTERNAL', { detail: 'secret host db-7.internal', meta: { reason: 'restore' } }),
      new DomainError('DB_UNAVAILABLE', { detail: 'secret host db-7.internal' }),
      new DomainError('MAINTENANCE', { detail: 'secret path /home/u/altis-data', meta: { reason: 'restore' } }),
      new DomainError('AUDIT_MISSING', { detail: 'secret' }),
      new DomainError('SCHEMA_TOO_NEW', { detail: 'secret' }),
    ]) {
      const { body, text } = await reply(error);
      expect(body, error.code).not.toHaveProperty('detail');
      expect(text).not.toContain('secret');
    }
  });

  it('Phase 2 (L09): 502 CATALOG_SRU_INVALID shows the detail it carries, the SRU server diagnostic (spec §6.2), and nothing else', async () => {
    const { res, body } = await reply(new DomainError('CATALOG_SRU_INVALID', { detail: 'Unsupported index: dc.title', meta: { message: 'x', reason: 'y' } }));
    expect(res.status).toBe(502);
    expect(body).toEqual({ type: 'about:blank', title: expect.any(String), status: 502, code: 'CATALOG_SRU_INVALID', detail: 'Unsupported index: dc.title', traceId: expect.any(String) });
    // An answer that is not SRU carries no detail (core keeps its own message in meta): none is sent.
    expect((await reply(new DomainError('CATALOG_SRU_INVALID', { meta: { message: 'The answer is not well-formed XML.' } }))).body).not.toHaveProperty('detail');
    // The other 502s of copy cataloguing keep theirs server-side.
    expect((await reply(new DomainError('CATALOG_OUTBOUND_FAILED', { detail: 'secret host sru.internal', meta: { reason: 'network' } }))).body).not.toHaveProperty('detail');
  });

  it('INTERNAL (500) still has neither detail nor reason', async () => {
    const { res, body } = await reply(new DomainError('INTERNAL', { detail: 'boom', meta: { reason: 'restore' } }));
    expect(res.status).toBe(500);
    expect(Object.keys(body).sort()).toEqual(['code', 'status', 'title', 'traceId', 'type']);
  });

  it('DATA_VOLUME_MISSING → 503 with exactly DATA_VOLUME_MISSING_DETAIL, whatever detail the error carries', async () => {
    const { res, body } = await reply(new DomainError('DATA_VOLUME_MISSING', { detail: 'volume /srv/secret is gone' }));
    expect(res.status).toBe(503);
    expect(body['detail']).toBe(DATA_VOLUME_MISSING_DETAIL);
    expect(body).toEqual({
      type: 'about:blank',
      title: expect.any(String),
      status: 503,
      code: 'DATA_VOLUME_MISSING',
      detail: DATA_VOLUME_MISSING_DETAIL,
      traceId: res.headers.get('x-request-id'),
    });
    // The detail is there with no detail on the error at all.
    expect((await reply(new DomainError('DATA_VOLUME_MISSING'))).body['detail']).toBe(DATA_VOLUME_MISSING_DETAIL);
  });

  it('DATA_DIR_MISMATCH → 503 with exactly DATA_DIR_MISMATCH_DETAIL', async () => {
    const { res, body } = await reply(new DomainError('DATA_DIR_MISMATCH', { detail: '/home/other/data' }));
    expect(res.status).toBe(503);
    expect(body['detail']).toBe(DATA_DIR_MISMATCH_DETAIL);
    expect(JSON.stringify(body)).not.toContain('/home/other');
  });

  it('the fixed details are bilingual single lines, naming the cause and no path, host or secret', () => {
    for (const detail of [DATA_VOLUME_MISSING_DETAIL, DATA_DIR_MISMATCH_DETAIL]) {
      expect(detail).toMatch(/ \/ /);
      expect(detail).not.toMatch(/[\r\n]/);
      expect(detail.length).toBeLessThanOrEqual(300);
    }
    expect(DATA_VOLUME_MISSING_DETAIL).not.toBe(DATA_DIR_MISMATCH_DETAIL);
    expect(DATA_VOLUME_MISSING_DETAIL).not.toBe(NOT_INSTALLED_DETAIL);
    expect(DATA_DIR_MISMATCH_DETAIL).not.toBe(NOT_INSTALLED_DETAIL);
  });

  it('NOT_INSTALLED still shows its fixed instruction', async () => {
    expect((await reply(new DomainError('NOT_INSTALLED', { detail: 'other' }))).body['detail']).toBe(NOT_INSTALLED_DETAIL);
  });

  it('a 4xx shows the detail it carries; the new 1c 4xx codes included', async () => {
    const { body } = await reply(new DomainError('OPS_IN_PROGRESS', { detail: 'Operasi restore sedang berjalan / A restore is running' }));
    expect(body['detail']).toBe('Operasi restore sedang berjalan / A restore is running');
  });
});

describe('Retry-After', () => {
  it('AUTH_TOO_MANY_ATTEMPTS with meta.retryAfterS 42 → Retry-After: 42, no meta in the body', async () => {
    const { res, body } = await reply(new DomainError('AUTH_TOO_MANY_ATTEMPTS', { meta: { retryAfterS: 42, bucket: 'login:ip' } }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(Object.keys(body).sort()).toEqual(['code', 'status', 'title', 'traceId', 'type']);
  });

  it('a fractional wait is rounded up; a missing or invalid one sends no header', async () => {
    expect((await reply(new DomainError('AUTH_BUSY', { meta: { retryAfterS: 1.2 } }))).res.headers.get('retry-after')).toBe('2');
    expect((await reply(new DomainError('AUTH_BUSY'))).res.headers.get('retry-after')).toBeNull();
    for (const retryAfterS of [-1, Number.NaN, Infinity, '5']) {
      const { res } = await reply(new DomainError('AUTH_TOO_MANY_ATTEMPTS', { meta: { retryAfterS } }));
      expect(res.headers.get('retry-after'), String(retryAfterS)).toBeNull();
    }
  });

  it('only on 429 codes and MAINTENANCE: DB_UNAVAILABLE (packet_too_large, L32) and others never carry it', async () => {
    const db = await reply(new DomainError('DB_UNAVAILABLE', { meta: { reason: 'packet_too_large', retryAfterS: 5 } }));
    expect(db.res.status).toBe(503);
    expect(db.res.headers.get('retry-after')).toBeNull();
    const stale = await reply(new DomainError('CONFLICT_STALE', { meta: { retryAfterS: 5 } }));
    expect(stale.res.headers.get('retry-after')).toBeNull();
    for (const code of ['DB_UNAVAILABLE', 'NOT_INSTALLED', 'DATA_VOLUME_MISSING', 'DATA_DIR_MISMATCH', 'SCHEMA_TOO_NEW', 'INTERNAL', 'OPS_IN_PROGRESS'] as const) {
      expect((await reply(new DomainError(code, { meta: { retryAfterS: 5 } }))).res.headers.get('retry-after'), code).toBeNull();
    }
  });

  it('1c: the new 429 (UPLOAD_LIMIT) carries Retry-After from meta.retryAfterS like the others', async () => {
    const { res } = await reply(new DomainError('UPLOAD_LIMIT', { meta: { retryAfterS: 90 } }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('90');
  });

  it('1d: UPDATE_CHECK_THROTTLED with meta.retryAfterS 60 → 429 with Retry-After: 60, like every 429', async () => {
    const { res, body } = await reply(new DomainError('UPDATE_CHECK_THROTTLED', { meta: { retryAfterS: 60 } }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(Object.keys(body).sort()).toEqual(['code', 'status', 'title', 'traceId', 'type']);
  });

  it('1c: MAINTENANCE with meta.retryAfterS 30 → 503, Retry-After: 30 and reason restore', async () => {
    const { res, body } = await reply(new DomainError('MAINTENANCE', { meta: { retryAfterS: 30, reason: 'restore' } }));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(body['reason']).toBe('restore');
    expect(res.headers.get('content-type')).toBe(PROBLEM_TYPE);
  });

  it('1c: MAINTENANCE takes its wait from meta.retryAfterS (rounded up) and defaults to 30', async () => {
    expect((await reply(new DomainError('MAINTENANCE', { meta: { retryAfterS: 5, reason: 'backup' } }))).res.headers.get('retry-after')).toBe('5');
    expect((await reply(new DomainError('MAINTENANCE', { meta: { retryAfterS: 1.2 } }))).res.headers.get('retry-after')).toBe('2');
    expect((await reply(new DomainError('MAINTENANCE', { meta: { retryAfterS: 0 } }))).res.headers.get('retry-after')).toBe('0');
    expect((await reply(new DomainError('MAINTENANCE'))).res.headers.get('retry-after')).toBe('30');
    expect((await reply(new DomainError('MAINTENANCE', { meta: { reason: 'update' } }))).res.headers.get('retry-after')).toBe('30');
    for (const retryAfterS of [-1, Number.NaN, Infinity, '5']) {
      const { res } = await reply(new DomainError('MAINTENANCE', { meta: { retryAfterS } }));
      expect(res.headers.get('retry-after'), String(retryAfterS)).toBe('30');
    }
  });

  it('1c: the body of a MAINTENANCE problem never carries meta, retryAfterS or the detail', async () => {
    const { body, text } = await reply(
      new DomainError('MAINTENANCE', { detail: 'secret', meta: { retryAfterS: 12, reason: 'manual', opId: 'op-secret' } }),
    );
    expect(Object.keys(body).sort()).toEqual(['code', 'reason', 'status', 'title', 'traceId', 'type']);
    expect(text).not.toMatch(/secret|retryAfterS|opId/);
  });
});

describe('titles of the 1c statuses', () => {
  it.each<[ErrorCode, number]>([
    ['EVENTS_CURSOR_EXPIRED', 410],
    ['UPLOAD_EXPIRED', 410],
    ['RANGE_NOT_SATISFIABLE', 416],
    ['UPLOAD_TOO_LARGE', 413],
    ['UPLOAD_TYPE_REFUSED', 415],
    ['OPS_NONE', 404],
    // 1d: the feed and download codes are 502
    ['FEED_UNREACHABLE', 502],
    ['UPDATE_DOWNLOAD_FAILED', 502],
  ])('%s → %i with the status phrase as its title, not the generic one', async (code, status) => {
    const { res, body } = await reply(new DomainError(code));
    expect(res.status).toBe(status);
    expect(body['title']).not.toBe('Permintaan gagal / Request Failed');
    expect(String(body['title'])).toMatch(/ \/ /);
  });
});

describe('Hono HTTPException (L48)', () => {
  it.each<[number, number, ErrorCode]>([
    [413, 413, 'PAYLOAD_TOO_LARGE'],
    [400, 400, 'INVALID_JSON'],
    [415, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [500, 500, 'INTERNAL'],
    [502, 500, 'INTERNAL'],
    [404, 500, 'INTERNAL'],
  ])('HTTPException(%i) → %i %s problem+json', async (thrown, status, code) => {
    const custom = new Response('Payload Too Large <host internals>', { status: thrown });
    const { res, body, text } = await reply(new HTTPException(thrown as 400, { res: custom, message: 'internal text' }));
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toBe(PROBLEM_TYPE);
    expect(body).toEqual({ type: 'about:blank', title: expect.any(String), status, code, traceId: res.headers.get('x-request-id') });
    expect(text).not.toMatch(/internals|internal text/);
  });

  it('an unmapped one is logged; a mapped 4xx is not', async () => {
    expect((await reply(new HTTPException(502))).log.lines.some((l) => l.level === 'error')).toBe(true);
    expect((await reply(new HTTPException(413))).log.lines.some((l) => l.level === 'error')).toBe(false);
  });
});
