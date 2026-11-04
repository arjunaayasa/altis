import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { TABLE_CLASSES, columnsAt, withTx, type DbHandle, type TableName } from '@altis/db';
import { backupImportedPath, backupPartPath, dataPath, openRead, readBytes, statOrNull, writeStreamAtomic, type DataPath } from '@altis/platform';
import { DomainError } from '@altis/shared';
import { z } from 'zod';
import { txCtx, type Actor } from '../context.js';
import { BACKUP_PATH_TABLES } from '../backup/canonical.js';
import { BACKUPS_LINK } from '../backup/create-job.js';
import { readManifest, type BackupManifest } from '../backup/manifest.js';
import { notify } from '../notifications/service.js';
import type { OpActor } from '../ops/files.js';
import { bumpDataEpoch, readDataEpoch } from '../ops/files.js';
import { writeSettings } from '../settings/service.js';
import { keptCheckpointSchema, type KeptCheckpoint } from './keep.js';
import { MISSING_MAX } from './prepass.js';
import { CHECKLIST_MAX, type RestoreChecklist, type SecretsBranch } from './secrets.js';
import type { RestoreSource } from './source.js';

// The end of a restore (spec §9.10 steps 9–11, P14; decisions C16, C25; rulings R1c-3; preflight S2, S4, S23; plan
// Task 22), on the work handle, each sub-step recorded in `params.final` (P7: a process that dies anywhere repeats at
// most the sub-step it died in, and every one of them can be repeated):
//
//   1 kept     the target's install and history rows put back (keep.ts restoreKeptStep);
//   2 history  the backup's history parts (audit_log, releases_log, backups) concatenated, as they are (gzip members),
//              into `backups/<backupId>/imported-<table>.jsonl.gz`: kept beside the backup, never loaded (§6.5);
//   3 files    the uploads (files.ts);
//   4 swap     SQLite only: Task 25's swap of the work file into place ('waiting' → the step is retried later);
//   5 volatile every volatile table emptied, `system.events_floor` back to 0 and `system.clock_confirmed` to null
//              (ruling R1c-3: the events start again from seq 1 in a new epoch; the confirmation's auditSeq belonged
//              to the audit chain as it was), in one transaction; with `targetSchema: 'backup'` (1d) only the volatile
//              tables of the backup's schema;
//   6 epoch    `ops/data-epoch` raised once: the value before is recorded first, and the bump happens only while the
//              file still holds it;
//   7 audit    the report (`ops/<opId>/report.json`), its lists read from the restored database (restoredLists: a
//              step killed after its commits in `loading` or step 3 loses no name); then `backup.restore {opId,
//              archiveSha256, archiveAuditHead, sourceInstallId, secretsBranch, outcome}` on the restored database
//              through the work handle (maintenance guarantees no other writer, so L41's two-handle deadlock cannot
//              arise, S4), together with `notification.restore_done` (or `restore_failed`, and `disk_low` after a full
//              disk) in one transaction that is skipped when the entry of this op is there. A failure here never
//              sends the op back (the data is restored and the epoch moved): the step stays at 7 and the next step
//              tries again (`auditFailedAt` records since when; kind.ts moves the op to `needs_attention` after the
//              machine's stall time of failures, and a resumed op tries again).
//
// The `pre_restore` replay (failed_restoring_pre) runs 1, 5, 6 and 7 with outcome `failed`.

/** The sub-steps of finalizing, in order. */
export const FINAL_STEPS = ['kept', 'history', 'files', 'swap', 'volatile', 'epoch', 'audit'] as const;
export type FinalStep = (typeof FINAL_STEPS)[number];

/** Where finalizing stands (op.params.final). */
export type FinalCheckpoint = {
  step: FinalStep | 'done';
  kept: KeptCheckpoint;
  /** Index into the backup's history tables of the next one to copy. */
  history: number;
  /** The last `files` row done. */
  filesAfter: string | null;
  /** The data epoch before the bump, once recorded. */
  epochBefore: number | null;
  /** Since when step 7 has been failing (null or absent: its last try did not fail). */
  auditFailedAt?: number | null;
  /**
   * Task 25 (R1c-11): since when the SQLite swap (or, in a replay's checkpoint, the rename back) has been waiting for
   * the owner processes to let go of the live file, on the op's clock; the wait's budget runs from there across steps.
   * Null or absent: no wait yet.
   */
  releaseWaitSince?: number | null;
};

export const finalCheckpointSchema = z.strictObject({
  step: z.enum([...FINAL_STEPS, 'done']),
  kept: keptCheckpointSchema,
  history: z.number().int().min(0).max(100),
  filesAfter: z.string().max(64).nullable(),
  epochBefore: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  auditFailedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  releaseWaitSince: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
}) satisfies z.ZodType<FinalCheckpoint>;

