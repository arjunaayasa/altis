import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, parseStrictJson, verifyDetached, type KeysetDoc, type TrustedKey } from '@altis/crypto';
import { FEED_TYP, FRESHNESS_TYP, verifyFeed, type FeedEntry } from '@altis/crypto/feed';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PASSPHRASE_ENV, runCli } from '../src/index.js';

// Task 8 (spec §9.6, D1d-3, preflight 1D-11): `feed sign` writes feed.json (the canonical payload, keyset = every
// document of --keyset) and feed.sig (altis-feed/1, release key); `freshness sign` writes freshness.json
// ({raw, env}, altis-timestamp/1, timestamp key), 1–14 days, `--issued-at` for dev keys only, never ahead of the clock.

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV_KEYS = path.resolve(PACKAGE_DIR, '..', 'keys', 'dev');
const devKey = (kid: string): string => path.join(DEV_KEYS, `${kid}.key.json`);
const DAY_MS = 86_400_000;

let root: string;
let counter = 0;
let devRoots: TrustedKey[];
let devKeyset: KeysetDoc[];

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-sign-feed-'));
  devRoots = JSON.parse(await fsp.readFile(path.join(DEV_KEYS, 'roots.json'), 'utf8')) as TrustedKey[];
  devKeyset = JSON.parse(await fsp.readFile(path.join(DEV_KEYS, 'keyset.json'), 'utf8')) as KeysetDoc[];
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const freshDir = async (): Promise<string> => {
  const dir = path.join(root, `case-${counter++}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
};

type Run = { code: number; out: string; err: string };

async function cli(...args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const exists = (file: string): Promise<boolean> =>
  fsp.access(file).then(
    () => true,
    () => false,
  );

function entry(version: string, over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    version,
    channel: 'stable',
    releasedAt: '2026-10-29',
    bootProtocol: 1,
    minUpgradeFrom: '0.0.0',
    minCodeVersionAfter: '0.0.0',
    minNode: '22.16.0',
    minDb: { mysql: '8.0', mariadb: '10.6', postgres: '15' },
    size: 1234,
    sha256: 'a'.repeat(64),
    url: `https://feed.example.invalid/packages/altis-${version}.zip`,
    notesUrl: null,
    ...over,
  };
}

const SOURCE = { v: 1, channel: 'stable', releases: [entry('0.2.0-test'), entry('0.3.0-test', { minCodeVersionAfter: '0.3.0-test' })] };

async function writeSource(dir: string, value: unknown = SOURCE): Promise<string> {
  const file = path.join(dir, 'feed-src.json');
  await fsp.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return file;
}

const feedSign = async (dir: string, src: string, key = devKey('dev-rel-1'), keyset = path.join(DEV_KEYS, 'keyset.json')): Promise<Run> =>
  cli('feed', 'sign', '--in', src, '--keyset', keyset, '--key', key, '--out-dir', path.join(dir, 'out'));

const freshnessSign = (dir: string, ...extra: string[]): Promise<Run> =>
  cli(
    ...['freshness', 'sign', '--feed', path.join(dir, 'out', 'feed.json'), '--seq', '3', '--expires-in-days', '7'],
    ...['--key', devKey('dev-ts-1'), '--out', path.join(dir, 'out', 'freshness.json'), ...extra],
  );

async function verifyOut(dir: string, now = Date.now()) {
  const read = (name: string) => fsp.readFile(path.join(dir, 'out', name), 'utf8');
  return verifyFeed({
    feedText: await read('feed.json'),
    sigText: await read('feed.sig'),
    freshnessText: await read('freshness.json'),
    channel: 'stable',
    roots: devRoots,
    sources: [],
    refuseDevKids: false,
    now,
    minSeq: 0,
  });
}

