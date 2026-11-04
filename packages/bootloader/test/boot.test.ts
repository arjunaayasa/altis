import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair } from '@altis/crypto';
import { describe, expect, it } from 'vitest';
import { buildBootloader } from '../src/build.js';
import {
  BUNDLED_VERSION,
  freePort,
  healthJson,
  httpGet,
  logLines,
  notStarting,
  releasesPath,
  rescueReason,
  useHarness,
  waitFor,
  waitForHttp,
  type AppProcess,
  type HttpReply,
  type Sandbox,
  type SpawnOptions,
} from './helpers/harness.js';
import { END_THEN_REJECT_BYTES, devKeysetText, keysetDoc, loadDevKey, makeRelease, type Signer } from './helpers/make-release.js';
import { useServerBundle } from './helpers/server-bundle.js';

// `node app.js` end to end (spec §9.2 for 1a): boot order, release verification, the rescue server, fallback to
// `previous`, port errors and CLI forwarding. Every case runs app.js as a child process with a clean environment
// and ALTIS_RUNTIME=service (no supervisor), so the process that serves is the one spawned. app.js owns the one
// http.Server and listens before it imports the release; releases serve through ctx.serve (ruling R64).

const h = useHarness();
const SPY = path.join(import.meta.dirname, 'fixtures', 'require-spy.cjs');
const PASSENGER = path.join(import.meta.dirname, 'fixtures', 'passenger-preload.cjs');
const DROPS_LISTEN_CALLBACK = path.join(import.meta.dirname, 'fixtures', 'listen-drops-callback.cjs');

/** The first super admin every install input names (Task 24). */
const ADMIN = { username: 'admin', name: 'Admin', password: 'kuda-lumping-biru' };

const STATE = {
  schema: 1,
  active: { version: BUNDLED_VERSION, source: 'bundled' },
  previous: null,
  pending: null,
  pendingSince: null,
  pinned: null,
};

async function writeReleasesFile(sb: Sandbox, name: string, text: string): Promise<void> {
  await fsp.mkdir(releasesPath(sb), { recursive: true });
  await fsp.writeFile(releasesPath(sb, name), text);
}

/** The rescue page of `urlPath` and `/_health`, checked for what every rescue reply must hold. */
async function expectRescue(sb: Sandbox, reason: string, urlPath = '/'): Promise<string> {
  const health = await waitForHttp(sb.port, '/_health', notStarting);
  expect(health.status).toBe(503);
  expect(health.headers['retry-after']).toBe('30');
  expect(health.headers['content-type']).toMatch(/^application\/json/);
  expect(healthJson(health)).toEqual({ status: 'rescue', reason });

  const page = await httpGet(sb.port, urlPath);
  expect(page.status).toBe(503);
  expect(page.headers['retry-after']).toBe('30');
  expect(page.headers['content-type']).toMatch(/^text\/html/);
  expect(page.headers['cache-control']).toBe('no-store');
  expect(page.body).toContain(reason);
  // Leaks nothing: no path, hostname, stack or error text.
  for (const secret of [sb.root, sb.dataDir, sb.appRoot, os.hostname(), 'Error', '    at ', 'RELEASE_INVALID:']) {
    expect(page.body).not.toContain(secret);
    expect(health.body).not.toContain(secret);
  }
  // Indonesian first, then English.
  expect(page.body.indexOf('lang="id"')).toBeGreaterThan(-1);
  expect(page.body.indexOf('lang="id"')).toBeLessThan(page.body.indexOf('lang="en"'));

  const head = await httpGet(sb.port, '/', 'HEAD');
  expect(head.status).toBe(503);
  expect(head.body).toBe('');
  return page.body;
}

describe('a valid bundled release', { timeout: 30_000 }, () => {
  it('serves /_health from the release and initialises current.json', async () => {
    const sb = await h.sandbox();
    const app = h.spawn(sb);
    const health = await waitForHttp(sb.port, '/_health', (r) => r.status === 200);
    expect(healthJson(health)).toEqual({ status: 'ok', version: BUNDLED_VERSION, source: 'bundled', pid: app.pid, runtime: 'service' });

    const current = JSON.parse(await fsp.readFile(releasesPath(sb, 'current.json'), 'utf8')) as unknown;
    expect(current).toEqual(STATE);

    const ctx = healthJson(await httpGet(sb.port, '/__ctx'));
    expect(ctx).toEqual({
      keys: [
        'appJsVersion',
        'appRoot',
        'bootMarker',
        'bootProtocol',
        'bundledRelease',
        'dataDir',
        'log',
        'markHealthy',
        'port',
        'release',
        'requestRestart',
        'runtime',
        'serve',
      ],
      bootProtocol: 1,
      appRoot: sb.appRoot,
      dataDir: sb.dataDir,
      release: { version: BUNDLED_VERSION, dir: sb.bundledDir, source: 'bundled' },
      runtime: 'service',
      port: sb.port,
      // 1c Task 23 (C29): app.js says its own version.
      appJsVersion: BUNDLED_VERSION,
      // 1d Task 16 (§9.8): the bundled release, the same as the one booted; no pendingBoot, no bootMode (normal).
      bundledRelease: { version: BUNDLED_VERSION, dir: sb.bundledDir, relation: 'same' },
      bootMarker: ['phase', 'progress', 'waiting'],
    });
  });

  it('boots an existing current.json as it is and writes nothing back (markHealthy without a pending release)', async () => {
    const sb = await h.sandbox();
    const text = `${JSON.stringify(STATE)}\n`;
    await writeReleasesFile(sb, 'current.json', text);
    const before = await fsp.stat(releasesPath(sb, 'current.json'));
    h.spawn(sb);
    await waitForHttp(sb.port, '/_health', (r) => r.status === 200);
    expect(await fsp.readFile(releasesPath(sb, 'current.json'), 'utf8')).toBe(text);
    expect((await fsp.stat(releasesPath(sb, 'current.json'))).mtimeMs).toBe(before.mtimeMs);
    await expect(fsp.stat(releasesPath(sb, 'current.json.bak'))).rejects.toThrow();
  });
});

