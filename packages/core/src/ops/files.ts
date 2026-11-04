import {
  atomicWriteJson,
  dataPath,
  ensureDir,
  readBytes,
  readJsonWithBak,
  removeFile,
  renameRetry,
  statOrNull,
  writeBytesAtomic,
  writeExclusive,
  type DataPath,
} from '@altis/platform';
import { DomainError, NEEDS_ATTENTION, OP_KINDS, OP_SCHEMA, isDomainError, isOpState, isTerminal, isUlid, type OpKind } from '@altis/shared';
import { z } from 'zod';

// The DATA_DIR files of the exclusive operations (spec §9.4, decision C8), all in `DATA_DIR/ops`:
//
// - `op.json`: the one op of the installation (the ops lock). `begin` creates it with O_EXCL (`wx`); every later
//   write replaces it atomically (atomicWriteJson: temporary file, fsync, rename, `.bak` with the previous content),
//   under `ops/step.lock` (machine.ts). It stays after the op ended, so that its `altis_ops` keeps working for an
//   hour, and the next `begin` moves it to `ops/<opId>/op.json`.
// - `maintenance.json`: the maintenance flag. Present = maintenance on. Written atomically with a `.bak` like
//   op.json (spec §9.3), so clearing it removes the `.bak` first: a `.bak` left behind would bring the flag back.
// - `data-epoch`: a decimal counter, raised by a restore (spec §9.10 step 11); every process's fence compares it and
//   drops its caches and sessions when it moves; event cursors carry it (`<dataEpoch>.<seq>`).
// - `corrupt-reported`: the id of the op (from its flag, `-` for none) whose unreadable op.json and `.bak` were
//   already reported through `onAttention` (M34: once, whichever process steps it); the next `begin` removes it.
//
// Writers serialize through the ops lock: the machine writes op.json and the flag under `ops/step.lock`, and an op
// kind that writes the flag (Task 25's `sqliteRelease`) or bumps the epoch does so inside its own step. Readers take
// no lock (a rename is atomic).

/** Who began (or took over) an op. `id` is the staff user's ULID; null for the CLI, the installer and the system. */
export interface OpActor {
  type: 'staff' | 'cli' | 'install' | 'system';
  id: string | null;
}

/**
 * `ops/op.json`, `opSchema 1`: the spec's fields (`opSchema`, `opId`, `kind`, `actor`, `state`, `version`, `backupId`,
 * `heartbeatAt`, `error`, `opsTokenHash`, `pointOfNoReturn`) plus `startedAt`, `finishedAt`, `stateBefore`, `params`,
 * `progress`, `message` and `secretParam`, additive inside `opSchema 1` (decision C8). Fields a later release adds
 * inside `opSchema 1` are kept when this code rewrites the file.
 */
export interface OpFile {
  opSchema: 1;
  /** ULID. */
  opId: string;
  kind: OpKind;
  actor: OpActor;
  /** A state of the kind's `opSchema 1` set (OP_STATES), or `needs_attention`. */
  state: string;
  /** The state an op left for `needs_attention`; `resume()` returns it there. */
  stateBefore?: string;
  /** The release the op is about: the target of an update, else the version of the code that began it. */
  version: string;
  backupId: string | null;
  /** Epoch ms of the last step that moved the op (15 minutes without one → `needs_attention`). */
  heartbeatAt: number;
  startedAt: number;
  finishedAt: number | null;
  /** A registered error code (`error.<CODE>` names its message) and an authored detail, never a driver message. */
  error: { code: string; detail?: string } | null;
  /** SHA-256 (hex) of the op's `altis_ops` token; null for an op nobody may drive by cookie. */
  opsTokenHash: string | null;
  /** Past this point `cancel` is refused and a failure goes forward (restore: back to `pre_restore`), never back. */
  pointOfNoReturn: boolean;
  /** The kind's own parameters and checkpoints (JSON). */
  params: Record<string, unknown>;
  /** 0 to 100. */
  progress: number;
  message: string | null;
  /** The op's secret (a backup passphrase's KEK), sealed with the keyring; removed when the op ends (from the `.bak` too). */
  secretParam?: string;
}

