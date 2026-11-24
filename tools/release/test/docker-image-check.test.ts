import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APP_ROOT_CHECK,
  LIST_FILES,
  checkImage,
  forbiddenImagePaths,
  isRootUser,
  parseImageCheckArgs,
  type DockerExec,
  type DockerResult,
} from '../smoke/docker-image-check.js';

// 1d Task 32 (spec §9.11 "CI memastikan image tidak memuat .env, .git, maupun source map"; L58/L59): the nightly image
// check. The pure parts and the flow over a fake `docker`; the nightly workflow runs it against the real image.

describe('forbiddenImagePaths', () => {
  it("the brief's case: .env, a source map and a file under .git/ are forbidden, app.js is not", () => {
    expect(forbiddenImagePaths(['/app/app.js', '/app/.env', '/app/x.js.map', '/app/.git/HEAD'])).toEqual([
      '/app/.env',
      '/app/x.js.map',
      '/app/.git/HEAD',
    ]);
  });

  it('anywhere in the image, and the variants: .env.<name>, a .git file (worktree link), any *.map', () => {
    expect(
      forbiddenImagePaths([
        '/.env',
        '/data/.env.production',
        '/usr/local/lib/node_modules/x/dist/index.mjs.map',
        '/app/bundled-release/0.1.0/public/admin/assets/app.css.map',
        '/srv/repo/.git',
        '/srv/repo/sub/.git/objects/ab/cdef',
      ]),
    ).toHaveLength(6);
  });

  it('names that only look alike pass', () => {
    expect(
      forbiddenImagePaths([
        '/app/.environment',
        '/app/env',
        '/app/.envrc.d/x',
        '/app/.gitignore',
        '/app/.github/workflows/x.yml',
        '/app/x.git/HEAD',
        '/app/map',
        '/app/.map',
        '/app/sitemap.xml',
        '/app/x.map.json',
        '/usr/share/zoneinfo/Asia/Jakarta',
      ]),
    ).toEqual([]);
  });

  it('keeps the order of the listing and ignores blank lines', () => {
    expect(forbiddenImagePaths(['', '/b/.env', '/a/y.map', '  '])).toEqual(['/b/.env', '/a/y.map']);
  });
});

describe('isRootUser', () => {
  it('no USER (empty), root, uid 0 (with or without a group) is root; node or 1000 is not', () => {
    for (const user of ['', ' ', 'root', '0', 'root:root', '0:0', '0:1000']) expect(isRootUser(user), user).toBe(true);
    for (const user of ['node', '1000', '1000:1000', 'node:node']) expect(isRootUser(user), user).toBe(false);
  });
});

describe('parseImageCheckArgs', () => {
  it('takes --image <tag>', () => {
    expect(parseImageCheckArgs(['--image', 'altis:0.1.0-test'])).toEqual({ image: 'altis:0.1.0-test' });
    expect(parseImageCheckArgs(['--image=arjunaayasa/altis@sha256:' + 'a'.repeat(64)])).toEqual({ image: 'arjunaayasa/altis@sha256:' + 'a'.repeat(64) });
  });

  it('refuses a missing or option-like tag and unknown flags (USAGE)', () => {
    expect(() => parseImageCheckArgs([])).toThrow(/^USAGE/);
    expect(() => parseImageCheckArgs(['--image', '--rm'])).toThrow(/^USAGE/);
    expect(() => parseImageCheckArgs(['--image', 'a b'])).toThrow(/^USAGE/);
    expect(() => parseImageCheckArgs(['--image', 'altis:x', '--fast'])).toThrow(/^USAGE/);
  });
});

/** A fake `docker`: answers by the first arguments, records every call. */
function fakeDocker(o: { user?: string; files?: string[]; appRoot?: string[]; fail?: 'inspect' | 'list' | 'appRoot' }): DockerExec & { calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout: string): DockerResult => ({ code: 0, stdout, stderr: '' });
  const exec = async (args: readonly string[]): Promise<DockerResult> => {
    calls.push([...args]);
    const failed: DockerResult = { code: 125, stdout: '', stderr: 'Error: No such image: altis:x\n' };
    if (args[0] === 'image') return o.fail === 'inspect' ? failed : ok(`${o.user ?? 'node'}\n`);
    const script = args[args.length - 1];
    if (script === LIST_FILES) return o.fail === 'list' ? failed : ok((o.files ?? ['/app/app.js', '/usr/local/bin/node']).join('\n') + '\n');
    if (script === APP_ROOT_CHECK) return o.fail === 'appRoot' ? failed : ok((o.appRoot ?? []).map((line) => `${line}\n`).join(''));
    throw new Error(`unexpected docker call: ${args.join(' ')}`);
  };
  return Object.assign(exec, { calls });
}

