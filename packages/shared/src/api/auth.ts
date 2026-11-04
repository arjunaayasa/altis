/**
 * The auth API vocabulary shared by the server and the admin SPA (spec §7.1). No Node built-ins here: the browser
 * bundles this module. Import it as `@altis/shared/api/auth`.
 */
import { z } from 'zod';
import type { Locale, MessageKey } from '../i18n/index.js';
import type { Permission } from '../permissions.js';
import { emailField, localeField, passwordField, personNameField } from './common.js';

/**
 * Where a staff session stands (§7.1):
 * - `full`: signed in, the second factor passed (or not needed);
 * - `mfa`: waiting for a TOTP code or a recovery code;
 * - `mfa_setup`: 2FA is required (by the user's flag or a role) but not enrolled yet;
 * - `recovery`: the TOTP secret must be enrolled again (`totp_reenroll`, after a restore): only a recovery code.
 *
 * A session in any stage but `full` reaches only `partialAuth` routes.
 */
export type SessionStage = 'full' | 'mfa' | 'mfa_setup' | 'recovery';

/**
 * `POST auth/login`. The username is taken as typed (at most 191 characters, the width of `username_key`) and matched
 * on its normalized key (`normalizeKey`: NFKC, trimmed, upper case; Review Focus 2); the password is never trimmed.
 */
export const LoginBody = z.strictObject({
  username: z.string().min(1).max(191),
  password: passwordField,
  remember: z.boolean().optional(),
});

export type LoginBody = z.infer<typeof LoginBody>;

/** The answer of `POST auth/login`: how far the new session got, and whether the password must be changed first. */
export interface LoginResponse {
  stage: SessionStage;
  mustChangePassword: boolean;
}

/** A TOTP code as an authenticator app shows it: exactly 6 ASCII digits. */
export const totpCodeField = z.string().regex(/^\d{6}$/);

/**
 * `POST auth/2fa/verify`, the second factor of a sign-in (§7.1): exactly one of a TOTP `code` (stage `mfa`) and a
 * `recoveryCode` (stage `mfa` or `recovery`; matched after normalization, so case, spaces and dashes do not matter).
 * `remember` asks for a remember-me token bound to the passed second factor.
 */
export const TwoFactorVerifyBody = z
  .strictObject({
    code: totpCodeField.optional(),
    recoveryCode: z.string().max(32).optional(),
    remember: z.boolean().optional(),
  })
  .refine((b) => (b.code === undefined) !== (b.recoveryCode === undefined), {
    message: 'Isi tepat satu: kode atau kode cadangan / Give exactly one of code and recoveryCode',
    path: ['code'],
  });

export type TwoFactorVerifyBody = z.infer<typeof TwoFactorVerifyBody>;

/** The answer of `POST auth/2fa/verify`: the stage the session reached (`full`, or `mfa_setup` after a recovery). */
export type TwoFactorVerifyResponse = LoginResponse;

/** `POST auth/2fa/enable`: the code of the secret `auth/2fa/setup` gave. */
export const TwoFactorEnableBody = z.strictObject({ code: totpCodeField });

export type TwoFactorEnableBody = z.infer<typeof TwoFactorEnableBody>;

/** `POST auth/2fa/disable` (§7.1: "Menonaktifkan 2FA butuh sandi + kode"). */
export const TwoFactorDisableBody = z.strictObject({ password: passwordField, code: totpCodeField });

export type TwoFactorDisableBody = z.infer<typeof TwoFactorDisableBody>;

/** `POST auth/reauth` (§7.3): the password, plus a TOTP code when 2FA is enabled. */
export const ReauthBody = z.strictObject({ password: passwordField, code: totpCodeField.optional() });

export type ReauthBody = z.infer<typeof ReauthBody>;

/**
 * The answer of `POST auth/2fa/setup`: the new secret in base32 (to type in) and its `otpauth://` URI (for the QR
 * code). Nothing is enabled until `auth/2fa/enable` gets a code of it.
 */
export interface TwoFactorSetupResponse {
  secret: string;
  otpauthUri: string;
}

/** 10 recovery codes `XXXXX-XXXXX`, shown once (`auth/2fa/enable`, `auth/2fa/recovery-codes`). */
export interface RecoveryCodesResponse {
  codes: string[];
}

/** The answer of `POST auth/reauth`: when the re-authentication stops counting (epoch ms, §7.3). */
export interface ReauthResponse {
  reauthUntil: number;
}

/**
 * A status banner of the admin shell (decision D32): the clock anomaly and maintenance. `messageKey` is a shared i18n
 * key (`banner.*`), `params` its placeholders, `link` an admin path to act on it.
 */
export interface Banner {
  kind: 'maintenance' | 'clock';
  severity: 'info' | 'warning' | 'error';
  messageKey: MessageKey;
  params?: Record<string, string | number>;
  link?: string;
}

/** The library as the sign-in screen and the shell show it (settings `library.name`, `library.locale`). */
export interface MeLibrary {
  name: string;
  locale: Locale;
}

