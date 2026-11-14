import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TrustedKey } from '@altis/crypto';
import { PHASE1_MIGRATIONS } from '@altis/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LEGAL_FILES,
  MIN_UPGRADE_FROM,
  PRODUCTION_LEAK_NEEDLES,
  bundleServer,
  buildRelease,
  fixtureLevelOf,
  parseReleaseArgs,
  schemaFacts,
} from '../src/build.js';

// Task 9 (decision D1d-26, D1d-2): the release build's fixture level (`__TEST_FIXTURE__`), the embedded feed URL
// (`__FEED_URL__`, `--feed-url` / ALTIS_RELEASE_FEED_URL, optional in every profile) and `--min-upgrade-from`.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
/** The schema of the release's own migrations (fixture levels 0 and 1), by the last name: later phases add theirs. */
const RELEASE_SCHEMA = (Object.keys(PHASE1_MIGRATIONS).sort().at(-1) ?? '').slice(0, 4);
const DEV_ROOTS = path.join(REPO_ROOT, 'tools', 'keys', 'dev', 'roots.json');

let tmp: string;

beforeAll(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-release-args-')));
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('parseReleaseArgs: --min-upgrade-from and --feed-url', () => {
  it('--min-upgrade-from is passed on; without it the option is absent and the manifest says 0.0.0', () => {
    const options = parseReleaseArgs(['--profile', 'test', '--version', '0.3.0-test', '--min-upgrade-from', '0.2.0-test'], {}, tmp);
    expect(options).toMatchObject({ profile: 'test', version: '0.3.0-test', minUpgradeFrom: '0.2.0-test' });
    expect(parseReleaseArgs(['--profile', 'test', '--version', '0.3.0-test'], {}, tmp).minUpgradeFrom).toBeUndefined();
    expect(MIN_UPGRADE_FROM).toBe('0.0.0');
  });

  it('--feed-url is passed on; ALTIS_RELEASE_FEED_URL is read for production only, the flag wins', () => {
    const env = { ALTIS_RELEASE_FEED_URL: 'https://env.example/altis' };
    expect(parseReleaseArgs(['--profile', 'test', '--version', '0.2.0-test', '--feed-url', 'http://127.0.0.1:7357/feed'], {}, tmp).feedUrl).toBe(
      'http://127.0.0.1:7357/feed',
    );
    expect(parseReleaseArgs(['--profile', 'test', '--version', '0.2.0-test'], env, tmp).feedUrl).toBeUndefined();
    expect(parseReleaseArgs(['--profile', 'production', '--version', '1.0.0'], env, tmp).feedUrl).toBe('https://env.example/altis');
    expect(parseReleaseArgs(['--profile', 'production', '--version', '1.0.0'], { ALTIS_RELEASE_FEED_URL: '' }, tmp).feedUrl).toBeUndefined();
    expect(
      parseReleaseArgs(['--profile', 'production', '--version', '1.0.0', '--feed-url', 'https://flag.example/altis'], env, tmp).feedUrl,
    ).toBe('https://flag.example/altis');
  });

  it('a production build without a feed URL is not refused for it: the build goes on to its keys (MISSING_RELEASE_KEY here)', async () => {
    // build.test.ts builds a whole production release without a feed URL; here only the order of the checks.
    const out = path.join(tmp, 'prod-no-feed');
    for (const env of [{}, { ALTIS_RELEASE_FEED_URL: '' }]) {
      const options = parseReleaseArgs(['--profile', 'production', '--version', '1.0.0', '--out', out], env, tmp);
      expect(options.feedUrl).toBeUndefined();
      await expect(buildRelease(options)).rejects.toThrow(/^MISSING_RELEASE_KEY\b/);
    }
    expect(existsSync(out)).toBe(false);
  });

  it('a feed URL that is not an http(s) URL without user:password (the rule of update.feedUrl) fails FEED_URL_INVALID', async () => {
    for (const profile of ['test', 'production'] as const) {
      const version = profile === 'test' ? '0.2.0-test' : '1.0.0';
      for (const feedUrl of ['ftp://feed.example/altis', 'https://user:pw@feed.example/altis', 'not a url', 'https://feed.example/a b']) {
        const options = { profile, version, out: path.join(tmp, 'bad-feed'), feedUrl };
        await expect(buildRelease(options), `${profile} ${feedUrl}`).rejects.toThrow(/^FEED_URL_INVALID\b/);
      }
    }
    expect(existsSync(path.join(tmp, 'bad-feed'))).toBe(false);
  });

  it('--min-upgrade-from must be a version older than the release (MIN_UPGRADE_FROM_INVALID)', async () => {
    for (const minUpgradeFrom of ['0.2', '0.3.0-test', '0.4.0']) {
      const options = { profile: 'test' as const, version: '0.3.0-test', out: path.join(tmp, 'bad-min'), minUpgradeFrom };
      await expect(buildRelease(options), minUpgradeFrom).rejects.toThrow(/^MIN_UPGRADE_FROM_INVALID\b/);
    }
  });
});

describe('the licence files of the zip (AGPL-3.0-only)', () => {
  it('LICENSE and NOTICE come from the repository root, which holds both', () => {
    expect(LEGAL_FILES).toEqual(['LICENSE', 'NOTICE']);
    for (const name of LEGAL_FILES) expect(existsSync(path.join(REPO_ROOT, name)), name).toBe(true);
  });

  it('a missing or empty one fails LEGAL_FILE_MISSING before anything is built or written', async () => {
    const legalRoot = path.join(tmp, 'legal');
    await fsp.mkdir(legalRoot, { recursive: true });
    const out = path.join(tmp, 'no-legal');
    const options = { profile: 'test' as const, version: '0.2.0-test', out, legalRoot };
    await expect(buildRelease(options)).rejects.toThrow(/^LEGAL_FILE_MISSING:LICENSE\b/);
    await fsp.writeFile(path.join(legalRoot, 'LICENSE'), 'GNU AFFERO GENERAL PUBLIC LICENSE\n');
    await fsp.writeFile(path.join(legalRoot, 'NOTICE'), '');
    await expect(buildRelease(options)).rejects.toThrow(/^LEGAL_FILE_MISSING:NOTICE\b/);
    expect(existsSync(out)).toBe(false);
  });
});

describe('fixture levels (decision D1d-26)', () => {
  it('fixtureLevelOf: 0.1.0-test → 1, 0.2.0-test → 2, 0.3.0-test → 3, another test version → 1, production → 0', () => {
    expect(fixtureLevelOf('test', '0.1.0-test')).toBe(1);
    expect(fixtureLevelOf('test', '0.2.0-test')).toBe(2);
    expect(fixtureLevelOf('test', '0.3.0-test')).toBe(3);
    expect(fixtureLevelOf('test', '0.4.0-test')).toBe(1);
    expect(fixtureLevelOf('test', '0.2.0-test.1')).toBe(1);
    expect(fixtureLevelOf('production', '0.2.0')).toBe(0);
    expect(fixtureLevelOf('production', '1.0.0')).toBe(0);
  });

  it('schemaFacts: level 0/1 → the release schema; level 2 → 9001; level 3 → 9002 with minCodeVersionAfter 0.3.0-test', () => {
    expect(RELEASE_SCHEMA).toBe('0046'); // the migration subject's 0046 after charges' 0045, after the member area's 0044, visits' 0043, the circulation core's 0042, holds' 0041, members and circulation's 0040, Komunitas K1's 0030–0033, Phase 2's 0020–0029 and 1c's 0009
    expect(schemaFacts(0)).toEqual({ schemaLatest: RELEASE_SCHEMA, minCodeVersionAfter: '0.0.0' });
    expect(schemaFacts(1)).toEqual({ schemaLatest: RELEASE_SCHEMA, minCodeVersionAfter: '0.0.0' });
    expect(schemaFacts(2)).toEqual({ schemaLatest: '9001', minCodeVersionAfter: '0.0.0' });
    expect(schemaFacts(3)).toEqual({ schemaLatest: '9002', minCodeVersionAfter: '0.3.0-test' });
  });

  it('the production leak scan also looks for the fixture migrations and their table', () => {
    expect(PRODUCTION_LEAK_NEEDLES).toEqual(expect.arrayContaining(['9001_test_expand', '9002_test_contract', 'test_fixture']));
  });
});

describe('server.mjs defines', () => {
  let roots: TrustedKey[];

  beforeAll(async () => {
    roots = JSON.parse(await fsp.readFile(DEV_ROOTS, 'utf8')) as TrustedKey[];
  });

  it('a production server bundle holds none of the leak needles, and embeds its feed URL', async () => {
    const bundle = await bundleServer('production', roots, { level: 0, feedUrl: 'https://feed.example/altis' });
    const text = new TextDecoder().decode(bundle.code);
    for (const needle of PRODUCTION_LEAK_NEEDLES) expect(text, needle).not.toContain(needle);
    expect(text).toContain('https://feed.example/altis');
  }, 120_000);

  it('a test server bundle carries the fixture migrations and their table (its level picks which ones run)', async () => {
    const text = new TextDecoder().decode((await bundleServer('test', roots, { level: 2, feedUrl: '' })).code);
    expect(text).toContain('9001_test_expand');
    expect(text).toContain('9002_test_contract');
    expect(text).toContain('test_fixture');
  }, 120_000);
});
