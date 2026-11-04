/**
 * The system configuration API vocabulary shared by the server and the admin SPA (spec §7.6, §13.3 "Konfigurasi
 * Sistem", P13, P15; decisions D17, D27, D42). Super admin only (`system.config.manage`). No Node built-ins here: the
 * browser bundles this module. Import it as `@altis/shared/api/system-config`.
 *
 * - `baseUrl`, `trustProxy.hops` and `allowedOrigins` live in config.json; the SMTP transport lives in the settings
 *   (`smtp.*`, D17), its password write-only (`{isSet}`, §7.6).
 * - A field an `ALTIS_*` environment variable sets ({@link ENV_LOCKS}) is shown locked with the variable's name, and a
 *   PUT that touches it is refused (409 `CONFIG_LOCKED_BY_ENV`).
 * - The server puts every URL in canonical form (`scheme://host[:port]`) and checks it (422 `INVALID_BASE_URL` with its
 *   `reason`); the body schema bounds only the size.
 * - A PUT that would lock the admin out at the address they use is refused (422 `INVALID_BASE_URL`, reason
 *   `origin_mismatch`): that address no longer the baseUrl nor an allowed origin, or a new https baseUrl set from an
 *   http address. An accepted change of the baseUrl's scheme answers `signInAgain: true`.
 */
import { z } from 'zod';
import { emailField } from './common.js';

/** The config.json fields an environment variable can set, and that variable (D17: no SMTP overrides). */
export const ENV_LOCKS = Object.freeze({ baseUrl: 'ALTIS_BASE_URL', 'trustProxy.hops': 'ALTIS_TRUST_PROXY_HOPS' } as const);

export type EnvLockedField = keyof typeof ENV_LOCKS;

/** `smtp.security`: `none` plain text, `starttls` an upgrade that must succeed, `tls` TLS from the first byte. */
export const SMTP_SECURITY = Object.freeze(['none', 'starttls', 'tls'] as const);

export type SmtpSecurityMode = (typeof SMTP_SECURITY)[number];

/** At most this many proxies in front of the server (config.json's own bound). */
export const MAX_PROXY_HOPS = 10;

/** At most this many extra origins. */
export const MAX_ALLOWED_ORIGINS = 10;

/** An http(s) origin as typed; the server checks it and keeps its canonical form. */
const originText = z.string().max(2048);

const HOSTNAME = z.hostname();
const IPV6 = z.ipv6();

/** A host name (an IPv4 address reads as one) or an IPv6 address, at most 191 characters. */
const smtpHost = z
  .string()
  .max(191)
  .check((ctx) => {
    if (!HOSTNAME.safeParse(ctx.value).success && !IPV6.safeParse(ctx.value).success) {
      ctx.issues.push({ code: 'invalid_format', format: 'hostname', input: ctx.value });
    }
  });

/**
 * The SMTP part of `PUT system/config`. A key left out keeps its value; `null` clears host, username, password or
 * sender. The password is never trimmed. Changing host, port or username without a new password in the same PUT
 * clears the saved password (a purpose-bound secret, §7.6).
 */
export const SmtpPatchBody = z.strictObject({
  host: smtpHost.nullable().optional(),
  port: z.int().min(1).max(65535).optional(),
  security: z.enum(SMTP_SECURITY).optional(),
  username: z.string().max(191).nullable().optional(),
  password: z.string().min(1).max(512).nullable().optional(),
  from: z.email().max(191).nullable().optional(),
});

export type SmtpPatchBody = z.infer<typeof SmtpPatchBody>;

/** `PUT system/config` (reauth). */
export const SystemConfigPatchBody = z.strictObject({
  baseUrl: originText.optional(),
  trustProxy: z.strictObject({ hops: z.int().min(0).max(MAX_PROXY_HOPS) }).optional(),
  allowedOrigins: z.array(originText).max(MAX_ALLOWED_ORIGINS).optional(),
  smtp: SmtpPatchBody.optional(),
});

export type SystemConfigPatchBody = z.infer<typeof SystemConfigPatchBody>;

/** `POST system/config/email-test` (reauth): one address the test mail goes to. */
export const EmailTestBody = z.strictObject({ to: emailField });

export type EmailTestBody = z.infer<typeof EmailTestBody>;

/**
 * What `GET system/config` answers (and `PUT system/config`, see {@link SystemConfigPutResponse}): the configuration
 * this server runs on.
 */
export interface SystemConfigView {
  /** In canonical form; the environment's value when {@link ENV_LOCKS} locks it. */
  baseUrl: string;
  trustProxy: { hops: number };
  allowedOrigins: string[];
  smtp: {
    host: string | null;
    port: number;
    security: SmtpSecurityMode;
    username: string | null;
    password: { isSet: boolean };
    from: string | null;
  };
  /** The cron token exists from the install on; `POST system/cron-token/rotate` replaces it. */
  cronToken: { isSet: true };
  /** The fields an environment variable sets, with its name. */
  locked: Partial<Record<EnvLockedField, string>>;
}

/** What `PUT system/config` answers: the configuration now in use, and what the change means for the admin's session. */
export interface SystemConfigPutResponse extends SystemConfigView {
  /**
   * The baseUrl changed scheme (http ↔ https). The sign-in cookies are named after it (`__Host-` and Secure for https,
   * P13), so the cookies the browser holds are no longer read: the admin signs in again, at the new address.
   */
  signInAgain: boolean;
}

/** `POST system/config/email-test`: the SMTP server accepted the mail. */
export interface EmailTestResponse {
  sent: true;
}

/** `POST system/cron-token/rotate` (reauth): the new token, shown this once. */
export interface CronTokenRotateResponse {
  cronToken: string;
}
