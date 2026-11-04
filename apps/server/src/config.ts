import { createPrivateKey } from 'node:crypto';
import { decodeBase64Url, rawPublicKey } from '@altis/crypto';
import { DIALECTS, type DbConfig } from '@altis/db';
import { RUNTIMES, atomicWriteJson, dataPath, ensureDir, isEnvSet, readJsonWithBak, withFileLock, type Env } from '@altis/platform';
import { DomainError, isUlid } from '@altis/shared';
import { z } from 'zod';

// `DATA_DIR/config.json` (spec §7.6): the keyring, the secrets, the install identity and the settings that
// must be known before the database can be reached. Mode 600; every write is atomic (§9.3) and, as several
// writers exist (the install wizard, the CLI, upgrades), serialised on `DATA_DIR/config.lock` (ruling R47).
//
// Reading: `readJsonWithBak` (a truncated file falls back to `config.json.bak`), then the schema below, then the
// environment overrides, then the schema again. A file that parses but is invalid is NOT replaced by the .bak: the
// operator edited it and must be told what is wrong. Errors carry the paths of the offending fields and never their
// values (the file holds secrets).
//
// Forward compatible (decision D1d-2): a later release may add keys at any level of config.json, and this release
// must still load the file, so that a revert or a fall back to `previous` works. Known keys are validated exactly as
// before and `version: 1` stays the gate for an incompatible change; an unknown key is accepted, named (parseConfig's
// `unknownKeys`, doctor) and never reaches the code: the schema's objects strip it from the value they return. Every
// rewrite (updateConfig) puts the file's unknown keys back unchanged, so an older release never drops a newer
// release's keys. A config this release's code builds (writeConfig, what an updateConfig mutate returns) is held to
// the known keys: an unknown key there is a bug and stays INVALID_CONFIG.

export const INSTALL_STATES = ['complete', 'migrate', 'profile', 'admin', 'cron'] as const;
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** More than this many proxies in front of the server is a misconfiguration, not a topology. */
const MAX_PROXY_HOPS = 10;
const KEY_BYTES = 32;

const CONFIG_FILE = 'config.json';
const CONFIG_LOCK = 'config.lock';

// ---------------------------------------------------------------------------------------------------------------
// baseUrl (spec P13)

const BASE_URL_SHAPE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i;

