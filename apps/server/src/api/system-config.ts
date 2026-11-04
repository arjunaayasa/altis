import { SETTINGS, randomToken, readSettings, renderMail, writeSettings, type SettingKey } from '@altis/core';
import { isEnvSet, type Env } from '@altis/platform';
import { DomainError, isDomainError, type Locale } from '@altis/shared';
import {
  ENV_LOCKS,
  EmailTestBody,
  SystemConfigPatchBody,
  type CronTokenRotateResponse,
  type EmailTestResponse,
  type EnvLockedField,
  type SmtpPatchBody,
  type SmtpSecurityMode,
  type SystemConfigPutResponse,
  type SystemConfigView,
} from '@altis/shared/api/system-config';
import type { Context } from 'hono';
import { validateBaseUrl, type Config } from '../config.js';
import { clientIp, peerOf } from '../http/client-ip.js';
import { isSecureBase } from '../http/cookies.js';
import { requestOrigin } from '../http/csrf.js';
import type { AppEnv } from '../http/request-id.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';
import { loggableError } from '../safe-error.js';

// The system configuration routes of Task 22 (route catalog; spec §7.6, §13.3 "Konfigurasi Sistem", P13, P15;
// decisions D17, D27, D42; Review Focus 5). Every one needs `system.config.manage`, which only the super admin holds
// (`admin` has everything else, §7.2), and every write a reauth (§7.3). The writes are `tx: 'self'` with idempotency
// `none` (S16): they write config.json or talk to SMTP, which never happens inside a database transaction (on SQLite
// a transaction holds the process's only connection; R37 forbids side effects in a re-runnable callback).
//
// - `system.config.get` answers config.json's baseUrl, proxy hops and allowed origins as this process uses them (the
//   environment overrides applied), the SMTP settings with the password as `{isSet}` (§7.6), and the fields an
//   `ALTIS_*` variable of the server's environment (`services.configWriter.env`) sets, with the variable's name.
// - `system.config.put` (D42):
//   1. validates everything before any write: a touched env-locked field → 409 CONFIG_LOCKED_BY_ENV (naming the
//      variable); baseUrl and allowedOrigins through validateBaseUrl (INVALID_BASE_URL with its reason); the admin
//      must not be locked out at the address they use (Review Focus 5: INVALID_BASE_URL `origin_mismatch`): the
//      request's Origin (else Referer, as step 8 reads it) must be the new baseUrl or one of the new allowedOrigins, or
//      the very next request would be refused, and from an http address the baseUrl cannot change to an https one,
//      whatever allowedOrigins holds (its sign-in cookies would be `__Host-` and Secure, P13, which a browser neither
//      sends nor sets over http); new proxy hops are tried on this request (clientIp: TRUST_PROXY_INVALID
//      `chain_short` or `collapsed`; the browser XFF test is 1c's), the hops in use sent again are not; the SMTP
//      values against the settings registry (VALIDATION_FAILED at the setting's path);
//   2. config.json through the config writer (updateConfigIfChanged, R58), outside any transaction, and only when a
//      field of it changes (a whole form sent again must not replace config.json.bak with a copy of the file); this
//      process applies the result at once, with the environment overrides (S17), and resets its fence; other
//      processes follow within 2 s;
//   3. one transaction: the SMTP settings (writeSettings: the password sealed, and cleared when host, port or username
//      change without a new one) and the one `system.config.update` audit, `meta.fields` the names of what changed.
//      When it fails after step 2 wrote the file, that is logged at `error` level with the field names, and the request
//      answers the error.
//   It answers the configuration now in use and `signInAgain`: the baseUrl changed scheme, so the sign-in cookies
//   changed names and the admin signs in again (P13).
// - `system.config.email_test` sends the `email_test` mail through the saved SMTP settings with
//   `services.emailTestMailer` (each phase of the session bounded by 8 s and the whole session by 20 s, so the request
//   stays inside its 30 s budget, P9), outside any transaction; then audits `system.config.email_test` with
//   `meta {ok, reason?}`, committed before the answer, so a failed test is recorded too: 200 `{sent: true}`, or the
//   mailer's SMTP_NOT_CONFIGURED / SMTP_FAILED (`reason` the stage it had reached).
// - `system.cron_token.rotate` writes a new randomToken(32) to config.json (config writer), then audits the rotation
//   (never the value), and answers the token this once (`Cache-Control: no-store`).

const SYSTEM = '/api/v1/system';