describe('altis-sign feed sign + freshness sign', () => {
  it('dev-rel-1 and dev-ts-1: verifyFeed (minSeq 0) returns seq 3 and the entries, for a window of 7 days', async () => {
    const dir = await freshDir();
    const before = Date.now();
    expect(await feedSign(dir, await writeSource(dir))).toMatchObject({ code: 0, err: '' });
    expect(await freshnessSign(dir)).toMatchObject({ code: 0, err: '' });
    const after = Date.now();
    const verified = await verifyOut(dir);
    expect(verified.seq).toBe(3);
    expect(verified.channel).toBe('stable');
    expect(verified.entries).toEqual(SOURCE.releases);
    expect(verified.keyset).toEqual(devKeyset);
    expect(verified.issuedAt).toBeGreaterThanOrEqual(before);
    expect(verified.issuedAt).toBeLessThanOrEqual(after);
    expect(verified.expiresAt - verified.issuedAt).toBe(7 * DAY_MS);
    expect((await fsp.readdir(path.join(dir, 'out'))).sort()).toEqual(['feed.json', 'feed.sig', 'freshness.json']);
  });

  it('feed.json is the canonical JSON of the payload with keyset = every document of --keyset; feed.sig its altis-feed/1 envelope', async () => {
    const dir = await freshDir();
    await feedSign(dir, await writeSource(dir));
    const text = await fsp.readFile(path.join(dir, 'out', 'feed.json'), 'utf8');
    expect(text).toBe(canonicalize({ ...SOURCE, keyset: devKeyset }));
    const env = parseStrictJson(await fsp.readFile(path.join(dir, 'out', 'feed.sig'), 'utf8')) as { typ: string; kid: string };
    expect(env).toMatchObject({ typ: FEED_TYP, kid: 'dev-rel-1', alg: 'Ed25519' });
    const devTrusted = JSON.parse(await fsp.readFile(path.join(DEV_KEYS, 'trusted.json'), 'utf8')) as TrustedKey[];
    expect(verifyDetached(text, env as never, devTrusted, FEED_TYP)).toEqual({ ...SOURCE, keyset: devKeyset });
  });

  it('freshness.json is {raw, env}: altis-timestamp/1 by dev-ts-1 over {feedSha256, seq, issuedAt, expiresAt}', async () => {
    const dir = await freshDir();
    await feedSign(dir, await writeSource(dir));
    await freshnessSign(dir);
    const doc = JSON.parse(await fsp.readFile(path.join(dir, 'out', 'freshness.json'), 'utf8')) as KeysetDoc;
    expect(Object.keys(doc).sort()).toEqual(['env', 'raw']);
    expect(doc.env).toMatchObject({ typ: FRESHNESS_TYP, kid: 'dev-ts-1' });
    const payload = JSON.parse(doc.raw) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['expiresAt', 'feedSha256', 'issuedAt', 'seq']);
    expect(doc.raw).toBe(canonicalize(payload));
  });

  it('a feed changed after its freshness document was signed fails verifyFeed (hash)', async () => {
    const dir = await freshDir();
    await feedSign(dir, await writeSource(dir));
    await freshnessSign(dir);
    await feedSign(dir, await writeSource(dir, { ...SOURCE, releases: [entry('0.2.0-test')] }));
    await expect(verifyOut(dir)).rejects.toThrow('FEED_INVALID:hash');
  });

  it('feed sign with a licence key (dev-lic-1): exit 1 KEY_USE:release, nothing written', async () => {
    const dir = await freshDir();
    const run = await feedSign(dir, await writeSource(dir), devKey('dev-lic-1'));
    expect(run.code).toBe(1);
    expect(run.err).toContain('KEY_USE:release');
    expect(await exists(path.join(dir, 'out'))).toBe(false);
  });

  it('refuses two entries with the same version, an entry of another channel, an invalid entry or an unknown field: exit 1', async () => {
    const cases: [string, unknown, string][] = [
      ['duplicate version', { ...SOURCE, releases: [entry('0.2.0-test'), entry('0.2.0-test', { size: 1 })] }, 'FEED_DUPLICATE_VERSION:0.2.0-test'],
      ['other channel', { ...SOURCE, releases: [entry('0.2.0-test', { channel: 'beta' })] }, 'FEED_CHANNEL:releases.0'],
      ['bad sha256', { ...SOURCE, releases: [entry('0.2.0-test', { sha256: 'xyz' })] }, 'FEED_FORMAT:releases.0.sha256'],
      ['bad version', { ...SOURCE, releases: [entry('1.0')] }, 'FEED_FORMAT:releases.0.version'],
      ['entry field this release does not know', { ...SOURCE, releases: [{ ...entry('0.2.0-test'), firmware: 'x' }] }, 'FEED_FORMAT:releases.0'],
      ['top-level field', { ...SOURCE, keyset: [] }, 'FEED_FORMAT'],
      ['v 2', { ...SOURCE, v: 2 }, 'FEED_FORMAT:v'],
      ['channel', { ...SOURCE, channel: 'nightly' }, 'FEED_FORMAT:channel'],
      ['duplicate key', '{"v":1,"v":1,"channel":"stable","releases":[]}', 'DUPLICATE_KEY'],
    ];
    for (const [name, value, message] of cases) {
      const dir = await freshDir();
      const run = await feedSign(dir, await writeSource(dir, value));
      expect(run.code, name).toBe(1);
      expect(run.err, name).toContain(message);
      expect(await exists(path.join(dir, 'out')), name).toBe(false);
    }
  });

  it('refuses a --keyset file that is not an array of keyset documents, or holds an entry of another shape', async () => {
    for (const content of [devKeyset[0], [...devKeyset, 1], [...devKeyset, { raw: 'x' }], [{ ...devKeyset[0], note: 1 }], [{ raw: 'x', env: { ...devKeyset[0]!.env, sig: 1 } }]]) {
      const dir = await freshDir();
      const bad = path.join(dir, 'keyset.json');
      await fsp.writeFile(bad, JSON.stringify(content));
      const run = await feedSign(dir, await writeSource(dir), devKey('dev-rel-1'), bad);
      expect(run.code, JSON.stringify(content)).toBe(1);
      expect(run.err).toContain('keyset');
      expect(await exists(path.join(dir, 'out'))).toBe(false);
    }
  });

  it('feed sign with an encrypted release key (passphrase from ALTIS_KEY_PASSPHRASE)', async () => {
    const dir = await freshDir();
    vi.stubEnv(PASSPHRASE_ENV, 'pp');
    expect((await cli('keygen', '--use', 'release', '--kid', 'dev-rel-enc', '--out', dir, '--encrypt')).code).toBe(0);
    const run = await feedSign(dir, await writeSource(dir), path.join(dir, 'dev-rel-enc.key.json'));
    expect(run).toMatchObject({ code: 0, err: '' });
    const env = JSON.parse(await fsp.readFile(path.join(dir, 'out', 'feed.sig'), 'utf8')) as { kid: string };
    expect(env.kid).toBe('dev-rel-enc');
  });

  it.each([['15'], ['0'], ['-1'], ['7.5'], ['x'], ['']])('freshness sign --expires-in-days %j: exit 2, nothing written', async (days) => {
    const dir = await freshDir();
    await feedSign(dir, await writeSource(dir));
    const run = await cli(
      ...['freshness', 'sign', '--feed', path.join(dir, 'out', 'feed.json'), '--seq', '3', '--expires-in-days', days],
      ...['--key', devKey('dev-ts-1'), '--out', path.join(dir, 'out', 'freshness.json')],
    );
    expect(run.code).toBe(2);
    expect(await exists(path.join(dir, 'out', 'freshness.json'))).toBe(false);
  });

  it('freshness sign --expires-in-days 1 and 14 are the bounds', async () => {
    for (const days of [1, 14]) {
      const dir = await freshDir();
      await feedSign(dir, await writeSource(dir));
      const run = await cli(
        ...['freshness', 'sign', '--feed', path.join(dir, 'out', 'feed.json'), '--seq', '0', '--expires-in-days', String(days)],
        ...['--key', devKey('dev-ts-1'), '--out', path.join(dir, 'out', 'freshness.json')],
      );
      expect(run).toMatchObject({ code: 0, err: '' });
      const verified = await verifyOut(dir);
      expect(verified.expiresAt - verified.issuedAt).toBe(days * DAY_MS);
    }
  });

  it.each([['-1'], ['1.5'], ['x'], ['9007199254740992']])('freshness sign --seq %j: exit 2', async (seq) => {
    const dir = await freshDir();
    await feedSign(dir, await writeSource(dir));
    const run = await cli(
      ...['freshness', 'sign', '--feed', path.join(dir, 'out', 'feed.json'), '--seq', seq, '--expires-in-days', '7'],
      ...['--key', devKey('dev-ts-1'), '--out', path.join(dir, 'out', 'freshness.json')],
    );
    expect(run.code).toBe(2);
  });

  it('freshness sign with a release key: exit 1 KEY_USE:timestamp', async () => {
    const dir = await freshDir();
    await feedSign(dir, await writeSource(dir));
    const run = await cli(
      ...['freshness', 'sign', '--feed', path.join(dir, 'out', 'feed.json'), '--seq', '3', '--expires-in-days', '7'],
      ...['--key', devKey('dev-rel-1'), '--out', path.join(dir, 'out', 'freshness.json')],
    );
    expect(run.code).toBe(1);
    expect(run.err).toContain('KEY_USE:timestamp');
  });

  it('freshness sign refuses a --feed that is not a feed (feed.sig given by mistake)', async () => {
    const dir = await freshDir();
    await feedSign(dir, await writeSource(dir));
    const run = await cli(
      ...['freshness', 'sign', '--feed', path.join(dir, 'out', 'feed.sig'), '--seq', '3', '--expires-in-days', '7'],
      ...['--key', devKey('dev-ts-1'), '--out', path.join(dir, 'out', 'freshness.json')],
    );
    expect(run.code).toBe(1);
    expect(run.err).toContain('FEED_FORMAT');
  });

  it('--issued-at with a non-dev timestamp key: exit 2 ISSUED_AT_DEV_ONLY', async () => {
    const dir = await freshDir();
    await feedSign(dir, await writeSource(dir));
    expect((await cli('keygen', '--use', 'timestamp', '--kid', 'ts-1', '--out', dir)).code).toBe(0);
    const run = await cli(
      ...['freshness', 'sign', '--feed', path.join(dir, 'out', 'feed.json'), '--seq', '3', '--expires-in-days', '7'],
      ...['--key', path.join(dir, 'ts-1.key.json'), '--out', path.join(dir, 'out', 'freshness.json')],
      ...['--issued-at', new Date(Date.now() - DAY_MS).toISOString()],
    );
    expect(run.code).toBe(2);
    expect(run.err).toContain('ISSUED_AT_DEV_ONLY');
    expect(await exists(path.join(dir, 'out', 'freshness.json'))).toBe(false);
    // Without --issued-at the production key signs (issuedAt = now).
    const ok = await cli(
      ...['freshness', 'sign', '--feed', path.join(dir, 'out', 'feed.json'), '--seq', '3', '--expires-in-days', '7'],
      ...['--key', path.join(dir, 'ts-1.key.json'), '--out', path.join(dir, 'out', 'freshness.json')],
    );
    expect(ok).toMatchObject({ code: 0, err: '' });
  });

  it('an issuedAt 10 min ahead of the clock: exit 2 ISSUED_AT_AHEAD; 4 min ahead and in the past are accepted (dev key)', async () => {
    const dir = await freshDir();
    await feedSign(dir, await writeSource(dir));
    const ahead = await freshnessSign(dir, '--issued-at', new Date(Date.now() + 10 * 60_000).toISOString());
    expect(ahead.code).toBe(2);
    expect(ahead.err).toContain('ISSUED_AT_AHEAD');
    expect(await exists(path.join(dir, 'out', 'freshness.json'))).toBe(false);

    const slightly = Date.now() + 4 * 60_000;
    expect(await freshnessSign(dir, '--issued-at', new Date(slightly).toISOString())).toMatchObject({ code: 0, err: '' });
    expect((await verifyOut(dir)).issuedAt).toBe(slightly);

    const past = Date.parse('2026-10-01T00:00:00Z');
    expect(await freshnessSign(dir, '--issued-at', '2026-10-01T07:00:00+07:00')).toMatchObject({ code: 0, err: '' });
    expect((await verifyOut(dir, past + DAY_MS)).issuedAt).toBe(past);
    await expect(verifyOut(dir, past + 8 * DAY_MS)).rejects.toThrow('FEED_INVALID:expired');
  });

  it.each([['yesterday'], ['2026-10-01'], ['2026-13-01T00:00:00Z'], ['1793059200000']])('--issued-at %j is not an ISO date-time: exit 2', async (value) => {
    const dir = await freshDir();
    await feedSign(dir, await writeSource(dir));
    expect((await freshnessSign(dir, '--issued-at', value)).code).toBe(2);
  });

  it('freshness sign --out naming the --key or --feed file: exit 2, that file untouched (1d review L01)', async () => {
    const dir = await freshDir();
    await feedSign(dir, await writeSource(dir));
    const key = path.join(dir, 'dev-ts-1.key.json');
    await fsp.copyFile(devKey('dev-ts-1'), key);
    const feed = path.join(dir, 'out', 'feed.json');
    for (const [option, file] of [['--key', key], ['--feed', feed]] as const) {
      const before = await fsp.readFile(file, 'utf8');
      const run = await cli(
        ...['freshness', 'sign', '--feed', feed, '--seq', '3', '--expires-in-days', '7'],
        ...['--key', key, '--out', path.join(path.dirname(file), '.', path.basename(file))],
      );
      expect(run.code, option).toBe(2);
      expect(run.err).toContain(`is the ${option} file`);
      expect(await fsp.readFile(file, 'utf8')).toBe(before);
    }
  });

  it('feed sign --out-dir whose feed.json or feed.sig is the --key, --in or --keyset file: exit 2, that file untouched (1d review L01)', async () => {
    for (const name of ['feed.json', 'feed.sig'] as const) {
      const dir = await freshDir();
      const target = path.join(dir, name);
      const inputs = { key: devKey('dev-rel-1'), in: await writeSource(dir), keyset: path.join(DEV_KEYS, 'keyset.json') };
      for (const option of ['key', 'in', 'keyset'] as const) {
        await fsp.rm(target, { force: true });
        const given = { ...inputs };
        if (option === 'in') await fsp.copyFile(inputs.in, target);
        else await fsp.copyFile(inputs[option], target);
        given[option] = target;
        const before = await fsp.readFile(target, 'utf8');
        const run = await cli('feed', 'sign', '--in', given.in, '--keyset', given.keyset, '--key', given.key, '--out-dir', dir);
        expect(run.code, `${name} ${option}`).toBe(2);
        expect(run.err).toContain(`is the --${option} file`);
        expect(await fsp.readFile(target, 'utf8')).toBe(before);
      }
    }
  });

  it('missing options exit 2', async () => {
    expect((await cli('feed', 'sign', '--in', 'x', '--keyset', 'k', '--key', 'k')).code).toBe(2);
    expect((await cli('freshness', 'sign', '--feed', 'f', '--seq', '1', '--key', 'k', '--out', 'o')).code).toBe(2);
    expect((await cli('feed', 'verify')).code).toBe(2);
    expect((await cli('freshness')).code).toBe(2);
  });
});
