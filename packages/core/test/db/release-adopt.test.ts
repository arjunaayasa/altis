import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readKeysetWithBak, verifyReleaseWithRoots, type KeysetDoc } from '@altis/crypto';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { dataPath, readCurrentState, updateCurrentState } from '@altis/platform';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { JobContext } from '../../src/jobs/types.js';
import { adoptRelease, releaseAdoptJob, type AdoptReleaseOptions } from '../../src/updates/adopt.js';
import { DEV_KEYSET, DEV_ROOTS, rootDoc, writeSignedRelease } from '../helpers/signed-release.js';

// The adoption of the bundled release (spec §9.3 "Adopsi rilis terbundel"; plan Task 27; decision D1d-23): after the
// first healthy boot of a `bundled` active release, the `release.adopt` job copies `bundled-release/<v>` into
// `DATA_DIR/releases/<v>/` (staged, verified `all`, `.complete`, renamed into place), flips current.json's entries of
// that version to `source: 'data'` and stores the release's keyset documents. A folder the Docker entrypoint copied is
// verified and kept (no copy). Image mode (`ALTIS_RELEASE_SOURCE=image`, §9.8) adopts nothing.

const copies = vi.hoisted(() => ({ count: 0 }));
vi.mock('@altis/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@altis/platform')>();
  return {
    ...actual,
    copyOperatorFile: async (...args: Parameters<typeof actual.copyOperatorFile>) => {
      copies.count += 1;
      return actual.copyOperatorFile(...args);
    },
  };
});

const ctx = testDbContext();
const V1 = '0.1.0-test';
const V2 = '0.2.0-test';
const silent = { info() {}, warn() {}, error() {} };

const exists = (file: string): Promise<boolean> =>
  fsp.lstat(file).then(
    () => true,
    () => false,
  );