/** Why maintenance is on; `manual` is `maintenance:on`. */
export const MAINTENANCE_REASONS = Object.freeze(['restore', 'backup', 'update', 'manual', 'install', 'migrate', 'reset'] as const);

/** `ops/maintenance.json` (spec §9.4): while it exists, the maintenance gate and the claim pause are on. */
export interface MaintenanceFlag {
  reason: (typeof MAINTENANCE_REASONS)[number];
  /** Epoch ms when it was raised: the freeze waits at least 3 s after it (decision C9). */
  since: number;
  /** The op that raised it, or null for a manual flag. */
  opId: string | null;
  /** Jobs that may still be claimed during the maintenance. */
  exemptJobIds: string[];
  /** SQLite restore (Task 25): the op whose swap asks every process to release its database file. */
  sqliteRelease?: string | null;
}

const epochMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ulid = z.string().refine(isUlid, 'not a ULID');

const actorSchema = z.strictObject({
  type: z.enum(['staff', 'cli', 'install', 'system']),
  id: z.string().min(1).max(64).nullable(),
});

const opFileSchema = z
  .looseObject({
    opSchema: z.literal(OP_SCHEMA),
    opId: ulid,
    kind: z.enum(OP_KINDS),
    actor: actorSchema,
    state: z.string().min(1).max(32),
    stateBefore: z.string().min(1).max(32).optional(),
    version: z.string().max(64),
    backupId: ulid.nullable(),
    heartbeatAt: epochMs,
    startedAt: epochMs,
    finishedAt: epochMs.nullable(),
    error: z.looseObject({ code: z.string().min(1).max(64), detail: z.string().max(2000).optional() }).nullable(),
    opsTokenHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    pointOfNoReturn: z.boolean(),
    params: z.record(z.string(), z.unknown()),
    progress: z.number().min(0).max(100),
    message: z.string().max(2000).nullable(),
    secretParam: z.string().max(4096).optional(),
  })
  .refine((op) => isOpState(op.kind, op.state), { message: 'state is not a state of the kind', path: ['state'] })
  .refine((op) => op.stateBefore === undefined || (op.stateBefore !== NEEDS_ATTENTION && isOpState(op.kind, op.stateBefore)), {
    message: 'stateBefore is not a state of the kind',
    path: ['stateBefore'],
  });

const maintenanceSchema = z.strictObject({
  reason: z.enum(MAINTENANCE_REASONS),
  since: epochMs,
  opId: ulid.nullable(),
  exemptJobIds: z.array(ulid).max(1000),
  sqliteRelease: ulid.nullable().optional(),
});

/** The op `raw` describes; throws (a Zod error) when it is not an `opSchema 1` op this code can resume. */
export function parseOpFile(raw: unknown): OpFile {
  return opFileSchema.parse(raw) as OpFile;
}

function parseMaintenance(raw: unknown): MaintenanceFlag {
  return maintenanceSchema.parse(raw);
}

function opsDir(dataDir: string): DataPath {
  return dataPath(dataDir, 'ops');
}

export function opFilePath(dataDir: string): DataPath {
  return dataPath(dataDir, 'ops', 'op.json');
}

/** `ops/<opId>/op.json`: where the next `begin` moves a finished op. */
export function archivedOpPath(dataDir: string, opId: string): DataPath {
  return dataPath(dataDir, 'ops', opId, 'op.json');
}

/** `ops/step.lock`: one stepper (and one `begin`, `cancel`, `takeover`, `resume`) at a time. */
export function stepLockPath(dataDir: string): DataPath {
  return dataPath(dataDir, 'ops', 'step.lock');
}

function maintenancePath(dataDir: string): DataPath {
  return dataPath(dataDir, 'ops', 'maintenance.json');
}

function epochPath(dataDir: string): DataPath {
  return dataPath(dataDir, 'ops', 'data-epoch');
}

