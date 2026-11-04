import { describe, expect, it } from 'vitest';
import { SECRET_COLUMNS, TABLE_CLASSES, type SecretColumn } from '../../src/registry.js';

// The data dictionary of encrypted columns (spec §7.6): every column that holds a `v1:<kid>:<iv>:<ct>` value. The
// secret box (AAD = table.column.rowId), the key rotation and the backup passes read it. The runtime check against
// the real catalog (the column exists, the id column is the primary key) is in tables.test.ts, on a migrated
// database; this file needs no database.

describe('SECRET_COLUMNS (spec §7.6)', () => {
  it('lists the three encrypted columns with the column that identifies their row', () => {
    expect(SECRET_COLUMNS).toEqual([
      { table: 'staff_users', column: 'totp_secret_enc', idColumn: 'id' },
      { table: 'settings', column: 'value', idColumn: 'key', onlyWhere: 'is_secret' },
      { table: 'jobs', column: 'secret_param', idColumn: 'id' },
    ]);
  });

  it('is frozen, with frozen entries', () => {
    expect(Object.isFrozen(SECRET_COLUMNS)).toBe(true);
    for (const s of SECRET_COLUMNS) expect(Object.isFrozen(s)).toBe(true);
  });

  it('names only tables of TABLE_CLASSES', () => {
    for (const s of SECRET_COLUMNS) expect(Object.keys(TABLE_CLASSES)).toContain(s.table);
  });

  it('names each column once', () => {
    const keys = SECRET_COLUMNS.map((s) => `${s.table}.${s.column}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('marks settings.value, whose rows hold a secret only where is_secret = 1, and no other column', () => {
    expect(SECRET_COLUMNS.filter((s) => s.onlyWhere !== undefined).map((s) => `${s.table}.${s.column}`)).toEqual([
      'settings.value',
    ]);
  });

  it('is checked against schema.ts at compile time: a column the table lacks does not type-check', () => {
    const entries: SecretColumn[] = [
      { table: 'staff_users', column: 'totp_secret_enc', idColumn: 'id' },
      // @ts-expect-error staff_users has no column called secret
      { table: 'staff_users', column: 'secret', idColumn: 'id' },
      // @ts-expect-error the id column must be a column of the table as well
      { table: 'jobs', column: 'secret_param', idColumn: 'key' },
      // @ts-expect-error there is no table called vault
      { table: 'vault', column: 'value', idColumn: 'id' },
      // @ts-expect-error only is_secret can restrict the rows
      { table: 'settings', column: 'value', idColumn: 'key', onlyWhere: 'is_public' },
    ];
    expect(entries).toHaveLength(5);
  });

  it('is a plain list that callers can read as strings', () => {
    const asStrings: readonly { table: string; column: string; idColumn: string; onlyWhere?: 'is_secret' }[] = SECRET_COLUMNS;
    expect(asStrings).toBe(SECRET_COLUMNS);
  });
});