describe.skipIf(!ctx.available)(`adoption of the bundled release [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let appRoot: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-adopt-')));
    await runMigrations(h, { appVersion: V1, dataDir: path.join(root, 'mig'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const base = await fsp.mkdtemp(path.join(root, 'case-'));
    dataDir = path.join(base, 'data');
    appRoot = path.join(base, 'app');
    await fsp.mkdir(dataDir, { recursive: true });
    await readCurrentState(dataDir, V1); // current.json: active 0.1.0-test (bundled)
    copies.count = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const options = (over: Partial<AdoptReleaseOptions> = {}): AdoptReleaseOptions => ({
    appRoot,
    dataDir,
    version: V1,
    roots: DEV_ROOTS,
    sources: [],
    refuseDevKids: false,
    log: silent,
    ...over,
  });
  const installed = (version = V1): string => path.join(dataDir, 'releases', version);
  const bundledDir = (version = V1): string => path.join(appRoot, 'bundled-release', version);
  const storedDocs = async (): Promise<KeysetDoc[]> =>
    (await readKeysetWithBak(dataPath(dataDir, 'releases', 'keyset.json'), 'store')).sources.flatMap((s) => s.docs as KeysetDoc[]);

  /** One slice of the `release.adopt` job, as a runner would run it (the context's other members are not used). */
  async function runJob(version: string, env: Record<string, string | undefined> = {}): Promise<{ done: boolean; message?: string }> {
    const job = releaseAdoptJob(() => ({ appRoot, dataDir, roots: DEV_ROOTS, sources: async () => [], refuseDevKids: false, env }));
    const jobCtx = { jobId: 'job', log: silent, handle: h, db: h.db, now: () => Date.now(), budgetLeftMs: () => 20_000 } as unknown as JobContext;
    const out = await job.run(jobCtx, job.payload.parse({ version }));
    return out as { done: boolean; message?: string };
  }

  it('active {0.1.0-test, bundled} → after the job: releases/0.1.0-test/.complete, verified all, current.json active source data', async () => {
    const docs = [...DEV_KEYSET, rootDoc()];
    await writeSignedRelease(bundledDir(), V1, { keyset: docs });
    const job = releaseAdoptJob(() => ({ appRoot, dataDir, roots: DEV_ROOTS, sources: async () => [], refuseDevKids: false, env: {} }));
    expect(job).toMatchObject({ type: 'release.adopt', permission: 'system.update.run', retryable: 'origin-only' });
    expect(await runJob(V1)).toEqual({ done: true, message: 'adopted' });

    expect(await exists(path.join(installed(), '.complete'))).toBe(true);
    const manifest = await verifyReleaseWithRoots(installed(), [...DEV_ROOTS], { check: 'all', sources: [] });
    expect(manifest.version).toBe(V1);
    const state = await readCurrentState(dataDir, V1);
    expect(state.active).toEqual({ version: V1, source: 'data' });
    // The release's keyset documents are stored (R65a): the revocation it carries outlives it.
    expect((await storedDocs()).map((d) => d.raw)).toContain(rootDoc().raw);
    // No staging folder is left behind.
    expect((await fsp.readdir(path.join(dataDir, 'releases'))).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('a second run → present (nothing copied again); image mode → skipped, nothing written', async () => {
    await writeSignedRelease(bundledDir(), V1);
    expect(await adoptRelease(options())).toBe('adopted');
    const copied = copies.count;
    expect(copied).toBeGreaterThan(0);
    expect(await adoptRelease(options())).toBe('present');
    expect(copies.count).toBe(copied);

    // Image mode: another DATA_DIR whose active release is bundled stays as it is.
    const other = path.join(path.dirname(dataDir), 'image-data');
    await fsp.mkdir(other, { recursive: true });
    await readCurrentState(other, V1);
    expect(await adoptRelease(options({ dataDir: other, mode: 'image' }))).toBe('skipped');
    expect(await runJob(V1, { ALTIS_RELEASE_SOURCE: 'image' })).toEqual({ done: true, message: 'skipped' });
    expect(await exists(path.join(other, 'releases', V1))).toBe(false);
    expect((await readCurrentState(other, V1)).active).toEqual({ version: V1, source: 'bundled' });
  });

  it('a folder the Docker entrypoint already copied → verified and flipped without a copy', async () => {
    await writeSignedRelease(bundledDir(), V1);
    await writeSignedRelease(installed(), V1); // the entrypoint's copy (§9.3: copied, the pointer unchanged)
    expect(await adoptRelease(options())).toBe('adopted');
    expect(copies.count).toBe(0);
    expect((await readCurrentState(dataDir, V1)).active).toEqual({ version: V1, source: 'data' });
  });

  it('every current.json entry of the version flips (previous too); other entries stay', async () => {
    await writeSignedRelease(bundledDir(V1), V1);
    await writeSignedRelease(installed(V2), V2);
    await updateCurrentState(dataDir, (s) => ({ ...s, active: { version: V2, source: 'data' }, previous: { version: V1, source: 'bundled' } }));
    expect(await adoptRelease(options())).toBe('adopted');
    const state = await readCurrentState(dataDir, V1);
    expect(state.active).toEqual({ version: V2, source: 'data' });
    expect(state.previous).toEqual({ version: V1, source: 'data' });
  });

  it('a version current.json does not name → skipped, nothing copied', async () => {
    await writeSignedRelease(bundledDir(V2), V2);
    expect(await adoptRelease(options({ version: V2 }))).toBe('skipped');
    expect(await exists(installed(V2))).toBe(false);
    expect(copies.count).toBe(0);
  });

  it('a folder of that version that does not verify (a copy cut short) gives way to a fresh verified copy', async () => {
    await writeSignedRelease(bundledDir(), V1);
    await writeSignedRelease(installed(), V1);
    await fsp.writeFile(path.join(installed(), 'server.mjs'), 'tampered\n');
    expect(await adoptRelease(options())).toBe('adopted');
    expect(copies.count).toBeGreaterThan(0);
    await verifyReleaseWithRoots(installed(), [...DEV_ROOTS], { check: 'all', sources: [] });
    expect((await readCurrentState(dataDir, V1)).active).toEqual({ version: V1, source: 'data' });
  });

  it('a bundled release that does not verify is never adopted (the error is thrown, nothing flipped)', async () => {
    await writeSignedRelease(bundledDir(), V1, { signer: 'dev-lic-1' }); // a licence key cannot sign a release
    await expect(adoptRelease(options())).rejects.toThrow(/RELEASE_INVALID/);
    expect(await exists(installed())).toBe(false);
    expect((await readCurrentState(dataDir, V1)).active).toEqual({ version: V1, source: 'bundled' });
    expect((await fsp.readdir(path.join(dataDir, 'releases'))).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });
});
