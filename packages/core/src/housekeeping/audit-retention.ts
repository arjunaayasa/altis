import { assertOutsideTx, countRows, upsert, withTx, type DbHandle } from '@altis/db';
import { z } from 'zod';
import { txCtx } from '../context.js';
import { readSettings, writeSettings } from '../settings/service.js';

// The audit retention (`audit.retention`, schedule `audit.retention`, daily; spec §7.8; decision C24; L39, M19).
//
// - Only a prefix of the log by `seq` is deleted, in ascending order, and it ends at the first entry that is not older
//   than the retention (`at ≥ now − 2 years`): an old entry after a newer one stays (M19), so what is left is always
//   one unbroken chain from the anchor to the head.
// - One run deletes at most `floor(0.1 × count(*))` entries, counted when it starts: spec §7.8's "a purge of more than
//   10 % needs a confirmation" is met by never deleting more (C24); a log far behind catches up over the following days.
//   The cap is kept as a seq bound fixed when the run starts (`maxSeq`: the seq of that many-th oldest entry), not as
//   a count: deletion is a prefix by seq, so the bound holds however often a slice is run again after its batches
//   committed (P7) from a checkpoint whose `deleted` is behind. The job's first slice only fixes that bound and stores
//   it (1d, T18-AUDIT-RETENTION-CAP), so not even the first deleting slice runs without a stored bound.
// - Each batch (at most 1000 entries) is one transaction: it locks the `audit.anchor` row (creating it when absent, so
//   that concurrent runs take turns), deletes, and sets `audit.anchor = {seq, hash}` of its last entry, so the chain
//   verifies from the anchor at every commit (L39: `verifyAuditChain(h, {anchor})`).
// - Each call (a job slice) that deleted entries appends one `audit.purge` entry `{deleted, anchorSeq}` (by the system
//   actor) for its own deletions, in the transaction of its last batch: the one that ends the run, or the one after
//   which its deadline had passed. A run stopped between slices (clock_anomaly, a cancel, a dead job) has recorded
//   what it deleted; a slice whose later batch fails records its committed batches in a transaction of its own (best
//   effort). A call that deleted nothing writes none.
//
// The caller skips it while `clock_anomaly` is active (ages are measured against `now`).

/** How long audit entries are kept: 2 years (730 days). */
export const AUDIT_RETENTION_MS = 730 * 86_400_000;
/** Entries deleted per transaction. */
export const AUDIT_PURGE_BATCH = 1000;

/**
 * A run in progress (the job's checkpoint): its cap as a count (`limit`, for progress) and as the seq bound that
 * enforces it (`maxSeq`, 0 when nothing may go), and how many its finished slices deleted.
 */
