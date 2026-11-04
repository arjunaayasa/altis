import { dropRegisteredTables, withTx, type DbHandle } from '@altis/db';
import { appPath, dataPath, removeAppFile, removeFile, renameRetry, statOrNull, type DataPath } from '@altis/platform';
import { errorFields, txCtx, type Actor } from '../../context.js';
import { bumpDataEpoch, type OpActor, type OpFile } from '../files.js';
import type { OpKindHandler, OpStepContext } from '../machine.js';

// The `reset` op kind (spec §13.6 `install:reset`, §7.7; ruling R1c-5): the CLI takes the ops lock (maintenance
// `reset`) and this step undoes the installation, one checkpointed stage per handler step (`params.stage`), each
// idempotent (P7: whoever resumes the op repeats at most the stage it died in):
//
//   audit  `install.reset {opId, wipeDb}` when the database answers (`ctx.db()`, else the op's own connection);
//          skipped otherwise. It comes first, before the wipe drops audit_log with everything else.
//   wipe   with `params.wipeDb` (the CLI had the database's name confirmed): dropRegisteredTables, every table
//          schema_tables lists and schema_tables itself. The audit stage sets the point of no return first.
//   files  DATA_DIR/install.lock removed (its `.bak` first, which would otherwise read as the lock); config.json renamed
//          to config.json.bak-<epoch ms> (`params.configBackup`), then its `.bak` removed (loadConfig would read it
//          back); the install marker <appRoot>/.altis/installed.json removed (`params.appRoot`; an application folder
//          that cannot be written keeps it: `params.markerRemoved: false`, logged); last, the data epoch raised
//          (final review): every serving process's ops fence then drops its caches and asks for a restart (S23, as
//          after a restore), and boots again into `not_installed`. A config fence keeps the config it has when
//          config.json disappears, so without it those processes went on serving the old installation. An epoch that
//          cannot be raised is logged (`params.epochRaised: false`): the reset still ends, and running servers must be
//          restarted by hand.
//
// The database stages come before the files on purpose: while config.json is still in place, any process that resumes
// the op (`jobs:run`, a server in `ops_wait`) can reach the database; the file stage needs none.
//
// Params, as `install:reset` begins the op: `{wipeDb: boolean, appRoot: string | null}`; missing ones read as
// `false` and `null`.

type Stage = 'audit' | 'wipe' | 'files';

/** The `.bak` copy atomicWriteJson keeps beside `p` (the same visible cast as ops/files.ts). */
function bakOf(p: DataPath): DataPath {
  return `${p}.bak` as DataPath;
}

function actorOf(a: OpActor): Actor {
  if (a.type === 'staff' || a.type === 'cli') return { type: a.type, id: a.id, ip: null };
  return { type: 'system', id: null, ip: null };
}

function stageOf(op: OpFile): Stage {
  const stage = op.params['stage'];
  return stage === 'wipe' || stage === 'files' ? stage : 'audit';
}

const wipeOf = (op: OpFile): boolean => op.params['wipeDb'] === true;

function appRootOf(op: OpFile): string | null {
  const root = op.params['appRoot'];
  return typeof root === 'string' && root !== '' && !root.includes('\0') ? root : null;
}

/** This process's handle, or the op's own connection; undefined when the database does not answer. */
async function answering(ctx: OpStepContext): Promise<DbHandle | undefined> {
  const live = ctx.db();
  if (live !== undefined) return live;
  try {
    return await ctx.connectDedicated();
  } catch {
    return undefined;
  }
}

async function auditStage(ctx: OpStepContext, op: OpFile): Promise<OpFile> {
  const h = await answering(ctx);
  let audited = false;
  if (h !== undefined) {
    try {
      await withTx(h, (trx) =>
        txCtx(trx, ctx.now(), actorOf(op.actor)).audit({
          action: 'install.reset',
          entity: null,
          entityId: null,
          meta: { opId: op.opId, wipeDb: wipeOf(op) },
        }),
      );
      audited = true;
    } catch (error) {
      ctx.log.warn('ops: install.reset could not be audited (the database did not answer)', { opId: op.opId, ...errorFields(error) });
    }
  }
  // Final review (ops minor): with --wipe-db the point of no return comes before the wipe. A failure from there on
  // leaves the op in needs_attention with maintenance kept (`ops:resume` goes on), never `failed` with maintenance
  // lifted over a half-dropped database that config.json and install.lock still call installed; a cancel is refused.
  return { ...op, params: { ...op.params, stage: 'wipe', audited }, pointOfNoReturn: op.pointOfNoReturn || wipeOf(op), progress: 25 };
}

async function wipeStage(ctx: OpStepContext, op: OpFile): Promise<OpFile> {
  if (wipeOf(op)) {
    // No answer here is DB_UNAVAILABLE, thrown on: the machine leaves the op for a later step.
    const h = ctx.db() ?? (await ctx.connectDedicated());
    ctx.lock.assertHeld();
    await dropRegisteredTables(h.db, h.dialect);
    ctx.log.info('ops: install:reset dropped every registered table', { opId: op.opId });
  }
  return { ...op, params: { ...op.params, stage: 'files', wiped: wipeOf(op) }, progress: 50 };
}

async function filesStage(ctx: OpStepContext, op: OpFile): Promise<OpFile> {
  const { dataDir } = ctx;
  ctx.lock.assertHeld();
  const lock = dataPath(dataDir, 'root', 'install.lock');
  await removeFile(bakOf(lock));
  await removeFile(lock);

  const config = dataPath(dataDir, 'root', 'config.json');
  const before = op.params['configBackup'];
  let configBackup = typeof before === 'string' ? before : null;
  if ((await statOrNull(config)) !== null) {
    const name = `config.json.bak-${String(Math.floor(ctx.now())).padStart(13, '0')}`;
    await renameRetry(config, dataPath(dataDir, 'root', name));
    configBackup = name;
  }
  await removeFile(bakOf(config));

  const appRoot = appRootOf(op);
  let markerRemoved: boolean | null = null;
  if (appRoot !== null) {
    markerRemoved = await removeAppFile(appPath(appRoot, 'installed-marker'));
    if (!markerRemoved) {
      ctx.log.warn('ops: the install marker could not be removed (the application folder is not writable)', { opId: op.opId });
    }
  }

  let epochRaised = true;
  try {
    ctx.lock.assertHeld();
    await bumpDataEpoch(dataDir);
  } catch (error) {
    epochRaised = false;
    ctx.log.warn('ops: install:reset could not raise the data epoch; running servers keep the old installation until restarted', {
      opId: op.opId,
      ...errorFields(error),
    });
  }
  return {
    ...op,
    state: 'done',
    params: { ...op.params, stage: 'done', configBackup, markerRemoved, epochRaised },
    progress: 100,
  };
}

/**
 * The `reset` kind: maintenance `reset` (which pauses job claims), no freeze: the freeze looks for job leases in the
 * database, and a reset must also run where there is none (a DATA_DIR that holds nothing but what the marker names).
 */
export function resetKind(): OpKindHandler {
  return {
    kind: 'reset',
    initialState: 'running',
    maintenance: 'reset',
    freeze: false,
    step: async (ctx, op) => {
      switch (stageOf(op)) {
        case 'audit':
          return auditStage(ctx, op);
        case 'wipe':
          return wipeStage(ctx, op);
        default:
          return filesStage(ctx, op);
      }
    },
  };
}
