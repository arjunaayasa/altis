import { AUDIT_GENESIS_HASH, assertOutsideTx, verifyAuditChain, withTx, type DbHandle } from '@altis/db';
import { appendLine, dataPath } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { z } from 'zod';
import { notify } from '../notifications/service.js';
import { readSettings, writeSettings } from '../settings/service.js';

// The daily audit anchor (`audit.anchor`, schedule `audit.anchor`; spec §7.8; L39, M5):
//
// 1. the head of the chain (`audit_head`: its seq and hash) is appended to `DATA_DIR/logs/audit-anchor.log` as one
//    JSON line `{"at","seq","hash"}`: a copy outside the database that a rewritten chain cannot match. A run appends
//    it once, in its first slice;
// 2. the chain is verified incrementally: from the point the last run verified (`audit.verified`: `head`, `headHash`)
//    or from the retention anchor (`audit.anchor`), whichever is later, up to the head. When a walk from the last
//    verified point breaks, the chain is walked again from the anchor alone: that point may belong to a chain that no
//    longer exists (a restore replaced the log), and only a break of the chain as it is counts;
// 3. the result is `audit.verified = {at, ok, head, headHash, brokenAt}`: after a success `head`/`headHash` are the
//    verified head, after a break they stay at the last good point (so later runs keep finding the break), and a break
//    notifies the holders of `system.audit.read` (`notification.audit_broken`), once per broken entry.
//
// A walk fits the job's slices (1d, T18-AUDIT-ANCHOR-BUDGET; P9): with a `deadline` it stops after the batch that
// passes it, and the run continues in the next slice from the last entry it verified (`AnchorResume`, kept in the
// job's payload), so the first walk of a large log, and one after a break or a restore, take as many slices as they
// need. `audit.verified` is written only by the slice that ends the run.

/** What `audit.verified` holds. */
export interface AuditVerified {
  at: number;
  ok: boolean;
  /** The last entry known to be good. */
  head: number;
  headHash: string;
  brokenAt: number | null;
}

type Point = { seq: number; hash: string };

/**
 * Which walk a run is in: `verified`, begun at the last verified point (a break walks the chain again from the anchor
 * alone), or `anchor`, begun at the retention anchor or the genesis (a break is the run's answer).
 */
export type AnchorWalk = 'verified' | 'anchor';

/** Where a run that stopped at its deadline goes on: the last entry its walk verified, and that walk. */
export interface AnchorResume {
  from: Point;
  walk: AnchorWalk;
}

/** A chain point in a job's payload: `{seq, hash}` as `audit.anchor` holds it. */
export const auditPointSchema = z.strictObject({
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});

/** What one anchorAudit call did. */
export interface AnchorRun {
  /** The head appended to the log by this call; null for a call that goes on with a run (`o.resume`). */
  logged: Point | null;
  /** The verification stored in `audit.verified`; null when the walk stopped at its deadline. */
  verified: AuditVerified | null;
  /** Where the next call goes on; null once the run is over (`verified` stored). */
  next: AnchorResume | null;
}

/** Where an anchor run's notification about a break leads: the audit log screen. */
const AUDIT_PAGE = '/admin/audit';

/** The later of the anchor and the verified point (the verified point wins a tie), as verifyAuditChain starts. */
function laterOf(anchor: Point | null, from: Point | null): Point | null {
  if (anchor === null) return from;
  if (from === null) return anchor;
  return from.seq >= anchor.seq ? from : anchor;
}

/**
 * One anchor run, or one slice of it, at `o.now` (see the top of this file). Run it outside any withTx callback: the
 * verification reads outside any transaction (R49), and the result is written in a transaction of its own.
 * `o.heartbeat` (the job's `ctx.heartbeat`) is awaited between the walk's batches, so the job's lease (and
 * `jobs:heavy`) outlives a long slice. `o.deadline` (a `performance.now()` reading) stops the walk after the batch
 * that passes it; `o.resume` (the previous call's `next`) goes on with that run.
 *
 * @returns what it logged, stored, and where the run goes on
 * @throws DomainError `STATE_CORRUPT` when `audit_head` has no row; `DISK_QUOTA` from the log append
 */
