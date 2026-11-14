import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { writeUsageImport } from '../../src/accreditation/slims-usage/write.js';

// The write step of the SLiMS usage import on the engine picked by ALTIS_TEST_DB: a member type name read from SLiMS
// is stored without the characters a text column of some engine refuses (PostgreSQL refuses NUL), so the import
// writes the same label on every engine instead of failing on one.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 8, 1, 2, 0, 0);

describe.skipIf(!ctx.available)(`the SLiMS usage write step [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-slims-usage-write-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('stores a member type name without NUL or other control characters', async () => {
    const written = await writeUsageImport(h, {
      runId: newId(NOW),
      now: NOW,
      createdBy: null,
      cutoverOn: null,
      spans: [],
      monthly: { '2026-03': { visits: { 'slims_type:1': 4, 'slims_type:2': 1, '': 5 }, visits_deduped: { 'slims_type:1': 3, 'slims_type:2': 1, '': 4 } } },
      spanCells: [],
      types: { '1': 'Sis\u0000wa', '2': 'Guru\u0000\tTetap' },
      memberTypeIds: ['1', '2'],
      unknownMemberGroupDefault: 'student',
    });
    expect(written.months).toBe(1);
    const labels = await h.db.selectFrom('usage_group_map').select(['group_key', 'label']).where('group_key', 'like', 'slims_type:%').orderBy('group_key').execute();
    expect(labels).toEqual([
      { group_key: 'slims_type:1', label: 'Siswa' },
      { group_key: 'slims_type:2', label: 'Guru Tetap' },
    ]);
  });
});
