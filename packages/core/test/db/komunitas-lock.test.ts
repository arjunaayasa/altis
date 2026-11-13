import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { KyselyPlugin } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { lockOpenPeriod } from '../../src/accreditation/periods/lock.js';

// The lock every writer of a period's data takes first: an update that changes nothing on an open, live period. A
// frozen period refuses the write with ACCRED_PERIOD_FROZEN, an archived or missing one with NOT_FOUND.

const ctx = testDbContext();
const NOW = Date.UTC(2026, 10, 14, 9, 0, 0);

describe.skipIf(!ctx.available)(`lockOpenPeriod [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-period-lock-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  /** A period in `status`, archived when asked; its id. */
  async function period(status: 'open' | 'frozen', archived = false): Promise<string> {
    const id = newId(NOW);
    await h.db
      .insertInto('accred_periods')
      .values({
        id,
        name: `Periode ${status}`,
        instrument_id: 'test-sch',
        kind: 'school_year',
        starts_on: '2025-07-01',
        ends_on: '2026-06-30',
        branch_id: null,
        profile: '{}',
        all_registered_confirmed: 0,
        status,
        frozen_at: status === 'frozen' ? NOW : null,
        frozen_by: null,
        archived_at: archived ? NOW : null,
        version: 4,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return id;
  }

  const versionOf = async (id: string) => Number((await h.db.selectFrom('accred_periods').select('version').where('id', '=', id).executeTakeFirstOrThrow()).version);

  it('an open period: resolves, and its version is unchanged', async () => {
    const id = await period('open');
    await withTx(h, (trx) => lockOpenPeriod(trx, id));
    expect(await versionOf(id)).toBe(4);
  });

  it('a frozen period: ACCRED_PERIOD_FROZEN (409)', async () => {
    const id = await period('frozen');
    await expect(withTx(h, (trx) => lockOpenPeriod(trx, id))).rejects.toMatchObject({ code: 'ACCRED_PERIOD_FROZEN', status: 409 });
    expect(await versionOf(id)).toBe(4);
  });

  it('an archived or missing period: NOT_FOUND (404)', async () => {
    const archived = await period('open', true);
    await expect(withTx(h, (trx) => lockOpenPeriod(trx, archived))).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(withTx(h, (trx) => lockOpenPeriod(trx, newId()))).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('is the first statement of its transaction: the conditional update of the period row', async () => {
    const id = await period('open');
    const statements: string[] = [];
    const capture: KyselyPlugin = {
      transformQuery(args) {
        statements.push(h.db.getExecutor().compileQuery(args.node, args.queryId).sql);
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    };
    await withTx({ ...h, db: h.db.withPlugin(capture) }, (trx) => lockOpenPeriod(trx, id));
    const work = statements.filter((sql) => !/^\s*(begin|start|set|savepoint|release|commit|rollback)\b/i.test(sql));
    expect(work).toHaveLength(1);
    expect(work[0]).toMatch(/^update ["`]accred_periods["`] set ["`]version["`] = ["`]version["`] where/);
  });
});