describe('Node too old (Review Focus 4, ruling R56)', { timeout: 30_000 }, () => {
  it('answers every path with the NODE_TOO_OLD rescue page', async () => {
    const sb = await h.sandbox();
    h.spawn(sb, { env: { ALTIS_TEST_FAKE_NODE_VERSION: '20.11.0' } });
    const page = await expectRescue(sb, 'NODE_TOO_OLD', '/admin/anything?x=1');
    expect(page).toContain('Node 22.16');
    expect(page).toContain('Setup Node.js App');
    expect(page).not.toContain('20.11.0');
    // Nothing after the check ran: DATA_DIR was not even created.
    await expect(fsp.stat(sb.dataDir)).rejects.toThrow();
  });

  it('loads nothing but http before the check passes', async () => {
    const sb = await h.sandbox();
    const spyFile = path.join(sb.root, 'spy-old.txt');
    h.spawn(sb, { execArgv: ['--require', SPY], env: { ALTIS_TEST_FAKE_NODE_VERSION: '16.20.2', SPY_FILE: spyFile } });
    await expectRescue(sb, 'NODE_TOO_OLD');
    const loaded = new Set((await fsp.readFile(spyFile, 'utf8')).split('\n').filter((line) => line !== ''));
    expect([...loaded]).toEqual(['http']);

    // Control: on a supported Node the spy does see what loads after the check.
    const ok = await h.sandbox();
    const okSpy = path.join(ok.root, 'spy-ok.txt');
    h.spawn(ok, { execArgv: ['--require', SPY], env: { SPY_FILE: okSpy } });
    await waitForHttp(ok.port, '/_health', (r) => r.status === 200);
    const okLoaded = (await fsp.readFile(okSpy, 'utf8')).split('\n');
    expect(okLoaded).toContain('node:crypto');
    expect(okLoaded).toContain('node:fs/promises');
  });

  it('refuses a command on the command line with a message and exit code 1', async () => {
    const sb = await h.sandbox();
    const app = h.spawn(sb, { args: ['doctor'], env: { ALTIS_TEST_FAKE_NODE_VERSION: '20.11.0' } });
    expect((await app.exited).code).toBe(1);
    expect(app.stderr()).toContain('Node 22.16');
    expect(app.stderr()).toContain('20.11.0');
    expect(app.stdout()).toBe('');
  });
});

describe('DATA_DIR checks', { timeout: 30_000 }, () => {
  it('refuses a DATA_DIR inside public_html (DOCROOT_EXPOSED) and creates nothing there', async () => {
    const sb = await h.sandbox();
    await fsp.mkdir(path.join(sb.home, 'public_html'));
    const dataDir = path.join(sb.home, 'public_html', 'altis-data');
    h.spawn(sb, { env: { ALTIS_DATA_DIR: dataDir } });
    const page = await expectRescue(sb, 'DOCROOT_EXPOSED');
    expect(page).not.toContain(dataDir);
    expect(page).toContain('public_html');
    await expect(fsp.stat(dataDir)).rejects.toThrow();
  });

  it('refuses a DATA_DIR that cannot be created (DATA_DIR_UNWRITABLE)', async () => {
    const sb = await h.sandbox();
    await fsp.writeFile(sb.dataDir, 'a file, not a folder');
    h.spawn(sb);
    await expectRescue(sb, 'DATA_DIR_UNWRITABLE');
  });
});

describe('current.json (Review Focus 2)', { timeout: 30_000 }, () => {
  it('boots from current.json.bak when current.json was truncated, and repairs it', async () => {
    const sb = await h.sandbox();
    const text = JSON.stringify(STATE);
    await writeReleasesFile(sb, 'current.json', text.slice(0, 25));
    await writeReleasesFile(sb, 'current.json.bak', text);
    h.spawn(sb);
    await waitForHttp(sb.port, '/_health', (r) => r.status === 200);
    expect(JSON.parse(await fsp.readFile(releasesPath(sb, 'current.json'), 'utf8'))).toEqual(STATE);
  });

  it('waits out a current.lock left by a killed container (another PID namespace) instead of failing the boot', async () => {
    const sb = await h.sandbox();
    // A holder this process cannot see: another host identity, so only the lock's age tells (R33). Test knob: the
    // lock goes stale 12 s after its last refresh (production: 30 s), still longer than withFileLock's default 10 s wait.
    await writeReleasesFile(
      sb,
      'current.lock',
      JSON.stringify({ pid: 4242, startMs: Date.now(), token: 'killed-container', host: 'old-container/boot-1/pid:[4026532999]' }),
    );
    const app = h.spawn(sb, { env: { ALTIS_TEST_LOCK_STALE_MS: '12000' } });
    const reply = await waitForHttp(sb.port, '/_health', notStarting, 25_000);
    expect(reply.status, reply.body).toBe(200);
    expect(healthJson(reply)).toMatchObject({ status: 'ok', pid: app.pid });
  });

  it('serves STATE_CORRUPT when current.json and its .bak are both corrupt, and boots no release', async () => {
    const sb = await h.sandbox();
    await writeReleasesFile(sb, 'current.json', '{"schema":1,"act');
    await writeReleasesFile(sb, 'current.json.bak', '{"schema":1,"active":{"version":"not-semver","source":"bundled"}}');
    h.spawn(sb);
    await expectRescue(sb, 'STATE_CORRUPT');
  });
});