describe('checkImage', () => {
  it('a clean image passes: non-root user, no forbidden file, nothing in /app writable by it', async () => {
    const docker = fakeDocker({});
    const result = await checkImage('altis:x', docker);
    expect(result).toEqual({ ok: true, user: 'node', files: 2, forbidden: [], failures: [] });
    // the listing runs the brief's find, as root (so no folder is skipped), without network
    expect(docker.calls).toContainEqual(['run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'sh', 'altis:x', '-c', 'find / -xdev -type f']);
    expect(docker.calls).toContainEqual(['image', 'inspect', '--format', '{{.Config.User}}', 'altis:x']);
  });

  it('fails on any forbidden path, naming each', async () => {
    const result = await checkImage('altis:x', fakeDocker({ files: ['/app/app.js', '/app/.env', '/app/server.mjs.map'] }));
    expect(result.ok).toBe(false);
    expect(result.forbidden).toEqual(['/app/.env', '/app/server.mjs.map']);
    expect(result.failures.join('\n')).toMatch(/\/app\/\.env/);
  });

  it('fails when the image runs as root', async () => {
    for (const user of ['', 'root', '0:0']) {
      const result = await checkImage('altis:x', fakeDocker({ user }));
      expect(result.ok, user).toBe(false);
      expect(result.failures.join('\n'), user).toMatch(/root/);
    }
  });

  it('fails when something in /app is not root-owned or is world-writable (the app must write nothing there)', async () => {
    const result = await checkImage('altis:x', fakeDocker({ appRoot: ['/app/bundled-release'] }));
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/\/app\/bundled-release/);
  });

  it('a listing without /app/app.js (find did not run, or not this image) fails', async () => {
    const result = await checkImage('altis:x', fakeDocker({ files: ['/usr/local/bin/node'] }));
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/app\.js/);
  });

  it('a docker failure fails the check with its message', async () => {
    for (const fail of ['inspect', 'list', 'appRoot'] as const) {
      const result = await checkImage('altis:x', fakeDocker({ fail }));
      expect(result.ok, fail).toBe(false);
      expect(result.failures.join('\n'), fail).toMatch(/No such image/);
    }
  });
});

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');

/** The text of one top-level job of a workflow (its key line to the next job). */
function jobBlock(workflow: string, name: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`no job ${name}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[\w-]+:\s*$/.test(line));
  return rest.slice(0, end === -1 ? undefined : end).join('\n');
}

describe('where the check runs, and what it checks', () => {
  it('nightly.yml: the image-check job builds the image from the release zip as compose does and runs the check', () => {
    const job = jobBlock(read('.github', 'workflows', 'nightly.yml'), 'image-check');
    expect(job).toMatch(/needs: release$/m);
    expect(job).toContain('name: release-zip');
    expect(job).toContain('unzip -q dist/altis-0.1.0-test.zip -d "$RUNNER_TEMP/release"');
    expect(job).toContain('docker build --build-context release="$RUNNER_TEMP/release" --tag altis:image-check docker');
    expect(job).toContain('pnpm exec tsx tools/release/smoke/docker-image-check.ts --image altis:image-check');
    expect(job).toMatch(/if: always\(\)\n\s+run: docker image rm --force altis:image-check/);
  });

  it('compose.yml: credentials only from .env, with the altis-init hint; the install code passed through; no db port', () => {
    const compose = read('docker', 'compose.yml');
    expect(compose.match(/\$\{ALTIS_DB_PASSWORD:\?jalankan \.\/altis-init dulu\}/g)).toHaveLength(2); // app and db
    expect(compose).toContain('MARIADB_ROOT_PASSWORD: ${ALTIS_DB_ROOT_PASSWORD:?jalankan ./altis-init dulu}');
    expect(compose).toMatch(/^ {6}ALTIS_INSTALL_CODE: \$\{ALTIS_INSTALL_CODE:-\}$/m);
    // a non-root database user with its own schema only
    expect(compose).toMatch(/^ {6}MARIADB_USER: altis$/m);
    expect(compose).toMatch(/^ {6}MARIADB_DATABASE: altis$/m);
    expect(compose.match(/^\s*ports:/gm)).toHaveLength(1); // the app's, on loopback
    // the update path of a published image (§9.8)
    expect(compose).toContain('docker compose pull && docker compose up -d');
  });

  it('the image never gets altis-init or a .env: the .dockerignore allowlist lets only entrypoint.sh through', () => {
    const rules = read('docker', '.dockerignore')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(rules).toEqual(['*', '!entrypoint.sh']);
  });
});
