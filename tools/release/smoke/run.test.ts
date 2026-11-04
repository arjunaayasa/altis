import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBootloader } from '@altis/bootloader';
import { ENGINE_SPECS, TEST_ENGINES } from '@altis/test-tools';
import * as acorn from 'acorn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALL_SCENARIOS,
  BUDGETS,
  COMPOSE_FILE,
  UPDATE_DONE_BUDGET_MS,
  UPDATE_SCENARIOS,
  UPDATE_SCENARIO_TARGETS,
  UPDATE_SIM_IDLE_MS,
  CRON_CALL_INTERVAL_MS,
  CookieJar,
  PASSENGER_IDLE_MS,
  PASSENGER_MAX_POOL,
  PASSENGER_SCENARIO_IDLE_MS,
  PM2_VERSION,
  PR_SCENARIOS,
  RSS_SAMPLE_DELAY_MS,
  SCENARIOS,
  SIM_TS,
  SseParser,
  XFF_FORGED,
  appCommand,
  baseEnv,
  budgetsApply,
  createSmokeDatabase,
  cronHeaders,
  derivedIp,
  descendantsOf,
  dockerDb,
  dockerEnvText,
  dockerOverrideText,
  evaluateBudget,
  forbiddenImageFiles,
  formatReport,
  isStartingPage,
  newDockerSecrets,
  parsePsTable,
  parseSmokeArgs,
  planSmoke,
  probeSseWorks,
  progressHints,
  scenarioSimCommand,
  smokeLayout,
  spawnTracked,
  stopTracked,
  writePrivateFile,
  type Admin,
  type SmokeOptions,
} from './run.js';

// Task 19: `pnpm smoke --zip <path> --target passenger-sim|pm2|docker|standalone --db <engine>`. The run itself is
// exercised by CI (and locally, see the task report); these tests cover what can be checked without starting
// anything: the command line, the budget evaluation with fake timings, the commands each target plan runs, and the
// Docker and CI files the run depends on.

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const NODE = process.execPath;
const ROOT = path.join(os.tmpdir(), 'altis-smoke-test-layout');
const PORT = 41234;
/** What every smoke install input names as its first super admin (Task 24). */
const SMOKE_ADMIN = { username: 'admin', name: 'Admin', password: expect.stringMatching(/^[0-9a-f]{32}$/) };

const options = (o: Partial<SmokeOptions> & Pick<SmokeOptions, 'target' | 'db'>): SmokeOptions => ({
  zip: path.join(REPO_ROOT, 'dist', 'altis-0.1.0-test.zip'),
  maxPool: PASSENGER_MAX_POOL,
  scenario: null,
  toZips: [],
  feed: null,
  ...o,
});