/** Whitespace of any kind and control characters: `new URL` would silently strip some of them. */
function hasForbiddenCharacter(text: string): boolean {
  if (/\s/.test(text)) return true;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function invalidBaseUrl(reason: string, why: string): DomainError {
  return new DomainError('INVALID_BASE_URL', {
    detail:
      `baseUrl harus berbentuk http(s)://host[:port] tanpa path, query, atau fragmen: ${why} / ` +
      `baseUrl must look like http(s)://host[:port] with no path, query or fragment: ${why}`,
    meta: { reason },
  });
}

/**
 * Checks the `baseUrl` (spec P13: the root of a domain or subdomain; its scheme decides `Secure`, `__Host-` and
 * HSTS, never a header) and returns it in canonical form: `scheme://host[:port]`, no trailing slash, scheme and host
 * in lower case, the scheme's default port dropped. A Unicode host comes back in punycode (`bücher.example` →
 * `xn--bcher-kva.example`), as the WHATWG URL parser does it.
 *
 * `http` is allowed (a LAN or single-PC install). A path other than `/`, a query, a fragment, user information and
 * a port of 0 are refused. Surrounding whitespace is trimmed. The error never repeats the value (it may carry
 * credentials), only `meta.reason`: `empty`, `invalid_characters`, `not_a_url`, `scheme`, `userinfo`, `path`,
 * `query`, `fragment`, `invalid_host` or `port`.
 *
 * @throws DomainError `INVALID_BASE_URL`
 */
export function validateBaseUrl(input: string): string {
  if (typeof input !== 'string') throw invalidBaseUrl('not_a_string', 'bukan teks / not text');
  const text = input.trim();
  if (text === '') throw invalidBaseUrl('empty', 'kosong / empty');
  if (hasForbiddenCharacter(text)) {
    throw invalidBaseUrl('invalid_characters', 'berisi spasi atau karakter kontrol / contains whitespace or control characters');
  }
  const shape = BASE_URL_SHAPE.exec(text);
  if (shape === null) throw invalidBaseUrl('not_a_url', 'bukan URL / not a URL');
  const scheme = shape[1]!.toLowerCase();
  const authority = shape[2]!;
  const rest = shape[3]!;
  if (scheme !== 'http' && scheme !== 'https') {
    throw invalidBaseUrl('scheme', 'hanya http atau https / only http or https');
  }
  if (authority.includes('@')) throw invalidBaseUrl('userinfo', 'tanpa user:sandi / no user:password');
  const pathPart = rest.split(/[?#]/, 1)[0]!;
  if (pathPart !== '' && pathPart !== '/') throw invalidBaseUrl('path', 'path ditolak / a path is not allowed');
  if (rest.includes('?')) throw invalidBaseUrl('query', 'query ditolak / a query is not allowed');
  if (rest.includes('#')) throw invalidBaseUrl('fragment', 'fragmen ditolak / a fragment is not allowed');

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalidBaseUrl('invalid_host', 'host atau port tidak valid / invalid host or port');
  }
  // The parser reads a backslash as a slash (`https://x\perpus`), which the checks on the raw text cannot see.
  if (url.pathname !== '/') throw invalidBaseUrl('path', 'path ditolak / a path is not allowed');
  if (url.username !== '' || url.password !== '') throw invalidBaseUrl('userinfo', 'tanpa user:sandi / no user:password');
  if (url.port === '0') throw invalidBaseUrl('port', 'port 0 tidak valid / port 0 is not valid');
  return url.origin;
}

/** Whether `value` is something `validateBaseUrl` accepts; an origin has exactly the shape of a baseUrl. */
function isBaseUrl(value: string): boolean {
  try {
    validateBaseUrl(value);
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol, username, password } = new URL(value);
    return (protocol === 'http:' || protocol === 'https:') && username === '' && password === '';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Schema
//
// Every object is `z.object`: an unknown key is no error, and is left out of the value the schema returns (D1d-2,
// see the top of this file). `unknownKeysOf` and `withUnknownKeysOf` below walk the same schema.

/** `YYYY-MM-DD`, and a day that exists (2026-02-30 does not). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Unpadded base64url of exactly 32 bytes (a session key, a cron token, a keyring key). */
const key32 = z.string().refine((value) => decodeBase64Url(value)?.length === KEY_BYTES, {
  message: 'harus 32 byte base64url tanpa padding / must be 32 bytes of unpadded base64url',
});

const port = z.number().int().min(1).max(65535);

/** `config.json`'s `db`: what `connect()` of @altis/db takes. */
const DbSchema = z.object({
  dialect: z.enum(DIALECTS),
  host: z.string().optional(),
  port: port.optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  database: z.string().optional(),
  file: z.string().optional(),
}) satisfies z.ZodType<DbConfig>;

const KeyringEntrySchema = z.object({
  // Becomes the `<kid>` of `v1:<kid>:<iv>:<ct>`, so no colon.
  kid: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
  key: key32,
  active: z.boolean(),
});

const InstallSchema = z
  .object({
    id: z.string().refine(isUlid, { message: 'harus ULID / must be a ULID' }),
    /** Ed25519, raw 32 bytes as base64url (the form of packages/crypto). */
    publicKey: z.string().refine((value) => decodeBase64Url(value)?.length === KEY_BYTES, {
      message: 'harus 32 byte base64url / must be 32 bytes of base64url',
    }),
    /** Ed25519, PKCS#8 DER as base64 (the form of the `{kid, use, pkcs8}` key files of tools/keys). */
    privateKey: z.string().min(1),
    /** The install date (`YYYY-MM-DD`, the library's time zone): the dashboard's backup_missing alert counts from it. */
    trialStartedAt: z.string().refine(isCalendarDate, { message: 'harus tanggal YYYY-MM-DD / must be a YYYY-MM-DD date' }),
    /**
     * The runtime the install decided its runtime-dependent settings for (ruling R66: P20 SQLite, P15 proxy hops):
     * --runtime, the input's `runtime`, or what the installing shell detected. Absent in a config written before it
     * was recorded. start() checks SQLite against the runtime it actually runs under, and warns when they differ.
     */
    runtime: z.enum(RUNTIMES).optional(),
  })
  .superRefine((install, ctx) => {
    let derived: string | undefined;
    try {
      const key = createPrivateKey({ key: Buffer.from(install.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
      if (key.asymmetricKeyType === 'ed25519') derived = rawPublicKey(key);
    } catch {
      // reported below
    }
    if (derived === undefined) {
      ctx.addIssue({ code: 'custom', path: ['privateKey'], message: 'bukan kunci privat Ed25519 PKCS#8 / not an Ed25519 PKCS#8 private key' });
    } else if (derived !== install.publicKey) {
      ctx.addIssue({ code: 'custom', path: ['publicKey'], message: 'bukan pasangan kunci privat / does not belong to the private key' });
    }
  });

export const ConfigSchema = z.object({
  /** The gate for an incompatible change: a release refuses any other version (D1d-2). */
  version: z.literal(1),
  port: port.optional(),
  /** Canonical form is applied by `loadConfig` and `writeConfig` (see {@link validateBaseUrl}). */
  baseUrl: z.string().refine(isBaseUrl, { message: 'baseUrl tidak valid / invalid baseUrl' }),
  trustProxy: z.object({ hops: z.number().int().min(0).max(MAX_PROXY_HOPS) }),
  allowedOrigins: z.array(z.string().refine(isBaseUrl, { message: 'bukan origin http(s) / not an http(s) origin' })),
  db: DbSchema,
  secrets: z.object({ sessionKey: key32, cronToken: key32 }),
  keyring: z.array(KeyringEntrySchema).superRefine((keyring, ctx) => {
    if (keyring.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'keyring tidak boleh kosong / the keyring must not be empty' });
      return;
    }
    if (keyring.filter((entry) => entry.active).length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'tepat satu kunci harus aktif / exactly one key must be active' });
    }
    if (new Set(keyring.map((entry) => entry.kid)).size !== keyring.length) {
      ctx.addIssue({ code: 'custom', message: 'kid harus unik / kids must be unique' });
    }
  }),
  install: InstallSchema,
  installState: z.enum(INSTALL_STATES),
  update: z.object({ feedUrl: z.string().refine(isHttpUrl, { message: 'bukan URL http(s) / not an http(s) URL' }).optional() }).optional(),
  log: z.object({ level: z.enum(LOG_LEVELS) }),
});

export type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Unknown keys (D1d-2)

/**
 * Lists whose entries are matched by a key of their own, not by position, when the unknown keys of the file are put
 * back: a rotation rebuilds the keyring (secrets:rotate), and an entry's unknown keys follow its `kid`.
 */
const ENTRY_IDENTITY = new Map<z.ZodType, string>([[KeyringEntrySchema, 'kid']]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `schema` without its `.optional()` wrappers. */
function unwrapped(schema: z.ZodType): z.ZodType {
  let inner = schema;
  while (inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodType;
  return inner;
}

/** The schema of `key` in `shape`, never one inherited from Object.prototype (`toString`, `constructor`, `__proto__`). */
function knownKey(shape: Readonly<Record<string, z.ZodType>>, key: string): z.ZodType | undefined {
  return Object.hasOwn(shape, key) ? shape[key] : undefined;
}

/** Sets `key` as an own, enumerable property, `__proto__` included (an assignment would set the prototype instead). */
function defineKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Collects the dotted paths of the keys of `value` that `schema` does not know, at every level. */
function collectUnknownKeys(schema: z.ZodType, value: unknown, at: string, out: string[]): void {
  const inner = unwrapped(schema);
  if (inner instanceof z.ZodObject && isPlainObject(value)) {
    const shape = inner.shape as Record<string, z.ZodType>;
    for (const key of Object.keys(value)) {
      const path = at === '' ? key : `${at}.${key}`;
      const known = knownKey(shape, key);
      if (known === undefined) out.push(path);
      else collectUnknownKeys(known, value[key], path, out);
    }
  } else if (inner instanceof z.ZodArray && Array.isArray(value)) {
    const element = inner.element as z.ZodType;
    value.forEach((item, index) => collectUnknownKeys(element, item, at === '' ? String(index) : `${at}.${index}`, out));
  }
}

/** The dotted paths of the keys of `raw` that config.json's schema does not know, sorted (`keyring.0.x` for a list entry). */
function unknownKeysOf(raw: unknown): string[] {
  const out: string[] = [];
  collectUnknownKeys(ConfigSchema, raw, '', out);
  return out.sort();
}

/**
 * What `raw` holds under keys the schema does not know, with the known objects on the way that hold some (and nothing
 * else): what is left of an object `next` no longer has. Undefined when that is nothing, or when `schema` would not
 * accept it (an object with a required known key cannot stand on its unknown keys alone).
 */
function unknownPartOf(schema: z.ZodType, raw: unknown): Record<string, unknown> | undefined {
  const inner = unwrapped(schema);
  if (!(inner instanceof z.ZodObject) || !isPlainObject(raw)) return undefined;
  const shape = inner.shape as Record<string, z.ZodType>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    const known = knownKey(shape, key);
    const kept = known === undefined ? raw[key] : unknownPartOf(known, raw[key]);
    if (kept !== undefined) defineKey(out, key, kept);
  }
  return Object.keys(out).length > 0 && inner.safeParse(out).success ? out : undefined;
}

/** The entry of `raw` that `entry` of the new list continues: the one with the same identity key, else the same position. */
function counterpartOf(element: z.ZodType, raw: readonly unknown[], entry: unknown, index: number): unknown {
  const identity = ENTRY_IDENTITY.get(element);
  if (identity === undefined) return raw[index];
  const id = isPlainObject(entry) ? entry[identity] : undefined;
  return id === undefined ? undefined : raw.find((candidate) => isPlainObject(candidate) && candidate[identity] === id);
}

/**
 * `next` (known keys only, as the schema returns them) with every unknown key of `raw` (the file) put back where it
 * was, its value unchanged. Known keys come first, in the schema's order, then the unknown ones. An object `next`
 * dropped keeps its unknown keys when the object is valid with them alone (`config:set update.feedUrl ''` removes an
 * `update` left empty, and a newer release's `update.channel` stays); a list entry `next` dropped takes its unknown
 * keys with it.
 */
function withUnknownKeysOf(schema: z.ZodType, next: unknown, raw: unknown): unknown {
  const inner = unwrapped(schema);
  if (inner instanceof z.ZodObject && isPlainObject(next) && isPlainObject(raw)) {
    const shape = inner.shape as Record<string, z.ZodType>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(next)) {
      const known = knownKey(shape, key);
      defineKey(out, key, known === undefined ? next[key] : withUnknownKeysOf(known, next[key], raw[key]));
    }
    for (const key of Object.keys(raw)) {
      const known = knownKey(shape, key);
      if (known === undefined) {
        defineKey(out, key, raw[key]);
      } else if (next[key] === undefined) {
        // removed (or set to undefined, which JSON drops) by mutate
        const kept = unknownPartOf(known, raw[key]);
        if (kept !== undefined) defineKey(out, key, kept);
      }
    }
    return out;
  }
  if (inner instanceof z.ZodArray && Array.isArray(next) && Array.isArray(raw)) {
    const element = inner.element as z.ZodType;
    return next.map((entry, index) => withUnknownKeysOf(element, entry, counterpartOf(element, raw, entry, index)));
  }
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Validation errors

interface ConfigIssue {
  path: string;
  code: string;
  message?: string;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(root)' : path.map(String).join('.');
}

/** The issues of a failed parse, as `INVALID_CONFIG` lists them: paths and codes, plus the text of our own checks. */
function issuesOf(error: z.ZodError): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) issues.push({ path: formatPath([...issue.path, key]), code: issue.code });
    } else if (issue.code === 'custom') {
      issues.push({ path: formatPath(issue.path), code: issue.code, message: issue.message });
    } else {
      issues.push({ path: formatPath(issue.path), code: issue.code });
    }
  }
  return issues;
}