/** The signed-in staff user as `GET auth/me` shows it. */
export interface MeUser {
  id: string;
  username: string;
  name: string;
  email: string | null;
  /** null: the library's language. */
  locale: Locale | null;
  totpEnabled: boolean;
  /** 2FA is required: by the user's own flag or by a role the user holds. */
  mfaRequired: boolean;
}

/**
 * How the SPA should talk to this host (1c Task 16; spec §5 P10, §10.8), from the settings and the last browser test
 * of Diagnostik (`system.probe`):
 * - `realtime`: `sse` when SSE is on (`realtime.sse`, or while it is null every runtime but `passenger`/`litespeed`),
 *   else `polling`;
 * - `methodOverride`: the browser test saw a WAF block PUT, PATCH or DELETE, so the SPA sends them as `POST` +
 *   `X-HTTP-Method-Override` from the start;
 * - `chunkBytes`: the chunk size an upload starts with (the largest the test saw pass, else 5 MiB);
 * - `probedAt`: when that browser test ran (`system.probe.at`, epoch ms), null before the first one. A chunk size the
 *   browser learned itself yields to `chunkBytes` once a newer test has run (admin lib/upload.ts);
 * - `runner` (1d, T31-RUNNER-MODE-FOR-ALL-STAFF): how this host runs its jobs, `worker` (an in-process worker is
 *   always on) or `external` (cron, `/_cron` and the pages that drive them: Passenger/LiteSpeed, `ALTIS_RUNNER=off`).
 *   Every staff user gets it, so a job's page offers "Jalankan sekarang" only where driving it helps.
 */
export interface MeClient {
  realtime: 'sse' | 'polling';
  methodOverride: boolean;
  chunkBytes: number;
  probedAt: number | null;
  runner: 'worker' | 'external';
}

/**
 * `GET auth/me`, the SPA's first request after a page load (§4.8). `csrfToken` is the token of the session (or the
 * pre-session token of `altis_csrf`, D20) for the `X-CSRF-Token` of the next write; `build` is the release version.
 * `maintenance: true` (1c Task 19) while a maintenance flag is up, whoever asks: the admin's maintenance screen lifts
 * once it is gone (absent otherwise; a restore refuses `auth/me` altogether).
 *
 * Until the stage is `full`, `permissions` is `[]`, `branchPermissions` is `{}`, `superAdmin` is false and `banners` is
 * `[]`: a pre-2FA session learns nothing about the account's rights (M10). `reauthUntil` is when the last
 * re-authentication stops counting (epoch ms; null without one, §7.3). `client` (1c) comes with stage `full` only.
 */
export type MeResponse =
  | { authenticated: false; csrfToken: string; library: MeLibrary; build: string; maintenance?: true }
  | {
      authenticated: true;
      csrfToken: string;
      stage: SessionStage;
      mustChangePassword: boolean;
      user: MeUser;
      permissions: Permission[];
      branchPermissions: Record<string, Permission[]>;
      superAdmin: boolean;
      reauthUntil: number | null;
      library: MeLibrary;
      build: string;
      banners: Banner[];
      /** Stage `full` only (absent before it). */
      client?: MeClient;
      maintenance?: true;
    };

/**
 * `POST auth/password/change` (§7.1): the current password and the new one. The new one must pass the password policy
 * (`security.password_min_length`, the common-password list), checked on the server; neither is ever trimmed.
 */
export const PasswordChangeBody = z.strictObject({ current: passwordField, next: passwordField });

export type PasswordChangeBody = z.infer<typeof PasswordChangeBody>;

/**
 * `POST auth/password/forgot` (§7.1 "Reset sandi"): the address of the account. The answer is always 202
 * {@link PasswordForgotResponse}, whether or not an active account has that address (429 only from its buckets).
 */
export const PasswordForgotBody = z.strictObject({ email: emailField });

export type PasswordForgotBody = z.infer<typeof PasswordForgotBody>;

/** The answer of `POST auth/password/forgot`: the same for every address. */
export interface PasswordForgotResponse {
  accepted: true;
}

/**
 * `POST auth/password/reset`: the token of the mail's link (`/admin/reset-password#token=<token>`, 256 bits as 43
 * base64url characters) and the new password, which must pass the password policy. The reset creates no session.
 */
export const PasswordResetBody = z.strictObject({ token: z.string().min(43).max(43), password: passwordField });

export type PasswordResetBody = z.infer<typeof PasswordResetBody>;

/**
 * `PATCH auth/me` ("Profil saya", §13.5): the signed-in user's own name and language. A field left out keeps its
 * value; `locale: null` means the library's language. The answer is the updated {@link MeUser}.
 */
export const ProfilePatchBody = z.strictObject({
  name: personNameField.optional(),
  locale: localeField.nullable().optional(),
});

export type ProfilePatchBody = z.infer<typeof ProfilePatchBody>;

/**
 * One live session of the signed-in user (`GET auth/sessions`). `id` is the session's id (the SHA-256 of its token,
 * never the token), which `DELETE auth/sessions/:id` takes; `current` marks the session of the request; `remembered`
 * says whether it carries a remember-me token. Times are epoch ms.
 */
export interface SessionItem {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
  remembered: boolean;
}
