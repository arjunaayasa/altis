import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREFLIGHT_CHECKS } from '@altis/shared/api/install';
import { MIN_NODE_VERSION, PREFLIGHT_MIN_RAM_BYTES, failedChecks, nodeVersionSupported, preflightChecks, type PreflightOptions } from '../src/install/preflight.js';

// The install's mandatory checks (spec §9.5 step 1; plan Task 27, L51): Node, DATA_DIR writable, P16, WASM, time zone
// and RAM, each `{ok, level, detail}`. The web wizard shows them and refuses its config step on an `error`; the
// headless install prints the warnings (cli-install.test.ts).

let root: string;
let home: string;

beforeEach(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-preflight-')));
  home = path.join(root, 'home');
  await fsp.mkdir(home);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await fsp.chmod(root, 0o700).catch(() => {});
  await fsp.rm(root, { recursive: true, force: true });
});

/** An app folder and a DATA_DIR side by side under `base` (the supported layout), both created. */
async function layout(base: string): Promise<{ appRoot: string; dataDir: string }> {
  const appRoot = path.join(base, 'app');
  const dataDir = path.join(base, 'altis-data');
  await fsp.mkdir(appRoot, { recursive: true });
  await fsp.mkdir(dataDir, { recursive: true });
  return { appRoot, dataDir };
}

async function run(over: Partial<PreflightOptions> = {}) {
  const { appRoot, dataDir } = await layout(path.join(root, 'altis'));
  return preflightChecks({ nodeVersion: '22.16.0', dataDir, appRoot, home, runtime: 'standalone', env: {}, rootPrefix: root, ...over });
}

describe('preflightChecks', () => {
  it('passes on this host: every check, in order, each with a level and a detail', async () => {
    const report = await run();
    expect(Object.keys(report.checks)).toEqual([...PREFLIGHT_CHECKS]);
    expect(report.ok).toBe(true);
    for (const name of PREFLIGHT_CHECKS) {
      expect(report.checks[name], name).toEqual({ ok: true, level: expect.stringMatching(/^(error|warn)$/), detail: expect.any(String) });
    }
    expect(report.checks.wasm.level).toBe('warn');
    expect(report.checks.ram.level).toBe('warn');
    expect(report.checks.node.level).toBe('error');
    expect(report.checks.timezone.detail).toMatch(/^Asia\/Jakarta; host /);
  });

  it('Node 20.11.0 → a `node` error, and the report is not ok', async () => {
    const report = await run({ nodeVersion: '20.11.0' });
    expect(report.checks.node).toEqual({ ok: false, level: 'error', detail: expect.stringContaining('22.16') });
    expect(report.ok).toBe(false);
    expect(failedChecks(report, 'error')).toEqual(['node']);
    expect(nodeVersionSupported(MIN_NODE_VERSION)).toBe(true);
    expect(nodeVersionSupported('22.15.9')).toBe(false);
    expect(nodeVersionSupported('not a version')).toBe(false);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a read-only DATA_DIR → a `dataDir` error', async () => {
    const { appRoot, dataDir } = await layout(path.join(root, 'ro'));
    await fsp.chmod(dataDir, 0o500);
    try {
      const report = await run({ appRoot, dataDir });
      expect(report.checks.dataDir).toEqual({ ok: false, level: 'error', detail: expect.stringMatching(/not writable/) });
      expect(report.ok).toBe(false);
    } finally {
      await fsp.chmod(dataDir, 0o700);
    }
  });

  it('a DATA_DIR that does not exist → a `dataDir` error', async () => {
    const { appRoot } = await layout(path.join(root, 'gone'));
    const report = await run({ appRoot, dataDir: path.join(root, 'gone', 'missing') });
    expect(report.checks.dataDir).toEqual({ ok: false, level: 'error', detail: expect.stringMatching(/does not exist/) });
  });

  it('WebAssembly.Memory stubbed to throw → a `wasm` warning with the NODE_OPTIONS hint; the report stays ok', async () => {
    vi.stubGlobal('WebAssembly', {
      Memory: class {
        constructor() {
          throw new RangeError('WebAssembly.Memory(): could not allocate memory');
        }
      },
    });
    const report = await run();
    expect(report.checks.wasm).toEqual({ ok: false, level: 'warn', detail: expect.stringContaining('NODE_OPTIONS=--disable-wasm-trap-handler') });
    expect(report.ok).toBe(true);
    expect(failedChecks(report, 'warn')).toEqual(['wasm']);
  });

  it('256 MiB of memory (stubbed) → a `ram` warning; the report stays ok', async () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(256 * 1024 * 1024);
    const report = await run();
    expect(report.checks.ram).toEqual({ ok: false, level: 'warn', detail: expect.stringContaining('256 MiB') });
    expect(report.ok).toBe(true);
    expect(PREFLIGHT_MIN_RAM_BYTES).toBe(512 * 1024 * 1024);
  });

  it('A2: /www/altis/<name>/{app,altis-data} passes P16; an app under /www/wwwroot/<site> is a `docroot` error', async () => {
    const supported = await layout(path.join(root, 'www', 'altis', 'perpus'));
    const ok = await preflightChecks({ nodeVersion: '22.16.0', ...supported, home, runtime: 'pm2', env: {}, rootPrefix: root });
    expect(ok.checks.docroot.ok).toBe(true);

    const site = path.join(root, 'www', 'wwwroot', 'site');
    const appRoot = path.join(site, 'app');
    await fsp.mkdir(appRoot, { recursive: true });
    const refused = await preflightChecks({ nodeVersion: '22.16.0', dataDir: supported.dataDir, appRoot, home, runtime: 'pm2', env: {}, rootPrefix: root });
    expect(refused.checks.docroot).toEqual({ ok: false, level: 'error', detail: expect.stringContaining(path.join(root, 'www', 'wwwroot')) });
    expect(refused.ok).toBe(false);
  });

  it('DATA_DIR inside the app folder → a `docroot` error', async () => {
    const { appRoot } = await layout(path.join(root, 'nested'));
    const dataDir = path.join(appRoot, 'altis-data');
    await fsp.mkdir(dataDir);
    const report = await run({ appRoot, dataDir });
    expect(report.checks.docroot).toEqual({ ok: false, level: 'error', detail: expect.stringContaining('inside the app folder') });
  });
});
