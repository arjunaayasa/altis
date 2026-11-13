import fsp from 'node:fs/promises';
import path from 'node:path';
import { connect, type DbHandle } from '@altis/db';
import { __setSlimsSourceFactory, __setSlimsStages } from '@altis/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbConfig, testDbContext } from '../../../../tools/test/test-db.js';
import { slimsFixtureBytes } from '../../../../packages/core/test/support/slims-fixture/index.js';
import { runCli } from '../../src/cli/index.js';
import { captureIo, writeInput, type CapturedIo } from '../cli-support.js';
import { bootContext, useDataDir } from '../support.js';

// `node app.js slims:import --catalog-mode sync --skip-catalog --from-run <id>` against the engine picked by
// ALTIS_TEST_DB, with the real SLiMS stages and the synthetic fixture: the command takes over a sync dry run it made
// (no source named again) and skips the catalogue stages when that dry run found no change; when it found changes, the
// start is refused with the `catalog_changed` message and nothing is started.

const engine = testDbContext();
const dirs = useDataDir();

const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };
const LIBRARY = 'Perpustakaan Baris Perintah';

interface Printed {
  ok: boolean;
  runId?: string;
  code?: string;
  detail?: string;
  summary?: { catalogChanges?: number; reconciliation?: { ok: boolean }; tables?: Record<string, { skipped: Record<string, number>; migrated: number }> };
}

describe.skipIf(!engine.available)(`slims:import --skip-catalog --from-run [${engineLabel()}]`, () => {
  let h: DbHandle | null = null;

  beforeEach(async () => {
    await (await testDb()).close(); // empties the worker's database
    await fsp.mkdir(path.join(dirs.root, 'home'));
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
  });

  afterEach(async () => {
    await h?.close();
    h = null;
  });

  async function cli(argv: string[], answer: string | null = null): Promise<{ code: number; io: CapturedIo; printed: Printed }> {
    const io = captureIo({ HOME: path.join(dirs.root, 'home') }, { hostPanels: () => [] });
    io.prompt = async () => answer;
    io.promptSecret = async () => null;
    const code = await runCli(argv, bootContext(dirs.dataDir), io);
    let printed: Printed;
    try {
      printed = JSON.parse(io.out.trim().split('\n').at(-1) ?? '{}') as Printed;
    } catch {
      printed = { ok: false };
    }
    return { code, io, printed };
  }

  it('a sync dry run with no change lets the command skip the catalogue; one with changes refuses it with catalog_changed', async () => {
    const input = await writeInput(path.join(dirs.root, 'input'), { baseUrl: 'https://perpus.example', db: testDbConfig(), admin: ADMIN, library: { name: LIBRARY } });
    const installed = await cli(['install', '--config', input]);
    expect(installed.code, installed.io.err).toBe(0);
    const plainPath = path.join(dirs.root, 'slims.sql');
    const mutatedPath = path.join(dirs.root, 'slims-kemudian.sql');
    await fsp.writeFile(plainPath, slimsFixtureBytes().dump);
    await fsp.writeFile(mutatedPath, slimsFixtureBytes(undefined, { mutateCatalog: true }).dump);

    const first = await cli(['slims:import', '--dump', plainPath, '--json']);
    expect(first.code, first.io.err + first.io.out).toBe(0);
    const unchanged = await cli(['slims:import', '--dump', plainPath, '--dry-run', '--catalog-mode', 'sync', '--json']);
    expect(unchanged.code, unchanged.io.err).toBe(0);
    expect(unchanged.printed.summary?.catalogChanges).toBe(0);
    const changed = await cli(['slims:import', '--dump', mutatedPath, '--dry-run', '--catalog-mode', 'sync', '--json']);
    expect(changed.code, changed.io.err).toBe(0);
    expect(changed.printed.summary?.catalogChanges).toBe(10);

    h = await connect(testDbConfig(), { runtime: 'standalone', purpose: 'cli', dataDir: dirs.dataDir });
    const runs = async () => (await h!.db.selectFrom('catalog_runs').select('id').execute()).length;
    const before = await runs();
    const refused = await cli(['slims:import', '--catalog-mode', 'sync', '--skip-catalog', '--from-run', changed.printed.runId!, '--allow-non-empty', '--json'], LIBRARY);
    expect(refused.code).not.toBe(0);
    expect([refused.printed.ok, refused.printed.code]).toEqual([false, 'MIGRATION_PRECHECK_FAILED']);
    expect(refused.printed.detail).toContain('catalog_changed');
    expect(await runs()).toBe(before);

    const versions = async () => (await h!.db.selectFrom('items').select(['id', 'version']).execute()).map((r) => `${r.id}:${Number(r.version)}`).sort();
    const items = await versions();
    const skipped = await cli(['slims:import', '--catalog-mode', 'sync', '--skip-catalog', '--from-run', unchanged.printed.runId!, '--allow-non-empty', '--json'], LIBRARY);
    expect(skipped.code, skipped.io.err + skipped.io.out).toBe(0);
    expect(skipped.printed.summary?.reconciliation?.ok).toBe(true);
    expect(skipped.printed.summary?.tables?.['item']).toMatchObject({ migrated: 0, skipped: { catalog_skipped: 600 } });
    const run = await h.db.selectFrom('catalog_runs').select('options').where('id', '=', skipped.printed.runId!).executeTakeFirstOrThrow();
    expect(JSON.parse(run.options)).toMatchObject({ adoptedFrom: unchanged.printed.runId, catalogMode: 'sync', skipCatalog: true });
    expect(await versions()).toEqual(items);
  }, 900_000);
});
