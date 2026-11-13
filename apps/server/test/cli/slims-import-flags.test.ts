import os from 'node:os';
import path from 'node:path';
import { newId } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import { parseArgs, runCli, USAGE } from '../../src/cli/index.js';
import { captureIo } from '../cli-support.js';
import { bootContext } from '../support.js';

// The catalogue re-sync flags of `slims:import`: `--catalog-mode append|sync`, `--skip-catalog` and `--from-run <id>`.
// They are checked before anything is opened (a usage error, exit 1 like every other one), and parsed into the import's
// options: skipping the catalogue stages is accepted only with the dry run it follows.

const DATA_DIR = path.join(os.tmpdir(), 'altis-never-created', 'altis-data');

async function cli(argv: string[]): Promise<{ code: number; err: string; out: string }> {
  const io = captureIo();
  const code = await runCli(['slims:import', '--dump', 'slims.sql', ...argv], bootContext(DATA_DIR), io);
  return { code, err: io.err, out: io.out };
}

describe('slims:import --catalog-mode, --skip-catalog, --from-run', () => {
  it('parses into the catalogue mode, the skip and the dry run it follows', () => {
    const run = newId();
    const args = parseArgs(['slims:import', '--dump', 'slims.sql', '--catalog-mode', 'sync', '--skip-catalog', '--from-run', run]);
    expect(args.slims).toEqual({ dump: 'slims.sql', catalogMode: 'sync', skipCatalog: true, fromRunId: run });
    expect(parseArgs(['slims:import', '--dump', 'slims.sql', '--catalog-mode=append']).slims).toEqual({ dump: 'slims.sql', catalogMode: 'append' });
    expect(parseArgs(['slims:import', '--dump', 'slims.sql']).slims).toEqual({ dump: 'slims.sql' });
  });

  it('an unknown catalogue mode is a usage error with its message', async () => {
    const r = await cli(['--catalog-mode', 'nope']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Nilai --catalog-mode tidak dikenal / Unknown --catalog-mode value');
    expect(r.out).toBe('');
    expect((await cli(['--catalog-mode'])).err).toContain('Unknown --catalog-mode value');
  });

  it('--skip-catalog without --from-run, and --from-run with no run id, are usage errors', async () => {
    const skip = await cli(['--skip-catalog']);
    expect(skip.code).toBe(1);
    expect(skip.err).toContain('--skip-catalog butuh --from-run <id uji coba sinkron> / --skip-catalog needs --from-run <sync dry run id>');
    for (const bad of [['--from-run', 'abc'], ['--from-run'], ['--from-run', '../x'], ['--skip-catalog=1', '--from-run', newId()]]) {
      expect((await cli(bad)).code, bad.join(' ')).toBe(1);
    }
  });

  it('the help names the three flags', () => {
    expect(USAGE).toContain('--catalog-mode append|sync');
    expect(USAGE).toContain('--skip-catalog --from-run <id>');
  });
});