describe('parseSmokeArgs', () => {
  it('takes --zip (relative to where pnpm was run), --target and --db', () => {
    const o = parseSmokeArgs(['--zip', 'dist/altis-0.1.0-test.zip', '--target', 'standalone', '--db', 'sqlite'], { INIT_CWD: '/work' }, '/elsewhere');
    expect(o).toEqual({
      zip: path.resolve('/work', 'dist/altis-0.1.0-test.zip'),
      target: 'standalone',
      db: 'sqlite',
      maxPool: PASSENGER_MAX_POOL,
      scenario: null,
      toZips: [],
      feed: null,
    });
  });

  it('accepts a leading `--` (pnpm passes it through) and falls back to cwd without INIT_CWD', () => {
    const o = parseSmokeArgs(['--', '--zip', 'a.zip', '--target', 'pm2', '--db', 'pg15'], {}, '/here');
    expect(o).toMatchObject({ zip: path.resolve('/here', 'a.zip'), target: 'pm2', db: 'pg15' });
  });

  it('knows the four targets and the seven test engines', () => {
    for (const target of ['passenger-sim', 'pm2', 'docker', 'standalone'] as const) {
      expect(parseSmokeArgs(['--zip', 'a.zip', '--target', target, '--db', 'mariadb106'], {}, '/').target).toBe(target);
    }
    for (const db of TEST_ENGINES) expect(parseSmokeArgs(['--zip', 'a.zip', '--target', 'standalone', '--db', db], {}, '/').db).toBe(db);
  });

  it('refuses a missing flag, an unknown target or engine, and stray arguments: USAGE', () => {
    expect(() => parseSmokeArgs(['--target', 'standalone', '--db', 'sqlite'], {}, '/')).toThrow(/^USAGE: --zip/);
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--db', 'sqlite'], {}, '/')).toThrow(/^USAGE: --target/);
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'standalone'], {}, '/')).toThrow(/^USAGE: --db/);
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'iis', '--db', 'sqlite'], {}, '/')).toThrow(/^USAGE: --target/);
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'standalone', '--db', 'oracle'], {}, '/')).toThrow(/^USAGE: --db/);
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'standalone', '--db', 'sqlite', 'extra'], {}, '/')).toThrow(/^USAGE/);
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'standalone', '--db', 'sqlite', '--fast'], {}, '/')).toThrow(/^USAGE/);
  });

  it('passenger-sim + sqlite is refused: SQLITE_NOT_ALLOWED (P20: Passenger targets use MySQL/MariaDB/PostgreSQL)', () => {
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'passenger-sim', '--db', 'sqlite'], {}, '/')).toThrow(/^SQLITE_NOT_ALLOWED/);
    // Every other target runs on SQLite (pm2 with its one instance, docker, standalone).
    for (const target of ['pm2', 'docker', 'standalone']) {
      expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', target, '--db', 'sqlite'], {}, '/')).not.toThrow();
    }
  });

  it('--max-pool applies to passenger-sim only (nightly runs 6)', () => {
    expect(parseSmokeArgs(['--zip', 'a.zip', '--target', 'passenger-sim', '--db', 'pg17', '--max-pool', '6'], {}, '/').maxPool).toBe(6);
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'passenger-sim', '--db', 'pg17', '--max-pool', '0'], {}, '/')).toThrow(/^USAGE: --max-pool/);
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'passenger-sim', '--db', 'pg17', '--max-pool', 'six'], {}, '/')).toThrow(/^USAGE: --max-pool/);
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'passenger-sim', '--db', 'pg17', '--max-pool', '1001'], {}, '/')).toThrow(/^USAGE: --max-pool/);
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'standalone', '--db', 'sqlite', '--max-pool', '6'], {}, '/')).toThrow(/^USAGE: --max-pool/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 1c Task 34: `--scenario <name>` (A5, A6, A9 on passenger-sim). The scenarios themselves run against a release (CI,
// and locally: see the task report); these tests cover the command line and the pure pieces they are built from.

describe('parseSmokeArgs --scenario (1c Task 34)', () => {
  const sim = ['--zip', 'a.zip', '--target', 'passenger-sim', '--db', 'mariadb106'];

  it('knows the six scenarios; none by default', () => {
    expect(SCENARIOS).toEqual(['cron-backup', 'piggyback', 'cron-cli', 'polling-progress', 'sse-progress', 'xff']);
    expect(parseSmokeArgs(sim, {}, '/').scenario).toBeNull();
    for (const scenario of SCENARIOS) expect(parseSmokeArgs([...sim, '--scenario', scenario], {}, '/').scenario).toBe(scenario);
    expect(parseSmokeArgs([...sim, '--max-pool', '6', '--scenario', 'xff'], {}, '/')).toMatchObject({ maxPool: 6, scenario: 'xff' });
  });

  it('the PR tier runs cron-backup and piggyback (A6 driven by /_cron alone, A5 by page views alone)', () => {
    expect(PR_SCENARIOS).toEqual(['cron-backup', 'piggyback']);
  });

  it('refuses an unknown scenario: USAGE', () => {
    expect(() => parseSmokeArgs([...sim, '--scenario', 'backup'], {}, '/')).toThrow(/^USAGE: --scenario must be one of cron-backup, piggyback/);
    expect(() => parseSmokeArgs([...sim, '--scenario', ''], {}, '/')).toThrow(/^USAGE: --scenario/);
  });

  it('cron-backup (and every scenario) refuses --db sqlite: SQLITE_NOT_ALLOWED (P20: Passenger runs several processes)', () => {
    for (const target of ['passenger-sim', 'standalone']) {
      expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', target, '--db', 'sqlite', '--scenario', 'cron-backup'], {}, '/')).toThrow(/^SQLITE_NOT_ALLOWED/);
    }
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'passenger-sim', '--db', 'sqlite', '--scenario', 'xff'], {}, '/')).toThrow(/^SQLITE_NOT_ALLOWED/);
  });

  it('a scenario runs on passenger-sim only (external runner mode, the proxy that appends X-Forwarded-For): USAGE elsewhere', () => {
    for (const target of ['pm2', 'docker', 'standalone']) {
      expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', target, '--db', 'mariadb106', '--scenario', 'piggyback'], {}, '/')).toThrow(
        /^USAGE: --scenario applies to --target passenger-sim only/,
      );
    }
  });

  it('a /_cron call is 31 s after the previous one (the single-flight lease is 30 s, §10.3)', () => {
    expect(CRON_CALL_INTERVAL_MS).toBe(31_000);
  });

  it("the scenario's sim keeps a worker as long as Passenger's default pool idle time (300 s), past one cron interval", () => {
    const layout = smokeLayout(ROOT, PORT, 'abc123');
    const plan = planSmoke(options({ target: 'passenger-sim', db: 'mariadb106', maxPool: 6 }), layout, { dialect: 'mariadb', host: 'h', port: 1, user: 'u', database: 'd' }, {});
    const sim = scenarioSimCommand(plan.start);
    expect(PASSENGER_SCENARIO_IDLE_MS).toBe(300_000);
    expect(PASSENGER_SCENARIO_IDLE_MS).toBeGreaterThan(CRON_CALL_INTERVAL_MS);
    expect(sim.args).toEqual(plan.start.args.map((a, i) => (plan.start.args[i - 1] === '--idle-ms' ? String(PASSENGER_SCENARIO_IDLE_MS) : a)));
    expect(sim.args).toContain('--max-pool');
    expect(sim.label).toBe('start-scenario');
    expect(sim.env).toEqual(plan.start.env);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 1d Task 35: the update scenarios (A7, A9, §12.7): `--to-zip`, `--feed` and the scenarios of update-scenarios.ts.

describe('parseSmokeArgs: the update scenarios (1d Task 35)', () => {
  const args = (target: string, db: string, scenario: string, ...rest: string[]) =>
    ['--zip', 'dist/altis-0.1.0-test.zip', '--target', target, '--db', db, '--scenario', scenario, ...rest] as const;

  it('knows the nine update scenarios, after the six of 1c', () => {
    expect(UPDATE_SCENARIOS).toEqual(['update', 'update-faults', 'update-kill', 'rollback-restore', 'rollback-manual', 'update-offline', 'rejections', 'docker-pull', 'zip-reupload']);
    expect(ALL_SCENARIOS).toEqual([...SCENARIOS, ...UPDATE_SCENARIOS]);
  });

  it('--scenario update without --to-zip: USAGE (it needs the release N to update to)', () => {
    expect(() => parseSmokeArgs(args('passenger-sim', 'mariadb106', 'update'), {}, '/')).toThrow(/^USAGE: --scenario update needs --to-zip/);
    for (const scenario of UPDATE_SCENARIOS) {
      const target = UPDATE_SCENARIO_TARGETS[scenario][0]!;
      expect(() => parseSmokeArgs(args(target, 'mariadb106', scenario), {}, '/'), scenario).toThrow(/^USAGE: --scenario \S+ needs --to-zip/);
    }
  });

  it('--scenario update with --to-zip: both zips resolved from where pnpm was run, the feed built by the run (no --feed)', () => {
    const o = parseSmokeArgs(args('passenger-sim', 'mariadb106', 'update', '--to-zip', 'dist/altis-0.2.0-test.zip'), { INIT_CWD: '/work' }, '/elsewhere');
    expect(o).toMatchObject({
      zip: path.resolve('/work', 'dist/altis-0.1.0-test.zip'),
      toZips: [path.resolve('/work', 'dist/altis-0.2.0-test.zip')],
      scenario: 'update',
      feed: null,
    });
    expect(parseSmokeArgs(args('standalone', 'sqlite', 'update', '--to-zip', 'b.zip', '--feed', 'feed-out'), {}, '/w').feed).toBe(path.resolve('/w', 'feed-out'));
  });

  it('update-kill refuses --db sqlite on passenger-sim: SQLITE_NOT_ALLOWED (P20), and runs on passenger-sim only', () => {
    expect(() => parseSmokeArgs(args('passenger-sim', 'sqlite', 'update-kill', '--to-zip', 'b.zip'), {}, '/')).toThrow(/^SQLITE_NOT_ALLOWED/);
    expect(() => parseSmokeArgs(args('standalone', 'sqlite', 'update-kill', '--to-zip', 'b.zip'), {}, '/')).toThrow(/^SQLITE_NOT_ALLOWED/);
    expect(() => parseSmokeArgs(args('standalone', 'mariadb106', 'update-kill', '--to-zip', 'b.zip'), {}, '/')).toThrow(/^USAGE: --scenario update-kill runs on passenger-sim/);
    expect(parseSmokeArgs(args('passenger-sim', 'mariadb106', 'update-kill', '--to-zip', 'b.zip', '--max-pool', '6'), {}, '/')).toMatchObject({ maxPool: 6, scenario: 'update-kill' });
  });

  it('the update scenarios run on the four A1 targets (SQLite where the target allows it); docker-pull on Docker (and standalone, the zip as the image), zip-reupload standalone', () => {
    for (const scenario of ['update', 'update-faults', 'rollback-restore', 'rollback-manual', 'update-offline', 'rejections'] as const) {
      expect(UPDATE_SCENARIO_TARGETS[scenario]).toEqual(['passenger-sim', 'pm2', 'docker', 'standalone']);
      expect(parseSmokeArgs(args('standalone', 'sqlite', scenario, '--to-zip', 'b.zip'), {}, '/').scenario).toBe(scenario);
      expect(() => parseSmokeArgs(args('passenger-sim', 'sqlite', scenario, '--to-zip', 'b.zip'), {}, '/')).toThrow(/^SQLITE_NOT_ALLOWED/);
    }
    expect(UPDATE_SCENARIO_TARGETS['update-kill']).toEqual(['passenger-sim']);
    expect(UPDATE_SCENARIO_TARGETS['docker-pull']).toEqual(['docker', 'standalone']);
    expect(UPDATE_SCENARIO_TARGETS['zip-reupload']).toEqual(['standalone']);
    expect(parseSmokeArgs(args('standalone', 'sqlite', 'docker-pull', '--to-zip', 'b.zip', '--to-zip', 'c.zip'), {}, '/').scenario).toBe('docker-pull');
    expect(() => parseSmokeArgs(args('pm2', 'mysql80', 'docker-pull', '--to-zip', 'b.zip', '--to-zip', 'c.zip'), {}, '/')).toThrow(/^USAGE: --scenario docker-pull runs on docker, standalone/);
    expect(() => parseSmokeArgs(args('pm2', 'mysql80', 'zip-reupload', '--to-zip', 'b.zip'), {}, '/')).toThrow(/^USAGE: --scenario zip-reupload runs on standalone/);
  });

  it('docker-pull takes two --to-zip (image 0.2, then image 0.3); every other update scenario exactly one', () => {
    expect(parseSmokeArgs(args('docker', 'mariadb106', 'docker-pull', '--to-zip', 'b.zip', '--to-zip', 'c.zip'), {}, '/w').toZips).toEqual([path.resolve('/w', 'b.zip'), path.resolve('/w', 'c.zip')]);
    expect(() => parseSmokeArgs(args('docker', 'mariadb106', 'docker-pull', '--to-zip', 'b.zip'), {}, '/')).toThrow(/^USAGE: --scenario docker-pull needs --to-zip twice/);
    expect(() => parseSmokeArgs(args('standalone', 'sqlite', 'update', '--to-zip', 'b.zip', '--to-zip', 'c.zip'), {}, '/')).toThrow(/^USAGE: --scenario update takes one --to-zip/);
  });

  it('--to-zip and --feed belong to the update scenarios: USAGE without one, or with a 1c scenario', () => {
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'standalone', '--db', 'sqlite', '--to-zip', 'b.zip'], {}, '/')).toThrow(/^USAGE: --to-zip/);
    expect(() => parseSmokeArgs(['--zip', 'a.zip', '--target', 'standalone', '--db', 'sqlite', '--feed', 'f'], {}, '/')).toThrow(/^USAGE: --feed/);
    expect(() => parseSmokeArgs(args('passenger-sim', 'mariadb106', 'piggyback', '--to-zip', 'b.zip'), {}, '/')).toThrow(/^USAGE: --to-zip/);
  });

  it('the 1c scenarios keep their rules: passenger-sim only, never SQLite', () => {
    expect(() => parseSmokeArgs(args('standalone', 'mariadb106', 'cron-cli'), {}, '/')).toThrow(/^USAGE: --scenario applies to --target passenger-sim only/);
    expect(() => parseSmokeArgs(args('standalone', 'sqlite', 'cron-cli'), {}, '/')).toThrow(/^SQLITE_NOT_ALLOWED/);
  });

  it('on passenger-sim the update scenarios run with no cron and an idle time of 5 s (A7: Passenger kills idle workers mid-update)', () => {
    expect(UPDATE_SIM_IDLE_MS).toBe(5000);
    const layout = smokeLayout(ROOT, PORT, 'abc123');
    const plan = planSmoke(options({ target: 'passenger-sim', db: 'mariadb106', maxPool: 6 }), layout, { dialect: 'mariadb', host: 'h', port: 1, user: 'u', database: 'd' }, {});
    const sim = scenarioSimCommand(plan.start, UPDATE_SIM_IDLE_MS);
    expect(sim.args[sim.args.indexOf('--idle-ms') + 1]).toBe('5000');
    expect(sim.args[sim.args.indexOf('--max-pool') + 1]).toBe('6');
    expect(scenarioSimCommand(plan.start).args[sim.args.indexOf('--idle-ms') + 1]).toBe(String(PASSENGER_SCENARIO_IDLE_MS));
  });

  it('the update budget: apply → done within 120 s on passenger-sim without cron (§12.7)', () => {
    expect(UPDATE_DONE_BUDGET_MS).toBe(120_000);
  });
});

describe('the scenario report', () => {
  const base = {
    target: 'passenger-sim',
    db: 'mariadb106',
    node: 'v22.16.0',
    zipBytes: 1,
    coldStartMs: 300,
    rssIdleMb: 80,
    healthOk: true,
    budgetsAsserted: false,
  } as const;

  it('without a scenario the line is as before', () => {
    expect(Object.keys(JSON.parse(formatReport(base)) as object)).not.toContain('scenario');
  });

  it('with a scenario it ends with the scenario, whether it passed and what it saw', () => {
    const line = formatReport({ ...base, scenario: 'cron-backup', scenarioOk: true, scenarioDetail: { cronCalls: 3 } });
    expect(line.trimEnd()).not.toContain('\n');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed).slice(-3)).toEqual(['scenario', 'scenarioOk', 'scenarioDetail']);
    expect(parsed['scenarioDetail']).toEqual({ cronCalls: 3 });
  });
});

