import { upsert, type DB } from '@altis/db';
import { DomainError, isUlid } from '@altis/shared';
import { issueCode } from '@altis/shared/api/common';
import type { Kysely, Transaction } from 'kysely';
import { openValue, sealValue, secretAad, type KeyringEntry } from '../crypto/secret-box.js';
import { SETTINGS, allSettingKeys, isSettingKey, type SettingDef, type SettingKey } from './registry.js';

// Reading and writing settings (spec §7.6; R54). `settings.value` holds JSON text, or `v1:<kid>:<iv>:<ct>` for a
// secret (AES-256-GCM, AAD `settings.value.<key>`, see secret-box.ts) and NULL for a secret that is cleared. A row
// that is absent reads as the registry's default.
//
// The service takes the handle or transaction it is given and opens none, so a route can read and write settings
// in the transaction of its action. It writes no audit entry: the route does, with the keys writeSettings returns.
// The cache (createSettingsCache) is the only state here, and it is only for values that are safe to serve stale
// (P6); a writer invalidates it in `afterCommit` (M17).

type Handle = Kysely<DB> | Transaction<DB>;

/** The time a cached value may be served for: other processes may read a value up to this long after it changed. */
const DEFAULT_TTL_MS = 30_000;

function registered(key: unknown, caller: string): SettingKey {
  if (!isSettingKey(key)) throw new TypeError(`${caller}: ${JSON.stringify(key)} is not a registered setting`);
  return key;
}

/** Two settings values are equal when their JSON texts are (values are strings, numbers and null). */
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The value of a stored JSON text when it is valid for `def`; null when it is not JSON or breaks the schema. */
function parseStored(def: SettingDef, text: string | null): { value: unknown } | null {
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = def.schema.safeParse(json);
  return parsed.success ? { value: parsed.data } : null;
}

/**
 * What a setting reads as given its stored `text` (undefined: no row). A secret is only a fact about the row. A stored
 * value that cannot be read (not JSON, or no longer valid for the schema: a hand-edited row, a restore from another
 * version) reads as the default rather than taking the login or the admin screens down with it.
 */
function effective(key: SettingKey, text: string | null | undefined): unknown {
  const def = SETTINGS[key];
  if (def.secret) return { isSet: text !== undefined && text !== null };
  if (text === undefined) return def.default;
  const stored = parseStored(def, text);
  return stored === null ? def.default : stored.value;
}

/** The stored text of each of `keys` that has a row. */
async function loadRows(db: Handle, keys: readonly SettingKey[]): Promise<Map<SettingKey, string | null>> {
  const found = new Map<SettingKey, string | null>();
  if (keys.length === 0) return found;
  const rows = await db.selectFrom('settings').select(['key', 'value']).where('key', 'in', [...keys]).execute();
  for (const row of rows) found.set(row.key as SettingKey, row.value);
  return found;
}

/**
 * The values of `keys`: the stored value, or the default when there is no row. A secret reads as `{isSet}` and
 * never as its value (use {@link readSecret}). Only the keys asked for are in the result.
 *
 * `keyring` is part of the signature so that every caller reads settings the same way; `{isSet}` is a fact about the
 * row and needs no key, so a database restored without its keys still shows which secrets were carried over.
 *
 * @throws TypeError for a key outside the registry
 */
