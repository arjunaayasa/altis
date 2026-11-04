import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  claimById,
  createJobRegistry,
  createSettingsCache,
  localStorageDriver,
  recordUrlPath,
  runSlice,
  writeSettings,
  type CatalogJobDeps,
  type CoreLogger,
  type Mailer,
} from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, verifyAuditChain, withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { MasterListResponse, SupplierView } from '@altis/shared/api/catalog/masters';
import type { RecordListResponse } from '@altis/shared/api/catalog/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { CATALOG_ROUTES } from '../../src/api/catalog/index.js';
import { createApp, type AppState } from '../../src/app.js';
import { writeConfig, type Config } from '../../src/config.js';
import { cookieName, isSecureBase } from '../../src/http/cookies.js';
import { routeMode } from '../../src/http/edition-gate.js';
import type { RouteDecl } from '../../src/http/route.js';
import { catalogJobHandlers } from '../../src/jobs/catalog.js';
import { OPAC_CATALOG_ROUTES } from '../../src/opac/catalog/index.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createAgent, type AgentReply } from '../agent.js';
import { personaSession, seedPersona, type PersonaUser, type SeedContext } from '../matrix-fixtures.js';
import { sessionCsrfFor } from '../support-auth.js';
import { recordingLogger, sampleConfig } from '../support.js';

// Phase 2 integration with Phase 1d (plan Task 39, part 39a; spec §15 K2, §1.3, §2.2, §12.3; preflight S12) on the
// engine picked by ALTIS_TEST_DB, through the app as the admin SPA, a visitor and a harvester use it, on one
// installation whose catalog is made through the API (a supplier with its contact fields, a record with an item bought
// from it, a public PDF, a page and a news post):
//
// - K2: the route modes (http/edition-gate.ts routeMode) of every Phase 2 route are §1.3's;
// - S12: merging agent A into B queues the reindex of B; once the job ran, the record moved from A is found by B's name
//   (admin search and OPAC), and no longer by A's;
// - §2.2 (*): a supplier's contact fields (name, phone, e-mail, address) never appear in any OPAC page or download,
//   any OAI-PMH answer or any export file, while the staff API still shows them.

const ctx = testDbContext();
/** In the past (an audit entry may not be dated ahead of the real clock). */
const NOW = Date.UTC(2026, 9, 30, 9, 0, 5);
const DAY = 86_400_000;
const API = '/api/v1';
const HTML = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
const silentMailer: Mailer = { send: async () => {} };

/** The supplier's contact fields (personal data, §2.2 *): strings found nowhere else, so a grep finds only a leak. */
const CONTACT = {
  contactName: 'Sutarmi Kontakpribadi',
  phone: '+62 21 5550 7788 41',
  email: 'sutarmi.kontak@pemasok-rahasia.example',
  address: 'Jalan Kontak Rahasia No. 17, Bekasi',
} as const;

/** Pieces of {@link CONTACT} that occur in nothing else either. */
const CONTACT_FRAGMENTS = ['Kontakpribadi', 'pemasok-rahasia', '5550 7788', 'Kontak Rahasia'] as const;

/** A small PDF (magic `%PDF-`): the record's public attachment. */
const PDF = new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1'));

/** The Phase 2 routes: the catalog API, the OPAC catalog routes and OAI, and the two Phase 2 routes of settings.ts. */
const PHASE2_ROUTES: readonly RouteDecl[] = (() => {
  const ids = new Set([...CATALOG_ROUTES, ...OPAC_CATALOG_ROUTES].map((d) => d.id));
  ids.add('settings.catalog.put');
  ids.add('catalog.config');
  return ALL_ROUTES.filter((d) => ids.has(d.id));
})();

/** §1.3: the four routes an edition never locks although they start work or hand out data. */
const SYSTEM_ROUTES = ['catalog.exports.create', 'catalog.runs.download', 'catalog.runs.report', 'catalog.search.reindex'];
/** §1.3: the POST routes that only read (a check, a preview, a PDF), and the harvester's POST /oai. */
const READ_POSTS = ['catalog.records.duplicates', 'catalog.labels.create', 'catalog.sru.test', 'opac.pages.preview', 'catalog.migrations.slims.test', 'oai.post'];

