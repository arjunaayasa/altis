import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Page, Response } from '@playwright/test';
import type { OpView } from '@altis/shared/api/ops';
import { buildFeed } from '../../release/feed/build.js';
import { startFeedDev, type FeedDev } from '../../release/feed/serve.js';
import type { OwnApp } from '../uninstalled-setup.js';
import { REPO_ROOT, RUN_DIR, buildEnv, run } from './server.js';

// What the update specs of 1d Task 35 share (A7, A8):
//
// - the releases: N−1 is the suite's own (ALTIS_E2E_RELEASE_ZIP, 0.1.0-test), N the test build 0.2.0-test, given as
//   ALTIS_E2E_UPDATE_ZIP or built once per run into tools/e2e/dist/run/ (a run that never reaches an update spec never
//   builds it);
// - the signed feed of N (tools/release/feed: `buildFeed` with the dev keys, served on 127.0.0.1 by feed-dev), and the
//   app pointed at it with `node app.js config:set update.feedUrl`, as a field tester does;
// - what `/admin/_update` did, read off the browser's own traffic: every `GET ops/current` answer (the op's state and
//   who answered, `X-Altis-Serving: server` or `app`), its `POST ops/drive` calls, and the SSE stream requests.

/** The release an update spec updates to (decision D1d-26: 0.2.0-test brings 9001_test_expand). */
export const UPDATE_VERSION = '0.2.0-test';

/** The dev keys (tools/keys/dev): test builds trust them; production builds refuse them (R65b). */
const DEV_KEYS = path.join(REPO_ROOT, 'tools', 'keys', 'dev');
export const devKey = (kid: string): string => path.join(DEV_KEYS, `${kid}.key.json`);
export const DEV_KEYSET = path.join(DEV_KEYS, 'keyset.json');
export const DEV_ROOTS = path.join(DEV_KEYS, 'roots.json');

const BUILD_TIMEOUT_MS = 15 * 60_000;

/** The zip of release N: ALTIS_E2E_UPDATE_ZIP (relative to where pnpm was run), or a test build made once per run. */
export async function updateZip(): Promise<string> {
  const given = process.env['ALTIS_E2E_UPDATE_ZIP']?.trim() ?? '';
  if (given !== '') return path.resolve(process.env['INIT_CWD'] ?? process.cwd(), given);
  const out = path.join(RUN_DIR, `build-${UPDATE_VERSION}`);
  const zip = path.join(out, `altis-${UPDATE_VERSION}.zip`);
  try {
    await fsp.access(zip);
    return zip;
  } catch {
    // not built yet in this run
  }
  await fsp.mkdir(RUN_DIR, { recursive: true });
  await run('pnpm release (N)', 'pnpm', ['release', '--profile', 'test', '--version', UPDATE_VERSION, '--out', out], {
    cwd: REPO_ROOT,
    env: buildEnv(),
    log: path.join(RUN_DIR, `build-${UPDATE_VERSION}.log`),
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  return zip;
}

/**
 * feed-dev on `<app root>/feed` with the signed feed of `zips` (seq `seq`), and the app pointed at it. The caller
 * closes the server (`dev.close()`), or the app's dispose leaves it to the process's end.
 */
export async function serveFeed(app: OwnApp, zips: readonly string[], seq = 1): Promise<FeedDev> {
  const dir = path.join(app.root, 'feed');
  await fsp.mkdir(dir, { recursive: true });
  const dev = await startFeedDev({ dir });
  await buildFeed({
    zips: [...zips],
    channel: 'stable',
    baseUrl: dev.url,
    out: dir,
    releaseKey: devKey('dev-rel-1'),
    timestampKey: devKey('dev-ts-1'),
    keyset: DEV_KEYSET,
    rootKeys: DEV_ROOTS,
    seq,
    expiresInDays: 14,
  });
  await app.cli(['config:set', 'update.feedUrl', dev.url]);
  return dev;
}

// ---------------------------------------------------------------------------------------------------------------
// The operations page's traffic

export interface OpsTraffic {
  /** The op states `GET ops/current` answered, in order, each once per run of equal states. */
  states: string[];
  /** Every answer of `GET ops/current`: its status, who answered and the op's state (null: no op view). */
  polls: { status: number; serving: string | null; state: string | null }[];
  /** `POST ops/drive` calls the page made. */
  drives: number;
  /** `GET events/stream` answers (the page's EventSource): status and who answered. */
  streams: { status: number; serving: string | null }[];
  /** The op view of the last 200 answer. */
  last: OpView | null;
}

/** Starts recording what `page` (and every page it loads later) asks of the ops routes. */
export function recordOpsTraffic(page: Page): OpsTraffic {
  const traffic: OpsTraffic = { states: [], polls: [], drives: 0, streams: [], last: null };
  page.on('response', (response: Response) => {
    const url = new URL(response.url());
    const serving = response.headers()['x-altis-serving'] ?? null;
    if (url.pathname === '/api/v1/ops/drive' && response.request().method() === 'POST') {
      traffic.drives += 1;
    } else if (url.pathname === '/api/v1/events/stream') {
      traffic.streams.push({ status: response.status(), serving });
    } else if (url.pathname === '/api/v1/ops/current') {
      const entry: OpsTraffic['polls'][number] = { status: response.status(), serving, state: null };
      traffic.polls.push(entry);
      if (response.status() !== 200) return;
      response.json().then(
        (view: OpView) => {
          entry.state = view.state;
          traffic.last = view;
          if (traffic.states.at(-1) !== view.state) traffic.states.push(view.state);
        },
        () => undefined, // the page went away mid-body
      );
    }
  });
  return traffic;
}

/** The states of an update op after which it reverts (an update that must succeed never shows one). */
export const REVERT_STATES: readonly string[] = Object.freeze(['reverting', 'rolled_back', 'restoring', 'restored', 'restore_failed']);

/** The terminal states of an update op (§9.4). */
export const UPDATE_END_STATES: readonly string[] = Object.freeze(['done', 'aborted', 'rolled_back', 'restored', 'restore_failed']);

/**
 * The state of the op in the app's DATA_DIR/ops/op.json (null without one). The page of an op that had already ended
 * when it was loaded polls nothing (it shows the end and goes back to Beranda), so a spec reads the end here.
 */
export async function opFileState(app: OwnApp): Promise<string | null> {
  return (await opFile(app))?.state ?? null;
}

/** The app's DATA_DIR/ops/op.json: its state and error code (null without a readable file). */
export async function opFile(app: OwnApp): Promise<{ state: string | null; error: string | null } | null> {
  try {
    const op = JSON.parse(await fsp.readFile(path.join(app.dataDir, 'ops', 'op.json'), 'utf8')) as { state?: unknown; error?: { code?: unknown } | null };
    return { state: typeof op.state === 'string' ? op.state : null, error: typeof op.error?.code === 'string' ? op.error.code : null };
  } catch {
    return null;
  }
}
