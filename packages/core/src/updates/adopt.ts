import {
  COMPLETE_FILE,
  MANIFEST_FILE,
  SIGNATURE_FILE,
  readReleaseKeyset,
  verifyReleaseWithRoots,
  type KeysetSource,
  type ReleaseManifest,
  type TrustedKey,
} from '@altis/crypto';
import type { DbHandle } from '@altis/db';
import {
  copyOperatorFile,
  dataPath,
  ensureHeadroom,
  fsyncDir,
  parseCurrentState,
  readJsonWithBak,
  releaseDir,
  releaseStagingPath,
  removeTree,
  renameRetry,
  stagedReleaseFile,
  updateCurrentState,
  writeBytesAtomic,
  type CurrentState,
  type Env,
  type ReleaseRef,
} from '@altis/platform';
import { isSemver, newId } from '@altis/shared';
import { z } from 'zod';
import { errorFields, type CoreLogger } from '../context.js';
import type { JobHandler } from '../jobs/types.js';
import { persistKeysetDocs } from './keyset-store.js';
import { isLockTimeout, withStepLock } from './retention.js';
import { releaseSourceMode } from './source-mode.js';

// The adoption of the bundled release (spec §9.3 "Adopsi rilis terbundel. Setelah boot sehat pertama dari rilis
// terbundel, tugas latar menyalin rilis itu ke `DATA_DIR/releases/<v>/` (diverifikasi, `.complete`) lalu mengubah
// entrinya menjadi `source:'data'`"; plan Task 27; decision D1d-23). With it `active` and `previous` always live on
// the data volume, so a later zip or image without them still boots them (§9.2 step 3).
//
// - Image mode (`ALTIS_RELEASE_SOURCE=image`, §9.8): no adoption (`skipped`); every new image passes §9.8 row 3.
// - A version current.json does not name (an update moved on meanwhile) is not adopted (`skipped`): retention would
//   remove the copy.
// - `releases/<v>` that verifies `all` (the Docker entrypoint copied it, or an earlier run did) is kept, no copy.
//   Otherwise `<appRoot>/bundled-release/<v>` is verified `all`, copied file by file into a staging folder
//   `releases/.tmp-<v>-<id>/release`, `.complete` written last, the copy verified `all` again, then renamed into place
//   under `ops/step.lock`, where the copy is verified once more: the boot's staging sweep holds that lock too, so the
//   folder that is renamed is whole. A folder of that version that does not verify gives way to the verified copy.
// - Only then does every current.json entry of that version (active, previous, pending) become `source: 'data'`, and
//   the release's keyset documents go to the keyset store (R65a: a revocation it carries outlives it).
//
// Idempotent and resumable (P7): a run killed anywhere leaves either no folder, a staging folder the boot sweep
// removes, or a verified folder the next run keeps; the flip writes nothing when it is done already.

/** What one adoption did: copied or flipped something, found everything done, or had nothing to adopt. */
export type AdoptOutcome = 'adopted' | 'present' | 'skipped';

export interface AdoptReleaseOptions {
  /** The folder of app.js (`bundled-release/<v>` lives there). */
  appRoot: string;
  dataDir: string;
  version: string;
  /** The embedded root keys. */
  roots: readonly TrustedKey[];
  /** The root-signed keyset documents the installation holds (its store, its releases). */
  sources: KeysetSource[];
  /** Production builds: documents that trust a `dev-` kid count for nothing (R65b). */
  refuseDevKids: boolean;
  log: CoreLogger;
  /** Where releases come from (`releaseSourceMode`); default `data`. Image mode adopts nothing. */
  mode?: 'data' | 'image';
  /** With a database, the keyset store's Diagnostik alert is kept (`system.keyset_full`). */
  db?: DbHandle | undefined;
  /** Epoch ms of the alert; default now. */
  now?: number;
}

/**
 * How long the rename into place waits for `ops/step.lock`. Short, so that the job's slice stays within P9's 20 s
 * (a step may hold the lock that long); a busy lock queues the job again ({@link releaseAdoptJob}).
 */
