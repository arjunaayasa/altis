import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyDatabase, engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../tools/test/test-db.js';
import { dropRegisteredTables } from '../src/ddl.js';
import { PHASE1_MIGRATIONS } from '../src/migrations/index.js';
import { runMigrations } from '../src/migrator.js';
import { listCatalogTables } from '../src/server-check.js';

// Phase 2 (catalog), Task 1, preflight B6: `install:reset --wipe-db` and a restore drop the registered tables with
// dropRegisteredTables. SQLite's FTS5 table `search_fts` is no registered table, and its four shadow tables cannot be
// dropped on their own: dropRegisteredTables drops the dialect's full-text virtual tables first, so the database is
// empty afterwards (listCatalogTables is what the installer's empty-database check reads, R55).

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`dropRegisteredTables after the Phase 2 migrations [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-ddl-drop-'));
  });

  afterAll(async () => {
    if (h !== undefined) await emptyDatabase(h);
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('leaves an empty catalog: no registered table, no search_fts* left (and a reinstall migrates again)', async () => {
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    // Some rows, so that the drops meet data, the full-text index included (SQLite).
    const now = Date.now();
    await h.db
      .insertInto('search_doc')
      .values({
        record_id: '01J0000000000000000000000A',
        is_public: 1,
        is_archived: 0,
        t_title: 'bumi manusia',
        t_agents: 'toer',
        t_subjects: '',
        t_rest: '',
        title_key: 'bumi manusia',
        year: 1980,
        created_at: now,
        changed_at: now,
      })
      .execute();
    if (h.dialect === 'sqlite') {
      await sql`INSERT INTO search_fts (rowid, t_title, t_agents, t_subjects, t_rest)
        SELECT doc_no, t_title, t_agents, t_subjects, t_rest FROM search_doc`.execute(h.db);
    }
    const before = await listCatalogTables(h);
    expect(before).toContain('search_doc');
    if (h.dialect === 'sqlite') expect(before).toEqual(expect.arrayContaining(['search_fts', 'search_fts_data', 'search_fts_idx']));

    await dropRegisteredTables(h.db, h.dialect);
    expect(await listCatalogTables(h)).toEqual([]);

    // The database can be installed again (the install's DB_NOT_EMPTY check would refuse leftovers).
    const again = await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    expect(again.mode).toBe('migrated');
    expect(again.applied).toEqual(Object.keys(PHASE1_MIGRATIONS).sort());
    await dropRegisteredTables(h.db, h.dialect);
    expect(await listCatalogTables(h)).toEqual([]);
  });

  it('is resumable: with search_fts already gone, a second call finds nothing to drop', async () => {
    await dropRegisteredTables(h.db, h.dialect);
    expect(await listCatalogTables(h)).toEqual([]);
  });
});
