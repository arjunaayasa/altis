import { withTx, type DB } from '@altis/db';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { txCtx, type TxCtx } from '../../context.js';
import type { StorageDriver } from '../../files/serve.js';
import type { JobHandler, JobOutcome } from '../../jobs/types.js';
import { readClockAnomaly } from '../../scheduler/clock.js';
import { scheduleWindowSchema } from '../../scheduler/registry.js';
import { readSettings } from '../../settings/service.js';
import { openLoanCount } from '../common.js';
import { historyAnonymizeSteps, memberBalanceMinor } from './hooks.js';
import { anonymizeMember } from './privacy.js';

// `privacy.anonymize` (daily at 02:15, skipped while the clock looks wrong): the history keeps what statistics need,
// and loses the person after the library's retention periods (`privacy.*.anonymizeAfterYears`; null = never).
//
// - loans returned longer ago than the loans' period: `member_id` and the override note cleared;
// - visits older than the visits' period: the member, the guest's name and institution, the note and the day key
//   cleared (the type, group, class, head count and source stay, so every count per month, type and class is the same
//   after);
// - members archived longer ago than the members' period (off by default), with no open loan and nothing owed:
//   anonymised in full, as staff would;
// - the steps other modules register (hooks.ts) run after the loans: closed holds as old as the loans' period lose their
//   member, and a settled or cancelled charge of an anonymised loan loses the loan, the item and its line.
//
// Each step works in batches of 500 rows, one short transaction each, until the slice's budget runs low; the job goes
// on in the next slice from its checkpoint, and running it twice changes nothing more. One audit entry per run
// (`privacy.anonymize.run`, the counts only), written when it ends.

/** Rows per batch. */
export const ANONYMIZE_BATCH = 500;

/** Below this much budget left, no further batch starts in this slice. */
const MARGIN_MS = 2000;

/** The payload: the schedule window, the step reached, and the counts so far. */
export const privacyAnonymizePayload = scheduleWindowSchema.extend({
  step: z.int().min(0).max(63).optional(),
  counts: z.record(z.string().max(64), z.int().min(0)).optional(),
});

export type PrivacyAnonymizePayload = z.infer<typeof privacyAnonymizePayload>;

/** `now` minus `years` calendar years (UTC), in epoch ms; null for null. */
export function yearsBefore(now: number, years: number | null): number | null {
  if (years === null) return null;
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.getTime();
}

type Step = { name: string; batch(trx: Transaction<DB>, tx: TxCtx): Promise<{ changed: number; files: string[] }> };

/** The built-in steps and the registered ones, for the cutoffs of this run. */
function steps(cut: { loansBefore: number | null; visitsBefore: number | null; membersBefore: number | null }): Step[] {
  const out: Step[] = [];
  if (cut.loansBefore !== null) {
    const before = cut.loansBefore;
    out.push({
      name: 'loans',
      async batch(trx) {
        const ids = (
          await trx.selectFrom('loans').select('id').where('member_id', 'is not', null).where('returned_at', 'is not', null).where('returned_at', '<', before).limit(ANONYMIZE_BATCH).execute()
        ).map((r) => r.id);
        if (ids.length > 0) await trx.updateTable('loans').set({ member_id: null, override_note: null }).where('id', 'in', ids).execute();
        return { changed: ids.length, files: [] };
      },
    });
  }
  for (const s of historyAnonymizeSteps()) {
    out.push({ name: s.name, batch: async (trx, tx) => ({ changed: await s.run(trx, { loansBefore: cut.loansBefore, visitsBefore: cut.visitsBefore, now: tx.now }), files: [] }) });
  }
  if (cut.visitsBefore !== null) {
    const before = cut.visitsBefore;
    out.push({
      name: 'visits',
      async batch(trx) {
        const ids = (
          await trx
            .selectFrom('visits')
            .select('id')
            .where('visited_at', '<', before)
            .where((eb) => eb.or([eb('member_id', 'is not', null), eb('guest_name', 'is not', null), eb('guest_institution', 'is not', null), eb('note', 'is not', null), eb('day_key', 'is not', null)]))
            .limit(ANONYMIZE_BATCH)
            .execute()
        ).map((r) => r.id);
        if (ids.length > 0) {
          await trx.updateTable('visits').set({ member_id: null, guest_name: null, guest_institution: null, note: null, day_key: null }).where('id', 'in', ids).execute();
        }
        return { changed: ids.length, files: [] };
      },
    });
  }
  if (cut.membersBefore !== null) {
    const before = cut.membersBefore;
    out.push({
      name: 'members',
      async batch(trx, tx) {
        // A few members per batch: each one is a full anonymisation.
        const candidates = await trx
          .selectFrom('members')
          .select('id')
          .where('archived_at', 'is not', null)
          .where('archived_at', '<', before)
          .where('anonymized_at', 'is', null)
          .orderBy('id')
          .limit(50)
          .execute();
        let changed = 0;
        const files: string[] = [];
        for (const c of candidates) {
          if ((await openLoanCount(trx, c.id)) > 0 || (await memberBalanceMinor(trx, c.id)) > 0) continue;
          const r = await anonymizeMember(tx, c.id, { audit: false });
          files.push(...r.deleteFiles);
          changed += 1;
        }
        return { changed, files };
      },
    });
  }
  return out;
}

