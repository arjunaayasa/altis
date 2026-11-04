import { runnerFor, type Actor } from '@altis/core';
import { connect } from '@altis/db';
import { isEnvSet, type Env } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import { loadConfig, updateConfig, validateBaseUrl, type Config } from '../config.js';
import type { BootContext } from '../index.js';
import { CliError } from './common.js';
import { notInstalled } from './migrate.js';

// `node app.js config:set <key> <value>` (spec §13.6): changes one setting of config.json that must be known before
// the database can be reached, without the UI (P2's port message points here).
//
//   baseUrl          validateBaseUrl (P13), written in canonical form                 INVALID_BASE_URL
//   trustProxy.hops  an integer from 0 to 10 (P15)                                    INVALID_CONFIG
//   allowedOrigins   comma-separated origins, each validated like baseUrl; empty: none INVALID_BASE_URL
//   update.feedUrl   an http(s) URL; empty: removed                                    INVALID_CONFIG
//   port             an integer from 1 to 65535; empty: removed (P2's default applies) INVALID_CONFIG
//
// Order: the key and the value are checked first (an unknown key is USAGE), so a refused change writes nothing; then
// updateConfig (ruling R58: the file read under config.lock, never the environment overrides); then the audit entry
// `system.config.update` (actor `cli`, `meta.fields`: the key, never the value) in a transaction of its own. The
// change is the operator's way out when the server cannot start, so an audit that fails does not undo it: for a
// failure with a code (a DomainError, or a driver or system error such as SQLite's file errors, which connect() leaves
// as they are) the command still exits 0 and prints a bilingual warning that the change is not in the audit log,
// worded by the code: DB_UNAVAILABLE says the database could not be reached; any other code names itself and points
// to `doctor`. Anything else (a TypeError: a bug) fails the command (INTERNAL), saying that config.json was changed. A running
// server picks the new file up through its config fence within seconds (D34; a changed port asks for a restart).
//
// A key that an environment variable overrides at run time (port: ALTIS_PORT, PORT; baseUrl: ALTIS_BASE_URL;
// trustProxy.hops: ALTIS_TRUST_PROXY_HOPS) is written all the same, with a bilingual note naming the variable: the
// server goes on using the variable's value. updateConfig parses the whole file first, so config:set cannot repair a
// config.json that is itself invalid (a port that is not a port included): that is fixed by editing the file.
//
// Nothing printed holds a value of config.json or of the environment: the key and the variable names only.

export const CONFIG_SET_KEYS = ['baseUrl', 'trustProxy.hops', 'allowedOrigins', 'update.feedUrl', 'port'] as const;

export type ConfigSetKey = (typeof CONFIG_SET_KEYS)[number];

export interface ConfigSetResult {
  key: ConfigSetKey;
  /** Whether `system.config.update` was written. */
  audited: boolean;
  /** Bilingual, when the audit could not be written (the change stays). */
  warning?: string;
  /** The environment variables that are set and override `key` at run time (absent when none is). */
  shadowedBy?: string[];
}

/** The environment variables that override a key of config.json at run time, in the order they win. */
const SHADOWS: Readonly<Record<ConfigSetKey, readonly string[]>> = {
  baseUrl: ['ALTIS_BASE_URL'],
  'trustProxy.hops': ['ALTIS_TRUST_PROXY_HOPS'],
  allowedOrigins: [],
  'update.feedUrl': ['ALTIS_UPDATE_FEED_URL'],
  port: ['ALTIS_PORT', 'PORT'],
};

/** The bilingual note for a key written while `variables` override it. */
export function shadowNote(key: ConfigSetKey, variables: readonly string[]): string {
  const names = variables.join(', ');
  return (
    `CATATAN: ${names} di lingkungan menimpa ${key}; server tetap memakai nilai lingkungan itu sampai variabelnya ` +
    `dihapus. / NOTE: ${names} in the environment overrides ${key}; the server keeps using the environment's value ` +
    'until the variable is removed.'
  );
}

