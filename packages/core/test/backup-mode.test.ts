import { describe, expect, it } from 'vitest';
import { BACKUP_FROZEN_SKIP_MS, BACKUP_PASSENGER_SNAPSHOT_MAX_MS, chooseConsistency, estimateBackupMs } from '../src/backup/mode.js';

// The backup mode (spec §9.9 table "Konsistensi"; decisions C31, C41): `snapshot` while a worker or `jobs:run` has run
// within 10 minutes, unless the host is passenger/litespeed and the estimate is over 10 minutes; `frozen` otherwise.

const NOW = Date.UTC(2026, 9, 28, 1, 0, 0);
const MINUTE = 60_000;

describe('chooseConsistency', () => {
  it('pm2, a worker run 1 min ago, an estimate of 1 min → snapshot', () => {
    expect(chooseConsistency({ runtime: 'pm2', runs: { worker: NOW - MINUTE }, now: NOW, estimateMs: MINUTE })).toBe('snapshot');
  });

  it('passenger, a jobs:run 2 min ago, an estimate of 5 min → snapshot', () => {
    expect(chooseConsistency({ runtime: 'passenger', runs: { cron_cli: NOW - 2 * MINUTE }, now: NOW, estimateMs: 5 * MINUTE })).toBe('snapshot');
  });

  it('passenger, a jobs:run 2 min ago, an estimate of 11 min → frozen', () => {
    expect(chooseConsistency({ runtime: 'passenger', runs: { cron_cli: NOW - 2 * MINUTE }, now: NOW, estimateMs: 11 * MINUTE })).toBe('frozen');
  });

  it('litespeed behaves as passenger; pm2 keeps snapshot whatever the estimate', () => {
    expect(chooseConsistency({ runtime: 'litespeed', runs: { worker: NOW - MINUTE }, now: NOW, estimateMs: 11 * MINUTE })).toBe('frozen');
    expect(chooseConsistency({ runtime: 'pm2', runs: { worker: NOW - MINUTE }, now: NOW, estimateMs: 5 * 60 * MINUTE })).toBe('snapshot');
  });

  it('passenger with only a POST /_cron run 1 min ago → frozen (the cron URL cannot hold a snapshot)', () => {
    expect(chooseConsistency({ runtime: 'passenger', runs: { cron_http: NOW - MINUTE }, now: NOW, estimateMs: MINUTE })).toBe('frozen');
  });

  it('passenger with no run at all → frozen; drive and piggyback runs do not count either', () => {
    expect(chooseConsistency({ runtime: 'passenger', runs: {}, now: NOW, estimateMs: MINUTE })).toBe('frozen');
    expect(chooseConsistency({ runtime: 'standalone', runs: { drive: NOW, piggyback: NOW }, now: NOW, estimateMs: MINUTE })).toBe('frozen');
  });

  it('a run older than 10 min → frozen; one recorded slightly ahead of the clock still counts', () => {
    expect(chooseConsistency({ runtime: 'pm2', runs: { worker: NOW - 11 * MINUTE }, now: NOW, estimateMs: MINUTE })).toBe('frozen');
    expect(chooseConsistency({ runtime: 'pm2', runs: { worker: NOW + MINUTE }, now: NOW, estimateMs: MINUTE })).toBe('snapshot');
  });

  it('exactly 10 min on passenger is still a snapshot (over 10 min is frozen)', () => {
    expect(BACKUP_PASSENGER_SNAPSHOT_MAX_MS).toBe(10 * MINUTE);
    const o = { runtime: 'passenger' as const, runs: { cron_cli: NOW }, now: NOW };
    expect(chooseConsistency({ ...o, estimateMs: 10 * MINUTE })).toBe('snapshot');
    expect(chooseConsistency({ ...o, estimateMs: 10 * MINUTE + 1 })).toBe('frozen');
  });
});

describe('estimateBackupMs', () => {
  it('from the previous backup when known: rows × ms / rows', () => {
    expect(estimateBackupMs({ rows: 2000, fileBytes: 0, last: { rows: 1000, ms: 30_000 } })).toBe(60_000);
    expect(estimateBackupMs({ rows: 500, fileBytes: 10 ** 9, last: { rows: 1000, ms: 30_000 } })).toBe(15_000);
  });

  it('otherwise 0.05 ms per row plus 20 MiB/s of files', () => {
    expect(estimateBackupMs({ rows: 100_000, fileBytes: 0 })).toBe(5000);
    expect(estimateBackupMs({ rows: 0, fileBytes: 20 * 1024 * 1024 })).toBe(1000);
    expect(estimateBackupMs({ rows: 1000, fileBytes: 40 * 1024 * 1024 })).toBe(2050);
  });

  it('a previous backup with no rows (or no time) is not a rate: the default formula applies', () => {
    expect(estimateBackupMs({ rows: 100_000, fileBytes: 0, last: { rows: 0, ms: 9000 } })).toBe(5000);
    expect(estimateBackupMs({ rows: 100_000, fileBytes: 0, last: { rows: 10, ms: 0 } })).toBe(5000);
  });

  it('rounds up and refuses negative or non-finite inputs', () => {
    expect(estimateBackupMs({ rows: 3, fileBytes: 0 })).toBe(1);
    expect(() => estimateBackupMs({ rows: -1, fileBytes: 0 })).toThrow(TypeError);
    expect(() => estimateBackupMs({ rows: 1, fileBytes: Number.NaN })).toThrow(TypeError);
  });

  it('a scheduled frozen backup is skipped above 3 h', () => {
    expect(BACKUP_FROZEN_SKIP_MS).toBe(3 * 60 * MINUTE);
  });
});