/** What the job needs besides its context: where stored files are removed. */
export interface PrivacyJobDeps {
  storage: StorageDriver;
}

/**
 * The `privacy.anonymize` handler (see the top of this file): permission `system.jobs.manage`, retryable from the API.
 */
export function privacyAnonymizeJob(deps: () => PrivacyJobDeps): JobHandler<PrivacyAnonymizePayload> {
  return {
    type: 'privacy.anonymize',
    permission: 'system.jobs.manage',
    retryable: 'api',
    payload: privacyAnonymizePayload,
    async run(ctx, p): Promise<JobOutcome<PrivacyAnonymizePayload>> {
      if ((await readClockAnomaly(ctx.db)) !== null) {
        ctx.log.info('privacy.anonymize: skipped while the clock looks wrong', { jobId: ctx.jobId });
        return { done: true, message: 'date_jobs_postponed' };
      }
      const now = ctx.now();
      const s = await readSettings(ctx.db, ['privacy.loans.anonymizeAfterYears', 'privacy.visits.anonymizeAfterYears', 'privacy.members.anonymizeArchivedAfterYears'], []);
      const cut = {
        loansBefore: yearsBefore(now, s['privacy.loans.anonymizeAfterYears'] as number | null),
        visitsBefore: yearsBefore(now, s['privacy.visits.anonymizeAfterYears'] as number | null),
        membersBefore: yearsBefore(now, s['privacy.members.anonymizeArchivedAfterYears'] as number | null),
      };
      const list = steps(cut);
      const counts: Record<string, number> = { ...(p.counts ?? {}) };
      let index = p.step ?? 0;
      const window = { windowStart: p.windowStart, windowEnd: p.windowEnd };
      let ran = false;
      while (index < list.length) {
        if (ran && (ctx.budgetLeftMs() < MARGIN_MS || ctx.cancelled())) {
          return { continueWith: { ...window, step: index, counts }, progress: Math.floor((100 * index) / Math.max(1, list.length)) };
        }
        const step = list[index]!;
        const r = await withTx(ctx.handle, (trx) => step.batch(trx, txCtx(trx, now, { type: 'system', id: null, ip: null })));
        ran = true;
        for (const id of r.files) {
          try {
            await deps().storage.delete(id);
          } catch (error) {
            ctx.log.warn('privacy.anonymize: a photo could not be removed from storage', { jobId: ctx.jobId, fileId: id, err: String(error) });
          }
        }
        counts[step.name] = (counts[step.name] ?? 0) + r.changed;
        if (r.changed === 0 || (step.name !== 'members' && r.changed < ANONYMIZE_BATCH)) {
          index += 1;
          await ctx.heartbeat({ progress: Math.floor((100 * index) / Math.max(1, list.length)) });
        }
      }
      await ctx.audit({ action: 'privacy.anonymize.run', entity: null, entityId: null, meta: { counts } });
      return { done: true };
    },
  };
}