/** `INVALID_CONFIG` listing where the problems are, never what was found there. */
function invalidConfig(issues: readonly ConfigIssue[]): DomainError {
  const where = [...new Set(issues.map((issue) => issue.path))];
  const shown = where.slice(0, 10).join(', ') + (where.length > 10 ? ', …' : '');
  return new DomainError('INVALID_CONFIG', {
    detail: `config.json tidak valid pada: ${shown} / config.json is invalid at: ${shown}`,
    meta: { issues },
  });
}

function invalidEnv(name: string, expected: string): DomainError {
  return new DomainError('INVALID_CONFIG', {
    detail: `${name} tidak valid: ${expected} / ${name} is invalid: ${expected}`,
    meta: { env: name },
  });
}

/**
 * Validates `raw` against the schema: the config (known keys only) with its URLs in canonical form, and the unknown
 * keys of `raw`. With `knownOnly` (a config this release's code built) an unknown key is refused as well.
 */
function validated(raw: unknown, o: { knownOnly: boolean }): { config: Config; unknownKeys: string[] } {
  const result = ConfigSchema.safeParse(raw);
  const unknownKeys = unknownKeysOf(raw);
  const refused: ConfigIssue[] = o.knownOnly ? unknownKeys.map((path) => ({ path, code: 'unrecognized_keys' })) : [];
  if (!result.success) {
    const baseUrl = isPlainObject(raw) ? raw['baseUrl'] : undefined;
    if (typeof baseUrl === 'string' && result.error.issues.some((issue) => issue.path[0] === 'baseUrl')) {
      validateBaseUrl(baseUrl); // throws INVALID_BASE_URL with the reason
    }
    throw invalidConfig([...issuesOf(result.error), ...refused]);
  }
  if (refused.length > 0) throw invalidConfig(refused);
  const config = result.data;
  return {
    config: { ...config, baseUrl: validateBaseUrl(config.baseUrl), allowedOrigins: config.allowedOrigins.map(validateBaseUrl) },
    unknownKeys,
  };
}

