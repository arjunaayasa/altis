import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lockHostIdentity, processStartMs } from '@altis/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOT_LOCK_STALE_MS,
  BOOT_REFRESH_MS,
  BOOT_RETRY_MS,
  INTERRUPTED_WINDOW_MS,
  REVERT_FAILED_BOOTS,
  REVERT_STALL_MS,
  attemptEnded,
  classifyAttempts,
  holderGone,
  readMarkers,
  removeMarkers,
  writeMarker,
  type BootMarker,
  type MarkerRecord,
} from '../src/markers.js';

// Boot markers (spec §9.3, decision D1d-19, preflight M8, S15): `releases/boot/<v>/<pid>-<startMs>`, and the count of
// the attempts they describe that decides a revert (Review Focus 1).

const V = '0.2.0-test';
const NOW = 1_800_000_000_000;

let dataDir: string;

beforeEach(async () => {
  dataDir = path.join(await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-markers-'))), 'data');
  await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
});

afterEach(async () => {
  await fsp.rm(path.dirname(dataDir), { recursive: true, force: true });
});

/** The pid of a process that has exited (a dead holder). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return child.pid as number;
}

function marker(o: Partial<BootMarker> = {}): BootMarker {
  return { phase: 'importing', lastProgressAt: NOW - 5000, refreshedAt: NOW - 5000, host: lockHostIdentity(), waiting: null, error: null, ...o };
}

function record(pid: number, o: Partial<BootMarker> = {}): MarkerRecord {
  return { pid, startMs: 1000, marker: marker(o) };
}

const ended = (m: MarkerRecord, now: number): boolean => attemptEnded(m, now);

describe('constants (spec §9.3)', () => {
  it('are the protocol values', () => {
    expect([BOOT_LOCK_STALE_MS, BOOT_REFRESH_MS, BOOT_RETRY_MS, INTERRUPTED_WINDOW_MS, REVERT_FAILED_BOOTS, REVERT_STALL_MS]).toEqual([
      60_000, 10_000, 5_000, 60_000, 3, 900_000,
    ]);
  });
});

describe('writeMarker / readMarkers / removeMarkers', () => {
  it('writes the marker at releases/boot/<v>/<pid>-<startMs> and reads it back; other names are skipped', async () => {
    const m = marker({ phase: 'migrating', waiting: 'migration_lock' });
    await writeMarker(dataDir, V, 4242, 1700, m);
    const file = path.join(dataDir, 'releases', 'boot', V, '4242-1700');
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual(m);
    // A writer's temporary sibling, a folder and a stray name are not markers.
    await fsp.writeFile(path.join(dataDir, 'releases', 'boot', V, '.4242-1700.tmp-1-abcdef'), '{');
    await fsp.writeFile(path.join(dataDir, 'releases', 'boot', V, 'notes.txt'), 'x');
    await fsp.mkdir(path.join(dataDir, 'releases', 'boot', V, '17-18'));
    expect(await readMarkers(dataDir, V)).toEqual([{ pid: 4242, startMs: 1700, marker: m }]);
  });

  it('a marker that cannot be read counts as a failed attempt (time stamps 0, unknown host)', async () => {
    await fsp.mkdir(path.join(dataDir, 'releases', 'boot', V), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'releases', 'boot', V, '77-88'), 'not json');
    await fsp.writeFile(path.join(dataDir, 'releases', 'boot', V, '78-88'), JSON.stringify({ phase: 'flying' }));
    const records = await readMarkers(dataDir, V);
    expect(records.map((r) => r.marker)).toEqual([
      { phase: 'importing', lastProgressAt: 0, refreshedAt: 0, host: '', waiting: null, error: null },
      { phase: 'importing', lastProgressAt: 0, refreshedAt: 0, host: '', waiting: null, error: null },
    ]);
    expect(classifyAttempts(records, NOW, ended)).toEqual({ failed: 2, interrupted: 0, explicit: null });
  });

  it('a refresh (inFolder) never brings back a folder that was removed', async () => {
    await writeMarker(dataDir, V, 4242, 1700, marker());
    await removeMarkers(dataDir, V);
    await expect(fsp.stat(path.join(dataDir, 'releases', 'boot', V))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeMarker(dataDir, V, 4242, 1700, marker(), { inFolder: true });
    await expect(fsp.stat(path.join(dataDir, 'releases', 'boot', V))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readMarkers(dataDir, V)).toEqual([]);
    await removeMarkers(dataDir, V); // nothing there: no error
  });

  it('keeps the explicit error with its detail and the rescue reason (preflight M8)', async () => {
    const m = marker({ error: { detail: 'stalled', reason: 'START_FAILED' } });
    await writeMarker(dataDir, V, 9, 10, m);
    expect((await readMarkers(dataDir, V))[0]?.marker.error).toEqual({ detail: 'stalled', reason: 'START_FAILED' });
  });
});

describe('classifyAttempts (Review Focus 1)', () => {
  it('three dead holders in importing: three failed', async () => {
    const dead = [await deadPid(), await deadPid(), await deadPid()];
    const records = dead.map((pid) => record(pid));
    expect(classifyAttempts(records, NOW, ended)).toEqual({ failed: 3, interrupted: 0, explicit: null });
  });

  it('a dead holder in migrating with progress 30 s before its last refresh: interrupted; 90 s: failed', async () => {
    const pid = await deadPid();
    const recent = record(pid, { phase: 'migrating', refreshedAt: NOW - 10_000, lastProgressAt: NOW - 40_000 });
    expect(classifyAttempts([recent], NOW, ended)).toEqual({ failed: 0, interrupted: 1, explicit: null });
    const stale = record(pid, { phase: 'migrating', refreshedAt: NOW - 10_000, lastProgressAt: NOW - 100_000 });
    expect(classifyAttempts([stale], NOW, ended)).toEqual({ failed: 1, interrupted: 0, explicit: null });
    // The window is "less than 60 s".
    const edge = record(pid, { phase: 'migrating', refreshedAt: NOW - 10_000, lastProgressAt: NOW - 10_000 - INTERRUPTED_WINDOW_MS });
    expect(classifyAttempts([edge], NOW, ended).failed).toBe(1);
  });

  it('a dead holder waiting for its environment is not counted (§9.3 "Bukan alasan revert")', async () => {
    const pid = await deadPid();
    for (const waiting of ['db_unavailable', 'migration_lock'] as const) {
      expect(classifyAttempts([record(pid, { waiting }), record(pid, { phase: 'migrating', waiting, lastProgressAt: 0 })], NOW, ended)).toEqual({
        failed: 0,
        interrupted: 0,
        explicit: null,
      });
    }
  });

  it('an explicit error is reported by its detail, the most recently refreshed one first', async () => {
    const pid = await deadPid();
    const records = [
      record(pid, { error: { detail: 'import', reason: 'START_FAILED' }, refreshedAt: NOW - 9000 }),
      record(pid, { error: { detail: 'stalled', reason: 'START_FAILED' }, refreshedAt: NOW - 1000 }),
      record(pid),
    ];
    expect(classifyAttempts(records, NOW, ended)).toEqual({ failed: 1, interrupted: 0, explicit: 'stalled' });
  });

  it('a live holder refreshed recently is not counted at all (its attempt has not ended)', () => {
    // The parent of this test process: alive, on this host, but not this process.
    const live = { pid: process.ppid, startMs: 1000, marker: marker({ refreshedAt: NOW - 1000 }) };
    expect(attemptEnded(live, NOW)).toBe(false);
    expect(classifyAttempts([live, live, live], NOW, ended)).toEqual({ failed: 0, interrupted: 0, explicit: null });
  });

  it("S15: another host's marker is judged by its age: 61 s without a refresh counts failed, 59 s does not", () => {
    const other = (ageMs: number): MarkerRecord => ({
      pid: 1,
      startMs: 5,
      marker: marker({ host: 'another-box/0d6c9f6e-1b6f-4f5e-9d1e-8c2c3b4a5d6e/pid:[4026532999]', refreshedAt: NOW - ageMs }),
    });
    expect(holderGone(other(61_000), NOW)).toBe(true);
    expect(holderGone(other(59_000), NOW)).toBe(false);
    expect(classifyAttempts([other(61_000)], NOW, ended)).toEqual({ failed: 1, interrupted: 0, explicit: null });
    expect(classifyAttempts([other(59_000)], NOW, ended)).toEqual({ failed: 0, interrupted: 0, explicit: null });
    // The brief's rule alone (holderGone) agrees.
    expect(classifyAttempts([other(61_000), other(59_000)], NOW, holderGone)).toEqual({ failed: 1, interrupted: 0, explicit: null });
  });

  it('attemptEnded: an explicit error ends an attempt even while its process lives; so does this process holding boot.lock', () => {
    const liveWithError = { pid: process.ppid, startMs: 1000, marker: marker({ refreshedAt: NOW, error: { detail: 'start', reason: 'START_FAILED' } }) };
    expect(holderGone(liveWithError, NOW)).toBe(false);
    expect(attemptEnded(liveWithError, NOW)).toBe(true);
    const own = { pid: process.pid, startMs: processStartMs(), marker: marker({ refreshedAt: NOW }) };
    expect(holderGone(own, NOW)).toBe(false);
    expect(attemptEnded(own, NOW)).toBe(true);
  });
});
