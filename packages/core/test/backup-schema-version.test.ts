import { PHASE1_MIGRATIONS, columnsAt } from '@altis/db';
import { describe, expect, it } from 'vitest';

// A backup records the name of the last migration as its schema version (schemaVersionOf: `0009` → `0009_ops_jobs`)
// in `backups.schema_version`, and an uploaded archive's header carries it (readUploadedHeader takes at most 32
// characters). A later migration with a longer name would make every backup's row fail to insert on MySQL/MariaDB
// strict mode and PostgreSQL, and its archives unreadable anywhere: every migration name must fit both.

describe('the schema version a backup records', () => {
  it('every migration name fits backups.schema_version and the uploaded header’s 32 characters', () => {
    const latest = Object.keys(PHASE1_MIGRATIONS).sort().at(-1)!;
    const column = columnsAt('backups', latest).find((c) => c.name === 'schema_version');
    expect(column?.length).toBe(32);
    for (const name of Object.keys(PHASE1_MIGRATIONS)) expect(name.length, name).toBeLessThanOrEqual(Math.min(column!.length!, 32));
  });
});