/**
 * Validates the content of a config.json (decision D1d-2): known keys exactly as the schema says, unknown keys at any
 * level accepted. Returns the config, with its URLs in canonical form and without the unknown keys, and the dotted
 * paths of those keys, sorted (`futureKey`, `update.channelX`, `keyring.0.createdAt`).
 *
 * @throws DomainError `INVALID_BASE_URL` for a `baseUrl` that does not pass {@link validateBaseUrl} (it is the more
 *   specific error); `INVALID_CONFIG` for anything else (`meta.issues` names the paths, never a value)
 */
export function parseConfig(raw: unknown): { config: Config; unknownKeys: string[] } {
  return validated(raw, { knownOnly: false });
}

/** A config this release's code built (writeConfig, an updateConfig mutate, the overrides applied): known keys only. */
function parseBuilt(cfg: unknown): Config {
  return validated(cfg, { knownOnly: true }).config;
}

// ---------------------------------------------------------------------------------------------------------------
// Environment overrides

function integerFrom(name: string, text: string, min: number, max: number): number {
  const value = /^\d{1,6}$/.test(text) ? Number(text) : Number.NaN;
  if (!(value >= min && value <= max)) throw invalidEnv(name, `harus bilangan bulat ${min}-${max} / must be an integer from ${min} to ${max}`);
  return value;
}