/**
 * The `.bak` copy atomicWriteJson keeps beside `p`. Platform names it (no dataPath segment can), so this is the one
 * visible cast of the module: the result is `p` plus a fixed suffix, in the same folder.
 */
function bakOf(p: DataPath): DataPath {
  return `${p}.bak` as DataPath;
}

function isUnreadable(error: unknown): boolean {
  return isDomainError(error) && error.code === 'STATE_CORRUPT' && error.meta?.['reason'] === 'state_unreadable';
}

/**
 * `ops/op.json` (its `.bak` when the file itself does not parse or is not an op), `'corrupt'` when neither is usable,
 * or null when there is none.
 *
 * @throws the file system's error for anything but a missing file (EACCES, EISDIR, ...)
 */
export async function readOpFile(dataDir: string): Promise<OpFile | 'corrupt' | null> {
  try {
    return await readJsonWithBak(opFilePath(dataDir), parseOpFile);
  } catch (error) {
    if (isUnreadable(error)) return 'corrupt';
    throw error;
  }
}

/**
 * The op that holds the ops lock: an op that has not ended (`needs_attention` included), or `'corrupt'` when op.json
 * and its `.bak` cannot be read (an op may be running: treat it as one). Null when there is none, or it ended. This
 * is what a booting process asks before it touches the database (preflight B4, decision C40).
 */
export async function activeOp(dataDir: string): Promise<OpFile | 'corrupt' | null> {
  const op = await readOpFile(dataDir);
  if (op === null || op === 'corrupt') return op;
  return isTerminal(op.kind, op.state) ? null : op;
}

function opText(op: OpFile): string {
  return `${JSON.stringify(op, null, 2)}\n`;
}

function checkedOp(op: OpFile, caller: string): OpFile {
  try {
    return parseOpFile(op);
  } catch (error) {
    throw new TypeError(`${caller}: the op is not a valid opSchema 1 op`, { cause: error });
  }
}

/**
 * Creates `ops/op.json` exclusively (O_EXCL, spec §9.4's `wx`) with `op`.
 *
 * @returns false, with nothing written, when an op.json exists already
 * @throws TypeError for an op this code would not read back
 */
export async function createOpFile(dataDir: string, op: OpFile): Promise<boolean> {
  return writeExclusive(opFilePath(dataDir), opText(checkedOp(op, 'createOpFile')));
}

/**
 * Replaces `ops/op.json` with `op` (atomicWriteJson: the previous content becomes the `.bak`). Callers hold
 * `ops/step.lock` and have checked it with `assertHeld()` (L11).
 *
 * @throws TypeError for an op this code would not read back
 */
export async function writeOpFile(dataDir: string, op: OpFile): Promise<void> {
  await atomicWriteJson(opFilePath(dataDir), checkedOp(op, 'writeOpFile'));
}

/**
 * Moves the finished op `op` (as read from op.json or its `.bak`) to `ops/<opId>/op.json`, leaving no op.json and no
 * `.bak` behind. The `.bak` goes first: it holds the version before the last write, an unfinished one, which would
 * otherwise come back as the current op once op.json is gone. A crash in between leaves op.json as it was.
 */
export async function archiveOpFile(dataDir: string, op: OpFile): Promise<void> {
  const main = opFilePath(dataDir);
  const archive = archivedOpPath(dataDir, op.opId);
  if ((await statOrNull(main)) === null) {
    // Read from the .bak: keep that copy until the archive holds it.
    await writeBytesAtomic(archive, opText(op));
    await removeFile(bakOf(main));
    return;
  }
  await removeFile(bakOf(main));
  await renameRetry(main, archive);
}

/**
 * Final review (OPS-ATTN-EXIT): moves an unreadable `ops/op.json` and its `.bak` (whichever exist) to
 * `ops/<folder>/op.json` and `ops/<folder>/op.json.bak`, so that they can be looked at later and no longer hold the
 * ops lock. `folder` is a new ULID (no op has that id). Callers hold `ops/step.lock`.
 */