describe('config.json (Review Focus 2)', { timeout: 30_000 }, () => {
  async function writeConfigFile(sb: Sandbox, name: string, text: string): Promise<void> {
    await fsp.mkdir(sb.dataDir, { recursive: true });
    await fsp.writeFile(path.join(sb.dataDir, name), text);
  }

  it.each([
    ['both unparseable', '{"version":1,"baseU', '{"vers'],
    ['config.json not an object, no .bak', '[1,2,3]', null],
  ])('serves CONFIG_CORRUPT (%s), starts no release, and names config.json and doctor', async (_case, main, bak) => {
    const sb = await h.sandbox();
    await writeConfigFile(sb, 'config.json', main);
    if (bak !== null) await writeConfigFile(sb, 'config.json.bak', bak);
    const app = h.spawn(sb);
    const page = await expectRescue(sb, 'CONFIG_CORRUPT');
    expect(page).toContain('config.json');
    expect(page).toContain('node app.js doctor');
    expect(logLines(app.stderr()).some((l) => l['msg'] === 'starting release')).toBe(false);
    expect(app.stderr()).toContain('CONFIG_CORRUPT');
  });

  it('standalone: the supervised child serves CONFIG_CORRUPT (no crash loop)', async () => {
    const sb = await h.sandbox();
    await writeConfigFile(sb, 'config.json', '{"version":1,"baseU');
    const app = h.spawn(sb, { env: { ALTIS_RUNTIME: undefined } });
    await expectRescue(sb, 'CONFIG_CORRUPT');
    expect(logLines(app.stderr()).filter((l) => l['msg'] === 'server process crashed')).toEqual([]);
  });

  it('boots from config.json.bak when only config.json is torn (no rescue)', async () => {
    const sb = await h.sandbox();
    await writeConfigFile(sb, 'config.json', '{"version":1,"baseU');
    await writeConfigFile(sb, 'config.json.bak', JSON.stringify({ version: 1 }));
    h.spawn(sb);
    expect((await waitForHttp(sb.port, '/_health', notStarting)).status).toBe(200);
  });

  it('a command still runs with a corrupt config.json (doctor must be able to report it)', async () => {
    const sb = await h.sandbox();
    await writeConfigFile(sb, 'config.json', '{"version":1,"baseU');
    const app = h.spawn(sb, { args: ['doctor'] });
    expect((await app.exited).code).toBe(7); // the fixture's runCli ran
  });
});

describe('release verification', { timeout: 30_000 }, () => {
  it('serves RELEASE_INVALID when one byte of server.mjs was changed', async () => {
    const sb = await h.sandbox();
    const file = path.join(sb.bundledDir, 'server.mjs');
    const bytes = await fsp.readFile(file);
    bytes[10] = (bytes[10] as number) ^ 0x01;
    await fsp.writeFile(file, bytes);
    h.spawn(sb);
    const page = await expectRescue(sb, 'RELEASE_INVALID');
    expect(page).not.toContain('hash:');
  });

  it('serves RELEASE_INVALID when .complete is missing', async () => {
    const sb = await h.sandbox();
    await fsp.rm(path.join(sb.bundledDir, '.complete'));
    h.spawn(sb);
    await expectRescue(sb, 'RELEASE_INVALID');
  });
});

