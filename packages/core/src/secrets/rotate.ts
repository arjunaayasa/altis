import { randomBytes } from 'node:crypto';
import { encodeBase64Url } from '@altis/crypto';
import { SECRET_COLUMNS, withTx, type DbHandle, type SecretColumn } from '@altis/db';
import { dataPath, ensureDir, withFileLock } from '@altis/platform';
import { DomainError, isDomainError, newId } from '@altis/shared';
import type { Kysely } from 'kysely';
import { errorFields, txCtx, type Actor, type CoreLogger } from '../context.js';
import { openValue, sealValue, secretAad, type KeyringEntry } from '../crypto/secret-box.js';

// `secrets:rotate` (spec §7.6, §13.6; decision C32): a new key for the secrets the database keeps.
//
//   1. config.json's keyring gains `{kid: 'k' + newId(), key: 32 random bytes, active: true}` and every other entry
//      becomes inactive. Old kids are never removed: a backup of branch a (same installation, spec §9.10) still holds
//      values sealed under them, and a value this run cannot reach keeps opening.
//   2. Wait `settleMs` (5 s): every process's config fence looks at config.json at most every 2 s (a worker-mode
//      server without traffic looks in every worker-loop pass, S19), so after the wait every process seals new values
//      with the new key and opens values sealed with it.
//   3. Every registered secret column (SECRET_COLUMNS: the data dictionary, never a list of this file's own) is read
//      in primary-key batches of 200, and each value whose kid is not the new one is opened with the whole keyring and
//      sealed again with the new key (same AAD `table.column.rowId`), by a compare-and-set
//      `UPDATE … SET column = :new WHERE pk = :id AND column = :old`: a value another process changed meanwhile is
//      left to it (its new value is the newer secret).
//   4. A second pass picks up what such writes sealed with the old key (a process whose fence had not looked yet).
//   5. `system.secrets_rotate {kid, rows}` is audited (actor `cli` unless the caller names another).
//
// A value that does not open (malformed, a kid no longer in the keyring, a failed tag: data of another installation)
// cannot be re-sealed: it is left as it is and logged once, by table, column and kind of failure (never the value).
// Re-running is safe (P7): a run that died after step 1 left a keyring whose active key some values already use; the
// next run adds another kid and re-seals everything not under it. One run at a time per DATA_DIR (`tmp/rotate.lock`).
//
// config.json belongs to the server (its schema, `config.lock`, ruling R58: changes go through updateConfig), which
// core cannot import: the caller passes `updateKeyring`, an updateConfig of the keyring.

/** Rows per key batch (C32). */
export const ROTATE_BATCH = 200;
/** How long the run waits after the keyring changed (C32: two fence intervals and a margin). */
export const ROTATE_SETTLE_MS = 5000;
/** The passes over the secret columns: the re-seal and the one for writes that raced it. */
const PASSES = 2;
/** A second rotation waits this long for the first; past it the run is refused. */
const LOCK_WAIT_MS = 2000;

const CLI_ACTOR: Actor = { type: 'cli', id: null, ip: null };

export interface RotateSecretsOptions {
  /** DATA_DIR: the run's lock `tmp/rotate.lock` lives there. */
  dataDir: string;
  /** Epoch ms (the audit entry's time). */
  now(): number;
  log: CoreLogger;
  /** Default {@link ROTATE_SETTLE_MS}. */
  settleMs?: number;
  /**
   * Replaces config.json's keyring with `mutate(current)` (through updateConfig, under `config.lock`) and returns the
   * keyring as written.
   */
  updateKeyring(mutate: (keyring: readonly KeyringEntry[]) => KeyringEntry[]): Promise<readonly KeyringEntry[]>;
  /** Who the audit entry names; default the CLI. */
  actor?: Actor;
}

/** The keyring with a new active entry appended and every other entry inactive (step 1). */
function withNewKey(keyring: readonly KeyringEntry[], kid: string): KeyringEntry[] {
  return [...keyring.map((entry) => ({ ...entry, active: false })), { kid, key: encodeBase64Url(randomBytes(32)), active: true }];
}

/** The kid of a sealed value `v1:<kid>:…`, or null when it is not one. */
function kidOf(sealed: string): string | null {
  const parts = sealed.split(':');
  return parts.length === 4 && parts[0] === 'v1' && parts[1] !== '' ? parts[1]! : null;
}

interface PassState {
  keyring: readonly KeyringEntry[];
  kid: string;
  /** `table.column.rowId` of the values already reported as unreadable (logged once per run). */
  reported: Set<string>;
  log: CoreLogger;
}