export function newFinal(): FinalCheckpoint {
  return { step: 'kept', kept: { table: 0, started: false, after: null }, history: 0, filesAfter: null, epochBefore: null, auditFailedAt: null };
}

/** The volatile tables (§6.5): emptied by a restore. */
export const VOLATILE_TABLES: readonly TableName[] = Object.freeze(
  (Object.keys(TABLE_CLASSES) as TableName[]).filter((t) => TABLE_CLASSES[t] === 'volatile').sort(),
);

/** The history tables the backup holds, in manifest order. */
export function historyTables(m: BackupManifest): string[] {
  return Object.entries(m.tables)
    .filter(([, t]) => t.class === 'history')
    .map(([name]) => name);
}

/** The bytes of the file `p` (positioned reads). */
async function* fileBytes(p: DataPath): AsyncGenerator<Buffer, void, undefined> {
  const handle: FileHandle = await openRead(p);
  try {
    for (let position = 0; ; ) {
      const buffer = Buffer.allocUnsafe(256 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Step 2 for the history table at `index` of the backup: its parts, concatenated as they are, written to
 * `backups/<backupId>/imported-<table>.jsonl.gz` (atomically). Returns the next index.
 *
 * @throws DomainError DISK_QUOTA (P21)
 */
export async function importHistoryTable(source: RestoreSource, dataDir: string, index: number): Promise<number> {
  const m = source.manifest;
  const table = historyTables(m)[index];
  if (table === undefined) return index;
  const parts = m.tables[table]!.parts;
  async function* all(): AsyncGenerator<Buffer> {
    for (const part of parts) yield* fileBytes(source.partFile(table!, part.n));
  }
  await writeStreamAtomic(backupImportedPath(dataDir, source.backupId, table, BACKUP_PATH_TABLES), all());
  return index + 1;
}

/**
 * Step 5: every volatile table emptied, the events floor and the clock confirmation reset (R1c-3), one transaction.
 * With `o.schemaVersion` (a restore that ends at the backup's schema, 1d), only the volatile tables that schema has.
 */
export async function clearVolatile(work: DbHandle, now: number, o: { schemaVersion?: string } = {}): Promise<void> {
  const tables = o.schemaVersion === undefined ? VOLATILE_TABLES : VOLATILE_TABLES.filter((t) => columnsAt(t, o.schemaVersion!).length > 0);
  await withTx(work, async (trx) => {
    for (const table of tables) await trx.deleteFrom(table).execute();
    await writeSettings(trx, { 'system.events_floor': 0, 'system.clock_confirmed': null }, { keyring: [], now, actorId: null });
  });
}

/**
 * Step 6: the data epoch raised once. `before` is the epoch recorded before the bump (null: read it now and return it,
 * so the caller records it first); the bump happens only while the file still holds it.
 */
export async function bumpEpochOnce(dataDir: string, before: number | null): Promise<{ before: number; bumped: boolean }> {
  if (before === null) return { before: await readDataEpoch(dataDir), bumped: false };
  if ((await readDataEpoch(dataDir)) === before) await bumpDataEpoch(dataDir);
  return { before, bumped: true };
}

/** Code-unit order (the same on every dialect, whatever its collation). */
function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The lists of a finished restore's report, read from the restored database: the `files` rows whose status is
 * `missing` (at most {@link MISSING_MAX}) and, unless the branch is `a` (every secret carried over as it was), the
 * checklist: the secret settings without a value (to enter again) and the staff with `totp_reenroll = 1` and no TOTP
 * secret (to enrol again), each at most {@link CHECKLIST_MAX}. Read at the end rather than gathered while the rows are
 * written, so that a step killed after its commits but before its checkpoint loses no name (P7).
 */
export async function restoredLists(work: DbHandle, branch: SecretsBranch): Promise<{ checklist: RestoreChecklist; missing: string[] }> {
  const files = await work.db.selectFrom('files').select('id').where('status', '=', 'missing').orderBy('id').limit(MISSING_MAX).execute();
  const missing = files.map((r) => r.id).sort(byCodeUnits);
  if (branch === 'a') return { checklist: { secrets: [], reenroll: [] }, missing };
  const settings = await work.db
    .selectFrom('settings')
    .select('key')
    .where('is_secret', '=', 1)
    .where('value', 'is', null)
    .orderBy('key')
    .limit(CHECKLIST_MAX)
    .execute();
  const staff = await work.db
    .selectFrom('staff_users')
    .select(['username_key', 'username_display'])
    .where('totp_reenroll', '=', 1)
    .where('totp_secret_enc', 'is', null)
    .orderBy('username_key')
    .limit(CHECKLIST_MAX)
    .execute();
  return {
    checklist: {
      secrets: settings.map((r) => r.key).sort(byCodeUnits),
      reenroll: staff.sort((a, b) => byCodeUnits(a.username_key, b.username_key)).map((r) => r.username_display),
    },
    missing,
  };
}

/** The audit actor of an op's actor. */
export function actorOf(a: OpActor): Actor {
  if (a.type === 'staff' || a.type === 'cli') return { type: a.type, id: a.id, ip: null };
  return { type: 'system', id: null, ip: null };
}

/** What step 7 records. */
export interface RestoreOutcome {
  opId: string;
  actor: OpActor;
  /** The `backups` row restored (or, for the replay, still the one the restore was about). */
  backupId: string;
  /** SHA-256 of the archive (an uploaded `.altisbak`) or of the backup's `manifest.json`. */
  archiveSha256: string | null;
  archiveAuditHead: { seq: number; hash: string };
  sourceInstallId: string;
  secretsBranch: SecretsBranch;
  outcome: 'done' | 'failed';
  /** The failure's code (outcome `failed`). */
  error?: string;
  /** `notification.restore_done` / `restore_failed`; none for a failure before the point of no return. */
  notifyOutcome: boolean;
  /** `notification.disk_low` too (a full disk or quota, P21). */
  diskLow: boolean;
  now: number;
}

/** Whether the `backup.restore` entry of op `opId` is in the audit log already (a step that died after its commit). */
async function audited(work: DbHandle, backupId: string, opId: string): Promise<boolean> {
  const rows = await work.db
    .selectFrom('audit_log')
    .select('meta')
    .where('action', '=', 'backup.restore')
    .where('entity_id', '=', backupId)
    .orderBy('seq', 'desc')
    .limit(20)
    .execute();
  return rows.some((r) => {
    try {
      return (JSON.parse(r.meta) as { opId?: unknown }).opId === opId;
    } catch {
      return false;
    }
  });
}

/**
 * Step 7: the `backup.restore` audit entry and the notifications, in one transaction on `work`, unless the entry of
 * this op is there already.
 */
export async function recordOutcome(work: DbHandle, o: RestoreOutcome): Promise<void> {
  if (await audited(work, o.backupId, o.opId)) return;
  await withTx(work, async (trx) => {
    const meta: Record<string, unknown> = {
      opId: o.opId,
      archiveSha256: o.archiveSha256,
      archiveAuditHead: o.archiveAuditHead,
      sourceInstallId: o.sourceInstallId,
      secretsBranch: o.secretsBranch,
      outcome: o.outcome,
    };
    if (o.error !== undefined) meta['error'] = o.error;
    await txCtx(trx, o.now, actorOf(o.actor)).audit({ action: 'backup.restore', entity: 'backup', entityId: o.backupId, meta });
    if (o.diskLow) {
      await notify(
        trx,
        { audience: { permission: 'system.diagnostics.read' }, type: 'disk.low', titleKey: 'notification.disk_low.title', link: '/admin/diagnostics' },
        o.now,
      );
    }
    if (o.notifyOutcome) {
      await notify(
        trx,
        {
          audience: { permission: 'system.backup.read' },
          type: o.outcome === 'done' ? 'restore.done' : 'restore.failed',
          titleKey: o.outcome === 'done' ? 'notification.restore_done.title' : 'notification.restore_failed.title',
          params: { name: o.backupId },
          link: BACKUPS_LINK,
        },
        o.now,
      );
    }
  });
}

/**
 * The end of the `pre_restore` backup the restore made (its manifest written): its row `ok` with `size` (manifest and
 * parts on disk) and `sha256` (of `manifest.json`). No notification and no retention: the retention could remove the
 * backup being restored, and the backup is the restore's own safety net.
 */
export async function finishPreRestore(h: DbHandle, dataDir: string, backupId: string): Promise<void> {
  const bytes = await readBytes(dataPath(dataDir, 'backups', backupId, 'manifest.json'), 64 * 1024 * 1024);
  const manifest = await readManifest(dataDir, backupId);
  if (bytes === null || manifest === null) throw new DomainError('BACKUP_INVALID', { meta: { reason: 'format' } });
  let size = bytes.byteLength;
  for (const [table, t] of Object.entries(manifest.tables)) {
    for (const part of t.parts) size += (await statOrNull(backupPartPath(dataDir, backupId, table, part.n, BACKUP_PATH_TABLES)))?.size ?? 0;
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await h.db.updateTable('backups').set({ status: 'ok', size, sha256 }).where('id', '=', backupId).where('status', '=', 'running').execute();
}