describe('release keys: root-signed keysets only (ruling R65)', { timeout: 30_000 }, () => {
  /** A release key app.js does not know, as a signer for makeRelease, and its public half. */
  function strangerKey(kid = 'test-rel-9'): { signer: Signer; pub: string } {
    const { privateKey, pub } = generateKeyPair();
    return { signer: { kid, privateKey }, pub };
  }

  /** The bundled release's keyset.json plus `docs`, as the text of a keyset.json. */
  function devKeysetWith(...docs: unknown[]): string {
    return JSON.stringify([...(JSON.parse(devKeysetText()) as unknown[]), ...docs], null, 2);
  }

  it("fresh install: the bundled release's own keyset.json is all app.js needs besides its embedded root", async () => {
    const sb = await h.sandbox();
    h.spawn(sb);
    const health = await waitForHttp(sb.port, '/_health', notStarting);
    expect(health.status).toBe(200);
    expect(healthJson(health)['version']).toBe(BUNDLED_VERSION);
    await expect(fsp.stat(releasesPath(sb, 'keyset.json'))).rejects.toThrow(); // nothing in DATA_DIR
  });

  it('a release without keyset.json is RELEASE_INVALID: the embedded root signs no release itself', async () => {
    const sb = await h.sandbox({ bundled: { keyset: null } });
    h.spawn(sb);
    await expectRescue(sb, 'RELEASE_INVALID');
  });

  it('a revocation of the signing release key in DATA_DIR/releases/keyset.json: RELEASE_INVALID rescue', async () => {
    const sb = await h.sandbox(); // signed by dev-rel-1, trusted through the bundled keyset
    const revoke = keysetDoc({ seq: 2, keys: [], revokedKids: ['dev-rel-1'] });
    await writeReleasesFile(sb, 'keyset.json', JSON.stringify([revoke]));
    h.spawn(sb);
    await expectRescue(sb, 'RELEASE_INVALID');
  });

  it('the revocation counts whatever its seq, and wherever it is shipped (a release keyset.json too)', async () => {
    const lowSeq = keysetDoc({ seq: 1, keys: [], revokedKids: ['dev-rel-1'] });
    const sb = await h.sandbox({ bundled: { keyset: devKeysetWith(lowSeq) } });
    h.spawn(sb);
    await expectRescue(sb, 'RELEASE_INVALID');
  });

  it('a keyset document signed by a release key counts for nothing: it can neither revoke nor add', async () => {
    // dev-rel-2 "revokes" dev-rel-1, which signs the bundled release: ignored, the release serves.
    const sb = await h.sandbox();
    const counter = keysetDoc({ seq: 1, keys: [], revokedKids: ['dev-rel-1'] }, loadDevKey('dev-rel-2'));
    await writeReleasesFile(sb, 'keyset.json', JSON.stringify([counter]));
    const app = h.spawn(sb);
    expect((await waitForHttp(sb.port, '/_health', notStarting)).status).toBe(200);
    expect(logLines(app.stderr()).filter((l) => l['msg'] === 'keyset document ignored')).toEqual([
      expect.objectContaining({ source: 'DATA_DIR/releases/keyset.json', index: 0, reason: 'SIG_INVALID:kid' }),
    ]);
    app.child.kill('SIGTERM');
    await app.exited;

    // dev-rel-1 "adds" test-rel-9, which signs the release: not trusted.
    const stranger = strangerKey();
    const add = keysetDoc({ seq: 2, keys: [{ kid: 'test-rel-9', use: 'release', pub: stranger.pub }], revokedKids: [] }, loadDevKey('dev-rel-1'));
    const other = await h.sandbox({ bundled: { signer: stranger.signer, keyset: devKeysetWith(add) } });
    h.spawn(other);
    await expectRescue(other, 'RELEASE_INVALID');
  });

  it('trusts a release key that a root-signed document adds, in DATA_DIR or in the release itself', async () => {
    const stranger = strangerKey();
    const add = keysetDoc({ seq: 2, keys: [{ kid: 'test-rel-9', use: 'release', pub: stranger.pub }], revokedKids: [] });
    const sb = await h.sandbox({ bundled: { signer: stranger.signer } });

    // Not trusted by the root and the dev keyset alone.
    const first = h.spawn(sb);
    await expectRescue(sb, 'RELEASE_INVALID');
    first.child.kill('SIGTERM');
    await first.exited;

    await writeReleasesFile(sb, 'keyset.json', JSON.stringify([add]));
    h.spawn(sb);
    expect(healthJson(await waitForHttp(sb.port, '/_health', (r) => r.status === 200))['version']).toBe(BUNDLED_VERSION);

    const shipped = await h.sandbox({ bundled: { signer: stranger.signer, keyset: devKeysetWith(add) } });
    h.spawn(shipped);
    expect((await waitForHttp(shipped.port, '/_health', notStarting)).status).toBe(200);
  });

  it('a document that touches the root is ignored as a whole', async () => {
    const sb = await h.sandbox();
    const root = loadDevKey('dev-root-1');
    const revokesRoot = keysetDoc({ seq: 3, keys: [], revokedKids: ['dev-rel-1', 'dev-root-1'] }, root);
    await writeReleasesFile(sb, 'keyset.json', JSON.stringify([revokesRoot]));
    const app = h.spawn(sb);
    expect((await waitForHttp(sb.port, '/_health', notStarting)).status).toBe(200);
    expect(logLines(app.stderr()).filter((l) => l['msg'] === 'keyset document ignored')).toEqual([
      expect.objectContaining({ source: 'DATA_DIR/releases/keyset.json', index: 0, reason: 'root' }),
    ]);
  });

  it('R65a: a revocation shipped in the bundled release counts for a data release, with no DATA_DIR keyset at all', async () => {
    const revoke = keysetDoc({ seq: 2, keys: [], revokedKids: ['dev-rel-1'] });
    // The bundled release (signed by dev-rel-2) carries the revocation; the active data release (dev-rel-1) does not.
    const sb = await h.sandbox({ bundled: { signer: loadDevKey('dev-rel-2'), keyset: devKeysetWith(revoke) } });
    await makeRelease(releasesPath(sb, '0.2.0-test'), { version: '0.2.0-test' });
    await writeReleasesFile(sb, 'current.json', JSON.stringify({ ...STATE, active: { version: '0.2.0-test', source: 'data' } }));
    h.spawn(sb);
    await expectRescue(sb, 'RELEASE_INVALID');
    await expect(fsp.stat(releasesPath(sb, 'keyset.json'))).rejects.toThrow();

    // Control: without that revocation the data release serves.
    const control = await h.sandbox({ bundled: { signer: loadDevKey('dev-rel-2') } });
    await makeRelease(releasesPath(control, '0.2.0-test'), { version: '0.2.0-test' });
    await writeReleasesFile(control, 'current.json', JSON.stringify({ ...STATE, active: { version: '0.2.0-test', source: 'data' } }));
    h.spawn(control);
    expect(healthJson(await waitForHttp(control.port, '/_health', notStarting))).toMatchObject({ status: 'ok', version: '0.2.0-test' });
  });

  it("R65a: a revocation in the keyset.json of `previous` counts for `active`", async () => {
    // active = the bundled release (dev-rel-1, the dev keyset only); previous = a data release signed by dev-rel-2 whose
    // keyset.json revokes dev-rel-1. active is refused, and app.js falls back to previous (no schema-meta.json yet).
    const revoke = keysetDoc({ seq: 2, keys: [], revokedKids: ['dev-rel-1'] });
    const sb = await h.sandbox();
    await makeRelease(releasesPath(sb, '0.0.9-test'), { version: '0.0.9-test', signer: loadDevKey('dev-rel-2'), keyset: devKeysetWith(revoke) });
    await writeReleasesFile(sb, 'current.json', JSON.stringify({ ...STATE, previous: { version: '0.0.9-test', source: 'data' } }));
    const app = h.spawn(sb);
    expect(healthJson(await waitForHttp(sb.port, '/_health', notStarting))).toMatchObject({ status: 'ok', version: '0.0.9-test' });
    expect(logLines(app.stderr()).find((l) => l['msg'] === 'release failed')).toMatchObject({ release: BUNDLED_VERSION, reason: 'RELEASE_INVALID' });
  });

  it('R65a: DATA_DIR keyset.json and its .bak count together: a revocation only in the .bak still revokes', async () => {
    const sb = await h.sandbox();
    await writeReleasesFile(sb, 'keyset.json', devKeysetText());
    await writeReleasesFile(sb, 'keyset.json.bak', JSON.stringify([keysetDoc({ seq: 2, keys: [], revokedKids: ['dev-rel-1'] })]));
    h.spawn(sb);
    await expectRescue(sb, 'RELEASE_INVALID');
  });

  it('round 2: an unreadable keyset.json.bak next to a healthy keyset.json is skipped with a warning, not a rescue page', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // chmod does not stop root
    const sb = await h.sandbox();
    await writeReleasesFile(sb, 'keyset.json', devKeysetText());
    await writeReleasesFile(sb, 'keyset.json.bak', devKeysetText());
    await fsp.chmod(releasesPath(sb, 'keyset.json.bak'), 0o000);
    try {
      const app = h.spawn(sb);
      expect((await waitForHttp(sb.port, '/_health', notStarting)).status).toBe(200);
      expect(logLines(app.stderr()).find((l) => l['msg'] === 'keyset.json not usable; its documents do not count')).toMatchObject({
        source: 'DATA_DIR/releases/keyset.json.bak',
      });
    } finally {
      await fsp.chmod(releasesPath(sb, 'keyset.json.bak'), 0o644);
    }
  });

  it('R65c: a FIFO as DATA_DIR keyset.json (and .bak) gives STATE_CORRUPT instead of a hang; a bare document too', async () => {
    if (process.platform === 'win32') return;
    const sb = await h.sandbox();
    await fsp.mkdir(releasesPath(sb), { recursive: true });
    execFileSync('mkfifo', [releasesPath(sb, 'keyset.json')]);
    h.spawn(sb);
    await expectRescue(sb, 'STATE_CORRUPT');

    const bare = await h.sandbox();
    await writeReleasesFile(bare, 'keyset.json', JSON.stringify(keysetDoc({ seq: 2, keys: [], revokedKids: [] })));
    h.spawn(bare);
    await expectRescue(bare, 'STATE_CORRUPT');
  });

  it('R65c: a FIFO as the release keyset.json gives RELEASE_INVALID instead of a hang', async () => {
    if (process.platform === 'win32') return;
    const sb = await h.sandbox();
    await fsp.rm(path.join(sb.bundledDir, 'keyset.json'));
    execFileSync('mkfifo', [path.join(sb.bundledDir, 'keyset.json')]);
    h.spawn(sb);
    await expectRescue(sb, 'RELEASE_INVALID');
  });

  describe('a production app.js (R65b): no document may trust a dev- key', () => {
    const rootA = { kid: 'root-ci-1', ...generateKeyPair() };
    const rootB = { kid: 'root-ci-2', ...generateKeyPair() };

    /** A sandbox running a production app.js that embeds rootA and rootB, its bundled release signed by `kid`. */
    async function productionSandbox(kid: string): Promise<Sandbox> {
      const signer = strangerKey(kid);
      const add = keysetDoc({ seq: 1, keys: [{ kid, use: 'release', pub: signer.pub }], revokedKids: [] }, { kid: rootA.kid, privateKey: rootA.privateKey });
      const sb = await h.sandbox({ bundled: { signer: signer.signer, keyset: JSON.stringify([add]) } });
      await buildBootloader({
        profile: 'production',
        outfile: sb.appJs,
        bundledVersion: BUNDLED_VERSION,
        rootKeys: [rootA, rootB].map((r) => ({ kid: r.kid, use: 'root' as const, pub: r.pub })),
      });
      return sb;
    }

    it('a root-signed document that adds a dev- release key is ignored: RELEASE_INVALID', async () => {
      const sb = await productionSandbox('dev-rel-9');
      const app = h.spawn(sb);
      await expectRescue(sb, 'RELEASE_INVALID');
      // The bundled release's keyset.json is read as an installation source and again as the release's own: a rejected
      // document suppresses no copy (round 2), so both are reported.
      expect(logLines(app.stderr()).filter((l) => l['msg'] === 'keyset document ignored')).toEqual([
        expect.objectContaining({ source: `bundled-release/${BUNDLED_VERSION}/keyset.json`, index: 0, reason: 'dev' }),
        expect.objectContaining({ source: 'release', index: 0, reason: 'dev' }),
      ]);
    });

    it('control: the same document adding a non-dev key is trusted', async () => {
      const sb = await productionSandbox('rel-9');
      h.spawn(sb);
      expect((await waitForHttp(sb.port, '/_health', notStarting)).status).toBe(200);
    });
  });

  it('serves STATE_CORRUPT when keyset.json and its .bak are both corrupt (revocations must not be lost)', async () => {
    const sb = await h.sandbox();
    await writeReleasesFile(sb, 'keyset.json', '[{"raw":');
    h.spawn(sb);
    await expectRescue(sb, 'STATE_CORRUPT');
  });
});

