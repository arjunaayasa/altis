import fsp from 'node:fs/promises';

/**
 * Creates directory `dir` and any missing parent, each new one private to the owner (mode 0700, before the
 * umask). A directory that already exists is accepted as it is (its mode is not changed); a file in the way
 * rejects with `EEXIST`.
 *
 * For callers under the `fs-nonliteral` lint rule (packages/db, apps): pass a path built by `dataPath`, e.g.
 * `ensureDir(dataPath(dataDir, 'db'))`.
 */
export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
}