/** A browser of the admin SPA: the session cookie, the CSRF token the app last gave it, the baseUrl's Origin. */
interface Browser {
  send(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown, headers?: Record<string, string>): Promise<AgentReply>;
  /** Uploads `data` into upload context `context` (declare, chunks, complete): `{uploadId}` or `{fileId}`. */
  upload(context: string, data: Uint8Array, name: string): Promise<{ uploadId?: string; fileId?: string }>;
}

describe('K2: the route modes of the Phase 2 routes are §1.3’s', () => {
  it('OPAC, OAI and feeds are read, the four system routes are system, the read-only POSTs are read, every other write is write', () => {
    expect(PHASE2_ROUTES.length).toBeGreaterThan(100);
    const byMode = (mode: string): string[] =>
      PHASE2_ROUTES.filter((d) => routeMode(d) === mode)
        .map((d) => d.id)
        .sort();
    expect(byMode('system')).toEqual([...SYSTEM_ROUTES].sort());
    for (const d of PHASE2_ROUTES) {
      const expected = SYSTEM_ROUTES.includes(d.id) ? 'system' : d.method === 'GET' || READ_POSTS.includes(d.id) ? 'read' : 'write';
      expect([d.id, routeMode(d)]).toEqual([d.id, expected]);
    }
    // Every OPAC route and OAI is public and read (an edition never locks data, §1.3).
    for (const d of PHASE2_ROUTES.filter((r) => !r.path.startsWith('/api/'))) expect([d.id, routeMode(d), d.public]).toEqual([d.id, 'read', true]);
  });
});