describe('fallback to previous (spec §9.2 step 3)', { timeout: 30_000 }, () => {
  /** active = 0.2.0-test from DATA_DIR (failing as `fault` says), previous = the bundled 0.1.0-test. */
  async function fallbackSandbox(fault: 'reject' | 'throw-on-import' | 'tampered', minCodeVersion: string): Promise<Sandbox> {
    const sb = await h.sandbox();
    const activeDir = releasesPath(sb, '0.2.0-test');
    await makeRelease(activeDir, { version: '0.2.0-test', startBehaviour: fault === 'tampered' ? 'ok' : fault });
    if (fault === 'tampered') await fsp.appendFile(path.join(activeDir, 'server.mjs'), '\n// changed\n');
    const state = { ...STATE, active: { version: '0.2.0-test', source: 'data' }, previous: { version: BUNDLED_VERSION, source: 'bundled' } };
    await writeReleasesFile(sb, 'current.json', JSON.stringify(state));
    await writeReleasesFile(sb, 'schema-meta.json', JSON.stringify({ schemaVersion: '0003', minCodeVersion }));
    return sb;
  }

  it.each(['reject', 'throw-on-import', 'tampered'] as const)(
    'active fails (%s), previous passes schema-meta.json: previous serves in the same process',
    async (fault) => {
      const sb = await fallbackSandbox(fault, BUNDLED_VERSION);
      const app = h.spawn(sb);
      const health = await waitForHttp(sb.port, '/_health', (r) => r.status === 200);
      expect(healthJson(health)).toMatchObject({ status: 'ok', version: BUNDLED_VERSION, source: 'bundled', pid: app.pid });
      expect(app.exitedAt()).toBeUndefined();
    },
  );

  it('active start rejects and minCodeVersion is above previous: START_FAILED', async () => {
    const sb = await fallbackSandbox('reject', '0.2.0-test');
    h.spawn(sb);
    await expectRescue(sb, 'START_FAILED');
  });

  it('active is invalid and minCodeVersion is above previous: RELEASE_INVALID', async () => {
    const sb = await fallbackSandbox('tampered', '0.2.0-test');
    h.spawn(sb);
    expect(await rescueReason(sb)).toBe('RELEASE_INVALID');
  });

  it('start rejects and there is no previous release: START_FAILED', async () => {
    const sb = await h.sandbox({ bundled: { startBehaviour: 'reject' } });
    h.spawn(sb);
    await expectRescue(sb, 'START_FAILED');
  });
});

describe("app.js's one http.Server (fixNow 3: frozen once released)", { timeout: 30_000 }, () => {
  it('a loader whose listen() never calls back: app.js serves once the server emits listening', async () => {
    const sb = await h.sandbox();
    const app = h.spawn(sb, { execArgv: ['--require', DROPS_LISTEN_CALLBACK] });
    const health = await waitForHttp(sb.port, '/_health', (r) => r.status === 200);
    expect(healthJson(health)).toMatchObject({ status: 'ok', version: BUNDLED_VERSION, pid: app.pid });
    expect(logLines(app.stderr()).filter((l) => l['msg'] === 'listening')).toHaveLength(1);
  });

  it('a handler that rejects after it ended its response: the client gets the whole body; logged; still serving', async () => {
    const sb = await h.sandbox();
    const app = h.spawn(sb);
    await waitForHttp(sb.port, '/_health', (r) => r.status === 200);
    const reply = await httpGet(sb.port, '/__end-then-reject');
    expect(reply.status).toBe(200);
    expect(reply.body.length).toBe(END_THEN_REJECT_BYTES);
    expect((await httpGet(sb.port, '/_health')).status).toBe(200);
    await waitFor(() => logLines(app.stderr()).some((l) => l['msg'] === 'request handler failed'), 'the failure in the log');
  });
});

