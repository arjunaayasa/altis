import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll } from 'vitest';
import { REPO_ROOT } from './make-release.js';

// The real server (apps/server) as a release's server.mjs, bundled the way the release build does it (global
// constraints: esbuild node/esm/node22.16, bundled, minified, the createRequire banner, node:sqlite external; test
// profile). Lets boot.test.ts run apps/server's start(ctx) under app.js.

const SERVER_ENTRY = path.join(REPO_ROOT, 'apps', 'server', 'src', 'index.ts');

/** Builds the server bundle once for the calling describe block; `file()` is its path, removed afterwards. */
export function useServerBundle(): { file(): string } {
  let dir = '';
  beforeAll(async () => {
    dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-server-bundle-')));
    await build({
      entryPoints: [SERVER_ENTRY],
      outfile: path.join(dir, 'server.mjs'),
      platform: 'node',
      format: 'esm',
      target: 'node22.16',
      bundle: true,
      minify: true,
      legalComments: 'none',
      external: ['node:sqlite'],
      logLevel: 'silent',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      define: { __BUILD_PROFILE__: JSON.stringify('test') },
    });
  });
  afterAll(async () => {
    if (dir !== '') await fsp.rm(dir, { recursive: true, force: true });
  });
  return { file: () => path.join(dir, 'server.mjs') };
}
