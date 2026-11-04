import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// S20: the admin tests run in a project of their own (jsdom), which `pnpm test` runs next to `unit`; the unit project's
// `**/test/**/*.test.ts` must not pick them up (they would run without a DOM). Asked of Vitest itself: `vitest list`.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function vitestList(project: string): Promise<{ file: string; projectName: string }[]> {
  const bin = path.join(path.dirname(createRequire(path.join(REPO_ROOT, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [bin, 'list', '--project', project, '--filesOnly', '--json'],
      { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error !== null) return reject(new Error(`vitest list --project ${project}: ${error.message}\n${stderr}`));
        try {
          resolve(JSON.parse(stdout) as { file: string; projectName: string }[]);
        } catch (parseError) {
          reject(new Error(`vitest list printed no JSON: ${String(parseError)}\n${stdout}`));
        }
      },
    );
  });
}

const inAdmin = (file: string): boolean => path.relative(path.join(REPO_ROOT, 'apps', 'admin'), file).split(path.sep)[0] !== '..';

describe('vitest projects (S20)', () => {
  it('`pnpm test` runs the unit and the admin projects', async () => {
    const manifest = JSON.parse(await fsp.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(manifest.scripts['test']).toBe('vitest run --project unit --project admin');
  });

  it('the admin project collects the apps/admin tests, the unit project none of them', async () => {
    const [admin, unit] = await Promise.all([vitestList('admin'), vitestList('unit')]);
    const adminFiles = admin.map((entry) => entry.file);
    expect(adminFiles).toContain(path.join(REPO_ROOT, 'apps', 'admin', 'test', 'projects.test.ts'));
    expect(adminFiles.every(inAdmin)).toBe(true);
    expect(unit.length).toBeGreaterThan(0);
    expect(unit.filter((entry) => inAdmin(entry.file))).toEqual([]);
  }, 120_000);
});
