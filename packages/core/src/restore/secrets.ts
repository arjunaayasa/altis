import { SECRET_COLUMNS } from '@altis/db';
import { isDomainError } from '@altis/shared';
import { openArchiveValue } from '../archive/kdf.js';
import { openValue, sealValue, secretAad, type KeyringEntry } from '../crypto/secret-box.js';

// The secret columns of a restored backup (spec §9.10 "rahasia", A6; decisions C13, C14; plan Task 22). Which branch
// applies is decided once, in `verifying`:
//
//   a  the manifest carries this installation's HMAC, its secrets are sealed with the keyring (`secrets: 'keyring'`)
//      and every `kid` it lists is in this keyring: the sealed values are copied as they are;
//   b  a passphrase archive (`secrets: 'archive'`) whose DEK the passphrase opened: each value is opened with the
//      archive's column key and sealed again with this keyring's active kid, same AAD (`table.column.rowId`);
//   c  anything else (another installation's keyring, an unencrypted download, secrets left out): every secret is
//      NULL; staff who had TOTP get `totp_reenroll = 1` (sign in with the password and a recovery code, then enrol
//      again), and the names go to the report's checklist.
//
// A single value that branch b cannot open (a value the preparer's keyring could not open was already left out) is
// treated as branch c for that value. The registered secret columns are SECRET_COLUMNS (`staff_users.totp_secret_enc`,
// `settings.value` where `is_secret = 1`; `jobs.secret_param` is volatile and never restored).

export type SecretsBranch = 'a' | 'b' | 'c';

/**
 * The branch of a restore (see the top of this file): `a` for a valid HMAC of this installation with `keyring`
 * secrets and every kid present, `b` for `archive` secrets with the DEK opened, `c` otherwise.
 */
export function secretsBranch(o: {
  hmacValid: boolean;
  kidsPresent: boolean;
  secrets: 'keyring' | 'archive' | 'omitted';
  dekOpened: boolean;
}): SecretsBranch {
  if (o.hmacValid && o.secrets === 'keyring' && o.kidsPresent) return 'a';
  if (o.secrets === 'archive' && o.dekOpened) return 'b';
  return 'c';
}

/** What the restore asks the administrator to do afterwards (the report's `checklist`). */
export interface RestoreChecklist {
  /** The secret settings (by key) that were not carried over and need to be entered again. */
  secrets: string[];
  /** The staff (by user name) who must enrol their TOTP again. */
  reenroll: string[];
}

/** The most names each checklist list keeps: a report is read by a person. */
export const CHECKLIST_MAX = 200;

/** What {@link restoreSecretColumns} needs. */
export interface SecretRestore {
  branch: SecretsBranch;
  keyring: readonly KeyringEntry[];
  /** columnKey(DEK) of a branch-b archive, else null. */
  columnKey: Uint8Array | null;
}

/** The secret columns of each table. */
const SECRETS_BY_TABLE: ReadonlyMap<string, readonly { column: string; idColumn: string; onlyWhere: 'is_secret' | undefined }[]> = (() => {
  const map = new Map<string, { column: string; idColumn: string; onlyWhere: 'is_secret' | undefined }[]>();
  for (const s of SECRET_COLUMNS) {
    const list = map.get(s.table) ?? [];
    list.push({ column: s.column, idColumn: s.idColumn, onlyWhere: s.onlyWhere });
    map.set(s.table, list);
  }
  return map;
})();

/** Whether `table` has registered secret columns. */
export function holdsSecrets(table: string): boolean {
  return SECRETS_BY_TABLE.has(table);
}

function note(list: string[], name: unknown): void {
  if (typeof name !== 'string' || name === '' || list.includes(name) || list.length >= CHECKLIST_MAX) return;
  list.push(name);
}

/** The value of `sealed` sealed again for this installation (branch b), or null when it cannot be opened. */
function reseal(r: SecretRestore, aad: string, sealed: string): string | null {
  if (r.columnKey !== null) {
    try {
      return sealValue(r.keyring, aad, openArchiveValue(r.columnKey, aad, sealed));
    } catch (error) {
      if (!(isDomainError(error) && error.code === 'SECRET_UNREADABLE')) throw error;
    }
  }
  // A value sealed with this installation's own keyring opens as it is.
  try {
    openValue(r.keyring, aad, sealed);
    return sealed;
  } catch (error) {
    if (!(isDomainError(error) && error.code === 'SECRET_UNREADABLE')) throw error;
    return null;
  }
}

/**
 * The canonical row `row` of `table` with its secret columns as the branch says (it is changed in place and
 * returned); the names of what was not carried over are added to `checklist`.
 */
export function restoreSecretColumns(table: string, row: Record<string, unknown>, r: SecretRestore, checklist: RestoreChecklist): Record<string, unknown> {
  const secrets = SECRETS_BY_TABLE.get(table);
  if (secrets === undefined || r.branch === 'a') return row;
  let lost = false;
  for (const s of secrets) {
    if (!Object.hasOwn(row, s.column)) continue;
    if (s.onlyWhere !== undefined && row[s.onlyWhere] !== 1) continue;
    const value = row[s.column];
    const id = row[s.idColumn];
    let next: string | null = null;
    if (typeof value === 'string' && r.branch === 'b' && (typeof id === 'string' || typeof id === 'number')) {
      next = reseal(r, secretAad(table, s.column, String(id)), value);
    }
    if (next === null && (value !== null || r.branch === 'c')) {
      // A secret row whose value the archive left out (`secrets: 'omitted'`) needs entering again as well.
      lost = lost || value !== null;
      if (table === 'settings') note(checklist.secrets, row['key']);
    }
    row[s.column] = next;
  }
  if (table === 'staff_users' && (lost || (row['totp_secret_enc'] === null && row['totp_enabled'] === 1))) {
    row['totp_reenroll'] = 1;
    note(checklist.reenroll, row['username_display']);
  }
  return row;
}
