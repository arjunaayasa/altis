import type { DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { MigrationMatchRow, SlimsCutoverView } from '@altis/shared/api/catalog/migration';
import type { Kysely, Transaction } from 'kysely';
import { loadGrants } from '../../authz/grants.js';
import type { TxCtx } from '../../context.js';
import { cutoverMarkAt } from './cutover-marks.js';
import { parseSlimsRunSettings } from './options.js';
import { liveCirculationCount } from './stages/circulation.js';
import { UNUSABLE_PASSWORD } from './stages/staff.js';

// The cut-over checklist of the move from SLiMS (shown in the Migrasi SLiMS wizard). "Mulai melayani" is held until
// every required item holds:
//
// - a real run read the circulation tables and its "Cocokkan dengan SLiMS" holds: the reconciliation balances and no
//   number differs beyond what the run's report explains (an open loan whose copy ALTIS lacks is never explained);
// - at least one desk staff member can sign in: an active account with a password of its own and a role that may lend
//   at the desk (migrated SLiMS accounts start disabled, with no usable password; a super admin does not count);
// - every room SLiMS recorded visits in has an activated guestbook station (SLiMS's guestbook went by IP address);
//   with no room, the run's branch needs one station;
// - the reprint list of cards and labels was opened from the checklist (the copies whose barcodes were rewritten).
//
// Stocktaking is part of this release (`stocktakeAvailable`): a SLiMS session still active comes in cancelled. Once the
// library serves in ALTIS ("Mulai melayani" marked), or ALTIS records any circulation of its own (a loan, a return or
// renewal of a migrated loan, a payment, a waiver, a hold), ALTIS's circulation is live, and a `replace` run is refused
// from then on.

type Db = Kysely<DB> | Transaction<DB>;

interface CutoverState {
  reprintOpenedAt: number | null;
  servingSince: number | null;
}

/** When each item was marked done (cutover-marks.ts). */
async function cutoverState(db: Db): Promise<CutoverState> {
  return { reprintOpenedAt: await cutoverMarkAt(db, 'reprint_opened'), servingSince: await cutoverMarkAt(db, 'serve') };
}

/** The last real run that read the circulation tables (its summary holds `matches`), or null. */
async function lastCirculationRun(db: Db): Promise<{ id: string; finishedAt: number; branchId: string; ok: boolean; matches: MigrationMatchRow[] } | null> {
  const runs = await db
    .selectFrom('catalog_runs')
    .select(['id', 'finished_at', 'options', 'summary'])
    .where('kind', '=', 'migration')
    .where('dry_run', '=', 0)
    .where('status', '=', 'succeeded')
    .orderBy('finished_at', 'desc')
    .limit(20)
    .execute();
  for (const r of runs) {
    let summary: { matches?: unknown; reconciliation?: { ok?: unknown } | null };
    try {
      summary = JSON.parse(r.summary) as typeof summary;
    } catch {
      continue;
    }
    if (!Array.isArray(summary.matches)) continue;
    let branchId: string;
    try {
      branchId = parseSlimsRunSettings(r.options).branchId;
    } catch {
      continue;
    }
    return { id: r.id, finishedAt: Number(r.finished_at ?? 0), branchId, ok: summary.reconciliation?.ok === true, matches: summary.matches as MigrationMatchRow[] };
  }
  return null;
}

/** Active staff, not super admins, with a password of their own and `circulation.desk.use`. */
async function deskStaffCount(db: Db): Promise<number> {
  const users = await db
    .selectFrom('staff_users')
    .select('id')
    .where('status', '=', 'active')
    .where('password_hash', '<>', UNUSABLE_PASSWORD)
    .limit(200)
    .execute();
  let n = 0;
  for (const u of users) {
    const g = await loadGrants(db, u.id);
    if (g.superAdmin) continue;
    if (g.global.has('circulation.desk.use') || [...g.branches.values()].some((s) => s.has('circulation.desk.use'))) n += 1;
  }
  return n;
}

/** The rooms migrated visits name in `branchId`, and how many of them have an activated station. */
async function roomStations(db: Db, branchId: string): Promise<{ rooms: number; withStation: number }> {
  const rooms = (
    await db
      .selectFrom('visits')
      .select('location_id')
      .distinct()
      .where('source', '=', 'migrated')
      .where('branch_id', '=', branchId)
      .where('location_id', 'is not', null)
      .execute()
  ).map((r) => r.location_id!);
  const stations = await db
    .selectFrom('visit_stations')
    .select('location_id')
    .where('branch_id', '=', branchId)
    .where('token_hash', 'is not', null)
    .where('revoked_at', 'is', null)
    .execute();
  if (rooms.length === 0) return { rooms: 1, withStation: stations.length > 0 ? 1 : 0 };
  const covered = new Set(stations.map((s) => s.location_id));
  return { rooms: rooms.length, withStation: rooms.filter((r) => covered.has(r)).length };
}

/** The cut-over checklist (see the top of this file). */
export async function slimsCutover(db: Db): Promise<SlimsCutoverView> {
  const state = await cutoverState(db);
  const run = await lastCirculationRun(db);
  const deskStaff = await deskStaffCount(db);
  const stations = run === null ? { rooms: 0, withStation: 0 } : await roomStations(db, run.branchId);
  const reconciled = run !== null && run.ok && run.matches.every((m) => m.ok);
  const ready = run !== null && reconciled && deskStaff >= 1 && stations.withStation >= stations.rooms && state.reprintOpenedAt !== null;
  return {
    runId: run?.id ?? null,
    finishedAt: run?.finishedAt ?? null,
    deskStaff,
    rooms: stations.rooms,
    roomsWithStation: stations.withStation,
    reprintOpenedAt: state.reprintOpenedAt,
    reconciled,
    stocktakeAvailable: true,
    ready,
    servingSince: state.servingSince,
    circulationLive: (await liveCirculationCount(db)) > 0,
  };
}

/**
 * Marks an item of the checklist done and audits `catalog.migration.cutover {step}`: `reprint_opened` (the reprint
 * list was opened) or `serve` (the library serves in ALTIS from now on; once only).
 *
 * @throws DomainError 422 `MIGRATION_PRECHECK_FAILED {reason: 'cutover_incomplete', count}` for `serve` while a
 *   required item does not hold (`count`: how many)
 */
export async function markSlimsCutoverStep(tx: TxCtx, step: 'reprint_opened' | 'serve'): Promise<SlimsCutoverView> {
  const state = await cutoverState(tx.trx);
  if (step === 'serve') {
    if (state.servingSince !== null) return slimsCutover(tx.trx);
    const view = await slimsCutover(tx.trx);
    if (!view.ready) {
      const missing = [view.runId !== null && view.reconciled, view.deskStaff >= 1, view.roomsWithStation >= view.rooms, view.reprintOpenedAt !== null].filter((ok) => !ok).length;
      throw new DomainError('MIGRATION_PRECHECK_FAILED', {
        detail: 'Daftar periksa pindah dari SLiMS belum lengkap / The checklist of the move from SLiMS is not complete',
        meta: { reason: 'cutover_incomplete', count: missing },
      });
    }
  }
  await tx.audit({ action: 'catalog.migration.cutover', entity: 'slims_cutover', entityId: step, meta: { step } });
  return slimsCutover(tx.trx);
}