export async function setAsideOpFiles(dataDir: string, folder: string): Promise<void> {
  const main = opFilePath(dataDir);
  const aside = archivedOpPath(dataDir, folder);
  await ensureDir(dataPath(dataDir, 'ops', folder));
  // The .bak first, as archiveOpFile: a crash in between leaves op.json, still unreadable, where it was.
  if ((await statOrNull(bakOf(main))) !== null) await renameRetry(bakOf(main), bakOf(aside));
  if ((await statOrNull(main)) !== null) await renameRetry(main, aside);
}

/**
 * The maintenance flag, or null when maintenance is off. A flag whose file and `.bak` are both unreadable still
 * means maintenance (fail closed): it reads as a manual flag (raised when the file was last written), which
 * `maintenance:off` (`clearMaintenance(dataDir, null)`) removes and an op's next step replaces with its own.
 */
export async function readMaintenance(dataDir: string): Promise<MaintenanceFlag | null> {
  const p = maintenancePath(dataDir);
  try {
    return await readJsonWithBak(p, parseMaintenance);
  } catch (error) {
    if (!isUnreadable(error)) throw error;
    const seen = (await statOrNull(p)) ?? (await statOrNull(bakOf(p)));
    return { reason: 'manual', since: Math.max(0, Math.floor(seen?.mtimeMs ?? 0)), opId: null, exemptJobIds: [] };
  }
}

/**
 * Raises (or replaces) the maintenance flag, atomically with a `.bak` (spec §9.3), creating `ops/` when missing.
 *
 * @throws TypeError for a flag that is not well formed (an unknown reason, an id that is not a ULID, ...)
 */
export async function writeMaintenance(dataDir: string, f: MaintenanceFlag): Promise<void> {
  let flag: MaintenanceFlag;
  try {
    flag = parseMaintenance(f);
  } catch (error) {
    throw new TypeError('writeMaintenance: the maintenance flag is not well formed', { cause: error });
  }
  await ensureDir(opsDir(dataDir));
  await atomicWriteJson(maintenancePath(dataDir), flag);
}

/**
 * Lowers the maintenance flag, but only one raised by the op `opId` (or a manual one, for null): an op never ends
 * another op's maintenance, nor a manual one. The `.bak` is removed first, so the flag cannot come back from it.
 *
 * @returns true when a flag was removed
 */
export async function clearMaintenance(dataDir: string, opId: string | null): Promise<boolean> {
  const flag = await readMaintenance(dataDir);
  if (flag === null || flag.opId !== opId) return false;
  const p = maintenancePath(dataDir);
  await removeFile(bakOf(p));
  await removeFile(p);
  return true;
}

function corruptReportedPath(dataDir: string): DataPath {
  return dataPath(dataDir, 'ops', 'corrupt-reported');
}

/** The longest `corrupt-reported` file read: a ULID or `-`, and a line break. */
const REPORTED_MAX_BYTES = 64;

/** What `corrupt-reported` records for an unreadable op.json whose op no maintenance flag names. */
const NO_OP_ID = '-';

/**
 * Whether the unreadable op.json of the op `opId` (from its maintenance flag; null when no flag names one) was
 * already reported, so that `onAttention` runs once for it (M34). A marker that cannot be read counts as none.
 */
export async function corruptReported(dataDir: string, opId: string | null): Promise<boolean> {
  let bytes: Buffer | null;
  try {
    bytes = await readBytes(corruptReportedPath(dataDir), REPORTED_MAX_BYTES);
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return false; // a folder, or too large
    throw error;
  }
  return bytes !== null && bytes.toString('utf8').trim() === (opId ?? NO_OP_ID);
}

/** Records that the unreadable op.json of the op `opId` (null: none named) was reported. Callers hold the ops lock. */
export async function markCorruptReported(dataDir: string, opId: string | null): Promise<void> {
  await ensureDir(opsDir(dataDir));
  await writeBytesAtomic(corruptReportedPath(dataDir), `${opId ?? NO_OP_ID}\n`);
}