export const ADOPT_LOCK_WAIT_MS = 5_000;
/** A slice that found the lock busy runs again this much later. */
const ADOPT_RETRY_MS = 30_000;

/** current.json (or its `.bak`), read-only; null when neither exists. */
function readState(dataDir: string): Promise<CurrentState | null> {
  return readJsonWithBak(dataPath(dataDir, 'releases', 'current.json'), parseCurrentState);
}

function names(state: CurrentState, version: string): boolean {
  return [state.active, state.previous, state.pending].some((r) => r !== null && r.version === version);
}

function verify(o: AdoptReleaseOptions, dir: string): Promise<ReleaseManifest> {
  return verifyReleaseWithRoots(dir, o.roots.slice(), { check: 'all', sources: o.sources, refuseDevKids: o.refuseDevKids });
}

async function verifies(o: AdoptReleaseOptions, dir: string): Promise<boolean> {
  try {
    await verify(o, dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies the verified bundled release into a staging folder and renames it into `releases/<v>` (see the top of this
 * file). The staging folder is removed whatever happens.
 *
 * @throws `Error('RELEASE_INVALID:<reason>')` when the bundled release or its copy does not verify; DomainError
 *   `DISK_QUOTA`; `STATE_CORRUPT` `lock_timeout` when `ops/step.lock` stays held; the I/O error of a copy or the rename
 */
async function copyIntoPlace(o: AdoptReleaseOptions): Promise<'copied' | 'present'> {
  const src = releaseDir(o.appRoot, o.dataDir, { version: o.version, source: 'bundled' });
  const manifest = await verify(o, src);
  const id = newId();
  const dest = releaseStagingPath(o.dataDir, o.version, id, 'release');
  const installed = dataPath(o.dataDir, 'releases', o.version);
  try {
    await ensureHeadroom(o.dataDir, 2 * manifest.files.reduce((sum, f) => sum + f.size, 0));
    // The paths are the verified manifest's (stagedReleaseFile refuses any a release folder cannot hold).
    const files = [...manifest.files.map((f) => f.path), MANIFEST_FILE, SIGNATURE_FILE];
    for (const name of files) await copyOperatorFile(`${src}/${name}`, stagedReleaseFile(o.dataDir, o.version, id, name));
    const folders = new Set<string>();
    for (const name of files) {
      const parts = name.split('/');
      for (let n = parts.length - 1; n > 0; n -= 1) folders.add(parts.slice(0, n).join('/'));
    }
    for (const folder of [...folders].sort((a, b) => b.split('/').length - a.split('/').length)) {
      await fsyncDir(stagedReleaseFile(o.dataDir, o.version, id, folder));
    }
    await fsyncDir(dest);
    await writeBytesAtomic(stagedReleaseFile(o.dataDir, o.version, id, COMPLETE_FILE), '');
    await verify(o, dest);
    return await withStepLock(
      o.dataDir,
      async (lock) => {
        // Another process adopted it meanwhile (or the entrypoint copied it): theirs stays.
        if (await verifies(o, installed)) return 'present';
        // The boot's sweep holds this lock too: whatever it did before, the copy that is renamed now is whole.
        await verify(o, dest);
        lock.assertHeld();
        await removeTree(installed);
        await renameRetry(dest, installed);
        await fsyncDir(dataPath(o.dataDir, 'releases'));
        return 'copied';
      },
      ADOPT_LOCK_WAIT_MS,
    );
  } finally {
    await removeTree(releaseStagingPath(o.dataDir, o.version, id)).catch((error: unknown) => {
      o.log.warn('adopt: the staging folder could not be removed; the boot sweep removes it', { version: o.version, ...errorFields(error) });
    });
  }
}

/** Every current.json entry of `version` (active, previous, pending) that is `bundled` becomes `data`; true when one did. */
async function flipToData(dataDir: string, version: string): Promise<boolean> {
  const flip = (r: ReleaseRef | null): ReleaseRef | null => (r !== null && r.version === version && r.source === 'bundled' ? { version, source: 'data' } : r);
  const { changed } = await updateCurrentState(dataDir, (s) => {
    const next: CurrentState = { ...s, active: flip(s.active)!, previous: flip(s.previous), pending: flip(s.pending) };
    return next.active === s.active && next.previous === s.previous && next.pending === s.pending ? null : next;
  });
  return changed;
}

/**
 * Adopts the bundled release `o.version` (see the top of this file).
 *
 * @returns `adopted` when it copied the release or flipped an entry, `present` when everything was done already,
 *   `skipped` in image mode or for a version current.json does not name (or without a current.json)
 * @throws TypeError for a version that is not SemVer; `Error('RELEASE_INVALID:<reason>')` when the bundled release (or
 *   its copy) does not verify, nothing flipped; DomainError `DISK_QUOTA`, `STATE_CORRUPT` (a lock, current.json); the
 *   I/O errors
 */
export async function adoptRelease(o: AdoptReleaseOptions): Promise<AdoptOutcome> {
  if (typeof o.version !== 'string' || !isSemver(o.version)) throw new TypeError(`adoptRelease: ${JSON.stringify(o.version)} is not a SemVer version`);
  if ((o.mode ?? 'data') === 'image') return 'skipped';
  const state = await readState(o.dataDir);
  if (state === null || !names(state, o.version)) {
    o.log.info('adopt: current.json does not name the release; nothing is adopted', { version: o.version });
    return 'skipped';
  }
  const installed = dataPath(o.dataDir, 'releases', o.version);
  const copied = (await verifies(o, installed)) ? 'present' : await copyIntoPlace(o);
  const flipped = await flipToData(o.dataDir, o.version);
  await persistKeysetDocs({
    dataDir: o.dataDir,
    roots: o.roots,
    docs: await readReleaseKeyset(installed),
    refuseDevKids: o.refuseDevKids,
    log: o.log,
    db: o.db,
    now: o.now ?? Date.now(),
  });
  if (copied === 'copied' || flipped) o.log.info('adopt: the bundled release now lives in DATA_DIR/releases', { version: o.version, copied: copied === 'copied' });
  return copied === 'copied' || flipped ? 'adopted' : 'present';
}

/** What the `release.adopt` job needs from its process (read at every slice). */
export interface AdoptJobDeps {
  appRoot: string;
  dataDir: string;
  roots: readonly TrustedKey[];
  sources(): Promise<KeysetSource[]>;
  refuseDevKids: boolean;
  /** `ALTIS_RELEASE_SOURCE` (image mode adopts nothing). */
  env: Env;
}

const semver = z
  .string()
  .max(64)
  .refine((v) => isSemver(v), 'not SemVer');

/**
 * The `release.adopt` job (payload `{version}`, permission `system.update.run`, retried only by the code that enqueued
 * it), enqueued after a healthy boot of a `bundled` active release: one {@link adoptRelease}, its outcome the job's
 * message. A busy `ops/step.lock` queues it again 30 s later.
 */
export function releaseAdoptJob(deps: () => AdoptJobDeps): JobHandler<{ version: string }> {
  return {
    type: 'release.adopt',
    permission: 'system.update.run',
    retryable: 'origin-only',
    payload: z.strictObject({ version: semver }),
    async run(ctx, p) {
      const d = deps();
      try {
        const outcome = await adoptRelease({
          appRoot: d.appRoot,
          dataDir: d.dataDir,
          version: p.version,
          roots: d.roots,
          sources: await d.sources(),
          refuseDevKids: d.refuseDevKids,
          log: ctx.log,
          mode: releaseSourceMode(d.env),
          db: ctx.handle,
          now: ctx.now(),
        });
        return { done: true, message: outcome };
      } catch (error) {
        if (isLockTimeout(error)) return { waitUntil: ctx.now() + ADOPT_RETRY_MS, message: 'busy' };
        throw error;
      }
    },
  };
}
