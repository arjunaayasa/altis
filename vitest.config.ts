import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Vitest >= 4 no longer reads vitest.workspace.ts; projects are declared here. Every project excludes `.claude/**`:
// agent worktrees (.claude/worktrees/<name>, full checkouts of this repository) must not be run as part of it.
export default defineConfig({
  // Test-only hooks (ALTIS_TEST_FAULT, ALTIS_TEST_FAKE_NODE_VERSION) are guarded by
  // `__BUILD_PROFILE__ !== 'production'`; the tests always run with the 'test' profile. `__TEST_FIXTURE__` is the
  // release fixture level (decision D1d-26): 1, the 0.1.0-test schema; tests pick levels 2 and 3 explicitly
  // (`releaseMigrations(level)`).
  define: { __BUILD_PROFILE__: JSON.stringify('test'), __TEST_FIXTURE__: '1' },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['**/test/**/*.test.ts', 'tools/**/*.test.ts'],
          // packages/db/test/*.test.ts and every test/db/ folder (apps/server, packages/core, ...) need a database
          // engine (the db project); packages/db/test/unit/ does not. apps/admin's tests need a DOM (the admin project).
          exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'packages/db/test/*.test.ts', '**/test/db/**', 'apps/admin/**'],
        },
      },
      {
        // The admin SPA (Task 27, S20): React components and hooks under jsdom. `__ALTIS_BUILD__` is the version the
        // SPA was built for (Vite `define` from ALTIS_BUILD); the `@/` alias is the one of apps/admin/vite.config.ts.
        extends: true,
        define: { __ALTIS_BUILD__: JSON.stringify('0.1.0') },
        resolve: { alias: { '@': path.resolve(import.meta.dirname, 'apps/admin/src') } },
        test: {
          name: 'admin',
          environment: 'jsdom',
          include: ['apps/admin/test/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
          setupFiles: ['apps/admin/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          include: ['packages/db/test/**/*.test.ts', '**/test/db/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'packages/db/test/unit/**'],
          // ALTIS_TEST_DB picks the engine (default sqlite); one database per worker (tools/test/test-db.ts).
          globalSetup: ['tools/test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