/** Forgets the report (a new op begins: op.json was readable again). */
export async function clearCorruptReported(dataDir: string): Promise<void> {
  await removeFile(corruptReportedPath(dataDir));
}

function controlRequestPath(dataDir: string): DataPath {
  return dataPath(dataDir, 'ops', 'control-request');
}

/**
 * `ops/control-request` (final review: cancel and takeover starved behind back-to-back drives): a control action
 * (cancel, takeover, resume, setAsideUnreadable, `maintenance:on|off`) waiting for `ops/step.lock`. While it is fresh no
 * step begins and a step under way stops after its handler step (machine.ts), so the action gets the lock next.
 */
export interface ControlRequest {
  /** Who wrote it (a random token): only they remove it. */
  id: string;
  /** Epoch ms when it was written. */
  at: number;
}

/** The longest `control-request` file read. */
const CONTROL_MAX_BYTES = 256;

const controlSchema = z.strictObject({ id: z.string().min(1).max(64), at: epochMs });

/** Writes `ops/control-request` (atomically), creating `ops/` when missing. */
export async function writeControlRequest(dataDir: string, r: ControlRequest): Promise<void> {
  await ensureDir(opsDir(dataDir));
  await writeBytesAtomic(controlRequestPath(dataDir), `${JSON.stringify(controlSchema.parse(r))}\n`);
}

/** `ops/control-request`, or null when there is none (or it cannot be read: it then keeps nothing out). */
export async function readControlRequest(dataDir: string): Promise<ControlRequest | null> {
  let bytes: Buffer | null;
  try {
    bytes = await readBytes(controlRequestPath(dataDir), CONTROL_MAX_BYTES);
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') return null; // a folder, or too large
    throw error;
  }
  if (bytes === null) return null;
  try {
    return controlSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
  } catch {
    return null;
  }
}

/** Removes `ops/control-request` unless another action's request replaced it meanwhile. */
export async function clearControlRequest(dataDir: string, id: string): Promise<void> {
  const r = await readControlRequest(dataDir);
  if (r !== null && r.id !== id) return;
  await removeFile(controlRequestPath(dataDir));
}

/** The longest data-epoch file read: a number and a line break. */
const EPOCH_MAX_BYTES = 64;
const EPOCH_TEXT = /^\d{1,15}$/;

/**
 * The data epoch (`ops/data-epoch`); 0 when the file does not exist.
 *
 * @throws DomainError `STATE_CORRUPT` (`meta.reason: 'data_epoch_unreadable'`) for a file that does not hold a
 *   number: guessing would let cursors of the old data through
 */
export async function readDataEpoch(dataDir: string): Promise<number> {
  let bytes: Buffer | null;
  try {
    bytes = await readBytes(epochPath(dataDir), EPOCH_MAX_BYTES);
  } catch (error) {
    if (isDomainError(error) && error.code === 'STATE_CORRUPT') throw unreadableEpoch(error);
    throw error;
  }
  if (bytes === null) return 0;
  const text = bytes.toString('utf8').trim();
  if (!EPOCH_TEXT.test(text)) throw unreadableEpoch();
  return Number(text);
}

function unreadableEpoch(cause?: unknown): DomainError {
  return new DomainError('STATE_CORRUPT', {
    detail:
      'Berkas ops/data-epoch di DATA_DIR tidak berisi angka; pulihkan dari cadangan / ' +
      'The file ops/data-epoch in DATA_DIR does not hold a number; restore it from a backup',
    meta: { reason: 'data_epoch_unreadable' },
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Raises the data epoch by one (atomically: temporary file, fsync, rename) and returns the new value. Only the op that
 * holds the ops lock calls it (a restore's last steps), so no two run at once.
 */
export async function bumpDataEpoch(dataDir: string): Promise<number> {
  const next = (await readDataEpoch(dataDir)) + 1;
  await writeBytesAtomic(epochPath(dataDir), `${next}\n`);
  return next;
}