describe.skipIf(!ctx.available)(`Phase 2 integration: merge reindex, supplier privacy [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  /** The installation's config (config.json). */
  let config: Config;
  let state: AppState;
  let app: ReturnType<typeof createApp>;
  let superAdmin: PersonaUser;
  let admin: Browser;
  let peerSerial = 0;
  const host = (): string => new URL(config.baseUrl).hostname;
  const nextPeer = (): string => {
    peerSerial += 1;
    return `198.18.${(peerSerial >> 8) & 255}.${peerSerial & 255}`;
  };
  const seed = (): SeedContext => ({ h, now: NOW, keyring: config.keyring, dataDir });

  /** What the API made: ids of the catalog every test reads. */
  const made = { buku: '', umum: '', branchId: '', supplierId: '', recordId: '', itemId: '', attachmentId: '', fileId: '', title: '', pageSlug: '', newsTitle: '' };

  // ---- clients -----------------------------------------------------------------------------------------------------

  async function browserOf(user: PersonaUser): Promise<Browser> {
    const token = await personaSession(h, user, { now: NOW });
    const origin = new URL(config.baseUrl).origin;
    const peer = nextPeer();
    const agent = createAgent(app, { peer, headers: { origin } });
    agent.setCookie(cookieName('altis_sid', isSecureBase(config.baseUrl)), token);
    let csrf = sessionCsrfFor(config, token);
    const send: Browser['send'] = async (method, url, body, headers = {}) => {
      const res = await agent[method](url, body, { 'x-csrf-token': csrf, ...headers });
      csrf = res.headers.get('x-csrf-token') ?? csrf;
      return res;
    };
    const upload: Browser['upload'] = async (context, data, name) => {
      const sha256 = createHash('sha256').update(data).digest('hex');
      const declared = await send('post', `${API}/files/uploads`, { context, size: data.byteLength, sha256, chunkBytes: 256 * 1024 });
      expect(declared.status, declared.text).toBe(201);
      const s = declared.json as { id: string; chunkSize: number };
      const cookie = [...agent.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      for (let n = 0; n * s.chunkSize < data.byteLength; n += 1) {
        const form = new FormData();
        form.append('chunk', new Blob([data.subarray(n * s.chunkSize, (n + 1) * s.chunkSize)]), 'blob');
        const res = await app.request(`${API}/files/uploads/${s.id}/chunks/${n}`, { method: 'POST', headers: { origin, cookie, 'x-csrf-token': csrf }, body: form }, { incoming: { socket: { remoteAddress: peer } } });
        csrf = res.headers.get('x-csrf-token') ?? csrf;
        expect(res.status, await res.text()).toBe(200);
      }
      const done = await send('post', `${API}/files/uploads/${s.id}/complete`, { originalName: name });
      expect(done.status, done.text).toBe(200);
      return done.json as { uploadId?: string; fileId?: string };
    };
    return { send, upload };
  }

  /** A visitor or harvester: no cookie, a peer address of its own (the OPAC rate limits are per IP). */
  async function visit(url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<AgentReply> {
    const res = await app.request(url, { method: o.method ?? 'GET', headers: { ...HTML, ...o.headers }, ...(o.body === undefined ? {} : { body: o.body }) }, { incoming: { socket: { remoteAddress: nextPeer() } } });
    const text = await res.text();
    let json: unknown;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** The JSON of a reply after checking its status. */
  function ok<T>(res: AgentReply, status = 200): T {
    expect(res.status, res.text).toBe(status);
    return res.json as T;
  }

  // ---- jobs ----------------------------------------------------------------------------------------------------------

  const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: config.baseUrl, keyring: config.keyring, storage: localStorageDriver(dataDir), log: silent });
  const registry = createJobRegistry(catalogJobHandlers(deps));

  /** Claims and runs job `id` until it ends, as any process would. */
  async function runToEnd(id: string): Promise<string> {
    for (let i = 0; i < 200; i += 1) {
      const job = await claimById(h, registry, id, { worker: 'integration', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(h, registry, job, { mode: 'worker', budgetMs: 20_000, keyring: config.keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return r.outcome;
    }
    throw new Error(`job ${id} did not end`);
  }

  /** Starts an export of every record in `format` (with items), runs it, downloads the file. */
  async function exported(format: string): Promise<AgentReply> {
    const started = ok<{ runId: string; jobId: string }>(await admin.send('post', `${API}/catalog/exports`, { format, filter: { includeItems: true, includeArchived: true } }), 202);
    expect(await runToEnd(started.jobId)).toBe('succeeded');
    const file = await admin.send('get', `${API}/catalog/runs/${started.runId}/download`);
    expect(file.status, file.text).toBe(200);
    return file;
  }

  /** The seeded supplier as the staff API lists it (masters have no single GET). */
  async function supplierView(): Promise<SupplierView> {
    const list = ok<MasterListResponse<SupplierView>>(await admin.send('get', `${API}/catalog/suppliers`));
    const found = list.items.find((s) => s.id === made.supplierId);
    if (found === undefined) throw new Error('the supplier is not listed');
    return found;
  }

  /** The records found by `q` in the admin search (relevance). */
  async function adminSearch(q: string): Promise<string[]> {
    const res = ok<RecordListResponse>(await admin.send('get', `${API}/catalog/records?q=${encodeURIComponent(q)}`));
    return res.items.map((r) => r.id);
  }

  // ---- the installation ----------------------------------------------------------------------------------------------

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-phase2-integration-')));
    dataDir = path.join(root, 'data');
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    config = sampleConfig({ db: h.config });
    await writeConfig(dataDir, config);
    await withTx(h, (trx) =>
      writeSettings(trx, { 'opac.oai.enabled': true, 'opac.oai.adminEmail': 'pustakawan@perpus.sekolah.sch.id' }, { keyring: config.keyring, now: NOW, actorId: null }).then(() => undefined),
    );
    state = { phase: 'ready', db: h, config };
    app = createApp({
      state,
      version: '0.1.0',
      buildId: 'phase2-integration',
      log: recordingLogger(),
      clock: () => NOW,
      env: {},
      dataDir,
      services: { mailer: silentMailer, emailTestMailer: silentMailer, settings: createSettingsCache({ ttlMs: 0 }) },
    });
    const user = await seedPersona(seed(), 'super_admin');
    if (user === null) throw new Error('no super admin');
    superAdmin = user;
    admin = await browserOf(superAdmin);

    // The catalog, through the API.
    made.buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    made.umum = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    made.branchId = newId(NOW - 30 * DAY);
    await h.db
      .insertInto('branches')
      .values({ id: made.branchId, code_key: 'PUSAT', code_display: 'PUSAT', name: 'Perpustakaan Pusat', timezone: 'Asia/Jakarta', created_at: NOW - 30 * DAY, updated_at: NOW - 30 * DAY })
      .execute();
    made.supplierId = ok<{ id: string }>(
      await admin.send('post', `${API}/catalog/suppliers`, { code: 'PEMASOK1', name: 'Toko Buku Nusantara', ...CONTACT, note: 'Langganan tahunan' }),
      201,
    ).id;
    made.title = 'Hikayat Pelabuhan Sundakelapa';
    made.recordId = ok<{ id: string }>(
      await admin.send('post', `${API}/catalog/records`, {
        materialTypeId: made.buku,
        title: made.title,
        subtitle: 'Catatan dagang abad ketujuh belas',
        publicationYear: '2019',
        publisher: { name: 'Penerbit Pesisir', place: 'Jakarta' },
        agents: [{ ref: { type: 'person', name: 'Wiranatakusuma, Hendra' }, role: 'aut', isMain: true }],
        subjects: [{ ref: { type: 'topic', term: 'Sejarah maritim' }, isPrimary: true }],
        identifiers: [{ type: 'isbn', value: '978-602-03-0112-9' }],
        summary: 'Kisah pelabuhan dan para pedagangnya.',
      }),
      201,
    ).id;
    made.itemId = ok<{ id: string }>(
      await admin.send('post', `${API}/branches/${made.branchId}/items`, {
        recordId: made.recordId,
        barcode: 'INT-0001',
        collectionTypeId: made.umum,
        supplierId: made.supplierId,
        price: '125000',
        invoiceNo: 'FAK/2026/17',
        orderNo: 'PO/2026/04',
        acqSource: 'purchase',
      }),
      201,
    ).id;
    const uploaded = await admin.upload('catalog.attachment', PDF, 'pelabuhan.pdf');
    if (uploaded.fileId === undefined) throw new Error('the attachment upload gave no file');
    made.fileId = uploaded.fileId;
    made.attachmentId = ok<{ id: string }>(
      await admin.send('post', `${API}/catalog/records/${made.recordId}/attachments`, { kind: 'file', fileId: made.fileId, title: 'Bab pembuka', access: 'public' }),
      201,
    ).id;
    made.pageSlug = 'tata-tertib-perpustakaan';
    ok(
      await admin.send('post', `${API}/opac/pages`, {
        kind: 'page',
        slug: made.pageSlug,
        status: 'published',
        showInNav: true,
        sortOrder: 1,
        translations: { id: { title: 'Tata tertib perpustakaan', bodyFormat: 'markdown', body: 'Harap tenang di ruang baca.' } },
      }),
      201,
    );
    made.newsTitle = 'Layanan malam dibuka';
    ok(
      await admin.send('post', `${API}/opac/pages`, {
        kind: 'news',
        slug: 'layanan-malam-dibuka',
        status: 'published',
        showInNav: false,
        sortOrder: 0,
        translations: { id: { title: made.newsTitle, bodyFormat: 'markdown', body: 'Ruang baca buka sampai pukul 21.00.' } },
      }),
      201,
    );
  }, 180_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // ---- S12 ------------------------------------------------------------------------------------------------------------

  it('S12: after merging agent A into B and running the queued reindex, the record moved from A is found by B’s name', async () => {
    const a = ok<{ id: string; version: number }>(await admin.send('post', `${API}/catalog/agents`, { type: 'person', name: 'Kartasasmita, Sumarsono' }), 201);
    const b = ok<{ id: string; version: number }>(await admin.send('post', `${API}/catalog/agents`, { type: 'person', name: 'Ratnaningrum, Sekarwangi' }), 201);
    const moved = ok<{ id: string }>(
      await admin.send('post', `${API}/catalog/records`, {
        materialTypeId: made.buku,
        title: 'Peta Jalur Rempah Nusantara',
        agents: [{ ref: { id: a.id }, role: 'aut', isMain: true }],
      }),
      201,
    ).id;
    // Saved and indexed in its own transaction (§4.1): found by A's name, not by B's.
    expect(await adminSearch('Kartasasmita')).toContain(moved);
    expect(await adminSearch('Ratnaningrum')).not.toContain(moved);

    const merged = await admin.send('post', `${API}/catalog/agents/${a.id}/merge`, { intoId: b.id, version: a.version });
    expect(merged.status, merged.text).toBe(200);
    const job = await h.db.selectFrom('jobs').select(['id', 'status']).where('unique_key', '=', `catalog.reindex:agent:${b.id}`).executeTakeFirstOrThrow();
    expect(job.status).toBe('queued');
    // The merge moved the link; the index follows when the queued job runs (S12).
    expect(await runToEnd(job.id)).toBe('succeeded');

    expect(await adminSearch('Ratnaningrum')).toContain(moved);
    expect(await adminSearch('Kartasasmita')).not.toContain(moved);
    const opac = await visit('/cari?q=Ratnaningrum');
    expect(opac.status).toBe(200);
    expect(opac.text).toContain('Peta Jalur Rempah Nusantara');
    expect((await visit('/cari?q=Kartasasmita')).text).not.toContain('Peta Jalur Rempah Nusantara');
  });

  // ---- §2.2 (*): supplier contact fields ------------------------------------------------------------------------------

  it('the supplier’s contact fields never appear in an OPAC page or download, an OAI-PMH answer or an export file', async () => {
    // They are stored, and the staff API shows them to a masters manager.
    expect(await supplierView()).toMatchObject(CONTACT);

    const canonical = recordUrlPath(made.recordId, made.title);
    const oaiId = encodeURIComponent(`oai:${host()}:${made.recordId}`);
    const outputs: [string, string][] = [];
    for (const url of [
      '/',
      '/cari?q=Sundakelapa',
      '/cari?q=Nusantara',
      '/cari/rss?q=Sundakelapa',
      '/rss',
      canonical,
      `${canonical}?lang=en`,
      `/katalog/${made.recordId}/ris`,
      `/katalog/${made.recordId}/bibtex`,
      `/katalog/${made.recordId}/marcxml`,
      `/katalog/${made.recordId}/lampiran/${made.attachmentId}`,
      '/sitemap/katalog/1',
      `/oai?verb=GetRecord&metadataPrefix=oai_dc&identifier=${oaiId}`,
      `/oai?verb=GetRecord&metadataPrefix=marc21&identifier=${oaiId}`,
      '/oai?verb=ListRecords&metadataPrefix=oai_dc',
      '/oai?verb=ListRecords&metadataPrefix=marc21',
    ]) {
      const res = await visit(url);
      expect([url, res.status]).toEqual([url, 200]);
      outputs.push([url, res.text]);
    }
    const itemsCsv = await exported('csv-items');
    // The item's supplier is exported, by its code: the join is there, the contact fields are not.
    expect(itemsCsv.text).toContain('PEMASOK1');
    outputs.push(['export csv-items', itemsCsv.text]);
    for (const format of ['marc21', 'marcxml', 'marcjson', 'csv-records']) outputs.push([`export ${format}`, (await exported(format)).text]);
    const mrc = await admin.send('get', `${API}/catalog/records/${made.recordId}/marc?format=mrc`);
    expect(mrc.status).toBe(200);
    outputs.push(['records/:id/marc', mrc.text]);

    // Whole values, and fragments of each that an escaping or a line break could not hide.
    const needles = [...Object.values(CONTACT), ...CONTACT_FRAGMENTS];
    // The grep finds them where they are shown: the staff list of suppliers.
    const staffList = (await admin.send('get', `${API}/catalog/suppliers`)).text;
    expect(needles.filter((v) => !staffList.includes(v))).toEqual([]);
    const leaks =outputs.flatMap(([what, text]) => needles.filter((v) => text.includes(v)).map((v) => `${what}: ${v}`));
    expect(leaks).toEqual([]);
    // The OPAC record page did render the item (its barcode), so the check above looked at a page that shows items.
    expect(outputs.find(([what]) => what === canonical)?.[1]).toContain('INT-0001');
  });

  it('the audit chain still verifies after all of the above', async () => {
    const rows = await h.db.selectFrom('audit_log').select('seq').execute();
    expect(await verifyAuditChain(h)).toEqual({ ok: true, head: rows.length });
  });
});