/** One pass over `s`: every value not under `state.kid` re-sealed, by compare-and-set. Returns the rows changed. */
async function resealColumn(h: DbHandle, s: SecretColumn, state: PassState): Promise<number> {
  // The table and its columns come from SECRET_COLUMNS, typed per table; one generic loop reads them all.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = h.db as unknown as Kysely<any>;
  let changed = 0;
  let after: string | null = null;
  for (;;) {
    let q = db.selectFrom(s.table).select([s.idColumn, s.column]).where(s.column, 'is not', null);
    if (s.onlyWhere !== undefined) q = q.where(s.onlyWhere, '=', 1);
    if (after !== null) q = q.where(s.idColumn, '>', after);
    const rows = (await q.orderBy(s.idColumn).limit(ROTATE_BATCH).execute()) as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row[s.idColumn]);
      const old = row[s.column];
      if (typeof old !== 'string' || kidOf(old) === state.kid) continue;
      const aad = secretAad(s.table, s.column, id);
      let plain: string;
      try {
        plain = openValue(state.keyring, aad, old);
      } catch (error) {
        if (!isDomainError(error) || error.code !== 'SECRET_UNREADABLE') throw error;
        if (!state.reported.has(aad)) {
          state.reported.add(aad);
          state.log.warn('secrets:rotate: a stored secret does not open and keeps its old seal', {
            table: s.table,
            column: s.column,
            ...errorFields(error),
            reason: error.meta?.['reason'],
          });
        }
        continue;
      }
      const result = await db
        .updateTable(s.table)
        .set({ [s.column]: sealValue(state.keyring, aad, plain) })
        .where(s.idColumn, '=', id)
        .where(s.column, '=', old)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) > 0) changed += 1;
    }
    if (rows.length < ROTATE_BATCH) break;
    after = String(rows[rows.length - 1]![s.idColumn]);
  }
  return changed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rotates the key of the database's secrets (see the top of this file).
 *
 * @returns the new kid and the number of values re-sealed (over both passes)
 * @throws DomainError `OPS_IN_PROGRESS` while another rotation of this DATA_DIR runs; what `updateKeyring` throws
 *   (nothing changed then); a database error (the keyring already holds the new kid: run it again)
 */
export async function rotateSecrets(h: DbHandle, o: RotateSecretsOptions): Promise<{ kid: string; rows: number }> {
  const settleMs = o.settleMs ?? ROTATE_SETTLE_MS;
  if (!Number.isSafeInteger(settleMs) || settleMs < 0) throw new RangeError('rotateSecrets: settleMs must be a whole number of ms ≥ 0');
  await ensureDir(dataPath(o.dataDir, 'tmp'));
  try {
    return await withFileLock(dataPath(o.dataDir, 'tmp', 'rotate.lock'), () => rotateLocked(h, o, settleMs), { waitMs: LOCK_WAIT_MS });
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT' && error.meta?.['reason'] === 'lock_timeout') {
      throw new DomainError('OPS_IN_PROGRESS', {
        detail: 'secrets:rotate sedang berjalan di proses lain / secrets:rotate is running in another process',
      });
    }
    throw error;
  }
}

async function rotateLocked(h: DbHandle, o: RotateSecretsOptions, settleMs: number): Promise<{ kid: string; rows: number }> {
  const kid = `k${newId()}`;
  const keyring = await o.updateKeyring((current) => withNewKey(current, kid));
  const active = keyring.filter((entry) => entry.active);
  if (active.length !== 1 || active[0]!.kid !== kid) {
    throw new TypeError('rotateSecrets: updateKeyring must return the keyring it wrote, with the new kid active');
  }
  o.log.info('secrets:rotate: a new key is active; waiting for every process to load it', { kid, settleMs });
  if (settleMs > 0) await sleep(settleMs);

  const state: PassState = { keyring, kid, reported: new Set(), log: o.log };
  let rows = 0;
  for (let pass = 0; pass < PASSES; pass += 1) {
    for (const s of SECRET_COLUMNS) rows += await resealColumn(h, s, state);
  }
  const actor = o.actor ?? CLI_ACTOR;
  await withTx(h, (trx) =>
    txCtx(trx, o.now(), actor).audit({ action: 'system.secrets_rotate', entity: null, entityId: null, meta: { kid, rows } }),
  );
  o.log.info('secrets:rotate: done', { kid, rows, unreadable: state.reported.size });
  return { kid, rows };
}