/** Who the audit entry names: the CLI, with no staff id and no client IP. */
const CLI_AUDIT_ACTOR: Actor = { type: 'cli', id: null, ip: null };

const MAX_PROXY_HOPS = 10;

/** A change to the copy of config.json updateConfig hands over. */
type Change = (cfg: Config) => void;

function isConfigSetKey(key: string): key is ConfigSetKey {
  return (CONFIG_SET_KEYS as readonly string[]).includes(key);
}

function unknownKey(): CliError {
  return new CliError(
    'USAGE',
    `config:set: kunci tidak dikenal; salah satu dari / unknown key; one of ${CONFIG_SET_KEYS.join(', ')}`,
  );
}

function invalidValue(key: ConfigSetKey, id: string, en: string): DomainError {
  return new DomainError('INVALID_CONFIG', {
    detail: `nilai ${key} tidak valid: ${id} / the value of ${key} is invalid: ${en}`,
    meta: { key },
  });
}

/** `text` (trimmed) as an integer from `min` to `max`, or undefined. */
function integerIn(text: string, min: number, max: number): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : undefined;
}

/** Whether `value` is an http(s) URL without user information (what config.json's `update.feedUrl` accepts). */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol, username, password } = new URL(value);
    return (protocol === 'http:' || protocol === 'https:') && username === '' && password === '';
  } catch {
    return false;
  }
}

/** `origin` through validateBaseUrl, its error naming allowedOrigins. */
function originOf(origin: string): string {
  try {
    return validateBaseUrl(origin);
  } catch (error) {
    if (!isDomainError(error)) throw error;
    throw new DomainError('INVALID_BASE_URL', {
      detail: `allowedOrigins: ${error.detail ?? error.message}`,
      meta: { ...error.meta, key: 'allowedOrigins' },
    });
  }
}

/**
 * The change `config:set key value` makes, checked before anything is written.
 *
 * @throws CliError `USAGE` (unknown key); DomainError `INVALID_CONFIG` or `INVALID_BASE_URL` (the value)
 */
function configChange(key: string, value: string): { key: ConfigSetKey; change: Change } {
  if (!isConfigSetKey(key)) throw unknownKey();
  switch (key) {
    case 'baseUrl': {
      const baseUrl = validateBaseUrl(value);
      return {
        key,
        change: (cfg) => {
          cfg.baseUrl = baseUrl;
        },
      };
    }
    case 'trustProxy.hops': {
      const hops = integerIn(value, 0, MAX_PROXY_HOPS);
      if (hops === undefined) {
        throw invalidValue(key, `harus bilangan bulat 0-${MAX_PROXY_HOPS}`, `must be an integer from 0 to ${MAX_PROXY_HOPS}`);
      }
      return {
        key,
        change: (cfg) => {
          cfg.trustProxy = { hops };
        },
      };
    }
    case 'allowedOrigins': {
      const origins = [
        ...new Set(
          value
            .split(',')
            .map((origin) => origin.trim())
            .filter((origin) => origin !== '')
            .map(originOf),
        ),
      ];
      return {
        key,
        change: (cfg) => {
          cfg.allowedOrigins = origins;
        },
      };
    }
    case 'update.feedUrl': {
      const feedUrl = value.trim();
      if (feedUrl === '') {
        return {
          key,
          change: (cfg) => {
            if (cfg.update === undefined) return;
            delete cfg.update.feedUrl;
            if (Object.keys(cfg.update).length === 0) delete cfg.update;
          },
        };
      }
      if (!isHttpUrl(feedUrl)) throw invalidValue(key, 'harus URL http(s)', 'must be an http(s) URL');
      return {
        key,
        change: (cfg) => {
          cfg.update = { ...cfg.update, feedUrl };
        },
      };
    }
    case 'port': {
      if (value.trim() === '') {
        return {
          key,
          change: (cfg) => {
            delete cfg.port;
          },
        };
      }
      const port = integerIn(value, 1, 65535);
      if (port === undefined) throw invalidValue(key, 'harus bilangan bulat 1-65535', 'must be an integer from 1 to 65535');
      return {
        key,
        change: (cfg) => {
          cfg.port = port;
        },
      };
    }
  }
}