/** The SMTP fields of the body and their settings, in registry order. */
const SMTP_FIELDS = Object.freeze([
  ['host', 'smtp.host'],
  ['port', 'smtp.port'],
  ['security', 'smtp.security'],
  ['username', 'smtp.username'],
  ['password', 'smtp.password'],
  ['from', 'smtp.from'],
] as const satisfies readonly (readonly [keyof SmtpPatchBody, SettingKey])[]);

const SMTP_KEYS: SettingKey[] = SMTP_FIELDS.map(([, key]) => key);

const NO_STORE = { 'Cache-Control': 'no-store' };

/** The fields of ENV_LOCKS whose variable `env` sets (a blank one sets nothing), with the variable's name. */
function lockedFields(env: Env): SystemConfigView['locked'] {
  const locked: SystemConfigView['locked'] = {};
  for (const [field, name] of Object.entries(ENV_LOCKS) as [EnvLockedField, string][]) {
    if (isEnvSet(env, name)) locked[field] = name;
  }
  return locked;
}

/** The configuration `config` runs on, with the SMTP settings as stored (the password only as `{isSet}`). */
async function viewOf(rc: RouteContext<unknown, unknown, unknown>, config: Config): Promise<SystemConfigView> {
  const s = await readSettings(rc.db.db, SMTP_KEYS, config.keyring);
  return {
    baseUrl: config.baseUrl,
    trustProxy: { hops: config.trustProxy.hops },
    allowedOrigins: [...config.allowedOrigins],
    smtp: {
      host: s['smtp.host'] as string | null,
      port: s['smtp.port'] as number,
      security: s['smtp.security'] as SmtpSecurityMode,
      username: s['smtp.username'] as string | null,
      password: s['smtp.password'] as { isSet: boolean },
      from: s['smtp.from'] as string | null,
    },
    cronToken: { isSet: true },
    locked: lockedFields(rc.services.configWriter.env),
  };
}

/** CONFIG_LOCKED_BY_ENV for the first locked field the body touches. */
function refuseLocked(body: SystemConfigPatchBody, locked: SystemConfigView['locked']): void {
  const touched: [EnvLockedField, boolean][] = [
    ['baseUrl', body.baseUrl !== undefined],
    ['trustProxy.hops', body.trustProxy !== undefined],
  ];
  for (const [field, given] of touched) {
    const name = locked[field];
    if (!given || name === undefined) continue;
    throw new DomainError('CONFIG_LOCKED_BY_ENV', {
      detail:
        `${field} ditetapkan oleh variabel lingkungan ${name}; ubah variabel itu di server / ` +
        `${field} is set by the environment variable ${name}; change that variable on the server`,
      meta: { field, env: name },
    });
  }
}

/** The allowed origins in canonical form, without repeats; an invalid one is INVALID_BASE_URL naming allowedOrigins. */
function canonicalOrigins(origins: readonly string[]): string[] {
  return [
    ...new Set(
      origins.map((origin) => {
        try {
          return validateBaseUrl(origin);
        } catch (error) {
          if (!isDomainError(error)) throw error;
          throw new DomainError('INVALID_BASE_URL', {
            detail: `allowedOrigins: ${error.detail ?? error.message}`,
            meta: { ...error.meta, field: 'allowedOrigins' },
          });
        }
      }),
    ),
  ];
}

/**
 * Review Focus 5: the admin must keep the UI at the address this request comes from (Origin, else Referer: what step 8
 * reads).
 *
 * - When `toHttps` (the baseUrl changes to an https one) and that address is http, whatever allowedOrigins holds: the
 *   sign-in cookies become `__Host-` and Secure (P13), which a browser neither sends nor sets over http, so the admin
 *   would be signed out there and could not sign in again. They must open the site at the https address first.
 * - The address must be allowed by the new configuration, or the admin's next request would be refused
 *   (ORIGIN_DENIED).
 */
function refuseOriginMismatch(
  c: Context<AppEnv>,
  next: { baseUrl: string; allowedOrigins: readonly string[]; toHttps: boolean },
): void {
  const origin = requestOrigin(c);
  if (origin === undefined || origin === null) return; // none (not a browser), or refused at step 8 already
  if (next.toHttps && !isSecureBase(origin)) {
    throw new DomainError('INVALID_BASE_URL', {
      detail:
        'Alamat https membuat cookie masuk hanya berlaku di https, jadi Anda akan keluar dan tidak dapat masuk lagi di ' +
        'alamat http ini: buka situs di alamat https lebih dulu, lalu ubah baseUrl dari sana / An https address makes ' +
        'the sign-in cookies https-only, so you would be signed out and could not sign in again at this http address: ' +
        'open the site at its https address first, then change baseUrl from there',
      meta: { reason: 'origin_mismatch' },
    });
  }
  if (origin === next.baseUrl || next.allowedOrigins.includes(origin)) return;
  throw new DomainError('INVALID_BASE_URL', {
    detail:
      'Alamat yang Anda pakai untuk membuka situs ini tidak akan diizinkan lagi: buka situs di alamat baru lebih dulu, ' +
      'atau tambahkan alamat ini ke allowedOrigins / The address you opened this site at would no longer be allowed: ' +
      'open the site at the new address first, or add it to allowedOrigins',
    meta: { reason: 'origin_mismatch' },
  });
}

