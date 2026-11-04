import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERF_SEED } from '../perf/seed.js';
import { PERF_BUDGETS, PERF_ENDPOINTS, PERF_REQUESTS, evaluatePerf, formatPerfReport, p95, parsePerfArgs, perfBudgetsApply, updateMsOfSmokeReport, type PerfMeasurements } from '../perf/measure.js';
import { ZIP_BUDGET_BYTES } from '../src/build.js';

// The §12.7 performance budgets (A11; plan Task 35): what `pnpm perf` measures and how it judges the numbers. The
// measurement itself needs a release zip, a seeded install and an engine (nightly: MariaDB 10.6 and SQLite on Linux x64).

/** Measurements inside every budget. */
const good = (): PerfMeasurements => ({
  p95Ms: { users: 40, audit: 90, jobs: 60, dashboard: 120 },
  rssLoadMb: 180,
  coldStartMs: 900,
  rssIdleMb: 110,
  zipBytes: 2_000_000,
  updateMs: 60_000,
});

describe('the budgets of §12.7', () => {
  it('admin API p95 < 200 ms, RSS under load < 300 MB, cold start < 1.5 s, idle RSS < 150 MB, zip < 15 MB, update < 120 s', () => {
    expect(PERF_BUDGETS).toEqual({ apiP95Ms: 200, rssLoadMb: 300, coldStartMs: 1500, rssIdleMb: 150, zipBytes: ZIP_BUDGET_BYTES, updateMs: 120_000 });
    expect(ZIP_BUDGET_BYTES).toBe(15_000_000);
  });

  it('p95 over 200 requests each to GET users, audit, jobs and dashboard', () => {
    expect(PERF_ENDPOINTS).toEqual(['users', 'audit', 'jobs', 'dashboard']);
    expect(PERF_REQUESTS).toBe(200);
  });

  it('the seed perf-phase1: 50 staff, 200 000 audit_log, 10 000 jobs', () => {
    expect(PERF_SEED).toEqual({ name: 'perf-phase1', staff: 50, audit: 200_000, jobs: 10_000 });
  });

  it('the budgets are asserted on Linux x64 only (reported elsewhere, as the smoke run does)', () => {
    expect(perfBudgetsApply('linux', 'x64')).toBe(true);
    expect(perfBudgetsApply('darwin', 'arm64')).toBe(false);
    expect(perfBudgetsApply('linux', 'arm64')).toBe(false);
    expect(perfBudgetsApply('win32', 'x64')).toBe(false);
  });
});

describe('p95 (nearest rank)', () => {
  it('of 200 samples is the 190th smallest', () => {
    const samples = Array.from({ length: 200 }, (_, i) => 200 - i); // 200 … 1, unsorted on purpose
    expect(p95(samples)).toBe(190);
  });

  it('of 20 samples the 19th; of one sample that sample; of none: null', () => {
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
    expect(p95([7])).toBe(7);
    expect(p95([])).toBeNull();
  });
});

describe('evaluatePerf', () => {
  it('fails a p95 of 201 ms and passes 199 ms (strict upper bound)', () => {
    const slow = evaluatePerf({ ...good(), p95Ms: { ...good().p95Ms, audit: 201 } });
    expect(slow.ok).toBe(false);
    expect(slow.failures).toEqual([expect.stringMatching(/^p95 GET audit 201 ms is over the budget \(< 200 ms\)/)]);
    expect(evaluatePerf({ ...good(), p95Ms: { ...good().p95Ms, audit: 199 } })).toEqual({ ok: true, failures: [] });
    expect(evaluatePerf({ ...good(), p95Ms: { ...good().p95Ms, dashboard: 200 } }).ok).toBe(false);
  });

  it('names every budget that is missed, each on its own', () => {
    const m: PerfMeasurements = {
      p95Ms: { users: 250, audit: 10, jobs: 10, dashboard: 10 },
      rssLoadMb: 300,
      coldStartMs: 1500,
      rssIdleMb: 150,
      zipBytes: 15_000_000,
      updateMs: 120_000,
    };
    const result = evaluatePerf(m);
    expect(result.failures.map((f) => f.split(' ')[0] === 'p95' ? 'p95' : f.split(' ')[0])).toEqual(['p95', 'rssLoadMb', 'coldStartMs', 'rssIdleMb', 'zipBytes', 'updateMs']);
  });

  it('an endpoint or a cold start never measured fails; an RSS not sampled (Windows) and an update not run are not asserted', () => {
    expect(evaluatePerf({ ...good(), p95Ms: { ...good().p95Ms, jobs: null } }).failures).toEqual(['p95 GET jobs: not measured']);
    expect(evaluatePerf({ ...good(), coldStartMs: null }).failures).toEqual(['coldStartMs: not measured']);
    expect(evaluatePerf({ ...good(), rssIdleMb: null, rssLoadMb: null, updateMs: null }).ok).toBe(true);
  });
});

describe('the perf report and its inputs', () => {
  it('one JSON line with the measurements, the budgets, whether they were asserted and what failed', () => {
    const line = formatPerfReport({ db: 'sqlite', node: 'v22.16.0', seed: PERF_SEED.name, measurements: good(), budgetsAsserted: false, failures: [] });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd()).not.toContain('\n');
    expect(Object.keys(JSON.parse(line) as object)).toEqual(['db', 'node', 'seed', 'measurements', 'budgets', 'budgetsAsserted', 'failures']);
  });

  it('the update duration comes from the smoke report of the update scenario (apply → done)', () => {
    const line = JSON.stringify({ target: 'passenger-sim', db: 'mariadb106', scenario: 'update', scenarioOk: true, scenarioDetail: { applyToDoneMs: 74_210 } });
    expect(updateMsOfSmokeReport(`${line}\n`)).toBe(74_210);
    expect(updateMsOfSmokeReport(JSON.stringify({ scenario: 'update', scenarioOk: false, scenarioDetail: {} }))).toBeNull();
    expect(() => updateMsOfSmokeReport(JSON.stringify({ scenario: 'cron-backup', scenarioOk: true }))).toThrow(/^USAGE/);
  });

  it('parsePerfArgs: --zip and --db (relative to where pnpm was run), --update-report optional; SQLite or a server engine', () => {
    expect(parsePerfArgs(['--zip', 'dist/a.zip', '--db', 'mariadb106'], { INIT_CWD: '/w' }, '/x')).toEqual({ zip: path.resolve('/w', 'dist/a.zip'), db: 'mariadb106', updateReport: null, keep: false });
    expect(parsePerfArgs(['--', '--zip', 'a.zip', '--db', 'sqlite', '--update-report', 'r.json', '--keep'], {}, '/w')).toEqual({
      zip: path.resolve('/w', 'a.zip'),
      db: 'sqlite',
      updateReport: path.resolve('/w', 'r.json'),
      keep: true,
    });
    expect(() => parsePerfArgs(['--db', 'sqlite'], {}, '/')).toThrow(/^USAGE: --zip/);
    expect(() => parsePerfArgs(['--zip', 'a.zip', '--db', 'oracle'], {}, '/')).toThrow(/^USAGE: --db/);
    expect(() => parsePerfArgs(['--zip', 'a.zip', '--db', 'sqlite', '--fast'], {}, '/')).toThrow(/^USAGE/);
  });
});