const FEED_URL_ENV = 'ALTIS_UPDATE_FEED_URL';

/**
 * `ALTIS_UPDATE_FEED_URL` (spec §9.6), trimmed: an http(s) URL without user information, as config.json's
 * `update.feedUrl`, and without whitespace or control characters inside. Undefined when the variable is not set.
 *
 * @throws DomainError `INVALID_CONFIG` with `meta.env`, never the value
 */
function envFeedUrl(env: Env): string | undefined {
  if (!isEnvSet(env, FEED_URL_ENV)) return undefined;
  const text = env[FEED_URL_ENV]!.trim();
  if (hasForbiddenCharacter(text) || !isHttpUrl(text)) {
    throw invalidEnv(FEED_URL_ENV, 'harus URL http(s) tanpa user:sandi / must be an http(s) URL without user:password');
  }
  return text;
}

/**
 * Applies the environment overrides (`ALTIS_BASE_URL`, `ALTIS_DB_DIALECT`, `ALTIS_DB_HOST`, `ALTIS_DB_PORT`,
 * `ALTIS_DB_USER`, `ALTIS_DB_PASSWORD`, `ALTIS_DB_NAME`, `ALTIS_TRUST_PROXY_HOPS`, `ALTIS_LOG_LEVEL`,
 * `ALTIS_UPDATE_FEED_URL`) to a copy of `config`. A blank variable counts as not set. A bad value is an error that
 * names the variable and never shows the value.
 */
