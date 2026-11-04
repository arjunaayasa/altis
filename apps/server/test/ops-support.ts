import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomToken, sha256hex, type MaintenanceFlag, type OpFile } from '@altis/core';
import { isTerminal, newId, type OpKind } from '@altis/shared';

// Ops files for the Task 15 tests (maintenance gate, ops fence, opsAuth, boot during an op): an op.json and a
// maintenance.json written straight into DATA_DIR/ops, as another process's OpsMachine would leave them, so that a
// test can stand at any state of any kind without a kind that walks there.

/** What {@link writeOp} writes: the op, and the `altis_ops` token whose hash it holds. */
export interface WrittenOp {
  op: OpFile;
  token: string;
}

/**
 * Writes DATA_DIR/ops/op.json (an `opSchema 1` op, readable by readOpFile) and removes its `.bak`. `token` is the
 * op's `altis_ops` (a new one by default); a terminal state gets `finishedAt` = `at` unless given.
 */
export async function writeOp(
  dataDir: string,
  o: { kind: OpKind; state: string; at?: number; token?: string } & Partial<Omit<OpFile, 'kind' | 'state'>>,
): Promise<WrittenOp> {
  const { kind, state, at: given, token: givenToken, ...rest } = o;
  const at = given ?? Date.now();
  const token = givenToken ?? randomToken();
  const op: OpFile = {
    opSchema: 1,
    opId: newId(at),
    kind,
    actor: { type: 'cli', id: null },
    state,
    version: '0.1.0',
    backupId: null,
    heartbeatAt: at,
    startedAt: at,
    error: null,
    opsTokenHash: sha256hex(token),
    pointOfNoReturn: false,
    params: {},
    progress: 0,
    message: null,
    ...rest,
    // A terminal op has ended at `at` unless told otherwise (a spread of a running op brings `finishedAt: null`).
    finishedAt: rest.finishedAt ?? (isTerminal(kind, state) ? at : null),
  };
  const dir = path.join(dataDir, 'ops');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.rm(path.join(dir, 'op.json.bak'), { force: true });
  await fsp.writeFile(path.join(dir, 'op.json'), `${JSON.stringify(op, null, 2)}\n`);
  return { op, token };
}

/** The op.json of DATA_DIR as it is now (parsed, not checked). */
export async function readOpJson(dataDir: string): Promise<OpFile> {
  return JSON.parse(await fsp.readFile(path.join(dataDir, 'ops', 'op.json'), 'utf8')) as OpFile;
}

/** Writes (or, with null, removes) DATA_DIR/ops/maintenance.json and its `.bak`. */
export async function writeFlag(dataDir: string, flag: MaintenanceFlag | null): Promise<void> {
  const dir = path.join(dataDir, 'ops');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.rm(path.join(dir, 'maintenance.json.bak'), { force: true });
  if (flag === null) await fsp.rm(path.join(dir, 'maintenance.json'), { force: true });
  else await fsp.writeFile(path.join(dir, 'maintenance.json'), `${JSON.stringify(flag)}\n`);
}

/** The maintenance flag an op of `reason` raises for the op `opId`. */
export function flagOf(reason: MaintenanceFlag['reason'], opId: string | null, since = Date.now()): MaintenanceFlag {
  return { reason, since, opId, exemptJobIds: [] };
}

/** Writes DATA_DIR/ops/data-epoch. */
export async function writeEpoch(dataDir: string, epoch: number): Promise<void> {
  const dir = path.join(dataDir, 'ops');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'data-epoch'), `${epoch}\n`);
}

/** Removes DATA_DIR/ops/op.json and its `.bak`: no op at all. */
export async function removeOp(dataDir: string): Promise<void> {
  const dir = path.join(dataDir, 'ops');
  await fsp.rm(path.join(dir, 'op.json'), { force: true });
  await fsp.rm(path.join(dir, 'op.json.bak'), { force: true });
}