describe('cronHeaders: what the panel line `curl -fsS -X POST -H "Authorization: Bearer …" …/_cron` sends', () => {
  it('the bearer token, and nothing a browser would add: no Origin, no Cookie, no CSRF token, no body type', () => {
    const headers = cronHeaders('tok_123');
    expect(headers['authorization']).toBe('Bearer tok_123');
    for (const name of Object.keys(headers)) expect(['authorization', 'user-agent', 'accept', 'content-length']).toContain(name);
    expect(headers['content-length']).toBe('0');
    expect(headers['user-agent']).toMatch(/^curl\//);
  });
});

describe("isStartingPage: app.js's own 503 while a fresh worker loads the release (sent again; a cron run that meets it is lost)", () => {
  const html = (body: string) => ({ status: 503, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
  it("knows the bootloader's starting page and its /_health answer", () => {
    expect(isStartingPage(html('<!doctype html>…<h1>ALTIS is starting</h1>…'))).toBe(true);
    expect(isStartingPage({ status: 503, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"status":"starting"}' })).toBe(true);
  });

  it("does not take the server's own refusals for it: 503 MAINTENANCE, another status, another page", () => {
    expect(isStartingPage({ status: 503, headers: { 'content-type': 'application/problem+json' }, body: '{"code":"MAINTENANCE"}' })).toBe(false);
    expect(isStartingPage({ ...html('<h1>ALTIS is starting</h1>'), status: 200 })).toBe(false);
    expect(isStartingPage(html('<h1>ALTIS tidak dapat dimulai</h1>'))).toBe(false);
  });
});

describe('CookieJar', () => {
  it('keeps the cookies a response sets, by name, and sends them back as one Cookie header', () => {
    const jar = new CookieJar();
    jar.store(['altis_session=abc; Path=/; HttpOnly; SameSite=Lax', 'altis_ops=op1; Path=/; Max-Age=604800; HttpOnly']);
    expect(jar.header()).toBe('altis_session=abc; altis_ops=op1');
    jar.store('altis_session=def; Path=/; HttpOnly');
    expect(jar.header()).toBe('altis_session=def; altis_ops=op1');
    expect(jar.get('altis_ops')).toBe('op1');
  });

  it('forgets a cookie the server clears (Max-Age=0, or an empty value)', () => {
    const jar = new CookieJar();
    jar.store(['a=1; Path=/', 'b=2; Path=/', 'c=3; Path=/']);
    jar.store(['a=; Path=/; Max-Age=0', 'b=; Path=/']);
    expect(jar.header()).toBe('c=3');
    jar.store(undefined);
    expect(jar.header()).toBe('c=3');
  });
});

describe('SseParser (text/event-stream, as an EventSource reads it)', () => {
  it('assembles events from chunks cut anywhere, with their id, type and data; comments and retry are not events', () => {
    const p = new SseParser();
    const text = 'retry: 1000\n\nid: 7.12\nevent: backup.progress\ndata: {"channel":"system.backup"}\n\n: hb\n\nid: 7.13\n\nevent: tick\ndata: {"n":1}\r\n\r\n';
    const events = [...text].flatMap((ch) => p.push(ch));
    expect(events).toEqual([
      { id: '7.12', event: 'backup.progress', data: '{"channel":"system.backup"}' },
      { id: '7.13', event: 'message', data: '' },
      { id: '7.13', event: 'tick', data: '{"n":1}' },
    ]);
    expect(p.lastEventId).toBe('7.13');
  });

  it('a block that only moves the id is reported with an empty `message` (the cursor moved), multi-line data joined', () => {
    const p = new SseParser();
    expect(p.push('id: 3.1\n\ndata: a\ndata: b\n\n')).toEqual([
      { id: '3.1', event: 'message', data: '' },
      { id: '3.1', event: 'message', data: 'a\nb' },
    ]);
  });
});

describe('probeSseWorks: the browser test of SSE (lib/probes.ts): three ticks within 6 s, spread over at least 1 s', () => {
  it('ticks 1 s apart pass; ticks delivered at once (a buffering proxy) or too few fail', () => {
    expect(probeSseWorks([100, 1100, 2100], true)).toBe(true);
    expect(probeSseWorks([2100, 2101, 2102], true)).toBe(false);
    expect(probeSseWorks([100, 1100], true)).toBe(false);
    expect(probeSseWorks([100, 1100, 2100], false)).toBe(false); // no `done` event: the stream was cut
  });
});

describe('progressHints: the backup progress a client sees on system.backup', () => {
  it('picks the backup.progress events of one backup and its backup.done, ignoring other backups and types', () => {
    const events = [
      { seq: 1, channel: 'system.backup', type: 'backup.progress', payload: { backupId: 'B1', progress: 0 }, at: 1 },
      { seq: 2, channel: 'system.backup', type: 'backup.progress', payload: { backupId: 'B2', progress: 10 }, at: 2 },
      { seq: 3, channel: 'system.backup', type: 'op.progress', payload: { opId: 'O', progress: 50 }, at: 3 },
      { seq: 4, channel: 'system.backup', type: 'backup.progress', payload: { backupId: 'B1', progress: 40 }, at: 4 },
      { seq: 4, channel: 'system.backup', type: 'backup.progress', payload: { backupId: 'B1', progress: 40 }, at: 4 }, // re-sent
      { seq: 5, channel: 'system.backup', type: 'backup.done', payload: { backupId: 'B1' }, at: 5 },
    ];
    expect(progressHints(events, 'B1')).toEqual({ progress: [0, 40], done: true });
    expect(progressHints(events.slice(0, 3), 'B1')).toEqual({ progress: [0], done: false });
  });
});

describe('derivedIp: the client IP hops derive from a chain (P15), as the server does', () => {
  it('passenger-sim appends the peer: a forged leftmost entry becomes the client IP with hops 2, not with hops 1', () => {
    const forged = [XFF_FORGED, '127.0.0.1'];
    expect(XFF_FORGED).toBe('203.0.113.77');
    expect(derivedIp(forged, '127.0.0.1', 1)).toBe('127.0.0.1');
    expect(derivedIp(forged, '127.0.0.1', 2)).toBe(XFF_FORGED);
    expect(derivedIp(forged, '127.0.0.1', 0)).toBe('127.0.0.1');
    expect(derivedIp([], '127.0.0.1', 3)).toBe('127.0.0.1'); // a chain shorter than the hops: the peer
  });
});

describe('appCommand: `node app.js <command>` of a scenario', () => {
  it('runs in the appRoot with DATA_DIR and the runtime of the install (passenger), nothing of this shell', () => {
    const layout = smokeLayout(ROOT, PORT, 'abc123');
    const c = appCommand(layout, 'jobs-run', ['jobs:run', '--budget', '1'], { PATH: '/bin' });
    expect([c.file, ...c.args]).toEqual([NODE, 'app.js', 'jobs:run', '--budget', '1']);
    expect(c.cwd).toBe(layout.appRoot);
    expect(c.env).toEqual({ PATH: '/bin', ALTIS_DATA_DIR: layout.dataDir, ALTIS_RUNTIME: 'passenger' });
    expect(c.label).toBe('jobs-run');
  });
});

describe('budgets (fake timings)', () => {
  it('the budgets are the Global Constraints: cold start < 1.5 s, idle RSS < 150 MB', () => {
    expect(BUDGETS).toEqual({ coldStartMs: 1500, rssIdleMb: 150 });
  });

  it('rejects coldStartMs 1600 and rssIdleMb 160, naming both', () => {
    const result = evaluateBudget({ coldStartMs: 1600, rssIdleMb: 160 });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatch(/^coldStartMs 1600/);
    expect(result.failures[1]).toMatch(/^rssIdleMb 160/);
  });

  it('accepts coldStartMs 1200 and rssIdleMb 120', () => {
    expect(evaluateBudget({ coldStartMs: 1200, rssIdleMb: 120 })).toEqual({ ok: true, failures: [] });
  });

  it('each budget on its own; the limits themselves fail (the budgets are strict upper bounds)', () => {
    expect(evaluateBudget({ coldStartMs: 1600, rssIdleMb: 120 }).failures).toEqual([expect.stringMatching(/^coldStartMs/)]);
    expect(evaluateBudget({ coldStartMs: 1200, rssIdleMb: 160 }).failures).toEqual([expect.stringMatching(/^rssIdleMb/)]);
    expect(evaluateBudget({ coldStartMs: 1500, rssIdleMb: 149.9 }).ok).toBe(false);
    expect(evaluateBudget({ coldStartMs: 1499, rssIdleMb: 150 }).ok).toBe(false);
  });

  it('an RSS that could not be sampled (null: Windows) is not asserted; a cold start never measured fails', () => {
    expect(evaluateBudget({ coldStartMs: 1200, rssIdleMb: null })).toEqual({ ok: true, failures: [] });
    expect(evaluateBudget({ coldStartMs: null, rssIdleMb: 120 }).ok).toBe(false);
  });

  it('budgets are asserted on Linux x64 only', () => {
    expect(budgetsApply('linux', 'x64')).toBe(true);
    expect(budgetsApply('linux', 'arm64')).toBe(false);
    expect(budgetsApply('darwin', 'arm64')).toBe(false);
    expect(budgetsApply('darwin', 'x64')).toBe(false);
    expect(budgetsApply('win32', 'x64')).toBe(false);
  });

  it('RSS is sampled 10 s after healthy, and an idle passenger-sim worker outlives the sample', () => {
    expect(RSS_SAMPLE_DELAY_MS).toBe(10_000);
    expect(PASSENGER_IDLE_MS).toBeGreaterThan(RSS_SAMPLE_DELAY_MS);
  });

  it('the report is one JSON line: target, db, node, zipBytes, coldStartMs, rssIdleMb, healthOk, budgetsAsserted', () => {
    const line = formatReport({
      target: 'standalone',
      db: 'sqlite',
      node: 'v22.16.0',
      zipBytes: 123,
      coldStartMs: 900,
      rssIdleMb: 80.5,
      healthOk: true,
      budgetsAsserted: false,
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    expect(Object.keys(JSON.parse(line) as object)).toEqual([
      'target',
      'db',
      'node',
      'zipBytes',
      'coldStartMs',
      'rssIdleMb',
      'healthOk',
      'budgetsAsserted',
    ]);
  });
});

describe('ps output', () => {
  const PS = ['  1     0  1000', ' 50     1  2048', ' 51    50 81920', ' 52    51  4096', ' 60     1  9999', 'garbage line', ''].join('\n');

  it('parsePsTable reads `pid ppid rss` rows (KiB) and skips anything else', () => {
    const table = parsePsTable(PS);
    expect(table.get(51)).toEqual({ ppid: 50, rssKb: 81920 });
    expect(table.size).toBe(5);
  });

  it('descendantsOf lists children and grandchildren, not the process itself or its siblings', () => {
    expect(descendantsOf(parsePsTable(PS), 50).sort()).toEqual([51, 52]);
    expect(descendantsOf(parsePsTable(PS), 52)).toEqual([]);
  });
});

describe('planSmoke', () => {
  const layout = smokeLayout(ROOT, PORT, 'abc123');
  const sqlite = { dialect: 'sqlite' } as const;
  const mariadb = { dialect: 'mariadb', host: '127.0.0.1', port: 33106, user: 'altis', password: 'pw', database: 'altis_smoke_x' } as const;

  it('child processes get only what node, npx and docker need: no ALTIS_* or pm_id of this shell; this Node first on PATH', () => {
    const env = baseEnv({ PATH: '/usr/bin', HOME: '/h', ALTIS_RUNTIME: 'pm2', ALTIS_DB_PASSWORD: 'x', pm_id: '3', IN_PASSENGER: '1' });
    expect(env).toEqual({ PATH: [path.dirname(NODE), '/usr/bin'].join(path.delimiter), HOME: '/h' });
  });

  it('the layout: a fresh appRoot with DATA_DIR as its sibling, outside any public_html', () => {
    expect(layout.appRoot).toBe(path.join(ROOT, 'app'));
    expect(path.dirname(layout.dataDir)).toBe(path.dirname(layout.appRoot));
    expect(layout.appRoot).not.toMatch(/public_html/);
    expect(layout.installFile.startsWith(layout.appRoot)).toBe(false);
  });

  it('standalone + sqlite: `node app.js install --config <f>`, then `node app.js`', () => {
    const plan = planSmoke(options({ target: 'standalone', db: 'sqlite' }), layout, sqlite, { PATH: '/bin' });
    expect(plan.setup).toEqual([]);
    expect([plan.install, plan.start].map((c) => [c.file, ...c.args])).toEqual([
      [NODE, 'app.js', 'install', '--config', layout.installFile],
      [NODE, 'app.js'],
    ]);
    for (const c of [plan.install, plan.start]) {
      expect(c.cwd).toBe(layout.appRoot);
      expect(c.env['ALTIS_DATA_DIR']).toBe(layout.dataDir);
      expect(c.env['PATH']).toBe('/bin');
      expect(c.env['ALTIS_RUNTIME']).toBeUndefined(); // detected: standalone
    }
    expect(plan.start.env['ALTIS_PORT']).toBe(String(PORT));
    // The first super admin (Task 24): a random password per run, written only to the install input (mode 0600).
    expect(plan.installInput).toEqual({ baseUrl: `http://127.0.0.1:${PORT}`, db: { dialect: 'sqlite' }, admin: SMOKE_ADMIN });
    const again = planSmoke(options({ target: 'standalone', db: 'sqlite' }), layout, sqlite, { PATH: '/bin' });
    expect(again.installInput.admin.password).not.toBe(plan.installInput.admin.password);
    expect(plan.teardown).toEqual([]);
  });

  it('passenger-sim + mariadb106: installs as runtime passenger, then the sim is pointed at appRoot', () => {
    const plan = planSmoke(options({ target: 'passenger-sim', db: 'mariadb106', maxPool: 6 }), layout, mariadb, {});
    expect(plan.install.env['ALTIS_RUNTIME']).toBe('passenger');
    expect([plan.start.file, ...plan.start.args]).toEqual([
      NODE,
      '--import',
      'tsx',
      SIM_TS,
      ...['--app', layout.appRoot, '--port', String(PORT), '--idle-ms', String(PASSENGER_IDLE_MS), '--max-pool', '6'],
    ]);
    expect(plan.start.cwd).toBe(REPO_ROOT);
    expect(plan.start.env['ALTIS_DATA_DIR']).toBe(layout.dataDir); // the workers inherit it
    expect(plan.start.env['ALTIS_RUNTIME']).toBeUndefined(); // the shim makes the workers detect passenger
    expect(plan.installInput.db).toEqual(mariadb);
  });

  it('pm2: `pm2 start ecosystem.config.cjs` with ALTIS_PORT, through npx at an exact version and a private PM2_HOME', () => {
    const plan = planSmoke(options({ target: 'pm2', db: 'sqlite' }), layout, sqlite, {});
    expect(PM2_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(plan.install.env['ALTIS_RUNTIME']).toBe('pm2');
    expect(plan.start.args).toEqual(['--yes', `pm2@${PM2_VERSION}`, 'start', 'ecosystem.config.cjs']);
    expect(plan.start.cwd).toBe(layout.appRoot);
    expect(plan.start.env).toMatchObject({ ALTIS_PORT: String(PORT), ALTIS_DATA_DIR: layout.dataDir, PM2_HOME: layout.pm2Home });
    expect(plan.teardown.map((c) => c.args)).toEqual([['--yes', `pm2@${PM2_VERSION}`, 'kill']]);
    expect(plan.teardown[0]!.env['PM2_HOME']).toBe(layout.pm2Home);
  });

  it('docker + mariadb106: build, DB up, install.json into /data, install with `docker compose run`, then up', () => {
    const plan = planSmoke(options({ target: 'docker', db: 'mariadb106' }), layout, dockerDb('mariadb106'), {});
    const compose = ['compose', '--project-name', layout.project, '--env-file', layout.envFile, '-f', COMPOSE_FILE];
    const all = [...plan.setup, plan.install, plan.start, ...plan.teardown];
    for (const c of all.slice(0, -1)) expect([c.file, ...c.args.slice(0, compose.length)]).toEqual(['docker', ...compose]);
    const tail = (c: { args: string[] }): string[] => c.args.slice(compose.length);
    expect(plan.setup.map(tail)).toEqual([
      ['build', 'app'],
      ['up', '--detach', '--wait', 'db'],
      ['run', '--rm', '-T', '--no-deps', 'app', 'sh', '-c', 'cat > /data/install.json'],
    ]);
    expect(JSON.parse(plan.setup[2]!.stdin!)).toEqual(plan.installInput);
    expect(tail(plan.install)).toEqual(['run', '--rm', '-T', '--no-deps', 'app', 'node', '/app/app.js', 'install', '--config', '/data/install.json']);
    expect(tail(plan.start)).toEqual(['up', '--detach', '--no-deps', 'app']);
    expect(plan.teardown.map((c) => [c.file, ...c.args.slice(c.file === 'docker' && c.args[0] === 'compose' ? compose.length : 0)])).toEqual([
      ['docker', 'down', '--volumes', '--remove-orphans', '--timeout', '20'],
      ['docker', 'image', 'rm', '--force', layout.image],
    ]);
    // The password reaches the app through ALTIS_DB_PASSWORD (from .env), never through install.json/config.json.
    expect(plan.installInput).toEqual({
      baseUrl: `http://127.0.0.1:${PORT}`,
      db: { dialect: 'mariadb', host: 'db', port: 3306, user: 'altis', database: 'altis' },
      admin: SMOKE_ADMIN,
    });
  });

  it('docker + sqlite needs no DB service; docker + pg15 adds the engine override', () => {
    const sqlitePlan = planSmoke(options({ target: 'docker', db: 'sqlite' }), layout, dockerDb('sqlite'), {});
    expect(sqlitePlan.setup.some((c) => c.args.includes('db'))).toBe(false);
    expect(sqlitePlan.installInput.db).toEqual({ dialect: 'sqlite' });

    const pgPlan = planSmoke(options({ target: 'docker', db: 'pg15' }), layout, dockerDb('pg15'), {});
    expect(pgPlan.install.args.slice(0, 9)).toEqual([
      ...['compose', '--project-name', layout.project, '--env-file', layout.envFile],
      ...['-f', COMPOSE_FILE, '-f', layout.overrideFile],
    ]);
    expect(pgPlan.installInput.db).toEqual({ dialect: 'postgres', host: 'db', port: 5432, user: 'altis', database: 'altis' });
  });

  it('dockerDb uses the dialect of each test engine', () => {
    for (const engine of TEST_ENGINES) expect(dockerDb(engine).dialect).toBe(ENGINE_SPECS[engine].dialect);
  });
});

describe('spawnTracked: a child that cannot be started or reports an error never crashes the run (final review 17)', () => {
  const quiet = (): void => {}; // the run reports a child's error on stderr; the test keeps its output clean
  const waitFor = async (condition: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 500; i++) {
      if (condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  it('a binary that does not exist: the error event is kept (no unhandled error), alive() reports it and stopTracked does not hang', async () => {
    const p = spawnTracked('npx-missing', path.join(os.tmpdir(), 'altis-smoke-no-such-binary'), [], { stdio: 'ignore' }, quiet);
    await waitFor(() => p.failure() !== null, 'the spawn error');
    expect(p.failure()).toMatch(/^npx-missing: .* could not be started: .*ENOENT/);
    expect(() => p.alive()).toThrow(/npx-missing: .* could not be started/);
    await stopTracked(p); // returns: there is nothing to stop
  });

  it('an error event on a running child (a failed kill, say) is kept too, and the child is still stopped afterwards', async () => {
    const p = spawnTracked('idle', NODE, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }, quiet);
    expect(p.alive()).toBe(true);
    expect(p.failure()).toBeNull();
    p.child.emit('error', new Error('boom'));
    expect(p.failure()).toMatch(/boom/);
    expect(() => p.alive()).toThrow(/boom/);
    await stopTracked(p);
    expect(p.child.exitCode !== null || p.child.signalCode !== null).toBe(true);
  });

  it('a child that simply exits is not alive, and no failure is reported', async () => {
    const p = spawnTracked('quick', NODE, ['-e', ''], { stdio: 'ignore' }, quiet);
    await waitFor(() => p.child.exitCode !== null, 'the exit');
    expect(p.alive()).toBe(false);
    expect(p.failure()).toBeNull();
  });
});

describe('createSmokeDatabase: the drop is registered before anything that can still fail (final review 17)', () => {
  /** An admin connection that records what runs; the first statement starting with `failOn` throws. */
  function fake(failOn?: string): { open: () => Promise<Admin>; events: string[]; statements: string[] } {
    const events: string[] = [];
    const statements: string[] = [];
    const open = async (): Promise<Admin> => {
      events.push('open');
      return {
        run: async (statement: string, values: unknown[] = []): Promise<void> => {
          statements.push(statement);
          events.push(`${statement.split(' ').slice(0, 2).join(' ')} ${JSON.stringify(values)}`);
          if (failOn !== undefined && statement.startsWith(failOn)) throw new Error(`${failOn} refused`);
        },
        close: async () => void events.push('close'),
      };
    };
    return { open, events, statements };
  }

  it('MySQL/MariaDB: a GRANT that fails after CREATE DATABASE still leaves a drop that removes the database', async () => {
    const f = fake('GRANT');
    const drops: (() => Promise<void>)[] = [];
    await expect(
      createSmokeDatabase('mariadb', 'altis_smoke_abcd', f.open, (drop) => {
        f.events.push('registered');
        drops.push(drop);
      }),
    ).rejects.toThrow(/GRANT refused/);
    expect(drops).toHaveLength(1);
    // Registered before the GRANT ran.
    expect(f.events.indexOf('registered')).toBeGreaterThan(-1);
    expect(f.events.indexOf('registered')).toBeLessThan(f.events.findIndex((e) => e.startsWith('GRANT')));
    expect(f.events.at(-1)).toBe('close'); // the admin connection of the failed create was closed
    f.events.length = 0;
    await drops[0]!();
    expect(f.events).toEqual(['open', 'DROP DATABASE ["altis_smoke_abcd"]', 'close']);
    expect(f.statements.at(-1)).toBe('DROP DATABASE IF EXISTS ??');
  });

  it('a CREATE DATABASE that fails also leaves its drop registered (the server may have created it before the error reached us)', async () => {
    const f = fake('CREATE DATABASE');
    const drops: (() => Promise<void>)[] = [];
    await expect(createSmokeDatabase('mysql', 'altis_smoke_ef01', f.open, (d) => drops.push(d))).rejects.toThrow(/CREATE DATABASE refused/);
    expect(drops).toHaveLength(1);
  });

  it('PostgreSQL: the role and the database are created, and the drop forces the other sessions off', async () => {
    const f = fake();
    const drops: (() => Promise<void>)[] = [];
    await createSmokeDatabase('postgres', 'altis_smoke_2345', f.open, (d) => drops.push(d));
    expect(f.statements.filter((s) => /^(CREATE ROLE|CREATE DATABASE)/.test(s))).toHaveLength(2);
    expect(drops).toHaveLength(1);
    await drops[0]!();
    expect(f.statements.at(-1)).toBe('DROP DATABASE IF EXISTS "altis_smoke_2345" WITH (FORCE)');
  });

  it('a successful create registers exactly one drop', async () => {
    const drops: (() => Promise<void>)[] = [];
    await createSmokeDatabase('mysql', 'altis_smoke_6789', fake().open, (d) => drops.push(d));
    expect(drops).toHaveLength(1);
  });
});

describe('forbiddenImageFiles: the image holds no .env, .git or source map (spec §9.11)', () => {
  it('names every .env*, .git entry and *.map, wherever it sits', () => {
    const files = [
      'app.js',
      'package.json',
      'bundled-release/0.1.0/server.mjs',
      'bundled-release/0.1.0/manifest.json',
      '.env',
      'bundled-release/.env.production',
      '.git/config',
      'vendor/.git',
      'app.js.map',
      'bundled-release/0.1.0/server.mjs.map',
      'ADMIN.MAP',
    ];
    expect(forbiddenImageFiles(files)).toEqual([
      '.env',
      'bundled-release/.env.production',
      '.git/config',
      'vendor/.git',
      'app.js.map',
      'bundled-release/0.1.0/server.mjs.map',
      'ADMIN.MAP',
    ]);
  });

  it('does not take look-alikes for them', () => {
    const lookAlikes = ['environment.js', 'dotenv.js', 'bundled-release/0.1.0/.complete', 'sitemap.xml', 'map.js', 'legit/readme.txt', '.github/x', 'a.gitignore'];
    expect(forbiddenImageFiles(lookAlikes)).toEqual([]);
  });
});

describe('Docker secrets and overrides', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altis-smoke-test-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('newDockerSecrets: random, URL-safe and different every time', () => {
    const a = newDockerSecrets();
    const b = newDockerSecrets();
    expect(a.dbPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(a.rootPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(new Set([a.dbPassword, a.rootPassword, b.dbPassword, b.rootPassword]).size).toBe(4);
  });

  it('the .env holds the secrets, the release folder, the image and the port; written with mode 0600', () => {
    const layout = smokeLayout(dir, PORT, 'def456');
    const secrets = newDockerSecrets();
    const text = dockerEnvText(layout, secrets, 'mariadb106');
    expect(text).toContain(`ALTIS_DB_PASSWORD=${secrets.dbPassword}\n`);
    expect(text).toContain(`ALTIS_DB_ROOT_PASSWORD=${secrets.rootPassword}\n`);
    expect(text).toContain(`ALTIS_RELEASE_DIR='${layout.appRoot}'\n`);
    expect(text).toContain(`ALTIS_IMAGE=${layout.image}\n`);
    expect(text).toContain(`ALTIS_HTTP_PORT=${PORT}\n`);
    writePrivateFile(layout.envFile, text);
    expect(fs.readFileSync(layout.envFile, 'utf8')).toBe(text);
    if (process.platform !== 'win32') expect(fs.statSync(layout.envFile).mode & 0o777).toBe(0o600);
  });

  it("the .env names each engine's database in the app's environment: exactly what install.json names, so compose.yml's MariaDB defaults never override it", () => {
    const layout = smokeLayout(dir, PORT, 'fed789');
    const compose = read('docker', 'compose.yml');
    for (const engine of TEST_ENGINES) {
      const env = composeAppEnv(compose, parseDotenv(dockerEnvText(layout, newDockerSecrets(), engine)));
      const db = dockerDb(engine);
      expect(dbEnvOf(env), engine).toEqual({
        ALTIS_DB_DIALECT: db.dialect,
        ALTIS_DB_HOST: db.host ?? '',
        ALTIS_DB_PORT: db.port === undefined ? '' : String(db.port),
        ALTIS_DB_USER: db.user ?? '',
        ALTIS_DB_NAME: db.database ?? '',
      });
      // A server engine's database is named with its host (the volume gate of spec §7.7 is on); SQLite's file is
      // in the data volume, so there is nothing to ask when that is lost.
      expect(env['ALTIS_DB_HOST'] !== '', engine).toBe(engine !== 'sqlite');
    }
  });

  it('a generated .env is git-ignored wherever it lands', () => {
    const ignored = execFileSync('git', ['check-ignore', '--no-index', 'docker/.env', '.env'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(ignored.split('\n').filter(Boolean)).toEqual(['docker/.env', '.env']);
  });

  it('engine overrides: none for mariadb106 and sqlite; the other engines replace the db service', () => {
    expect(dockerOverrideText('mariadb106')).toBeNull();
    expect(dockerOverrideText('sqlite')).toBeNull();
    expect(dockerOverrideText('mariadb114')).toMatch(/image: mariadb:11\.4/);
    expect(dockerOverrideText('mysql80')).toMatch(/image: mysql:8\.0/);
    expect(dockerOverrideText('mysql84')).toMatch(/image: mysql:8\.4/);
    expect(dockerOverrideText('pg15')).toMatch(/image: postgres:15/);
    expect(dockerOverrideText('pg17')).toMatch(/image: postgres:17/);
    for (const engine of ['mysql80', 'mysql84', 'mariadb114', 'pg15', 'pg17'] as const) {
      const text = dockerOverrideText(engine)!;
      expect(text, engine).not.toMatch(/^\s*ports:/m); // still no published DB port
      // MariaDB 11.4 keeps compose.yml's MARIADB_* environment; the others get their image's variables.
      if (engine !== 'mariadb114') expect(text, engine).toMatch(/^ {4}environment: !override$/m);
      if (engine !== 'mariadb114') expect(text, engine).toContain('_PASSWORD: ${ALTIS_DB_PASSWORD:?');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The Docker image files and the CI workflows (Task 19 rulings).

const read = (...p: string[]): string => fs.readFileSync(path.join(REPO_ROOT, ...p), 'utf8');

/** The lines of a top-level (2-space indented) service of a compose file, its header excluded. */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`no service ${name}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));
  return rest.slice(0, end === -1 ? undefined : end).join('\n');
}

/** The KEY=VALUE lines of a .env (comments and blank lines skipped; one pair of single quotes taken off). */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const value = line.slice(eq + 1);
    out[line.slice(0, eq)] = /^'.*'$/.test(value) ? value.slice(1, -1) : value;
  }
  return out;
}

/**
 * The app service's `environment:` of a compose file as Docker Compose hands it to the container: `${VAR}`,
 * `${VAR-default}` (default only when VAR is unset), `${VAR:-default}` (also when blank) and `${VAR:?message}`
 * (an error when unset or blank) resolved against `vars` (the .env).
 */
function composeAppEnv(compose: string, vars: Record<string, string>): Record<string, string> {
  const lines = serviceBlock(compose, 'app').split('\n');
  const start = lines.indexOf('    environment:');
  if (start === -1) throw new Error('no environment for app');
  const out: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (/^ {6}#/.test(line)) continue;
    const m = /^ {6}([A-Z0-9_]+): (.*)$/.exec(line);
    if (m === null) break;
    out[m[1]!] = m[2]!.replace(/\$\{([A-Z0-9_]+)(?:(:?)([-?])([^}]*))?\}/g, (_all, name: string, colon: string | undefined, op: string | undefined, arg: string | undefined) => {
      const value = vars[name];
      const missing = value === undefined || (colon === ':' && value === '');
      if (op === '?' && missing) throw new Error(`${name}: ${arg ?? ''}`);
      if (op === '-' && missing) return arg ?? '';
      return value ?? '';
    });
  }
  return out;
}

/** The ALTIS_DB_* the install gate and loadConfig read (the password apart), as a container gets them. */
const DB_ENV_NAMES = ['ALTIS_DB_DIALECT', 'ALTIS_DB_HOST', 'ALTIS_DB_PORT', 'ALTIS_DB_USER', 'ALTIS_DB_NAME'] as const;

function dbEnvOf(env: Record<string, string>): Record<string, string | undefined> {
  return Object.fromEntries(DB_ENV_NAMES.map((name) => [name, env[name]]));
}

/** What altis-init writes (docker/altis-init): the two passwords and the install code, nothing else. */
const ALTIS_INIT_ENV = { ALTIS_DB_PASSWORD: 'p'.repeat(32), ALTIS_DB_ROOT_PASSWORD: 'r'.repeat(32), ALTIS_INSTALL_CODE: '' };

describe('docker/', () => {
  it('Dockerfile: node:24-bookworm-slim pinned by digest (tag kept in a comment), the release at /app, non-root, DATA_DIR /data, runtime docker', () => {
    const dockerfile = read('docker', 'Dockerfile');
    const instructions = dockerfile.split('\n').filter((line) => /^[A-Z]+\s/.test(line));
    // A moving tag would change the image under a reproducible release: the base is the digest of the tag's index.
    expect(instructions[0]).toMatch(/^FROM node:24-bookworm-slim@sha256:[0-9a-f]{64}$/);
    expect(dockerfile).toMatch(/^# Base image: node:24-bookworm-slim, pinned by the digest/m);
    expect(instructions.filter((line) => line.startsWith('FROM '))).toHaveLength(1);
    expect(dockerfile).toMatch(/^COPY --from=release \. \/app$/m);
    expect(dockerfile).toMatch(/^ENV .*ALTIS_DATA_DIR=\/data/m);
    expect(dockerfile).toMatch(/^ENV .*ALTIS_RUNTIME=docker/m);
    expect(dockerfile).toMatch(/^VOLUME \/data$/m);
    // The OCI labels of the licence and of the source (AGPL-3.0 section 13).
    expect(instructions).toContain(
      'LABEL org.opencontainers.image.licenses="AGPL-3.0-only" org.opencontainers.image.source="https://github.com/arjunaayasa/altis"',
    );
    expect(instructions[instructions.length - 1]).toBe('CMD ["node", "/app/app.js"]');
    const user = instructions.findIndex((line) => line === 'USER node');
    expect(user).toBeGreaterThan(0);
    // Nothing runs as root after USER node, and nothing switches back.
    expect(instructions.slice(user).filter((line) => /^(USER|RUN) /.test(line))).toEqual(['USER node']);
  });

  it('entrypoint.sh has LF line endings only, and .gitattributes keeps it (and the other text files) LF on every checkout', () => {
    // A Windows checkout with core.autocrlf=true would give it CRLF, and the image's dash stops at `set -eu\r`.
    expect(fs.readFileSync(path.join(REPO_ROOT, 'docker', 'entrypoint.sh')).includes(0x0d)).toBe(false);
    const files = ['docker/entrypoint.sh', 'docker/Dockerfile', 'docker/compose.yml', '.github/workflows/nightly.yml', 'tools/release/templates/ecosystem.config.cjs'];
    const out = execFileSync('git', ['check-attr', 'eol', '--', ...files], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(out.split('\n').filter(Boolean)).toEqual(files.map((file) => `${file}: eol: lf`));
    const text = execFileSync('git', ['check-attr', 'text', '--', 'docker/entrypoint.sh'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(text.trim()).toMatch(/: text: (set|auto)$/);
  });

  it('.dockerignore is an allowlist: only entrypoint.sh leaves docker/ (never a .env)', () => {
    const lines = read('docker', '.dockerignore')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(lines).toEqual(['*', '!entrypoint.sh']);
  });

  it('compose.yml: the documented install.json holds the required first super admin, and a step deletes it after the install', () => {
    const header = read('docker', 'compose.yml')
      .split('\n')
      .filter((line) => line.startsWith('#'))
      .join('\n');
    // Without `admin` the install exits 1 with INVALID_CONFIG; with it, the file keeps a plaintext password on /data.
    expect(header).toMatch(/"admin": \{"username": [^}]*"name": [^}]*"password": [^}]*\}/);
    expect(header).toMatch(/at least 10 characters/);
    expect(header).toMatch(/docker compose -f docker\/compose\.yml run --rm app rm \/data\/install\.json/);
  });

  it('compose.yml: app read-only with tmpfs /tmp, data volume, restart unless-stopped; db mariadb:10.6 without ports', () => {
    const compose = read('docker', 'compose.yml');
    const app = serviceBlock(compose, 'app');
    const db = serviceBlock(compose, 'db');
    expect(app).toMatch(/^ {4}read_only: true$/m);
    expect(app).toMatch(/^ {4}tmpfs:\n {6}- \/tmp$/m);
    expect(app).toMatch(/^ {4}volumes:\n {6}- data:\/data$/m);
    expect(app).toMatch(/^ {4}restart: unless-stopped$/m);
    expect(app).toMatch(/^ {6}ALTIS_DB_PASSWORD: \$\{ALTIS_DB_PASSWORD:\?/m);
    expect(db).toMatch(/^ {4}image: mariadb:10\.6$/m);
    expect(db).not.toMatch(/^\s*ports:/m);
    expect(db).toMatch(/^ {6}MARIADB_PASSWORD: \$\{ALTIS_DB_PASSWORD:\?/m);
    expect(db).toMatch(/^ {6}MARIADB_ROOT_PASSWORD: \$\{ALTIS_DB_ROOT_PASSWORD:\?/m);
    // The only published port is the app's, on loopback unless the operator says otherwise.
    expect(compose.match(/^\s*ports:/gm)).toHaveLength(1);
    expect(app).toContain("'${ALTIS_HTTP_BIND:-127.0.0.1}:${ALTIS_HTTP_PORT:-8080}:3000'");
  });

  it("compose.yml with altis-init's .env names the db service's database in the app's environment (spec §7.7, A2: the 'volume data hilang' gate is on)", () => {
    const compose = read('docker', 'compose.yml');
    const env = composeAppEnv(compose, ALTIS_INIT_ENV);
    // The install gate asks the database ALTIS_DB_* names (dialect and host at least) when config.json is gone.
    expect(dbEnvOf(env)).toEqual({ ALTIS_DB_DIALECT: 'mariadb', ALTIS_DB_HOST: 'db', ALTIS_DB_PORT: '3306', ALTIS_DB_USER: 'altis', ALTIS_DB_NAME: 'altis' });
    expect(env['ALTIS_DB_PASSWORD']).toBe(ALTIS_INIT_ENV.ALTIS_DB_PASSWORD);
    // The same database the db service creates, and the one the smoke's MariaDB 10.6 install names.
    const db = serviceBlock(compose, 'db');
    expect(db).toContain(`MARIADB_USER: ${env['ALTIS_DB_USER']}`);
    expect(db).toContain(`MARIADB_DATABASE: ${env['ALTIS_DB_NAME']}`);
    expect(dockerDb('mariadb106')).toEqual({ dialect: 'mariadb', host: 'db', port: 3306, user: 'altis', database: 'altis' });
    // `${VAR-default}`: a variable the .env sets blank stays blank (the server reads blank as unset), so an operator
    // (or the smoke's SQLite run) can take one out; one the .env sets wins.
    expect(dbEnvOf(composeAppEnv(compose, { ...ALTIS_INIT_ENV, ALTIS_DB_HOST: '', ALTIS_DB_DIALECT: 'postgres' }))).toMatchObject({
      ALTIS_DB_DIALECT: 'postgres',
      ALTIS_DB_HOST: '',
    });
  });

  it('entrypoint.sh: POSIX sh, set -eu, copies the bundled release only if absent, never touches the pointers', () => {
    const script = read('docker', 'entrypoint.sh');
    expect(script.split('\n')[0]).toBe('#!/bin/sh');
    expect(script).toMatch(/^set -eu$/m);
    expect(script).toMatch(/^exec "\$@"$/m);
    const code = script
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(code).not.toMatch(/current\.json/); // the pointers are app.js's
    expect(code).not.toMatch(/\[\[|\bfunction\b|\blocal\b|\$\{[A-Za-z_]+\/\/|<<<|\bsource\b/); // no bashisms
    if (process.platform !== 'win32') execFileSync('sh', ['-n', path.join(REPO_ROOT, 'docker', 'entrypoint.sh')]);
  });

  it.skipIf(process.platform === 'win32')(
    'entrypoint.sh removes the .tmp-entrypoint-* copies a killed container left (spec §9.3), never a recent one, the server\'s staging or a release',
    () => {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), 'altis-entrypoint-'));
      try {
        const releases = path.join(data, 'releases');
        const hoursAgo = (h: number): Date => new Date(Date.now() - h * 3_600_000);
        const folder = (name: string, mtime: Date): string => {
          const dir = path.join(releases, name);
          fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
          fs.writeFileSync(path.join(dir, 'public', 'app.js'), 'x');
          fs.utimesSync(dir, mtime, mtime);
          return dir;
        };
        folder('.tmp-entrypoint-Ab12Cd', hoursAgo(2)); // a copy killed two hours ago: its EXIT trap never ran
        folder('.tmp-entrypoint-Zz99Yy', hoursAgo(26));
        folder('.tmp-entrypoint-Live01', hoursAgo(0.05)); // another container on this volume may be copying right now
        folder('.tmp-0.2.0-01JZ0000000000000000000000', hoursAgo(2)); // the server's staging: its own boot sweep's
        folder('0.1.0', hoursAgo(48));
        fs.writeFileSync(path.join(releases, 'current.json'), '{}');
        execFileSync('sh', [path.join(REPO_ROOT, 'docker', 'entrypoint.sh'), 'true'], {
          env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', ALTIS_DATA_DIR: data },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        expect(fs.readdirSync(releases).sort()).toEqual(['.tmp-0.2.0-01JZ0000000000000000000000', '.tmp-entrypoint-Live01', '0.1.0', 'current.json']);
      } finally {
        fs.rmSync(data, { recursive: true, force: true });
      }
    },
  );
});

// The Docker guide (1d Task 32; phase-end review C15, L15): what a person runs by hand next to compose.yml, held to
// what compose.yml does.

/** Each ```sh block of `text` that holds only KEY=VALUE lines, parsed on its own, in order. */
function envBlocks(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const [, body] of text.matchAll(/```sh\n([\s\S]*?)```/g)) {
    const lines = body!.split('\n').filter((line) => line.trim() !== '');
    if (lines.every((line) => /^\s*[A-Z_]+=\S*$/.test(line))) out.push(parseDotenv(lines.map((line) => line.trim()).join('\n')));
  }
  return out;
}

/** The KEY=VALUE lines of the ```sh blocks of `text` that hold nothing else. */
function envBlockLines(text: string): Record<string, string> {
  return Object.assign({}, ...envBlocks(text)) as Record<string, string>;
}

describe('the Docker guide (docs/install/docker.md)', () => {
  it('compose.yml fixes the project name, so docker.md tells a second ALTIS on one host to set its own COMPOSE_PROJECT_NAME and port', () => {
    // `name: altis` keeps the volumes of an install whatever its folder is called; a second folder shares them unless
    // its .env names another project (COMPOSE_PROJECT_NAME wins over `name:`).
    expect(read('docker', 'compose.yml')).toMatch(/^name: altis$/m);
    const env = envBlockLines(read('docs', 'install', 'docker.md'));
    expect(env['COMPOSE_PROJECT_NAME']).toMatch(/^altis-[a-z0-9-]+$/);
    expect(env['ALTIS_HTTP_PORT']).toMatch(/^\d+$/);
    expect(env['ALTIS_HTTP_PORT']).not.toBe('8080');
  });
});

describe('.github/workflows', () => {
  let workflows: { name: string; text: string }[] = [];

  beforeAll(() => {
    workflows = ['pr.yml', 'nightly.yml'].map((name) => ({ name, text: read('.github', 'workflows', name) }));
  });

  it('least privilege: `permissions: contents: read` at the top, no other permission granted', () => {
    for (const { name, text } of workflows) {
      expect(text, name).toMatch(/^permissions:\n {2}contents: read$/m);
      expect(text.match(/permissions:/g), name).toHaveLength(1);
    }
  });

  it('every action is pinned to a full commit SHA, and checkout keeps no credentials', () => {
    for (const { name, text } of workflows) {
      const uses = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
      expect(uses.length, name).toBeGreaterThan(0);
      for (const ref of uses) expect(ref, name).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
      const checkouts = text.split('actions/checkout@').length - 1;
      expect(text.match(/persist-credentials: false/g), name).toHaveLength(checkouts);
    }
  });

  it('pr.yml: Node 22.16, check, unit, test:db [sqlite, mariadb106, pg15], test release, two smoke runs', () => {
    const pr = workflows[0]!.text;
    expect(pr).toContain("NODE_VERSION: '22.16.0'");
    for (const step of ['pnpm install --frozen-lockfile', 'pnpm check', 'pnpm test', 'pnpm test:db', 'pnpm release --profile test --version 0.1.0-test']) {
      expect(pr).toContain(step);
    }
    expect(pr).toMatch(/engine: \[sqlite, mariadb106, pg15\]/);
    expect(pr).toContain('--target passenger-sim --db mariadb106');
    expect(pr).toContain('--target standalone --db sqlite');
  });

  it('nightly.yml: Node [22.16, 24, 26] × the seven engines, every target, passenger-sim/sqlite excluded, Windows', () => {
    const nightly = workflows[1]!.text;
    expect(nightly).toMatch(/node: \['22\.16\.0', '24', '26'\]/);
    expect(nightly).toMatch(/engine: \[sqlite, mysql80, mysql84, mariadb106, mariadb114, pg15, pg17\]/);
    expect(nightly).toMatch(/target: \[passenger-sim, pm2, standalone\]/);
    expect(nightly).toMatch(/- target: passenger-sim\n\s+engine: sqlite/);
    expect(nightly).toContain('--max-pool 6');
    expect(nightly).toContain('--target docker');
    expect(nightly).toContain('runs-on: windows-latest');
  });

  it('pr.yml: the passenger-sim scenarios cron-backup and piggyback on MariaDB 10.6 (1c Task 34, §13.2 CI)', () => {
    const job = jobBlock(workflows[0]!.text, 'smoke');
    for (const scenario of PR_SCENARIOS) {
      expect(job).toContain(`pnpm --silent smoke --zip dist/altis-0.1.0-test.zip --target passenger-sim --db mariadb106 --scenario ${scenario} >`);
    }
    expect(job).toContain('docker compose -f tools/test/compose.yml up -d --wait mariadb106');
  });

  it('nightly.yml: every scenario on passenger-sim + MariaDB 10.6 with --max-pool 6, after the release job (1c Task 34)', () => {
    const job = jobBlock(workflows[1]!.text, 'smoke-scenarios');
    expect(job).toMatch(/needs: release$/m);
    expect(job).toContain(`scenario: [${SCENARIOS.join(', ')}]`);
    expect(job).toContain('name: release-zip');
    expect(job).toContain('docker compose -f tools/test/compose.yml up -d --wait mariadb106');
    expect(job).toMatch(/pnpm --silent smoke --zip dist\/altis-0\.1\.0-test\.zip --target passenger-sim --db mariadb106 --max-pool 6 --scenario "\$SCENARIO"/);
    expect(job).toContain('SCENARIO: ${{ matrix.scenario }}');
    for (const line of job.split('\n').filter((l) => /^\s+(- )?run:/.test(l))) expect(line).not.toContain('${{');
  });

  it('nightly.yml: the e2e job runs the whole Playwright suite (the 1c specs with it) and uploads the traces on failure', () => {
    const job = jobBlock(workflows[1]!.text, 'e2e');
    expect(job).toMatch(/- run: pnpm e2e\n/);
    expect(job).toMatch(/if: failure\(\)\n\s+with:\n\s+name: e2e-traces/);
    expect(job).toContain('tools/e2e/dist/test-results/');
  });

  it('nightly.yml: the matrix Node reaches the smoke step as MATRIX_NODE, never as NODE (pnpm overwrites NODE for the scripts it runs)', () => {
    const nightly = workflows[1]!.text;
    expect(nightly).not.toMatch(/^\s+NODE:/m);
    expect(nightly).not.toMatch(/\$NODE\b|\$\{NODE\}/);
    expect(nightly).toContain('MATRIX_NODE: ${{ matrix.node }}');
    expect(nightly).toContain('-node$MATRIX_NODE.json');
  });

  it('nightly.yml: unit tests (pnpm test) on Node 22.16, 24 and 26 (spec §4.2)', () => {
    const unit = jobBlock(workflows[1]!.text, 'unit');
    expect(unit).toMatch(/node: \['22\.16\.0', '24', '26'\]/);
    expect(unit).toContain('node-version: ${{ matrix.node }}');
    expect(unit).toContain('pnpm install --frozen-lockfile');
    expect(unit).toMatch(/- run: pnpm test$/m);
  });

  // 1d Task 35 (§13.2 CI): the update scenario in the PR tier; every scenario, the wizard per target, perf and the
  // Windows update in the nightly tier.
  it('pr.yml: the 0.2.0-test build and the update scenario on passenger-sim + MariaDB 10.6 (1d Task 35)', () => {
    const job = jobBlock(workflows[0]!.text, 'smoke');
    expect(job).toContain('- run: pnpm release --profile test --version 0.1.0-test\n');
    expect(job).toContain('- run: pnpm release --profile test --version 0.2.0-test\n');
    expect(job).toContain(
      'pnpm --silent smoke --zip dist/altis-0.1.0-test.zip --to-zip dist/altis-0.2.0-test.zip --target passenger-sim --db mariadb106 --scenario update >',
    );
  });

  it('nightly.yml: the release job builds and uploads 0.1.0-test, 0.2.0-test and 0.3.0-test (1d Task 35)', () => {
    const job = jobBlock(workflows[1]!.text, 'release');
    for (const version of ['0.1.0-test', '0.2.0-test', '0.3.0-test']) {
      expect(job).toContain(`pnpm release --profile test --version ${version}`);
      expect(job).toContain(`dist/altis-${version}.zip`);
    }
  });

  it('nightly.yml: every update scenario on its A1 targets, after the release job (1d Task 35)', () => {
    const job = jobBlock(workflows[1]!.text, 'smoke-update');
    expect(job).toMatch(/needs: release$/m);
    const general = UPDATE_SCENARIOS.filter((s) => UPDATE_SCENARIO_TARGETS[s].length === 4);
    expect(job).toContain(`scenario: [${general.join(', ')}]`);
    const sites = ['{ target: passenger-sim, engine: mariadb106 }', '{ target: pm2, engine: mysql80 }', '{ target: docker, engine: mariadb106 }', '{ target: docker, engine: pg15 }', '{ target: standalone, engine: sqlite }'];
    for (const site of sites) expect(job).toContain(`- ${site}`);
    // The scenarios of one target each, as UPDATE_SCENARIO_TARGETS says.
    for (const scenario of UPDATE_SCENARIOS.filter((s) => !general.includes(s))) {
      for (const target of UPDATE_SCENARIO_TARGETS[scenario]) expect(job).toMatch(new RegExp(`- scenario: ${scenario}\\n\\s+site: \\{ target: ${target}, `));
    }
    expect(job).toContain('rollback-restore) from=0.2.0-test; to=(--to-zip dist/altis-0.3.0-test.zip)');
    expect(job).toContain('docker-pull) to=(--to-zip dist/altis-0.2.0-test.zip --to-zip dist/altis-0.3.0-test.zip)');
    expect(job).toContain('if [ "$TARGET" = passenger-sim ]; then extra=(--max-pool 6); fi');
    expect(job).toContain('--scenario "$SCENARIO"');
    for (const line of job.split('\n').filter((l) => /^\s+(- )?run:/.test(l))) expect(line).not.toContain('${{');
  });

  it('nightly.yml: the wizard on each other A1 target and the perf budgets on MariaDB 10.6 and SQLite (1d Task 35)', () => {
    const wizard = jobBlock(workflows[1]!.text, 'e2e-wizard');
    expect(wizard).toContain('- run: pnpm e2e --project uninstalled');
    expect(wizard).toContain('ALTIS_E2E_TARGET: ${{ matrix.site.target }}');
    expect(wizard).toContain('ALTIS_E2E_DB: ${{ matrix.site.engine }}');
    expect(wizard).toMatch(/if: failure\(\)\n\s+with:\n\s+name: e2e-wizard-traces/);
    const perf = jobBlock(workflows[1]!.text, 'perf');
    expect(perf).toContain('engine: [mariadb106, sqlite]');
    expect(perf).toContain('pnpm --silent perf --zip dist/altis-0.1.0-test.zip --db "$ENGINE" "${report[@]}"');
    expect(perf).toContain('--target passenger-sim --db "$ENGINE" --scenario update');
    expect(perf).toMatch(/runs-on: ubuntu-24\.04$/m);
  });

  it('nightly.yml: the Windows standalone smoke updates 0.1 → 0.2 and forces the update faults (preflight 1D-26)', () => {
    const job = jobBlock(workflows[1]!.text, 'smoke-windows');
    expect(job).toContain('runs-on: windows-latest');
    expect(job).toContain('--to-zip dist/altis-0.2.0-test.zip --target standalone --db sqlite --scenario update >');
    expect(job).toContain('--to-zip dist/altis-0.2.0-test.zip --target standalone --db sqlite --scenario update-faults >');
  });

  it('nightly.yml: the NODE_TOO_OLD rescue runs on Node 10, 12, 14, 16, 18 and 20.11 against the release zip (R56, Review Focus 4)', () => {
    const job = jobBlock(workflows[1]!.text, 'old-node');
    expect(job).toMatch(/needs: release$/m);
    expect(job).toMatch(/node: \['10', '12', '14', '16', '18', '20\.11'\]/);
    expect(job).toContain('node-version: ${{ matrix.node }}');
    expect(job).toContain('name: release-zip');
    expect(job).toContain('unzip');
    expect(job).toContain('altis-0.1.0-test.zip');
    expect(job).toMatch(/node tools\/release\/smoke\/old-node-check\.cjs --app "\$RUNNER_TEMP\/app"/);
    // Nothing of the toolchain runs on the old Node: no pnpm, no install (the checker is plain CommonJS).
    expect(job).not.toContain('pnpm');
    expect(job).not.toContain('cache:');
  });
});

/** The text of one top-level job of a workflow (its key line to the next job). */
function jobBlock(workflow: string, name: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`no job ${name}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[\w-]+:\s*$/.test(line));
  return rest.slice(0, end === -1 ? undefined : end).join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// old-node-check.cjs: the checker the nightly `old-node` job runs on Node 10 to 20.11 (R56).

describe('old-node-check.cjs', () => {
  const CHECKER = path.join(import.meta.dirname, 'old-node-check.cjs');
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altis-old-node-test-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A fake app folder whose app.js is `source`. */
  function fakeApp(name: string, source: string): string {
    const app = path.join(dir, name);
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'app.js'), source);
    return app;
  }

  interface CheckResult {
    status: number | null;
    stdout: string;
    stderr: string;
    report: { ok: boolean; node: string; checks: { name: string; ok: boolean; detail: string }[] } | null;
  }

  function check(app: string, env: Record<string, string> = {}): CheckResult {
    const r = spawnSync(NODE, [CHECKER, '--app', app, '--timeout-ms', '8000'], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 });
    const line = r.stdout.trim().split('\n').filter(Boolean).at(-1);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, report: line === undefined ? null : (JSON.parse(line) as CheckResult['report']) };
  }

  /** An app.js that behaves like the rescue server of a too-old Node, with one thing `FAKE_MODE` can break. */
  const FAKE = `
    const http = require('http');
    const mode = process.env.FAKE_MODE || 'rescue';
    const text = 'Node 22.16 ... Setup Node.js App';
    if (process.argv[2] === 'doctor') {
      process.stderr.write('ALTIS (NODE_TOO_OLD): ' + (mode === 'doctor-silent' ? 'old' : text) + '\\n');
      process.exit(mode === 'doctor-zero' ? 0 : 1);
    }
    const page = '<!doctype html><html lang="id"><section lang="id">' + (mode === 'no-text' ? '' : text) + '</section><hr><section lang="en"></section></html>';
    http.createServer(function (req, res) {
      if (mode === 'healthy') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok"}'); }
      if (req.url === '/_health') {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '30' });
        return res.end(JSON.stringify({ status: 'rescue', reason: mode === 'wrong-reason' ? 'START_FAILED' : 'NODE_TOO_OLD' }));
      }
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
    }).listen(Number(process.env.ALTIS_PORT), '127.0.0.1');
  `;

  it('passes on an app.js that answers like the NODE_TOO_OLD rescue (503 JSON health, 503 bilingual page, doctor exits 1)', () => {
    const r = check(fakeApp('rescue', FAKE));
    expect(r.stderr).not.toMatch(/FAILED/);
    expect(r.status).toBe(0);
    expect(r.report?.ok).toBe(true);
    expect(r.report?.node).toBe(process.version);
    const names = r.report!.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['/_health is 503', '/_health says rescue / NODE_TOO_OLD', '`app.js doctor` exits 1', 'DATA_DIR was not created (nothing ran after the version check)']),
    );
    expect(r.report!.checks.every((c) => c.ok)).toBe(true);
  });

  it.each([
    ['healthy', '/_health is 503'],
    ['wrong-reason', '/_health says rescue / NODE_TOO_OLD'],
    ['no-text', 'GET / names Node 22.16'],
    ['doctor-zero', '`app.js doctor` exits 1'],
    ['doctor-silent', '`app.js doctor` names NODE_TOO_OLD and Node 22.16'],
  ])('fails (exit 1) when the app is %s: the failed check is named', (mode, failed) => {
    const r = check(fakeApp(`bad-${mode}`, FAKE), { FAKE_MODE: mode });
    expect(r.status).toBe(1);
    expect(r.report?.ok).toBe(false);
    expect(r.report!.checks.filter((c) => !c.ok).map((c) => c.name)).toContain(failed);
  });

  it('fails when app.js dies on start (what a syntax error on an old Node looks like), with its output in the message', () => {
    const r = check(fakeApp('syntax-error', 'const x = {};\nx?.y ?? ;\n'));
    expect(r.status).toBe(1);
    const failed = r.report!.checks.filter((c) => !c.ok);
    expect(failed[0]!.name).toMatch(/^app\.js answers on Node v/);
    expect(failed[0]!.detail).toMatch(/exited before it answered/);
    expect(failed[0]!.detail).toMatch(/SyntaxError/);
  });

  it('is a usage error (exit 2) without --app, for a folder without app.js, and for an unknown argument', () => {
    expect(spawnSync(NODE, [CHECKER], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(NODE, [CHECKER, '--app', path.join(dir, 'nowhere')], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(NODE, [CHECKER, '--app', dir, '--bogus', '1'], { encoding: 'utf8' }).status).toBe(2);
  });

  it('passes on the real app.js (test build) when the Node it sees is too old', async () => {
    const app = path.join(dir, 'real');
    await buildBootloader({ profile: 'test', outfile: path.join(app, 'app.js'), bundledVersion: '0.1.0-test' });
    const r = check(app, { ALTIS_TEST_FAKE_NODE_VERSION: '20.11.0' });
    expect(r.stderr).not.toMatch(/FAILED/);
    expect(r.status).toBe(0);
    expect(r.report?.ok).toBe(true);
    expect(r.report!.checks.length).toBeGreaterThanOrEqual(12);
  });

  it('is written for Node 10: ES2017 syntax at most, and none of the APIs that came after it', () => {
    const text = fs.readFileSync(CHECKER, 'utf8').replace(/^#!.*/, ''); // the shebang is not program text
    const comments: [number, number][] = [];
    acorn.parse(text, { ecmaVersion: 2017, sourceType: 'script', onComment: (_block, _text, start, end) => void comments.push([start, end]) });
    // Comments name what is avoided; only code is scanned.
    let code = text;
    for (const [start, end] of comments.reverse()) code = `${code.slice(0, start)}${' '.repeat(end - start)}${code.slice(end)}`;
    const newer = [
      /\bfetch\s*\(/,
      /\?\./,
      /\?\?/,
      /\bnew URL\b/,
      /\bglobalThis\b/,
      /\bAbortController\b/,
      /\bfs\.(rmSync|rm|promises|cpSync)\b/,
      /\.(flat|flatMap|matchAll|replaceAll|at)\(/,
      /\bObject\.(fromEntries|hasOwn)\b/,
      /\bstructuredClone\b/,
      /\bPromise\.(allSettled|any)\b/,
      /\bimport\s*\(/,
    ];
    for (const pattern of newer) expect(code, String(pattern)).not.toMatch(pattern);
    // Everything it requires is a built-in that Node 10 has.
    const required = [...code.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    expect(required.sort()).toEqual(['child_process', 'fs', 'http', 'net', 'os', 'path']);
  });
});
