import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from '@playwright/test';
import { MAILPIT_API, MAILPIT_SMTP } from '../../packages/core/test/mailpit.js';
import { extractZip } from '../release/src/zip.js';
import { StaffApi } from './lib/api.js';
import { startFakeMailCatcher } from './lib/fake-mail.js';
import { MailCatcher, mailSetup } from './lib/mail.js';
import {
  E2E_VERSION,
  REPO_ROOT,
  RUN_DIR,
  buildEnv,
  childEnv,
  freePort,
  installInput,
  readAdminFixture,
  run,
  startApp,
  tail,
  waitHealthy,
} from './lib/server.js';

// The install every spec runs against (Task 32), set up once per run in the Playwright runner:
//
//   1. the release: `pnpm release --profile test --version 0.1.0-test --out <tmp>/build` (or the zip ALTIS_E2E_ZIP
//      names, for a quicker local rerun), unzipped into <tmp>/app with DATA_DIR <tmp>/altis-data beside it;
//   2. the mail catcher (lib/mail.ts): mailpit when the run asks for it, else the in-process one, started here;
//   3. `node app.js install --config <tmp>/install.json --runtime standalone`: SQLite, baseUrl
//      http://127.0.0.1:<free port>, the first super admin of fixtures/admin.json (test-only credentials);
//   4. `node app.js` with ALTIS_PORT, until /_health answers 200 with the zip's version;
//   5. as the super admin, through Playwright's request context (never global fetch, M24): SMTP to the catcher
//      (`security: 'none'`) with `PUT system/config` after a reauth.
//
// The specs find the install through ALTIS_E2E_BASE_URL and the catcher's API through ALTIS_E2E_MAIL_API (the workers
// start after this and inherit both). The teardown it returns stops the app and the catcher and removes the temp
// folder (ALTIS_E2E_KEEP=1 keeps it). Logs go to tools/e2e/dist/run/ (build, install, server), which CI uploads on
// failure with the traces.

const say = (line: string): void => void process.stderr.write(`e2e: ${line}\n`);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The sender address of the install's mail. */
const MAIL_FROM = 'perpustakaan@perpus.test';
const BUILD_TIMEOUT_MS = 15 * 60_000;
const INSTALL_TIMEOUT_MS = 2 * 60_000;
const HEALTH_TIMEOUT_MS = 90_000;

