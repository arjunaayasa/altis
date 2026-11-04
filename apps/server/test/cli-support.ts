import { spawn } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { RELEASE_TYP, buildManifest, signDetached, type TrustedKey } from '@altis/crypto';
import { connect, type DbConfig, type DbHandle } from '@altis/db';
import type { Runtime } from '@altis/platform';
import type { CliIo } from '../src/cli/index.js';

// Helpers for the CLI tests (cli-install, cli-doctor, db/cli-engine).

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DEV_KEYS = path.join(ROOT, 'tools', 'keys', 'dev');

/** A CliIo that keeps what the CLI prints. `env` is the whole environment the CLI sees. */
export interface CapturedIo extends CliIo {
  out: string;
  err: string;
}

export function captureIo(
  env: Record<string, string> = {},
  extra: Partial<Pick<CliIo, 'nodeVersion' | 'rootKeys' | 'refuseDevKids' | 'hostPanels'>> = {},
): CapturedIo {
  const io: CapturedIo = {
    env,
    out: '',
    err: '',
    stdout(text) {
      io.out += text;
    },
    stderr(text) {
      io.err += text;
    },
    ...extra,
  };
  return io;
}

/** Writes `input` as JSON to `<dir>/input.json` and returns its path. */
export async function writeInput(dir: string, input: unknown, name = 'input.json'): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fsp.writeFile(file, typeof input === 'string' ? input : JSON.stringify(input, null, 2));
  return file;
}

/** The dev root keys (tools/keys/dev/roots.json): what a test build embeds, and what tests pass as root keys. */
export async function devRootKeys(): Promise<TrustedKey[]> {
  return JSON.parse(await fsp.readFile(path.join(DEV_KEYS, 'roots.json'), 'utf8')) as TrustedKey[];
}

/**
 * Writes a release signed with `dev-rel-1` into `dir`: server.mjs, public/.keep, keyset.json (the dev keyset, signed by
 * dev-root-1, which trusts dev-rel-1), manifest.json, manifest.sig, .complete.
 */
export async function makeSignedRelease(dir: string, version: string): Promise<void> {
  await fsp.mkdir(path.join(dir, 'public'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'server.mjs'), 'export const bootProtocol = 1;\n');
  await fsp.writeFile(path.join(dir, 'public', '.keep'), '');
  await fsp.copyFile(path.join(DEV_KEYS, 'keyset.json'), path.join(dir, 'keyset.json'));
  const manifest = await buildManifest(dir, {
    version,
    buildId: `test-${version}`,
    bootProtocol: 1,
    releasedAt: '2026-10-27',
    schemaLatest: '0009',
    minCodeVersionAfter: '0.0.0',
    minUpgradeFrom: '0.0.0',
    minNode: '22.16.0',
    minDb: { mysql: '8.0.0', mariadb: '10.6.0', postgres: '15.0.0' },
  });
  const key = JSON.parse(await fsp.readFile(path.join(DEV_KEYS, 'dev-rel-1.key.json'), 'utf8')) as { kid: string; pkcs8: string };
  const privateKey = createPrivateKey({ key: Buffer.from(key.pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await fsp.writeFile(path.join(dir, 'manifest.sig'), JSON.stringify(signDetached(manifest, { typ: RELEASE_TYP, kid: key.kid, privateKey })));
  await fsp.writeFile(path.join(dir, '.complete'), '');
}

/** Opens the database of an installed (or half-installed) DATA_DIR, as the CLI would. Close it when done. */
export function openInstalled(dataDir: string, db: DbConfig = { dialect: 'sqlite' }): Promise<DbHandle> {
  return connect(db, { runtime: 'standalone', purpose: 'cli', dataDir });
}

export interface ChildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `runCli(argv, ctx, {env})` in a child process (fixtures/cli-child.mjs, test profile), so that a fault hook
 * can kill it for real. The child is killed after `timeoutMs`.
 */
export function runCliChild(
  o: { argv: string[]; dataDir: string; appRoot: string; runtime?: Runtime; version?: string; env: Record<string, string> },
  timeoutMs = 25_000,
): Promise<ChildOutcome> {
  const options = { runtime: 'standalone', version: '0.1.0', ...o };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'fixtures', 'cli-child.mjs'), JSON.stringify(options)], {
      cwd: ROOT,
      env: { PATH: process.env['PATH'] ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