/** P15, tried on this request: the new hops must find a client address behind exactly that many proxies. */
function refuseUnfitHops(c: Context<AppEnv>, hops: number): void {
  const tried = clientIp({ peer: peerOf(c), xff: c.req.header('x-forwarded-for'), xRealIp: c.req.header('x-real-ip'), hops, persisted: 'ok' });
  if (tried.chainShort) {
    throw new DomainError('TRUST_PROXY_INVALID', {
      detail:
        `Permintaan ini melewati kurang dari ${hops} proxy; turunkan nilai hops / ` +
        `This request came through fewer than ${hops} proxies; lower the hops value`,
      meta: { reason: 'chain_short' },
    });
  }
  if (tried.trust === 'collapsed') {
    throw new DomainError('TRUST_PROXY_INVALID', {
      detail:
        'Dengan nilai hops ini setiap pengunjung tampak beralamat proxy lokal; naikkan nilai hops / ' +
        'With this hops value every visitor appears as the local proxy; raise the hops value',
      meta: { reason: 'collapsed' },
    });
  }
}

/** The SMTP settings of the body, each checked against the settings registry first (VALIDATION_FAILED at its key). */
function smtpPatch(smtp: SmtpPatchBody | undefined): Partial<Record<SettingKey, unknown>> {
  const patch: Partial<Record<SettingKey, unknown>> = {};
  const errors: { path: string; code: string }[] = [];
  for (const [field, key] of SMTP_FIELDS) {
    const value = smtp?.[field];
    if (value === undefined) continue;
    const parsed = SETTINGS[key].schema.safeParse(value);
    if (parsed.success) patch[key] = value;
    else errors.push({ path: key, code: parsed.error.issues[0]?.code ?? 'invalid' });
  }
  if (errors.length > 0) {
    throw new DomainError('VALIDATION_FAILED', {
      detail: 'Nilai pengaturan SMTP tidak valid / An SMTP setting is not valid',
      meta: { errors },
    });
  }
  return patch;
}

/** GET system/config. */
const configGet = route({
  id: 'system.config.get',
  method: 'GET',
  path: `${SYSTEM}/config`,
  permission: 'system.config.manage',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => ({ body: await viewOf(rc, rc.config), headers: NO_STORE }),
});