/** The release zip: ALTIS_E2E_ZIP (relative to where pnpm was run), or a fresh test-profile build. */
async function releaseZip(root: string): Promise<string> {
  const given = process.env['ALTIS_E2E_ZIP']?.trim() ?? '';
  if (given !== '') {
    const zip = path.resolve(process.env['INIT_CWD'] ?? process.cwd(), given);
    say(`release: ${zip} (ALTIS_E2E_ZIP)`);
    return zip;
  }
  const out = path.join(root, 'build');
  say(`release: pnpm release --profile test --version ${E2E_VERSION} (log: ${path.join(RUN_DIR, 'build.log')})…`);
  await run('pnpm release', 'pnpm', ['release', '--profile', 'test', '--version', E2E_VERSION, '--out', out], {
    cwd: REPO_ROOT,
    env: buildEnv(),
    log: path.join(RUN_DIR, 'build.log'),
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  return path.join(out, `altis-${E2E_VERSION}.zip`);
}

/** Where the install sends mail and where the specs read it; registers the in-process catcher's close. */
async function mailCatcher(onCleanup: (fn: () => Promise<void>) => void): Promise<{ smtp: { host: string; port: number }; api: string }> {
  const setup = mailSetup();
  if (setup.kind === 'mailpit') {
    const api = `http://${MAILPIT_API.host}:${MAILPIT_API.port}`;
    if (await new MailCatcher(api).available()) {
      say(`mail: mailpit (SMTP ${MAILPIT_SMTP.host}:${MAILPIT_SMTP.port}, API ${api})`);
      return { smtp: { ...MAILPIT_SMTP }, api };
    }
    if (setup.required) {
      throw new Error('mailpit does not answer, and ALTIS_TEST_MAILPIT_REQUIRED=1 requires it: docker compose -f tools/test/compose.yml up -d --wait mailpit');
    }
    say('mail: mailpit does not answer; using the in-process catcher');
  }
  const fake = await startFakeMailCatcher();
  onCleanup(() => fake.close());
  say(`mail: in-process catcher (SMTP ${fake.smtp.host}:${fake.smtp.port}, API ${fake.api})`);
  return { smtp: fake.smtp, api: fake.api };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const cleanups: (() => Promise<void>)[] = [];
  const teardown = async (): Promise<void> => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch (error) {
        say(`cleanup: ${messageOf(error)}`);
      }
    }
  };

  try {
    await fsp.rm(RUN_DIR, { recursive: true, force: true });
    await fsp.mkdir(RUN_DIR, { recursive: true });
    const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-e2e-')));
    if (process.env['ALTIS_E2E_KEEP'] === '1') say(`keeping ${root} (ALTIS_E2E_KEEP=1)`);
    else cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

    // 1. The release, unzipped; DATA_DIR beside the app (never inside it, P16). The specs that need an app of their
    //    own (1c Task 34: uninstalled-setup.ts) unzip the same release (ALTIS_E2E_RELEASE_ZIP).
    const zip = await releaseZip(root);
    process.env['ALTIS_E2E_RELEASE_ZIP'] = zip;
    const appRoot = path.join(root, 'app');
    const dataDir = path.join(root, 'altis-data');
    await extractZip(await fsp.readFile(zip), appRoot);
    await fsp.mkdir(dataDir, { mode: 0o700 });
    const version = (JSON.parse(await fsp.readFile(path.join(appRoot, 'package.json'), 'utf8')) as { version: string }).version;

    // 2. Mail.
    const mail = await mailCatcher((fn) => void cleanups.push(fn));

    // 3. The headless install (its input holds the admin's password: owner-only, removed with the temp folder).
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const admin = readAdminFixture();
    const installFile = path.join(root, 'install.json');
    await fsp.writeFile(installFile, `${JSON.stringify(installInput({ baseUrl, admin }))}\n`, { mode: 0o600, flag: 'wx' });
    const env = { ...childEnv(), ALTIS_DATA_DIR: dataDir };
    say(`install: ${version}, standalone + SQLite, ${baseUrl}…`);
    await run('install', process.execPath, ['app.js', 'install', '--config', installFile, '--runtime', 'standalone'], {
      cwd: appRoot,
      env,
      log: path.join(RUN_DIR, 'install.log'),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });

    // 4. The server.
    const serverLog = path.join(RUN_DIR, 'server.log');
    const app = startApp({ appRoot, env: { ...env, ALTIS_PORT: String(port) }, log: serverLog });
    cleanups.push(() => app.stop());
    let health: { version: string | undefined };
    try {
      health = await waitHealthy(baseUrl, { timeoutMs: HEALTH_TIMEOUT_MS, alive: app.alive });
    } catch (error) {
      throw new Error(`${messageOf(error)}\n----- server.log\n${tail(serverLog)}`, { cause: error });
    }
    if (health.version !== version) throw new Error(`/_health reports version ${String(health.version)}, the zip is ${version}`);
    say(`server: healthy at ${baseUrl} (log: ${serverLog})`);

    // 5. SMTP to the catcher, as the super admin.
    const api = await StaffApi.open(request, baseUrl);
    try {
      await api.signIn(admin.username, admin.password);
      await api.reauth(admin.password);
      await api.call('PUT', 'system/config', { smtp: { host: mail.smtp.host, port: mail.smtp.port, security: 'none', from: MAIL_FROM } });
    } finally {
      await api.dispose();
    }

    process.env['ALTIS_E2E_BASE_URL'] = baseUrl;
    process.env['ALTIS_E2E_MAIL_API'] = mail.api;
    return teardown;
  } catch (error) {
    await teardown();
    throw error;
  }
}