describe('port already in use (P2)', { timeout: 30_000 }, () => {
  it.each([
    ['service', 'service'],
    ['standalone (supervised child)', undefined],
  ])('%s: bilingual message naming ALTIS_PORT, exit code 1, no rescue server', async (_name, runtime) => {
    const sb = await h.sandbox();
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(sb.port, resolve));
    try {
      const app = h.spawn(sb, { env: { ALTIS_RUNTIME: runtime } });
      const exit = await app.exited;
      expect(exit.code).toBe(1);
      const stderr = app.stderr();
      expect(stderr).toContain('sedang dipakai');
      expect(stderr).toContain('is in use');
      expect(stderr).toContain('ALTIS_PORT');
      expect(stderr.split('is in use').length - 1).toBe(1); // said once: no restart loop
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe('command line', { timeout: 30_000 }, () => {
  it('forwards the arguments to runCli and exits with its code; a command has no server (ctx.serve throws)', async () => {
    const sb = await h.sandbox();
    const app = h.spawn(sb, { args: ['doctor', '--json'] });
    expect((await app.exited).code).toBe(7);
    const line = app.stdout().trim().split('\n').pop() as string;
    expect(JSON.parse(line)).toEqual({ argv: ['doctor', '--json'], version: BUNDLED_VERSION, runtime: 'service', serve: 'refused' });
  });

  it('reports a failed check on stderr with exit code 1 instead of serving a rescue page', async () => {
    const sb = await h.sandbox();
    await fsp.rm(path.join(sb.bundledDir, '.complete'));
    const app = h.spawn(sb, { args: ['doctor'] });
    expect((await app.exited).code).toBe(1);
    expect(app.stderr()).toContain('RELEASE_INVALID');
    expect(app.stdout()).toBe('');
  });

  /** The one JSON line a command with --json must print on stdout, whatever failed (runCli's contract). */
  async function jsonFailure(app: AppProcess): Promise<Record<string, unknown>> {
    expect((await app.exited).code).toBe(1);
    const lines = app.stdout().split('\n').filter((line) => line !== '');
    expect(lines, app.stderr()).toHaveLength(1);
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  }

  it.each([
    ['RELEASE_INVALID', ['doctor', '--json'], async (sb: Sandbox) => fsp.rm(path.join(sb.bundledDir, '.complete')), {}],
    ['DATA_DIR_UNWRITABLE', ['install', '--config', 'x.json', '--json'], async (sb: Sandbox) => fsp.writeFile(sb.dataDir, 'a file'), {}],
    ['DOCROOT_EXPOSED', ['migrate', '--json'], async (sb: Sandbox) => fsp.mkdir(path.join(sb.home, 'public_html')), { docroot: true }],
    ['STATE_CORRUPT', ['doctor', '--json'], async (sb: Sandbox) => writeReleasesFile(sb, 'current.json', '{"sch'), {}],
  ] as const)('--json: %s before runCli prints exactly one JSON line {ok:false, command, code, reason, detail}', async (reason, args, prepare, o) => {
    const sb = await h.sandbox();
    await prepare(sb);
    const env = 'docroot' in o ? { ALTIS_DATA_DIR: path.join(sb.home, 'public_html', 'altis-data') } : {};
    const app = h.spawn(sb, { args: [...args], env });
    const line = await jsonFailure(app);
    expect(line).toEqual({ ok: false, command: args[0], code: reason, reason, detail: expect.any(String) });
    expect(line['detail']).not.toContain(sb.root);
    expect(app.stderr()).toContain(reason); // the bilingual message for humans stays on stderr
  });

  it('--json: Node too old prints the JSON line too', async () => {
    const sb = await h.sandbox();
    const app = h.spawn(sb, { args: ['doctor', '--json'], env: { ALTIS_TEST_FAKE_NODE_VERSION: '16.20.2' } });
    const line = await jsonFailure(app);
    expect(line).toMatchObject({ ok: false, command: 'doctor', code: 'NODE_TOO_OLD', reason: 'NODE_TOO_OLD' });
    expect(line['detail']).toContain('22.16');
  });

  it('L52: a port setting that is not a port does not stop a command (it has no server); runCli runs', async () => {
    const sb = await h.sandbox();
    const app = h.spawn(sb, { args: ['doctor', '--json'], env: { ALTIS_PORT: '70000' } });
    expect((await app.exited).code).toBe(7);
    const lines = app.stdout().split('\n').filter((line) => line !== '');
    expect(lines, app.stderr()).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ argv: ['doctor', '--json'], version: BUNDLED_VERSION, runtime: 'service', serve: 'refused' });
  });

  it('a port setting that is not a port still stops the server: message naming the setting, exit 1', async () => {
    const sb = await h.sandbox();
    const app = h.spawn(sb, { env: { ALTIS_PORT: '70000' } });
    expect((await app.exited).code).toBe(1);
    expect(app.stderr()).toContain('ALTIS_PORT');
  });
});

/** app.js under the Passenger-like preload: a second http.Server#listen() in the process throws, as Passenger's does. */
interface UnderPassenger {
  app: AppProcess;
  /** The listen() calls made so far, as `<pid> <n>` lines. */
  listens(): Promise<string[]>;
}

function spawnUnderPassenger(sb: Sandbox, o: SpawnOptions = {}): UnderPassenger {
  const listenLog = path.join(sb.root, 'listen.log');
  const app = h.spawn(sb, {
    ...o,
    execArgv: ['--require', PASSENGER],
    env: { ALTIS_RUNTIME: undefined, ...o.env, LISTEN_LOG: listenLog },
  });
  return {
    app,
    listens: async () => (await fsp.readFile(listenLog, 'utf8').catch(() => '')).split('\n').filter((line) => line !== ''),
  };
}

/**
 * Ruling R1c-14: a POST to `urlPath` sent as soon as the port accepts a connection, as the cron line's curl does when
 * its call is what wakes a Passenger/LiteSpeed process: refused connections are retried every 5 ms until `timeoutMs`.
 */
async function postWhenListening(port: number, urlPath: string, headers: http.OutgoingHttpHeaders = {}, timeoutMs = 10_000): Promise<HttpReply> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await new Promise<HttpReply>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers, agent: false }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED' || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/** The lines of `<DATA_DIR>/fixture-events.txt` (see make-release.ts). */
async function fixtureEvents(sb: Sandbox): Promise<string[]> {
  return (await fsp.readFile(path.join(sb.dataDir, 'fixture-events.txt'), 'utf8').catch(() => '')).split('\n').filter((line) => line !== '');
}

describe('one http.Server per process, under a Passenger-like loader (P2, ruling R64)', { timeout: 30_000 }, () => {
  /** active = 0.2.0-test from DATA_DIR (start rejects), previous = the bundled 0.1.0-test. */
  async function rejectingActive(sb: Sandbox): Promise<void> {
    await makeRelease(releasesPath(sb, '0.2.0-test'), { version: '0.2.0-test', startBehaviour: 'reject' });
    const state = { ...STATE, active: { version: '0.2.0-test', source: 'data' }, previous: { version: BUNDLED_VERSION, source: 'bundled' } };
    await writeReleasesFile(sb, 'current.json', JSON.stringify(state));
    await writeReleasesFile(sb, 'schema-meta.json', JSON.stringify({ schemaVersion: '0003', minCodeVersion: BUNDLED_VERSION }));
  }

  it('the runtime is passenger and app.js serves with exactly one listen()', async () => {
    const sb = await h.sandbox();
    const { app, listens } = spawnUnderPassenger(sb);
    const health = await waitForHttp(sb.port, '/_health', (r) => r.status === 200);
    expect(healthJson(health)).toMatchObject({ status: 'ok', version: BUNDLED_VERSION, runtime: 'passenger', pid: app.pid });
    expect(await listens()).toEqual([`${app.pid} 1`]);
  });

  it('active start() rejects after serving: previous serves /_health 200 in the same process, one listen()', async () => {
    const sb = await h.sandbox();
    await rejectingActive(sb);
    const { app, listens } = spawnUnderPassenger(sb);
    const health = await waitForHttp(sb.port, '/_health', (r) => r.status === 200);
    expect(healthJson(health)).toMatchObject({ status: 'ok', version: BUNDLED_VERSION, source: 'bundled', pid: app.pid, runtime: 'passenger' });

    // The failed release's handler was retired, and a ctx.serve() it makes later changes nothing.
    await waitFor(async () => (await fixtureEvents(sb)).some((line) => line.startsWith('late-serve 0.2.0-test')), 'the late serve()');
    expect(await fixtureEvents(sb)).toEqual(['retired 0.2.0-test', 'late-serve 0.2.0-test resolved']);
    expect(healthJson(await httpGet(sb.port, '/_health'))).toMatchObject({ version: BUNDLED_VERSION, pid: app.pid });
    expect(await listens()).toEqual([`${app.pid} 1`]);
    expect(app.exitedAt()).toBeUndefined();
  });

  it('start() rejects and there is no fallback: the rescue page START_FAILED on the same listener', async () => {
    const sb = await h.sandbox({ bundled: { startBehaviour: 'reject' } });
    const { app, listens } = spawnUnderPassenger(sb);
    await expectRescue(sb, 'START_FAILED');
    expect(await listens()).toEqual([`${app.pid} 1`]);
    expect(app.exitedAt()).toBeUndefined();
    expect(await fixtureEvents(sb)).toContain(`retired ${BUNDLED_VERSION}`);
  });

  it('a release that fails verification: the rescue page RELEASE_INVALID on the same listener', async () => {
    const sb = await h.sandbox();
    await fsp.appendFile(path.join(sb.bundledDir, 'server.mjs'), '\n// changed\n');
    const { app, listens } = spawnUnderPassenger(sb);
    await expectRescue(sb, 'RELEASE_INVALID');
    expect(await listens()).toEqual([`${app.pid} 1`]);
  });

  it('listens before the release is imported: 503 "starting" until start() serves', async () => {
    const sb = await h.sandbox({ bundled: { startBehaviour: 'slow' } });
    const { app, listens } = spawnUnderPassenger(sb);
    const starting = await waitForHttp(sb.port, '/_health');
    expect(starting.status).toBe(503);
    expect(healthJson(starting)).toEqual({ status: 'starting' });
    expect(starting.headers['cache-control']).toBe('no-store');
    expect(starting.headers['retry-after']).toBeUndefined();
    const page = await httpGet(sb.port, '/catalog');
    expect(page.status).toBe(503);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.body).toContain('sedang dimulai');
    expect(page.body).toContain('is starting');
    expect(page.body.indexOf('lang="id"')).toBeLessThan(page.body.indexOf('lang="en"'));

    await waitForHttp(sb.port, '/_health', (r) => r.status === 200);
    expect(await listens()).toEqual([`${app.pid} 1`]);
  });

  it('R1c-14: the POST /_cron that wakes the process is held while the release loads, then answered by the release', async () => {
    const sb = await h.sandbox({ bundled: { startBehaviour: 'slow' } }); // the import takes 1.5 s
    const { app, listens } = spawnUnderPassenger(sb);
    const reply = await postWhenListening(sb.port, '/_cron');
    expect(reply.status, reply.body).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ cron: 'ran', version: BUNDLED_VERSION });
    expect(await listens()).toEqual([`${app.pid} 1`]);
  });

  it('start() resolves without ever calling ctx.serve: the rescue page START_FAILED', async () => {
    const sb = await h.sandbox({ bundled: { startBehaviour: 'no-serve' } });
    const { app, listens } = spawnUnderPassenger(sb);
    await expectRescue(sb, 'START_FAILED');
    expect(await listens()).toEqual([`${app.pid} 1`]);
  });

  it('a handler that throws: 500 for that request, and the server keeps serving', async () => {
    const sb = await h.sandbox();
    const { app } = spawnUnderPassenger(sb);
    await waitForHttp(sb.port, '/_health', (r) => r.status === 200);
    const failed = await httpGet(sb.port, '/__throw');
    expect(failed.status).toBe(500);
    expect(failed.body).not.toContain('fixture: handler failed');
    expect((await httpGet(sb.port, '/_health')).status).toBe(200);
    expect(logLines(app.stderr()).some((l) => l['msg'] === 'request handler failed')).toBe(true);
  });

  describe('with the real server (apps/server start(ctx))', () => {
    const bundle = useServerBundle();

    it('not installed: /_health 503 not_installed and the NOT_INSTALLED problem, through ctx.serve', async () => {
      const sb = await h.sandbox({ bundled: { serverFile: bundle.file() } });
      const { app, listens } = spawnUnderPassenger(sb);
      const health = await waitForHttp(sb.port, '/_health', notStarting);
      expect(health.status).toBe(503);
      expect(healthJson(health)).toEqual({ status: 'not_installed', version: BUNDLED_VERSION });
      // 1c Task 10: the home page sends a browser to the install wizard; other paths stay NOT_INSTALLED.
      expect((await httpGet(sb.port, '/')).status).toBe(302);
      const page = await httpGet(sb.port, '/api/v1/auth/me');
      expect(page.status).toBe(503);
      expect(JSON.parse(page.body)).toMatchObject({ code: 'NOT_INSTALLED' });
      expect(await listens()).toEqual([`${app.pid} 1`]);
      expect(logLines(app.stderr()).find((l) => l['msg'] === 'serving')).toMatchObject({ runtime: 'passenger' });
    });

    it('config.json and its .bak corrupt: CONFIG_CORRUPT, not START_FAILED, and the release is not started', async () => {
      const sb = await h.sandbox({ bundled: { serverFile: bundle.file() } });
      await fsp.mkdir(sb.dataDir, { recursive: true });
      await fsp.writeFile(path.join(sb.dataDir, 'config.json'), '{"version":1,"db":{"dial');
      await fsp.writeFile(path.join(sb.dataDir, 'config.json.bak'), '');
      const { app, listens } = spawnUnderPassenger(sb);
      await expectRescue(sb, 'CONFIG_CORRUPT');
      expect(logLines(app.stderr()).some((l) => l['msg'] === 'starting release')).toBe(false);
      expect(await listens()).toEqual([`${app.pid} 1`]);
    });

    it('DB down at boot: 503 db_unavailable through ctx.serve, then 200 without a restart once the config is fixed', async () => {
      const sb = await h.sandbox({ bundled: { serverFile: bundle.file() } });
      // Install (SQLite needs a runtime other than passenger, P20), then point config.json at a closed MariaDB port.
      const input = path.join(sb.root, 'install.json');
      await fsp.writeFile(input, JSON.stringify({ baseUrl: `http://127.0.0.1:${sb.port}`, db: { dialect: 'sqlite' }, admin: ADMIN }));
      const install = h.spawn(sb, { args: ['install', '--config', input] });
      expect((await install.exited).code).toBe(0);
      const configFile = path.join(sb.dataDir, 'config.json');
      const setDb = async (db: Record<string, unknown>): Promise<void> => {
        const config = JSON.parse(await fsp.readFile(configFile, 'utf8')) as Record<string, unknown>;
        await fsp.writeFile(configFile, JSON.stringify({ ...config, db }));
      };
      const closed = await closedPort();
      await setDb({ dialect: 'mariadb', host: '127.0.0.1', port: closed, user: 'altis', password: 'pw', database: 'altis' });

      const { app, listens } = spawnUnderPassenger(sb, { env: { ALTIS_RUNTIME: 'service' } });
      const down = await waitForHttp(sb.port, '/_health', (r) => healthJson(r)['status'] === 'db_unavailable');
      expect(down.status).toBe(503);

      await setDb({ dialect: 'sqlite' });
      const up = await waitForHttp(sb.port, '/_health', (r) => r.status === 200, 15_000);
      expect(healthJson(up)).toEqual({ status: 'ok', version: BUNDLED_VERSION });
      expect(await listens()).toEqual([`${app.pid} 1`]);
      expect(app.exitedAt()).toBeUndefined();
    });

    it('R1c-14: the cron call that wakes a cold process does its work: 200 with the pass it ran, not 503 "starting"', async () => {
      const sb = await h.sandbox({ bundled: { serverFile: bundle.file() } });
      // Installed on SQLite (which needs a runtime other than passenger, P20), under the Passenger-like loader.
      const input = path.join(sb.root, 'install.json');
      await fsp.writeFile(input, JSON.stringify({ baseUrl: `http://127.0.0.1:${sb.port}`, db: { dialect: 'sqlite' }, admin: ADMIN }));
      const install = h.spawn(sb, { args: ['install', '--config', input] });
      expect((await install.exited).code).toBe(0);
      const config = JSON.parse(await fsp.readFile(path.join(sb.dataDir, 'config.json'), 'utf8')) as { secrets: { cronToken: string } };

      const { app, listens } = spawnUnderPassenger(sb, { env: { ALTIS_RUNTIME: 'service' } });
      const reply = await postWhenListening(sb.port, '/_cron', { authorization: `Bearer ${config.secrets.cronToken}` });
      expect(reply.status, reply.body).toBe(200);
      expect(JSON.parse(reply.body)).toEqual({ op: null, scheduled: expect.any(Number), slices: expect.any(Number) });
      // The single-flight was taken: the pass ran in this call.
      const flight = JSON.parse(await fsp.readFile(path.join(sb.dataDir, 'tmp', 'cron-flight.json'), 'utf8')) as { until: number };
      expect(flight.until).toBeGreaterThan(Date.now());
      expect(await listens()).toEqual([`${app.pid} 1`]);
    });

    it('L52: ALTIS_PORT=abc node app.js config:set port 3000 runs the command (exit 0) and config.json gets port 3000', async () => {
      const sb = await h.sandbox({ bundled: { serverFile: bundle.file() } });
      const input = path.join(sb.root, 'install.json');
      await fsp.writeFile(input, JSON.stringify({ baseUrl: `http://127.0.0.1:${sb.port}`, db: { dialect: 'sqlite' }, admin: ADMIN }));
      expect((await h.spawn(sb, { args: ['install', '--config', input] }).exited).code).toBe(0);

      const app = h.spawn(sb, { args: ['config:set', 'port', '3000'], env: { ALTIS_PORT: 'abc' } });
      const { code } = await app.exited;
      expect(code, app.stderr()).toBe(0);
      const config = JSON.parse(await fsp.readFile(path.join(sb.dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
      expect(config['port']).toBe(3000);
    });
  });
});

/** A TCP port nothing listens on (free a moment ago, from this worker's block, below the ephemeral ranges). */
function closedPort(): Promise<number> {
  return freePort();
}
