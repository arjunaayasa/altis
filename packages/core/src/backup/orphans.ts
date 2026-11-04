import type { DbHandle } from '@altis/db';
import { isTerminal, isUlid } from '@altis/shared';
import { readOpFile } from '../ops/files.js';
import { BACKUP_CREATE_JOB } from './create-job.js';

// Backups nobody works on any more (spec §9.9; P7). A `running` row is ended only by its own job's slice or its own
// op's step; when the job ends without its handler running, nothing ends the row:
//
// - a queued `backup.create` job cancelled through the API (requestCancel cancels a queued job at once);
// - a job made dead by a claim, its lease expired at its last attempt (claim (c));
// - a first slice whose result was lost after it made a row under a new id (its retry makes another one).
//
// Such a row would stay `running` forever: its folder leaks (on SQLite `.work/snapshot.sqlite`, a full copy of the
// database), and no upload blob is ever collected again (a running backup's blobs may not be in a manifest yet). The
// files cleanup (housekeeping/files.ts) ends each one with abandonBackup: the row `failed`, the folder removed.
//
// A `running` row is live, and left alone, while
// - an op is active (`ops/op.json` not terminal, or unreadable): no row at all is judged then (a frozen backup's row
//   is its op's, and so is a restore's pre_restore backup);
// - a `backup.create` job that is `queued` or `running` names it: its own id (the row of its first slice) or its
//   payload's `backupId`. A live job whose payload cannot be read leaves every row alone.
//
// The caller holds the lock `backup:snapshot`: every slice of a snapshot backup takes it before it makes a row, so no
// first slice is making a row its job's payload does not name yet.

/** The `backups` rows that are `running` with nothing working on them (see the top of this file), sorted. */
export async function orphanBackups(h: DbHandle, dataDir: string): Promise<string[]> {
  const running = await h.db.selectFrom('backups').select('id').where('status', '=', 'running').orderBy('id').execute();
  if (running.length === 0) return [];
  const op = await readOpFile(dataDir);
  if (op === 'corrupt' || (op !== null && !isTerminal(op.kind, op.state))) return [];
  const live = new Set<string>();
  const jobs = await h.db
    .selectFrom('jobs')
    .select(['id', 'payload'])
    .where('type', '=', BACKUP_CREATE_JOB)
    .where('status', 'in', ['queued', 'running'])
    .execute();
  for (const job of jobs) {
    live.add(job.id);
    let payload: unknown;
    try {
      payload = JSON.parse(job.payload);
    } catch {
      return [];
    }
    if (typeof payload !== 'object' || payload === null) return [];
    const backupId = (payload as { backupId?: unknown }).backupId;
    if (typeof backupId === 'string') live.add(backupId);
    else if (backupId !== null && backupId !== undefined) return [];
  }
  return running.map((r) => r.id).filter((id) => isUlid(id) && !live.has(id));
}