/** PUT system/config. */
const configPut = route({
  id: 'system.config.put',
  method: 'PUT',
  path: `${SYSTEM}/config`,
  permission: 'system.config.manage',
  reauth: true,
  idempotency: 'none',
  audit: 'system.config.update',
  tx: 'self',
  body: SystemConfigPatchBody,
  handler: async (rc) => {
    const body = rc.body;
    const writer = rc.services.configWriter;
    // What this process runs on (env overrides applied) before this PUT: rc.config follows the state, which step 2 sets.
    const inUse = rc.config;

    // 1. Everything is checked before anything is written.
    refuseLocked(body, lockedFields(writer.env));
    const baseUrl = body.baseUrl === undefined ? undefined : validateBaseUrl(body.baseUrl);
    const allowedOrigins = body.allowedOrigins === undefined ? undefined : canonicalOrigins(body.allowedOrigins);
    if (baseUrl !== undefined || allowedOrigins !== undefined) {
      // An env-locked baseUrl is the environment's, and stays it.
      refuseOriginMismatch(rc.c, {
        baseUrl: baseUrl ?? inUse.baseUrl,
        allowedOrigins: allowedOrigins ?? inUse.allowedOrigins,
        toHttps: baseUrl !== undefined && baseUrl !== inUse.baseUrl && isSecureBase(baseUrl),
      });
    }
    const hops = body.trustProxy?.hops;
    // Only a new value is tried: saving the hops in use again (a form sent whole) changes nothing it could break.
    if (hops !== undefined && hops !== inUse.trustProxy.hops) refuseUnfitHops(rc.c, hops);
    const smtp = smtpPatch(body.smtp);

    // 2. config.json, outside any transaction, when one of its fields changes; this process applies it at once.
    let config = inUse;
    const fields: string[] = [];
    let wroteFile = false;
    if (baseUrl !== undefined || allowedOrigins !== undefined || hops !== undefined) {
      const applied = await writer.update((cfg) => {
        fields.length = 0;
        if (baseUrl !== undefined && cfg.baseUrl !== baseUrl) {
          cfg.baseUrl = baseUrl;
          fields.push('baseUrl');
        }
        if (hops !== undefined && cfg.trustProxy.hops !== hops) {
          cfg.trustProxy = { hops };
          fields.push('trustProxy.hops');
        }
        if (allowedOrigins !== undefined && JSON.stringify(cfg.allowedOrigins) !== JSON.stringify(allowedOrigins)) {
          cfg.allowedOrigins = allowedOrigins;
          fields.push('allowedOrigins');
        }
      });
      if (applied !== null) {
        config = applied;
        wroteFile = true;
      }
    }

    // 3. The SMTP settings and the audit, in one transaction.
    try {
      await rc.withTx(async (tx) => {
        const keys = await writeSettings(tx.trx, smtp, { keyring: config.keyring, now: rc.now, actorId: rc.auth!.subjectId });
        await tx.audit({ action: 'system.config.update', entity: null, entityId: null, meta: { fields: [...fields, ...keys] } });
        if (keys.length > 0) rc.afterCommit(() => rc.services.settings.invalidate());
      });
    } catch (error) {
      if (wroteFile) {
        rc.log.error('config.json changed but the audit/settings write failed', { fields, err: loggableError(error) });
      }
      throw error;
    }

    const answer: SystemConfigPutResponse = {
      ...(await viewOf(rc, config)),
      signInAgain: isSecureBase(config.baseUrl) !== isSecureBase(inUse.baseUrl),
    };
    return { body: answer, headers: NO_STORE };
  },
});

/** Why a test mail failed, for its audit entry: the SMTP stage, `not_configured`, or `error`. */
function failureReason(error: unknown): string {
  if (isDomainError(error)) {
    if (error.code === 'SMTP_NOT_CONFIGURED') return 'not_configured';
    const reason = error.meta?.['reason'];
    if (error.code === 'SMTP_FAILED' && typeof reason === 'string') return reason;
  }
  return 'error';
}

/** POST system/config/email-test. */
const emailTest = route({
  id: 'system.config.email_test',
  method: 'POST',
  path: `${SYSTEM}/config/email-test`,
  permission: 'system.config.manage',
  reauth: true,
  mode: 'system',
  idempotency: 'none',
  audit: 'system.config.email_test',
  tx: 'self',
  body: EmailTestBody,
  handler: async (rc) => {
    const db = rc.db.db;
    let failure: unknown;
    try {
      const locale: Locale = rc.auth!.user.locale ?? (await rc.services.settings.get<Locale>(db, 'library.locale'));
      const library = await rc.services.settings.get<string>(db, 'library.name');
      const mail = renderMail('email_test', locale, { library });
      // The saved settings read now; each phase and the whole session bounded inside the request budget.
      await rc.services.emailTestMailer.send({ to: rc.body.to, subject: mail.subject, text: mail.text });
    } catch (error) {
      failure = error;
    }
    // Committed before the answer, whichever it is.
    const meta = failure === undefined ? { ok: true } : { ok: false, reason: failureReason(failure) };
    await rc.audit({ entity: null, entityId: null, meta });
    if (failure !== undefined) throw failure;
    const body: EmailTestResponse = { sent: true };
    return { body };
  },
});

/** POST system/cron-token/rotate. */
const cronTokenRotate = route({
  id: 'system.cron_token.rotate',
  method: 'POST',
  path: `${SYSTEM}/cron-token/rotate`,
  permission: 'system.config.manage',
  reauth: true,
  idempotency: 'none',
  audit: 'system.config.cron_token_rotate',
  tx: 'self',
  handler: async (rc) => {
    const cronToken = randomToken(32);
    await rc.services.configWriter.update((cfg) => {
      cfg.secrets.cronToken = cronToken;
    });
    try {
      await rc.audit({ entity: null, entityId: null });
    } catch (error) {
      rc.log.error('config.json changed but the audit/settings write failed', { fields: ['secrets.cronToken'], err: loggableError(error) });
      throw error;
    }
    const body: CronTokenRotateResponse = { cronToken };
    return { body, headers: NO_STORE };
  },
});

export const SYSTEM_CONFIG_ROUTES: RouteDecl[] = [configGet, configPut, emailTest, cronTokenRotate];