function withEnvOverrides(config: Config, env: Env): Config {
  const next = structuredClone(config);
  const text = (name: string): string | undefined => (isEnvSet(env, name) ? env[name]! : undefined);

  const baseUrl = text('ALTIS_BASE_URL');
  if (baseUrl !== undefined) {
    try {
      next.baseUrl = validateBaseUrl(baseUrl);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      throw new DomainError('INVALID_BASE_URL', {
        detail: `ALTIS_BASE_URL: ${error.detail ?? error.message}`,
        meta: { ...error.meta, env: 'ALTIS_BASE_URL' },
      });
    }
  }
  const dialect = text('ALTIS_DB_DIALECT');
  if (dialect !== undefined) {
    const wanted = dialect.trim().toLowerCase();
    const known = DIALECTS.find((candidate) => candidate === wanted);
    if (known === undefined) throw invalidEnv('ALTIS_DB_DIALECT', `salah satu dari / one of ${DIALECTS.join(', ')}`);
    next.db.dialect = known;
  }
  const host = text('ALTIS_DB_HOST');
  if (host !== undefined) next.db.host = host.trim();
  const dbPort = text('ALTIS_DB_PORT');
  if (dbPort !== undefined) next.db.port = integerFrom('ALTIS_DB_PORT', dbPort.trim(), 1, 65535);
  const user = text('ALTIS_DB_USER');
  if (user !== undefined) next.db.user = user;
  const password = text('ALTIS_DB_PASSWORD');
  if (password !== undefined) next.db.password = password;
  const database = text('ALTIS_DB_NAME');
  if (database !== undefined) next.db.database = database;
  const hops = text('ALTIS_TRUST_PROXY_HOPS');
  if (hops !== undefined) next.trustProxy.hops = integerFrom('ALTIS_TRUST_PROXY_HOPS', hops.trim(), 0, MAX_PROXY_HOPS);
  const level = text('ALTIS_LOG_LEVEL');
  if (level !== undefined) {
    const wanted = level.trim().toLowerCase();
    const known = LOG_LEVELS.find((candidate) => candidate === wanted);
    if (known === undefined) throw invalidEnv('ALTIS_LOG_LEVEL', `salah satu dari / one of ${LOG_LEVELS.join(', ')}`);
    next.log.level = known;
  }
  const feedUrl = envFeedUrl(env);
  if (feedUrl !== undefined) next.update = { ...next.update, feedUrl };
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Feed URL sources (spec §9.6: "URL feed tertanam saat build, bisa ditimpa `update.feedUrl` / `ALTIS_UPDATE_FEED_URL`")

/** Where the feed base comes from: `ALTIS_UPDATE_FEED_URL`, config.json's `update.feedUrl`, or the build. */
export type FeedSource = 'env' | 'config' | 'build';

/**
 * The feed base the release build embedded (`__FEED_URL__`); null for the `''` an unconfigured build embeds, and for
 * a server.mjs the release build did not bundle (no define).
 */
function buildFeedUrl(): string | null {
  const embedded = typeof __FEED_URL__ === 'string' ? __FEED_URL__ : '';
  return embedded === '' ? null : embedded;
}

function feedOf(config: Config, env: Env): { base: string; source: FeedSource } | null {
  const fromEnv = envFeedUrl(env);
  if (fromEnv !== undefined) return { base: fromEnv, source: 'env' };
  const fromConfig = config.update?.feedUrl;
  if (fromConfig !== undefined) return { base: fromConfig, source: 'config' };
  const fromBuild = buildFeedUrl();
  return fromBuild === null ? null : { base: fromBuild, source: 'build' };
}

/**
 * The base URL of the update feed (`<feedBase>/<channel>/feed.json`, spec §9.6): `ALTIS_UPDATE_FEED_URL`, else
 * `config.update.feedUrl`, else the build's embedded `__FEED_URL__`, else null (no feed: nothing to check). `config`
 * may be the file's or what {@link loadConfig} returned (the variable already applied); the variable wins either way.
 *
 * @throws DomainError `INVALID_CONFIG` with `meta.env` for an `ALTIS_UPDATE_FEED_URL` that is not an http(s) URL
 */
export function feedBaseOf(config: Config, env: Env): string | null {
  return feedOf(config, env)?.base ?? null;
}

/**
 * Which source {@link feedBaseOf} takes the feed base from, or null when there is none. doctor names it (preflight
 * M11): Konfigurasi Sistem has no feed field.
 *
 * @throws as {@link feedBaseOf}
 */
export function feedSourceOf(config: Config, env: Env): FeedSource | null {
  return feedOf(config, env)?.source ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Load and write

function requireObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('config.json is not an object');
  return raw as Record<string, unknown>;
}

/**
 * Reads `DATA_DIR/config.json`, with the environment overrides applied on top.
 *
 * Returns `null` when there is no config (not installed yet; the environment alone does not make one). A damaged
 * file is replaced by `config.json.bak` when that is intact. The result is validated twice, as it was written
 * and with the overrides, so that a bad variable is reported as such. Keys of the file this release does not know
 * are not in the result (D1d-2; {@link inspectConfig} names them).
 *
 * The result is for USE (connect to the database, listen, log), never for writing: it holds the environment
 * overrides (`ALTIS_DB_PASSWORD` and the others), so passing it, or a copy of it, to `writeConfig` would persist
 * them in `config.json`. To change the config use {@link updateConfig} (ruling R58), which reads the file itself.
 *
 * @throws DomainError `STATE_CORRUPT` when the file and its `.bak` are both unusable; `INVALID_CONFIG` (`meta.issues`
 *   lists the field paths, `meta.env` the variable) or `INVALID_BASE_URL` when the content is not valid
 */
export async function loadConfig(dataDir: string, env: Env): Promise<Config | null> {
  return (await inspectConfig(dataDir, env))?.config ?? null;
}

/**
 * {@link loadConfig}, plus the keys of the file this release does not know (dotted paths, sorted; see
 * {@link parseConfig}): doctor names them, as they may be a typo in a hand edit.
 *
 * @throws as {@link loadConfig}
 */
export async function inspectConfig(dataDir: string, env: Env): Promise<{ config: Config; unknownKeys: string[] } | null> {
  const raw = await readJsonWithBak(dataPath(dataDir, 'root', CONFIG_FILE), requireObject);
  if (raw === null) return null;
  const file = parseConfig(raw);
  return { config: parseBuilt(withEnvOverrides(file.config, env)), unknownKeys: file.unknownKeys };
}

/**
 * `cfg` with the environment overrides applied, validated: exactly what {@link loadConfig} will return once `cfg` is
 * the content of config.json. The installer connects with it before anything is written, so that it prepares the
 * database the server will use. For USE only, never for writing (it holds the overrides; ruling R58).
 *
 * @throws DomainError `INVALID_CONFIG` or `INVALID_BASE_URL`, as {@link loadConfig}; `INVALID_CONFIG` for a key of
 *   `cfg` the schema does not know (this release's code built it)
 */
export function applyEnvOverrides(cfg: Config, env: Env): Config {
  return parseBuilt(withEnvOverrides(parseBuilt(cfg), env));
}

/** Writes `content` (validated) as `config.json`; the caller holds `config.lock`. */
async function writeLocked(dataDir: string, content: unknown): Promise<void> {
  await atomicWriteJson(dataPath(dataDir, 'root', CONFIG_FILE), content, { mode: 0o600 });
}

/**
 * Writes `DATA_DIR/config.json` for the first time (the installer): atomically, keeping the previous copy as
 * `.bak`, mode 600 (the mode does not apply on Windows), under `withFileLock` on `DATA_DIR/config.lock`, so that
 * the install wizard, the CLI and an upgrade never write at once. DATA_DIR is created when missing. `cfg` is
 * validated first and an invalid one is refused, leaving the file as it is; URLs are written in canonical form.
 *
 * This is for the initial write only. Never pass it what {@link loadConfig} returned (that carries the
 * environment overrides), and do not use it to change an existing config: {@link updateConfig} reads the file
 * under the lock, so no concurrent change is lost and no override is persisted.
 *
 * @throws DomainError `INVALID_CONFIG` or `INVALID_BASE_URL` for an invalid `cfg` (a key the schema does not know
 *   included: this release's code built it); `STATE_CORRUPT` when the lock cannot be taken
 */
export async function writeConfig(dataDir: string, cfg: Config): Promise<void> {
  const config = parseBuilt(cfg);
  await ensureDir(dataPath(dataDir, 'root'));
  await withFileLock(dataPath(dataDir, 'root', CONFIG_LOCK), () => writeLocked(dataDir, config));
}

/**
 * Changes the existing `DATA_DIR/config.json` (ruling R58): under `withFileLock` on `config.lock` it reads the
 * FILE (`readJsonWithBak` and the schema, with no environment override), calls `mutate` with a copy, validates what
 * comes out and writes it atomically (mode 600, previous copy kept as `.bak`). Because the read happens inside the
 * lock, two callers, in one process or in several, never lose each other's change; and because the environment is
 * not consulted, `ALTIS_DB_PASSWORD` and the other overrides can never end up in the file.
 *
 * Keys of the file this release does not know (a newer release wrote them, D1d-2) are not in the copy `mutate` gets,
 * and are written back unchanged, wherever `mutate` left the object that held them (see withUnknownKeysOf): an older
 * release rewriting config.json never drops a newer release's keys.
 *
 * `mutate` changes the copy it is given in place, or returns a replacement. It is synchronous and runs while the
 * lock is held, so it must be quick and must not call `writeConfig` or `updateConfig` (the lock is not
 * re-entrant). An error it throws is passed on and nothing is written. A key it adds that the schema does not know
 * is refused (`INVALID_CONFIG`).
 *
 * @returns the config that was written (the file's content without its unknown keys, not the overrides)
 * @throws DomainError `NOT_INSTALLED` when there is no config; `STATE_CORRUPT` when the file and its `.bak` are
 *   unusable or the lock cannot be taken; `INVALID_CONFIG` or `INVALID_BASE_URL` when the file or the result is
 *   not valid
 */
export async function updateConfig(dataDir: string, mutate: (cfg: Config) => Config | void): Promise<Config> {
  return (await changeConfig(dataDir, mutate, { always: true })).config;
}

/**
 * {@link updateConfig}, except that nothing is written when what `mutate` leaves is the file's content already (both
 * validated, so a URL in another but equal form is no change; compared under the lock). config.json.bak then keeps
 * the real previous copy, and the file's mtime, which the config fence of every process watches, stays as it was.
 *
 * @returns the config the file holds now, and whether this call wrote it
 * @throws as {@link updateConfig}
 */
export async function updateConfigIfChanged(
  dataDir: string,
  mutate: (cfg: Config) => Config | void,
): Promise<{ config: Config; changed: boolean }> {
  return changeConfig(dataDir, mutate, { always: false });
}

/** updateConfig (`always`: write even an unchanged result) and updateConfigIfChanged. */
async function changeConfig(
  dataDir: string,
  mutate: (cfg: Config) => Config | void,
  o: { always: boolean },
): Promise<{ config: Config; changed: boolean }> {
  await ensureDir(dataPath(dataDir, 'root'));
  return withFileLock(dataPath(dataDir, 'root', CONFIG_LOCK), async () => {
    const raw = await readJsonWithBak(dataPath(dataDir, 'root', CONFIG_FILE), requireObject);
    if (raw === null) {
      throw new DomainError('NOT_INSTALLED', {
        detail: 'config.json belum ada; pasang ALTIS lebih dulu / config.json does not exist; install ALTIS first',
      });
    }
    const current = parseConfig(raw).config;
    const draft = structuredClone(current);
    const next = parseBuilt(mutate(draft) ?? draft);
    // Both come out of the same schema, so their keys are in the same order and equal configs have equal texts. The
    // unknown keys are the file's on both sides: no change there.
    if (!o.always && JSON.stringify(next) === JSON.stringify(current)) return { config: current, changed: false };
    await writeLocked(dataDir, withUnknownKeysOf(ConfigSchema, next, raw));
    return { config: next, changed: true };
  });
}
