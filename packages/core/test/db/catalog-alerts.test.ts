import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { catalogAlerts, type CatalogAlertKind } from '../../src/dashboard/catalog-alerts.js';
import { searchHealth } from '../../src/search/health.js';
import { writeSettings } from '../../src/settings/service.js';
import { finishSeededIndex, seedCatalog, wipeCatalog } from '../support/search-corpus.js';

// The catalog's dashboard alerts (Phase 2 plan, preflight B2; spec §4.8, §10): `search_index_mismatch` while the index
// says it is ready and its documents of live records differ from the live records; `oai_misconfigured` while OAI-PMH
// is on and its admin e-mail is empty (a fresh install: OAI on, no e-mail, by the spec's defaults).

const ctx = testDbContext();
const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);

describe.skipIf(!ctx.available)(`catalogAlerts [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-catalog-alerts-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    if (h !== undefined) await wipeCatalog(h);
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await wipeCatalog(h);
    await h.db.deleteFrom('settings').where('key', 'in', ['opac.oai.enabled', 'opac.oai.adminEmail']).execute();
  });

  const raised = async (): Promise<CatalogAlertKind[]> => {
    const kinds: CatalogAlertKind[] = [];
    await catalogAlerts(h.db, (k) => kinds.push(k));
    return kinds;
  };
  const set = (values: Record<string, unknown>) => withTx(h, (trx) => writeSettings(trx, values as never, { keyring: [], now: NOW, actorId: null }));

  it('a fresh install: OAI on without an admin e-mail → oai_misconfigured; the index not built yet → no mismatch', async () => {
    expect(await searchHealth(h.db)).toEqual({ status: 'missing', docs: 0, records: 0, builtAt: null, jobId: null });
    expect(await raised()).toEqual(['oai_misconfigured']);
  });

  it('oai_misconfigured goes with an e-mail set, or with OAI off', async () => {
    await set({ 'opac.oai.adminEmail': 'pustakawan@perpus.example.sch.id' });
    expect(await raised()).toEqual([]);
    await set({ 'opac.oai.adminEmail': '', 'opac.oai.enabled': false });
    expect(await raised()).toEqual([]);
    await set({ 'opac.oai.enabled': true });
    expect(await raised()).toEqual(['oai_misconfigured']);
  });

  it('search_index_mismatch: a record inserted without indexing while the index is ready; not while it builds', async () => {
    await set({ 'opac.oai.adminEmail': 'pustakawan@perpus.example.sch.id' });
    await seedCatalog(h, [{ key: 'a', title: 'Satu' }, { key: 'b', title: 'Dua', archived: true }], { now: NOW });
    await finishSeededIndex(h, NOW);
    expect(await searchHealth(h.db)).toEqual({ status: 'ready', docs: 1, records: 1, builtAt: NOW, jobId: null });
    expect(await raised()).toEqual([]);
    // A write that skipped indexRecords (what the alert is for).
    await seedCatalog(h, [{ key: 'c', title: 'Tiga' }], { now: NOW, index: false });
    expect(await searchHealth(h.db)).toMatchObject({ status: 'ready', docs: 1, records: 2 });
    expect(await raised()).toEqual(['search_index_mismatch']);
    // While a rebuild runs the counts differ by design: no alert.
    await h.db.updateTable('search_state').set({ status: 'building' }).execute();
    expect(await raised()).toEqual([]);
  });

  it('both at once, mismatch first', async () => {
    await seedCatalog(h, [{ key: 'a', title: 'Satu' }], { now: NOW });
    await finishSeededIndex(h, NOW);
    await seedCatalog(h, [{ key: 'b', title: 'Dua' }], { now: NOW, index: false });
    expect(await raised()).toEqual(['search_index_mismatch', 'oai_misconfigured']);
  });
});
