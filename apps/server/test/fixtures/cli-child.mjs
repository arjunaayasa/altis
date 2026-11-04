// Child process for the CLI tests, started through `node --import tsx` (cli-support.ts runCliChild).
//
// Usage: cli-child.mjs <optionsJson>, options {argv, dataDir, appRoot, runtime, version, env}. Runs
// runCli(argv, ctx, {env}) with a boot context like the bootloader's and exits with its code. A fault hook
// (ALTIS_TEST_FAULT in `env`) may kill the process first.
import path from 'node:path';
import { runCli } from '../../src/cli/index.ts';

// The sources run unbundled: give their test hooks the test profile that Vitest defines for the parent.
globalThis.__BUILD_PROFILE__ = 'test';

const o = JSON.parse(process.argv[2]);
const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const ctx = {
  bootProtocol: 1,
  appRoot: o.appRoot,
  dataDir: o.dataDir,
  release: { version: o.version, dir: path.join(o.appRoot, 'bundled-release', o.version), source: 'bundled' },
  runtime: o.runtime,
  port: 3000,
  markHealthy: async () => {},
  requestRestart: async () => {},
  bootMarker: { phase() {}, progress() {} },
  log: silent,
  // As app.js's context for a command: there is no server to serve on.
  serve() {
    throw new Error('serve() is not available to a command');
  },
};

const code = await runCli(o.argv, ctx, { env: o.env });
process.exitCode = code;