export const auditPurgeCheckpointSchema = z.strictObject({
  limit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  deleted: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  maxSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type AuditPurgeCheckpoint = z.infer<typeof auditPurgeCheckpointSchema>;

type Anchor = { seq: number; hash: string };

const SYSTEM = { type: 'system', id: null, ip: null } as const;

/** Appends the `audit.purge` entry of a slice that deleted `deleted` entries, the anchor then at `anchorSeq`. */
function recordPurge(trx: Parameters<typeof txCtx>[0], now: number, deleted: number, anchorSeq: number | null): Promise<unknown> {
  return txCtx(trx, now, SYSTEM).audit({ action: 'audit.purge', entity: 'audit_log', entityId: null, meta: { deleted, anchorSeq } });
}

/**
 * One batch (see the top of this file): how many it deleted, the anchor after it, whether it ended the run, and
 * whether it ended the slice (the run's end, or `deadline` passed). The slice's last batch records the slice's
 * deletions (`sliceBefore` plus its own).
 */
async function purgeBatch(
  h: DbHandle,
  o: { now: number; maxSeq: number; sliceBefore: number; deadline: number | undefined },
): Promise<{ deleted: number; anchorSeq: number | null; finished: boolean; sliceEnded: boolean }> {
  const cutoff = o.now - AUDIT_RETENTION_MS;
  return withTx(h, async (trx) => {
    await upsert(
      trx,
      'settings',
      { key: 'audit.anchor' },
      { value: 'null', is_secret: 0, scope: 'instance', updated_at: o.now, updated_by: null },
      { scope: 'instance' },
    );
    let anchor = (await readSettings(trx, ['audit.anchor'], []))['audit.anchor'] as Anchor | null;
    const rows = await trx
      .selectFrom('audit_log')
      .select(['seq', 'at', 'hash'])
      .where('seq', '<=', o.maxSeq)
      .orderBy('seq')
      .limit(AUDIT_PURGE_BATCH)
      .execute();
    const old: { seq: number; hash: string }[] = [];
    let reachedRecent = false;
    for (const row of rows) {
      if (Number(row.at) >= cutoff) {
        reachedRecent = true;
        break;
      }
      old.push({ seq: Number(row.seq), hash: row.hash });
    }
    if (old.length > 0) {
      const first = old[0]!;
      const last = old[old.length - 1]!;
      const r = await trx
        .deleteFrom('audit_log')
        .where('seq', '>=', first.seq)
        .where('seq', '<=', last.seq)
        .where('at', '<', cutoff)
        .executeTakeFirst();
      // Every entry of the range was read just now under the anchor's lock: anything else is not this run's to delete.
      if (Number(r.numDeletedRows) !== old.length) throw new Error('audit retention: the entries changed while they were purged');
      anchor = { seq: last.seq, hash: last.hash };
      await writeSettings(trx, { 'audit.anchor': anchor }, { keyring: [], now: o.now, actorId: null });
    }
    const finished = reachedRecent || rows.length < AUDIT_PURGE_BATCH;
    const sliceEnded = finished || (o.deadline !== undefined && Date.now() >= o.deadline);
    const slice = o.sliceBefore + old.length;
    if (sliceEnded && slice > 0) await recordPurge(trx, o.now, slice, anchor?.seq ?? null);
    return { deleted: old.length, anchorSeq: anchor?.seq ?? null, finished, sliceEnded };
  });
}

/**
 * A new run as of now: its cap (10 % of the log) and the seq of the entry that cap ends at (0: nothing may go). A job
 * stores it as its checkpoint before it deletes anything (1d, T18-AUDIT-RETENTION-CAP): a first slice that deleted
 * entries and was run again (killed before its result was stored, P7) would otherwise count the log it had already
 * shortened and set a second cap past the first.
 */
export async function startAuditPurge(h: DbHandle): Promise<AuditPurgeCheckpoint> {
  const limit = Math.floor((await countRows(h.db.selectFrom('audit_log'))) / 10);
  if (limit === 0) return { limit, deleted: 0, maxSeq: 0 };
  const last = await h.db.selectFrom('audit_log').select('seq').orderBy('seq').offset(limit - 1).limit(1).executeTakeFirst();
  return { limit, deleted: 0, maxSeq: last === undefined ? 0 : Number(last.seq) };
}

/**
 * Runs (or continues, from `o.from`) one audit retention run as of `o.now` (see the top of this file). With
 * `o.deadline` (a `Date.now()` reading) no batch starts once it passed, the first excepted; the result then holds the
 * checkpoint to continue from. Each call that deleted entries appends one `audit.purge` entry for them. `o.from: null`
 * starts a run in the same call (startAuditPurge): fine for a call made once, while a job slice that may run again
 * stores startAuditPurge's checkpoint first.
 *
 * Call it outside any withTx callback (R49).
 *
 * @returns how many entries this call deleted, the anchor's seq after it (null when there is none), and the
 *   checkpoint of a run that is not over (null when it is)
 * @throws TypeError inside a withTx callback or for a malformed `now`
 */
export async function purgeAudit(
  h: DbHandle,
  o: { now: number; from: AuditPurgeCheckpoint | null; deadline?: number },
): Promise<{ deleted: number; anchorSeq: number | null; next: AuditPurgeCheckpoint | null }> {
  assertOutsideTx('purgeAudit');
  if (!Number.isSafeInteger(o.now) || o.now < 0) throw new TypeError('purgeAudit: now must be an epoch-ms integer');
  const run = o.from ?? (await startAuditPurge(h));
  if (run.maxSeq === 0) return { deleted: 0, anchorSeq: null, next: null };
  let slice = 0;
  let anchorSeq: number | null = null;
  for (;;) {
    let batch: Awaited<ReturnType<typeof purgeBatch>>;
    try {
      batch = await purgeBatch(h, { now: o.now, maxSeq: run.maxSeq, sliceBefore: slice, deadline: o.deadline });
    } catch (error) {
      // Best effort: the batches that committed before this one stay recorded; the error is the one to report.
      if (slice > 0) await withTx(h, (trx) => recordPurge(trx, o.now, slice, anchorSeq)).catch(() => undefined);
      throw error;
    }
    slice += batch.deleted;
    anchorSeq = batch.anchorSeq;
    if (batch.finished) return { deleted: slice, anchorSeq, next: null };
    if (batch.sliceEnded) return { deleted: slice, anchorSeq, next: { ...run, deleted: run.deleted + slice } };
  }
}