/** Writes `system.config.update` by the CLI, through the database config.json (with the overrides) names. */
async function auditChange(ctx: BootContext, env: Env, key: ConfigSetKey): Promise<void> {
  const config = await loadConfig(ctx.dataDir, env);
  if (config === null) throw notInstalled();
  const h = await connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
  try {
    await runnerFor(h, Date.now(), CLI_AUDIT_ACTOR)((tx) =>
      tx.audit({ action: 'system.config.update', entity: null, entityId: null, meta: { fields: [key] } }),
    );
  } finally {
    await h.close();
  }
}

/**
 * The code an audit failure is reported with: a DomainError's, or a driver's or the system's (`ERR_SQLITE_ERROR`,
 * `EACCES`); undefined for anything else, a programming error (TypeError, RangeError, ReferenceError, SyntaxError)
 * included.
 */
function failureCode(error: unknown): string | undefined {
  if (isDomainError(error)) return error.code;
  if (!(error instanceof Error) || error instanceof TypeError || error instanceof RangeError) return undefined;
  if (error instanceof ReferenceError || error instanceof SyntaxError) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : undefined;
}

/** The warning of an audit that failed with `code` (the change stays). */
export function auditWarning(code: string): string {
  if (code === 'DB_UNAVAILABLE') {
    return (
      `PERINGATAN: config.json sudah diubah, tetapi perubahan ini tidak tercatat di log audit karena database tidak dapat ` +
      `dihubungi atau ditulis (${code}) / WARNING: config.json was changed, but the change is not in the audit log because ` +
      `the database could not be reached or written (${code})`
    );
  }
  return (
    `PERINGATAN: config.json sudah diubah, tetapi pencatatan audit gagal (${code}), jadi perubahan ini tidak ada di log ` +
    `audit; periksa dengan node app.js doctor / WARNING: config.json was changed, but writing the audit entry failed ` +
    `(${code}), so the change is not in the audit log; check with node app.js doctor`
  );
}

/**
 * Runs `config:set <key> <value>` (see the top of this file).
 *
 * @returns what was set, whether it was audited (an audit that failed with a code is a warning, not a failure: the
 *   file changed), and the environment variables that override the key
 * @throws CliError `USAGE` (unknown key), `INTERNAL` (the file changed, then the audit failed with an error without a
 *   code: a bug); DomainError `INVALID_CONFIG`, `INVALID_BASE_URL` (nothing written), `NOT_INSTALLED` (no
 *   config.json), `STATE_CORRUPT` (config.json unusable or locked)
 */
export async function configSet(ctx: BootContext, env: Env, key: string, value: string): Promise<ConfigSetResult> {
  const planned = configChange(key, value);
  await updateConfig(ctx.dataDir, (cfg) => planned.change(cfg));
  const shadowedBy = SHADOWS[planned.key].filter((name) => isEnvSet(env, name));
  const shadow = shadowedBy.length > 0 ? { shadowedBy } : {};
  try {
    await auditChange(ctx, env, planned.key);
    return { key: planned.key, audited: true, ...shadow };
  } catch (error) {
    const code = failureCode(error);
    if (code !== undefined) return { key: planned.key, audited: false, warning: auditWarning(code), ...shadow };
    const name = error instanceof Error ? error.name : typeof error;
    throw new CliError(
      'INTERNAL',
      `config.json sudah diubah (${planned.key}), tetapi pencatatan audit gagal karena galat tak terduga (${name}); ` +
        `periksa dengan node app.js doctor / config.json was changed (${planned.key}), but writing the audit entry ` +
        `failed with an unexpected error (${name}); check with node app.js doctor`,
    );
  }
}