export async function readSettings<K extends SettingKey>(
  db: Handle,
  keys: readonly K[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see above: part of the signature, not needed to say isSet
  keyring: readonly KeyringEntry[],
): Promise<Record<K, unknown>> {
  const wanted = [...new Set(keys.map((key) => registered(key, 'readSettings') as K))];
  const stored = await loadRows(db, wanted);
  const out = {} as Record<K, unknown>;
  for (const key of wanted) out[key] = effective(key, stored.get(key));
  return out;
}

/**
 * The plaintext of the secret `key`, or null when it is absent or cleared.
 *
 * @throws TypeError for a key that is not a registered secret
 * @throws DomainError `SECRET_UNREADABLE` when the stored value does not open with `keyring` (never carries the value)
 */
export async function readSecret(db: Handle, key: SettingKey, keyring: readonly KeyringEntry[]): Promise<string | null> {
  registered(key, 'readSecret');
  if (!SETTINGS[key].secret) throw new TypeError(`readSecret: ${key} is not a secret`);
  const row = await db.selectFrom('settings').select('value').where('key', '=', key).executeTakeFirst();
  if (row === undefined || row.value === null) return null;
  return openValue(keyring, secretAad('settings', 'value', key), row.value);
}

export interface WriteSettingsOptions {
  keyring: readonly KeyringEntry[];
  /** Epoch ms of the action (`settings.updated_at`). */
  now: number;
  /** The staff user's ULID, or null for the CLI and the system (`settings.updated_by`). */
  actorId: string | null;
}

/**
 * Writes the settings of `patch` in `trx` and returns the keys whose value changed, in registry order. Nothing is
 * audited: the route writes the audit entry (meta: names only) with the returned keys.
 *
 * - Every value is validated first (VALIDATION_FAILED, one `{path, code}` per bad key, never the value), and
 *   nothing is written when one fails. `path` is the key, followed for a list or an object by where in the value its
 *   first issue lies (`catalog.sru.servers.0.url`).
 * - `undefined` keeps a value. `null` clears one that may be null (it reads as its default, null) and a secret.
 * - A value equal to the current one (an absent row counts as its default) changes nothing: no row is written and the
 *   key is not returned.
 * - A secret is sealed with the keyring's active key and AAD `settings.value.<key>`; a secret in the patch always
 *   counts as changed (the value is write-only, there is nothing to compare it with).
 * - A purpose-bound secret (smtp.password) is cleared when one of its `boundTo` settings changes and the patch holds
 *   no new secret for it (§7.6); the cleared key is then in the result when it was set as read. The clear is written
 *   whatever was read (an absent or NULL row becomes a NULL row): upsert's write waits for a concurrent writer of
 *   that row and then overrides it, so a password another transaction is setting for the old host (not visible to
 *   this one's read on PostgreSQL or MySQL/MariaDB) never stays bound to the new one (T8).
 * - The scope of a row is the registered one, also when the row already existed with another.
 *
 * Re-runnable as a whole (R37): it reads and writes only through `trx`. Await it before the next statement on `trx`.
 *
 * @throws DomainError `VALIDATION_FAILED`
 * @throws TypeError for a key outside the registry, an actor id that is not a ULID, or a `now` that is not an
 *   epoch-ms integer
 */
export async function writeSettings(
  trx: Transaction<DB>,
  patch: Partial<Record<SettingKey, unknown>>,
  o: WriteSettingsOptions,
): Promise<SettingKey[]> {
  if (!Number.isSafeInteger(o.now) || o.now < 0) throw new TypeError('writeSettings: now must be an epoch-ms integer');
  if (o.actorId !== null && !isUlid(o.actorId)) throw new TypeError('writeSettings: actorId must be a ULID or null');

  const given = new Map<SettingKey, unknown>();
  for (const [key, value] of Object.entries(patch)) {
    registered(key, 'writeSettings');
    if (value !== undefined) given.set(key as SettingKey, value);
  }

  // Validate all before writing any, in registry order.
  const valid = new Map<SettingKey, unknown>();
  const errors: { path: string; code: string }[] = [];
  for (const key of allSettingKeys()) {
    if (!given.has(key)) continue;
    const parsed = SETTINGS[key].schema.safeParse(given.get(key));
    if (parsed.success) {
      valid.set(key, parsed.data);
      continue;
    }
    const issue = parsed.error.issues[0];
    // 1d (Task 1): the path goes on into the value for a list or an object (`catalog.sru.servers.0.url`); a plain
    // value's issue has no path of its own, so a form field's error keeps the key itself.
    const path = issue === undefined ? key : [key, ...issue.path.map((p) => String(p))].join('.');
    errors.push({ path, code: issue === undefined ? 'invalid' : issueCode(issue) });
  }
  if (errors.length > 0) {
    throw new DomainError('VALIDATION_FAILED', {
      detail: 'Nilai pengaturan tidak valid / A setting value is not valid',
      meta: { errors },
    });
  }
  if (valid.size === 0) return [];

  // The rows that decide what changes: the keys of the patch, and the bound secrets they may clear.
  const bound = allSettingKeys().filter((key) => SETTINGS[key].boundTo?.some((to) => valid.has(to)) === true);
  const current = await loadRows(trx, [...new Set([...valid.keys(), ...bound])]);

  const writes = new Map<SettingKey, string | null>();
  /** Keys written without being reported: a bound secret cleared that was not set as read (T8). */
  const silent = new Set<SettingKey>();
  for (const [key, value] of valid) {
    const def = SETTINGS[key];
    const text = current.get(key);
    if (def.secret) {
      if (value === null) {
        if (text !== undefined && text !== null) writes.set(key, null);
      } else {
        writes.set(key, sealValue(o.keyring, secretAad('settings', 'value', key), value as string));
      }
      continue;
    }
    // A stored value that cannot be read (NULL, not JSON, no longer valid) is rewritten, even to the default.
    const same = text === undefined ? sameValue(def.default, value) : sameValue(parseStored(def, text)?.value, value);
    if (!same) writes.set(key, JSON.stringify(value));
  }
  for (const key of bound) {
    if (valid.has(key)) continue;
    const text = current.get(key);
    const changed = SETTINGS[key].boundTo?.some((to) => writes.has(to)) === true;
    if (!changed) continue;
    writes.set(key, null);
    if (text === undefined || text === null) silent.add(key);
  }

  const changedKeys: SettingKey[] = [];
  for (const key of allSettingKeys()) {
    if (!writes.has(key)) continue;
    const def = SETTINGS[key];
    const row = {
      value: writes.get(key) ?? null,
      is_secret: def.secret ? 1 : 0,
      scope: def.scope,
      updated_at: o.now,
      updated_by: o.actorId,
    };
    await upsert(trx, 'settings', { key }, row, row);
    if (!silent.has(key)) changedKeys.push(key);
  }
  return changedKeys;
}

export interface SettingsCache {
  /**
   * The value of `key`: served from memory for up to the time to live, read from `db` otherwise. A secret is never
   * kept: it is read afresh as `{isSet}` every time. A transaction is never cached either, since what it reads may
   * still roll back.
   */
  get<T>(db: Handle, key: SettingKey): Promise<T>;
  /** Forgets every cached value; a read that was already running does not put its value back. */
  invalidate(): void;
}

/**
 * A cache of settings for values that are safe to serve stale (P6): another process that changed a value shows up
 * here within `ttlMs` (default 30 s, a value is served while its age is below it). A writer calls `invalidate()` in
 * `afterCommit`, so that its own process reads the new value at once (M17).
 *
 * `clock` is the time source (default `Date.now`), for tests.
 */
export function createSettingsCache(o: { ttlMs?: number; clock?: () => number } = {}): SettingsCache {
  const ttlMs = o.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError('createSettingsCache: ttlMs must be a finite number of at least 0');
  const clock = o.clock ?? Date.now;
  const entries = new Map<SettingKey, { value: unknown; at: number }>();
  // Bumped by invalidate(): a read that began before it must not store what it read.
  let generation = 0;

  return {
    async get<T>(db: Handle, key: SettingKey): Promise<T> {
      registered(key, 'SettingsCache.get');
      if (SETTINGS[key].secret || db.isTransaction) {
        return (await readSettings(db, [key], []))[key] as T;
      }
      const now = clock();
      const hit = entries.get(key);
      // A clock that went back counts as expired, so that a wrong reading cannot pin a value for good.
      if (hit !== undefined && now >= hit.at && now - hit.at < ttlMs) return hit.value as T;
      const began = generation;
      const value = (await readSettings(db, [key], []))[key];
      if (began === generation) entries.set(key, { value, at: now });
      return value as T;
    },
    invalidate(): void {
      generation += 1;
      entries.clear();
    },
  };
}
