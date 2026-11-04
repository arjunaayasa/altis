import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { writeConfig } from '../src/config.js';
import { captureIo } from './cli-support.js';
import { bootContext, sampleConfig, useDataDir } from './support.js';

// `config:set` when its audit fails with something that is not a DomainError (a bug, not the database): the change
// to config.json stays, and the command fails (exit 1, INTERNAL) saying so, instead of passing the bug off as a
// warning about the database (final review T24).

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    // The audit reads config.json (with the overrides) through loadConfig; updateConfig, which writes it, stays real.
    loadConfig: vi.fn(async () => {
      throw new TypeError('a bug in the audit path');
    }),
  };
});

const dirs = useDataDir();

describe('config:set: an unexpected audit failure', () => {
  it('exit 1 with INTERNAL, saying config.json was changed; the change stays', async () => {
    await writeConfig(dirs.dataDir, sampleConfig());
    const home = path.join(dirs.root, 'home');
    await fsp.mkdir(home);
    const io = captureIo({ HOME: home }, { hostPanels: () => [] });
    const code = await runCli(['config:set', 'port', '8080'], bootContext(dirs.dataDir), io);
    expect(code).toBe(1);
    expect(io.err).toContain('INTERNAL');
    expect(io.err).toContain('config.json sudah diubah (port)');
    expect(io.err).toContain('config.json was changed (port)');
    expect(io.err).not.toContain('a bug in the audit path');
    const stored = JSON.parse(await fsp.readFile(path.join(dirs.dataDir, 'config.json'), 'utf8')) as { port?: number };
    expect(stored.port).toBe(8080);
  });
});