export async function anchorAudit(
  h: DbHandle,
  o: { dataDir: string; now: number; heartbeat?: () => Promise<void>; deadline?: number; resume?: AnchorResume | null },
): Promise<AnchorRun> {
  assertOutsideTx('anchorAudit');
  const resume = o.resume ?? null;
  let logged: Point | null = null;
  if (resume === null) {
    const head = await h.db.selectFrom('audit_head').select(['last_seq', 'last_hash']).where('id', '=', 1).executeTakeFirst();
    if (head === undefined) {
      throw new DomainError('STATE_CORRUPT', {
        detail: 'Baris kepala log audit (audit_head id 1) tidak ada / The audit log head row (audit_head id 1) is missing',
        meta: { reason: 'audit_head_missing' },
      });
    }
    logged = { seq: Number(head.last_seq), hash: head.last_hash };
    await appendLine(dataPath(o.dataDir, 'logs', 'audit-anchor.log'), JSON.stringify({ at: o.now, ...logged }));
  }

  const stored = await readSettings(h.db, ['audit.anchor', 'audit.verified'], []);
  const anchor = (stored['audit.anchor'] as Point | null) ?? null;
  const prev = (stored['audit.verified'] as AuditVerified | null) ?? null;
  /** The point the last run verified. */
  const verifiedPoint = prev === null ? null : { seq: prev.head, hash: prev.headHash };

  let walk: AnchorWalk;
  /** Where this call's walk goes on from (with the anchor, the later of the two is its start). */
  let from: Point | null;
  if (resume === null) {
    walk = verifiedPoint !== null && laterOf(anchor, verifiedPoint) === verifiedPoint ? 'verified' : 'anchor';
    from = verifiedPoint;
  } else {
    ({ walk, from } = resume);
  }

  let verified: AuditVerified;
  for (;;) {
    /** Where the walk starts: the last point known to be good when it breaks or reaches the head right there. */
    const start = laterOf(anchor, from);
    const result = await verifyAuditChain(h, {
      ...(anchor === null ? {} : { anchor }),
      ...(from === null ? {} : { from }),
      ...(o.heartbeat === undefined ? {} : { onBatch: o.heartbeat }),
      ...(o.deadline === undefined ? {} : { deadline: o.deadline }),
    });
    if ('complete' in result) return { logged, verified: null, next: { from: { seq: result.head, hash: result.headHash }, walk } };
    if (!result.ok && walk === 'verified') {
      // The walk from the anchor alone decides (in this call while its deadline allows, else in the next ones).
      walk = 'anchor';
      from = null;
      continue;
    }
    if (result.ok) {
      let headHash: string | undefined;
      if (result.head === (start?.seq ?? 0)) headHash = start?.hash ?? AUDIT_GENESIS_HASH;
      else headHash = (await h.db.selectFrom('audit_log').select('hash').where('seq', '=', result.head).executeTakeFirst())?.hash;
      verified =
        headHash === undefined
          ? // The head entry went between the walk and this read (a purge reached it): the start stays the good point.
            { at: o.now, ok: true, head: start?.seq ?? 0, headHash: start?.hash ?? AUDIT_GENESIS_HASH, brokenAt: null }
          : { at: o.now, ok: true, head: result.head, headHash, brokenAt: null };
    } else {
      // The last verified point stays good when the break lies beyond it and it is later than this walk's start.
      const kept = verifiedPoint !== null && result.brokenAt > verifiedPoint.seq && verifiedPoint.seq > (start?.seq ?? 0);
      const good = kept ? verifiedPoint : start;
      verified = { at: o.now, ok: false, head: good?.seq ?? 0, headHash: good?.hash ?? AUDIT_GENESIS_HASH, brokenAt: result.brokenAt };
    }
    break;
  }

  const brokenAt = verified.brokenAt;
  const known = prev !== null && !prev.ok && prev.brokenAt === brokenAt;
  await withTx(h, async (trx) => {
    await writeSettings(trx, { 'audit.verified': verified }, { keyring: [], now: o.now, actorId: null });
    if (brokenAt !== null && !known) {
      await notify(
        trx,
        {
          audience: { permission: 'system.audit.read' },
          type: 'audit.broken',
          titleKey: 'notification.audit_broken.title',
          params: { seq: brokenAt },
          link: AUDIT_PAGE,
        },
        o.now,
      );
    }
  });
  return { logged, verified, next: null };
}
