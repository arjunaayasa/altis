import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_DIR, REPO_ROOT } from '../lib/server.js';

// The CI wiring of the E2E suite (Task 32 step 3; spec §12.3): a nightly job, none in the PR tier. The workflows'
// general rules (least privilege, actions pinned to SHAs) are checked in tools/release/smoke/run.test.ts.

const read = (...parts: string[]): string => fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');

/** The lines of job `name` of a workflow (up to the next job). */
function jobBlock(workflow: string, name: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`no job ${name}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[\w-]+:\s*$/.test(line));
  return rest.slice(0, end === -1 ? undefined : end).join('\n');
}

describe('nightly.yml: the e2e job', () => {
  const job = jobBlock(read('.github', 'workflows', 'nightly.yml'), 'e2e');

  it('runs `pnpm e2e` on the minimum Node after a frozen install, with mailpit up and required', () => {
    expect(job).toContain('node-version: ${{ env.NODE_VERSION }}');
    expect(job).toContain('- run: pnpm install --frozen-lockfile');
    expect(job).toContain('docker compose -f tools/test/compose.yml up -d --wait mailpit');
    expect(job).toMatch(/- run: pnpm e2e\n\s+env:\n\s+ALTIS_TEST_MAILPIT_REQUIRED: '1'/);
    expect(job).toMatch(/if: always\(\)\n\s+run: docker compose -f tools\/test\/compose.yml down/);
  });

  it("installs the Chromium of the pinned @playwright/test through the workspace's binary, never an unpinned npx", () => {
    expect(job).toContain('pnpm --filter @altis/e2e exec playwright install --with-deps chromium');
    const commands = job
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(commands).not.toMatch(/npx\s+playwright/);
  });

  it('uploads the traces, screenshots and the app logs when it fails', () => {
    expect(job).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} # v[\d.]+\n\s+if: failure\(\)/);
    for (const dir of ['tools/e2e/dist/test-results/', 'tools/e2e/dist/report/', 'tools/e2e/dist/run/']) expect(job).toContain(dir);
  });

  it('puts no untrusted input in a run step', () => {
    for (const line of job.split('\n').filter((l) => /^\s+(- )?run:/.test(l))) expect(line).not.toContain('${{');
  });
});

describe('the PR tier', () => {
  it('has no E2E (§12.3)', () => {
    expect(read('.github', 'workflows', 'pr.yml')).not.toMatch(/pnpm e2e|playwright/);
  });
});

describe('the wiring of the suite', () => {
  it('`pnpm e2e` runs the pinned Playwright of tools/e2e', () => {
    const root = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(root.scripts['e2e']).toBe('pnpm --filter @altis/e2e exec playwright test');
    const own = JSON.parse(fs.readFileSync(path.join(E2E_DIR, 'package.json'), 'utf8')) as { name: string; dependencies: Record<string, string> };
    expect(own.name).toBe('@altis/e2e');
    expect(own.dependencies['@playwright/test']).toBe('1.64.0');
    expect(own.dependencies['@altis/core']).toBe('workspace:*');
  });

  it('tools/e2e is a TypeScript project of its own (S22)', () => {
    const strip = (text: string): string => text.replace(/^\s*\/\/.*$/gm, '');
    const root = JSON.parse(strip(read('tsconfig.json'))) as { references: { path: string }[] };
    expect(root.references).toContainEqual({ path: 'tools/e2e' });
    const tools = JSON.parse(strip(read('tools', 'tsconfig.json'))) as { exclude: string[] };
    expect(tools.exclude).toContain('e2e');
  });
});
