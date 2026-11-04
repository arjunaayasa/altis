import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KEYSET_MAX_DOCS, signDetached, type KeysetDoc, type TrustedKey } from '@altis/crypto';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import type { CoreLogger } from '../../src/context.js';
import { readSettings } from '../../src/settings/service.js';
import { persistKeysetDocs } from '../../src/updates/keyset-store.js';

// The keyset store's Diagnostik alert (spec §8.3, ruling R65c; plan Task 10): persistKeysetDocs sets the instance
// setting `system.keyset_full {at, refused}` when DATA_DIR/releases/keyset.json cannot take a verified document, and
// clears it after a later append that fits. On the engine picked by ALTIS_TEST_DB.

const ctx = testDbContext();
const DEV_KEYS = path.resolve(import.meta.dirname, '..', '..', '..', '..', 'tools', 'keys', 'dev');
const readDev = (name: string): unknown => JSON.parse(readFileSync(path.join(DEV_KEYS, name), 'utf8')) as unknown;
const ROOTS = readDev('roots.json') as TrustedKey[];
const ROOT_KEY = createPrivateKey({
  key: Buffer.from((readDev('dev-root-1.key.json') as { pkcs8: string }).pkcs8, 'base64'),
  format: 'der',
  type: 'pkcs8',
});
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const NOW = 1_800_000_000_000;

function signed(payload: unknown): KeysetDoc {
  return { raw: JSON.stringify(payload), env: signDetached(payload, { typ: 'altis-keyset/1', kid: 'dev-root-1', privateKey: ROOT_KEY }) };
}
const many = (n: number, from: number): KeysetDoc[] =>
  Array.from({ length: n }, (_, i) => signed({ seq: from + i, keys: [], revokedKids: [`unused-${from + i}`] }));

/** 4096 documents: a full store. */
const FULL = many(KEYSET_MAX_DOCS, 1);
const [EXTRA, OTHER] = many(2, 9000);

describe.skipIf(!ctx.available)(`keyset store: system.keyset_full [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let tmp: string;
  let counter = 0;
  let dataDir: string;

  beforeAll(async () => {
    h = await testDb();
    tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-keyset-full-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(tmp, 'migrate'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (tmp !== undefined) await fsp.rm(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('settings').execute();
    dataDir = path.join(tmp, `data-${counter++}`);
    await fsp.mkdir(path.join(dataDir, 'releases'), { recursive: true });
  });

  const fill = (): Promise<void> => fsp.writeFile(path.join(dataDir, 'releases', 'keyset.json'), JSON.stringify(FULL));
  const flag = async (): Promise<unknown> => (await readSettings(h.db, ['system.keyset_full'], []))['system.keyset_full'];
  const persist = (docs: KeysetDoc[], now: number, withDb = true) =>
    persistKeysetDocs({ dataDir, roots: ROOTS, docs, refuseDevKids: false, log: silent, now, ...(withDb ? { db: h } : {}) });

  it('4096 documents present plus one more: full, and the setting names when and how many were refused', async () => {
    await fill();
    expect(await persist([EXTRA!, OTHER!], NOW)).toEqual({ added: 0, present: 0, rejected: 0, refused: 2, full: true });
    expect(await flag()).toEqual({ at: NOW, refused: 2 });
    const row = await h.db.selectFrom('settings').select(['scope']).where('key', '=', 'system.keyset_full').executeTakeFirstOrThrow();
    expect(row.scope).toBe('instance');

    // A call that only finds documents already there leaves the alert alone.
    expect(await persist([FULL[3]!], NOW + 1000)).toMatchObject({ added: 0, present: 1, full: false });
    expect(await flag()).toEqual({ at: NOW, refused: 2 });

    // Refused again later: the alert is refreshed.
    expect(await persist([EXTRA!], NOW + 2000)).toMatchObject({ refused: 1, full: true });
    expect(await flag()).toEqual({ at: NOW + 2000, refused: 1 });
  });

  it('a later append that fits clears the alert', async () => {
    await fill();
    await persist([EXTRA!], NOW);
    expect(await flag()).toEqual({ at: NOW, refused: 1 });
    // The store has room again (an operator replaced it from a backup with a smaller one).
    await fsp.writeFile(path.join(dataDir, 'releases', 'keyset.json'), JSON.stringify(FULL.slice(0, 10)));
    expect(await persist([EXTRA!], NOW + 1000)).toEqual({ added: 1, present: 0, rejected: 0, refused: 0, full: false });
    expect(await flag()).toBeNull();
  });

  it('without a database handle only the file is written', async () => {
    await fill();
    expect(await persist([EXTRA!], NOW, false)).toMatchObject({ full: true });
    expect(await flag()).toBeNull();
  });
});
