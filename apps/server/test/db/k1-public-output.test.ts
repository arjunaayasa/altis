import fsp from 'node:fs/promises';
import path from 'node:path';
import { recordUrlPath, writeSettings } from '@altis/core';
import { PERSONAL_COLUMNS, withTx } from '@altis/db';
import { reportExportPath } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { createLogger } from '../../src/logger.js';
import type { AgentReply } from '../agent.js';
import { openK1Installation, type K1Browser, type K1Installation } from './k1-support.js';

// No personal value of the reports and the accreditation workspace reaches a public output, on the engine picked by
// ALTIS_TEST_DB. Every column registered as personal is filled with a value found nowhere else: the library staff's
// names and appointment decree numbers, a staff user's name and e-mail, a supplier's contact fields, an answer's note,
// the profile's school head, library head, the head's staff number, phone and e-mail, and the officer's name a migrated
// stocktake session keeps for a copy. A full flow then runs through the API as the admin SPA drives it (a supplier and
// a record with a copy bought from it, a period with that profile, the staff register with a training, an answer with
// its note, the evaluation, the evidence file, the simulation and the staff annex, the stocktake officers report and
// minutes of the migrated session, the freeze). Then the OPAC home, a search and its feed, the news feed, the record
// page and its citation downloads, the sitemap and OAI-PMH, the payloads of every event the flow published (what the
// event stream serves) and the server's own JSON log contain none of those values, while the staff API still shows
// them.

const ctx = testDbContext();
const API = '/api/v1';
const HTML = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

/** One value per personal column (and JSON path) of the community tables, each found nowhere else. */
const PERSONAL = {
  staffName: 'Wulandari Penandapribadi',
  appointmentRef: 'SK/PRIBADI/7731/2025',
  userName: 'Bambang Namapetugas',
  userEmail: 'bambang.surelpetugas@contoh-pribadi.example',
  contactName: 'Sutini Kontakpemasok',
  contactPhone: '+62 21 5550 9911 23',
  contactEmail: 'sutini@pemasok-pribadi.example',
  contactAddress: 'Jalan Pemasok Rahasia No. 9',
  answerNote: 'Catatan-jawaban-pribadi-5521',
  schoolHead: 'Drs. Hartono Kepalasekolah',
  libraryHead: 'Sri Kepalaperpus',
  libraryHeadId: '197501012000032009',
  phone: '+62 22 7777 6543',
  email: 'kepala.perpus@sekolah-pribadi.example',
  officerName: 'Suharti Petugaslama',
} as const;

/** Pieces of those values that no escaping, encoding or line break could hide. */
const FRAGMENTS = ['Penandapribadi', 'PRIBADI/7731', 'Namapetugas', 'surelpetugas', 'Kontakpemasok', '5550 9911', 'pemasok-pribadi', 'Pemasok Rahasia', 'jawaban-pribadi', 'Kepalasekolah', 'Kepalaperpus', '197501012000032009', '7777 6543', 'sekolah-pribadi', 'Petugaslama'] as const;

const NEEDLES: readonly string[] = [...Object.values(PERSONAL), ...FRAGMENTS];

describe.skipIf(!ctx.available)(`no personal value of the workspace in a public output [${engineLabel()}]`, () => {
  let k: K1Installation;
  let admin: K1Browser;
  const made = { branchId: '', supplierId: '', recordId: '', itemId: '', title: 'Riwayat Pelabuhan Cirebon', periodId: '', staffId: '', stocktakeId: '' };
  let peer = 0;

  /** A visitor or a harvester: no cookie, an address of its own. */
  async function visit(url: string): Promise<AgentReply> {
    peer += 1;
    const res = await k.app.request(url, { method: 'GET', headers: HTML }, { incoming: { socket: { remoteAddress: `198.18.7.${peer % 250}` } } });
    const text = await res.text();
    return { status: res.status, json: undefined, text, headers: res.headers };
  }

  function ok<T>(res: AgentReply, status = 200): T {
    expect(res.status, res.text).toBe(status);
    return res.json as T;
  }

  const tick = (): void => {
    k.clock.now += 1_000;
  };

  beforeAll(async () => {
    k = await openK1Installation({ prefix: 'k1-public-output', baseUrl: 'https://perpus.sma-pribadi.sch.id', log: (dataDir) => createLogger({ dataDir, level: 'debug' }) });
    await withTx(k.h, (trx) =>
      writeSettings(trx, { 'library.name': 'Perpustakaan SMA Terbuka', 'library.type': 'sekolah', 'opac.oai.enabled': true, 'opac.oai.adminEmail': 'oai@perpus.sma-terbuka.sch.id' }, { keyring: k.config.keyring, now: k.clock.now, actorId: null }),
    );
    const adminId = await k.staff('kepala_perpustakaan', 'super_admin');
    // The staff user's own name and e-mail (personal columns of staff_users).
    await k.h.db.updateTable('staff_users').set({ name: PERSONAL.userName, email_key: PERSONAL.userEmail, email_display: PERSONAL.userEmail }).where('id', '=', adminId).execute();
    admin = await k.browser(adminId);

    // The catalogue: a supplier with its contact fields, a record and a copy bought from it.
    made.branchId = newId(k.clock.now);
    await k.h.db
      .insertInto('branches')
      .values({ id: made.branchId, code_key: 'PUSAT', code_display: 'PUSAT', name: 'Perpustakaan Pusat', timezone: 'Asia/Jakarta', is_default: 1, created_at: k.clock.now, updated_at: k.clock.now })
      .execute();
    const buku = (await k.h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    const umum = (await k.h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    made.supplierId = ok<{ id: string }>(
      await admin.send('post', `${API}/catalog/suppliers`, {
        code: 'PEMASOK9',
        name: 'Toko Buku Pesisir',
        contactName: PERSONAL.contactName,
        phone: PERSONAL.contactPhone,
        email: PERSONAL.contactEmail,
        address: PERSONAL.contactAddress,
      }),
      201,
    ).id;
    made.recordId = ok<{ id: string }>(
      await admin.send('post', `${API}/catalog/records`, {
        materialTypeId: buku,
        title: made.title,
        publicationYear: '2021',
        agents: [{ ref: { type: 'person', name: 'Sastradiredja, Umar' }, role: 'aut', isMain: true }],
        subjects: [{ ref: { type: 'topic', term: 'Sejarah maritim' }, isPrimary: true }],
        classification: '959.8',
      }),
      201,
    ).id;
    made.itemId = ok<{ id: string }>(
      await admin.send('post', `${API}/branches/${made.branchId}/items`, { recordId: made.recordId, barcode: 'PUB-0001', collectionTypeId: umum, supplierId: made.supplierId, price: '98000', acqSource: 'purchase' }),
      201,
    ).id;
    ok(
      await admin.send('post', `${API}/opac/pages`, {
        kind: 'news',
        slug: 'pojok-baca-dibuka',
        status: 'published',
        showInNav: false,
        sortOrder: 0,
        translations: { id: { title: 'Pojok baca dibuka', bodyFormat: 'markdown', body: 'Pojok baca kini buka setiap hari.' } },
      }),
      201,
    );

    // A stocktake session migrated from SLiMS: its copy found by an officer known by name only (no staff user). No API
    // writes that name, so the rows are written straight into the tables, as the staff user's name above.
    made.stocktakeId = newId(k.clock.now);
    await k.h.db
      .insertInto('stocktakes')
      .values({ id: made.stocktakeId, branch_id: made.branchId, name: 'Stock opname 2024', scope: '{}', status: 'finished', total: 1, found: 1, started_at: k.clock.now, finished_at: k.clock.now, source: 'migrated', created_at: k.clock.now, updated_at: k.clock.now })
      .execute();
    await k.h.db
      .insertInto('stocktake_items')
      .values({ stocktake_id: made.stocktakeId, item_id: made.itemId, expected: 1, state: 'found', expected_status: 'available', scanned_at: k.clock.now, scanned_by: null, scanned_by_name: PERSONAL.officerName, result: 'none' })
      .execute();

    // The accreditation workspace: a period with the profile, the staff register, an answer with its note.
    tick();
    made.periodId = ok<{ id: string }>(
      await admin.send('post', `${API}/accreditation/periods`, {
        name: 'Tahun pelajaran 2025/2026',
        instrumentId: 'sch-sma-2025',
        kind: 'school_year',
        startYear: 2025,
        profile: {
          schoolName: 'SMA Terbuka',
          schoolLevel: 'sma_smk_ma',
          npp: '3201010D1000099',
          schoolHead: PERSONAL.schoolHead,
          libraryHead: PERSONAL.libraryHead,
          libraryHeadId: PERSONAL.libraryHeadId,
          phone: PERSONAL.phone,
          email: PERSONAL.email,
        },
      }),
      201,
    ).id;
    made.staffId = ok<{ id: string }>(
      await admin.send('post', `${API}/accreditation/staff`, {
        name: PERSONAL.staffName,
        role: 'head',
        isLibrarian: true,
        educationLevel: 's1',
        educationLibrary: true,
        libraryTraining: true,
        competencyCert: false,
        associationMember: false,
        appointmentRef: PERSONAL.appointmentRef,
        startsOn: '2021-07-01',
      }),
      201,
    ).id;
    ok(await admin.send('post', `${API}/accreditation/staff/${made.staffId}/trainings`, { title: 'Pelatihan pengolahan bahan pustaka', heldOn: '2025-09-10', hours: 16 }), 201);
    tick();
    ok(await admin.send('put', `${API}/accreditation/periods/${made.periodId}/answers/SCH-SP1`, { answer: 'b', mode: 'manual', note: PERSONAL.answerNote }));

    // The evaluation, the documents with the staff's names, the staff annex, the freeze.
    tick();
    const evaluation = ok<{ jobId: string }>(await admin.send('post', `${API}/accreditation/periods/${made.periodId}/evaluate`, {}), 202);
    expect(await k.drive(evaluation.jobId)).toBe('succeeded');
    tick();
    for (const [url, body] of [
      [`${API}/accreditation/periods/${made.periodId}/dossier`, { format: 'pdf' }],
      [`${API}/accreditation/periods/${made.periodId}/dossier`, { format: 'zip' }],
      [`${API}/accreditation/periods/${made.periodId}/self-assessment`, {}],
      [`${API}/reports/runs/personal`, { reportId: 'accreditation.annex.staff', format: 'pdf', params: { periodId: made.periodId } }],
      [`${API}/reports/runs/personal`, { reportId: 'stocktake.by_officer', format: 'pdf', params: { stocktakeId: made.stocktakeId } }],
      [`${API}/reports/runs`, { reportId: 'collection.item_list', format: 'csv', params: {} }],
    ] as const) {
      const run = ok<{ id: string; jobId: string }>(await admin.send('post', url, body));
      expect(await k.drive(run.jobId)).toBe('succeeded');
      expect((await admin.bytes(`${API}/reports/runs/${run.id}/download`)).status).toBe(200);
    }
    expect((await admin.bytes(`${API}/branches/${made.branchId}/stocktakes/${made.stocktakeId}/minutes`)).status).toBe(200);
    // The evidence file PDF goes missing before the freeze, so the freeze logs that it cannot keep a copy of it: the
    // flow writes at least one line of its own to the log.
    const dossier = await k.h.db.selectFrom('report_runs').select('id').where('report_id', '=', 'accreditation.dossier').where('format', '=', 'pdf').executeTakeFirstOrThrow();
    await fsp.rm(reportExportPath(k.dataDir, dossier.id, 'pdf'));
    tick();
    ok(await admin.send('post', `${API}/accreditation/periods/${made.periodId}/freeze`, {}), 201);
  }, 300_000);

  afterAll(async () => {
    await k?.close();
  });

  it('every personal column of the community tables is filled with its value by the flow (the staff API shows them)', async () => {
    // The members, loans, visits, clearance and charge columns are filled by the members, visits and circulation flows,
    // which check their own public output.
    const theirs = ['members', 'loans', 'visits', 'member_clearances', 'charges', 'charge_adjustments', 'payments'];
    const tables = Object.keys(PERSONAL_COLUMNS).filter((t) => !theirs.includes(t));
    expect(tables.sort()).toEqual(['accred_answers', 'accred_periods', 'library_staff', 'staff_users', 'stocktake_items', 'suppliers']);
    expect(await k.h.db.selectFrom('stocktake_items').select('scanned_by_name').execute()).toEqual([{ scanned_by_name: PERSONAL.officerName }]);
    expect(await k.h.db.selectFrom('library_staff').select(['name', 'appointment_ref']).execute()).toEqual([{ name: PERSONAL.staffName, appointment_ref: PERSONAL.appointmentRef }]);
    expect((await k.h.db.selectFrom('accred_answers').select('note').where('note', 'is not', null).execute()).map((r) => r.note)).toEqual([PERSONAL.answerNote]);
    const profile = JSON.parse((await k.h.db.selectFrom('accred_periods').select('profile').where('id', '=', made.periodId).executeTakeFirstOrThrow()).profile) as Record<string, unknown>;
    for (const p of PERSONAL_COLUMNS.accred_periods![0]!.jsonPaths!) expect([p, profile[p]]).toEqual([p, PERSONAL[p as keyof typeof PERSONAL]]);
    // The staff API shows them to the staff who may read them.
    const staffList = (await admin.send('get', `${API}/accreditation/staff`)).text;
    for (const v of [PERSONAL.staffName, PERSONAL.appointmentRef]) expect(staffList).toContain(v);
    const suppliers = (await admin.send('get', `${API}/catalog/suppliers`)).text;
    for (const v of [PERSONAL.contactName, PERSONAL.contactPhone, PERSONAL.contactEmail, PERSONAL.contactAddress]) expect(suppliers).toContain(v);
    expect((await admin.send('get', `${API}/branches/${made.branchId}/stocktakes/${made.stocktakeId}/items`)).text).toContain(PERSONAL.officerName);
    expect((await admin.send('get', `${API}/branches/${made.branchId}/stocktakes/${made.stocktakeId}/officers`)).text).toContain(PERSONAL.officerName);
  });

  it('the OPAC, its feeds, the sitemap and OAI-PMH hold none of them', async () => {
    const canonical = recordUrlPath(made.recordId, made.title);
    const host = new URL(k.config.baseUrl).hostname;
    const oaiId = encodeURIComponent(`oai:${host}:${made.recordId}`);
    const outputs: [string, string][] = [];
    for (const url of [
      '/',
      '/cari?q=Cirebon',
      '/cari?q=Pelabuhan',
      '/cari/rss?q=Cirebon',
      '/rss',
      canonical,
      `${canonical}?lang=en`,
      `/katalog/${made.recordId}/ris`,
      `/katalog/${made.recordId}/bibtex`,
      `/katalog/${made.recordId}/marcxml`,
      '/sitemap/katalog/1',
      '/oai?verb=Identify',
      `/oai?verb=GetRecord&metadataPrefix=oai_dc&identifier=${oaiId}`,
      `/oai?verb=GetRecord&metadataPrefix=marc21&identifier=${oaiId}`,
      '/oai?verb=ListRecords&metadataPrefix=oai_dc',
      '/oai?verb=ListRecords&metadataPrefix=marc21',
    ]) {
      const res = await visit(url);
      expect([url, res.status]).toEqual([url, 200]);
      outputs.push([url, res.text]);
    }
    // The record page shows the copy (its barcode), so the check looked at a page that lists copies.
    expect(outputs.find(([url]) => url === canonical)?.[1]).toContain('PUB-0001');
    const leaks = outputs.flatMap(([url, text]) => NEEDLES.filter((v) => text.includes(v)).map((v) => `${url}: ${v}`));
    expect(leaks).toEqual([]);
  });

  it('the payloads of every event the flow published hold none of them', async () => {
    const events = await k.h.db.selectFrom('events').select(['channel', 'type', 'payload']).execute();
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['accreditation.results.changed', 'catalog.record.changed', 'catalog.item.changed']));
    const leaks = events.flatMap((e) => NEEDLES.filter((v) => `${e.channel} ${e.type} ${e.payload}`.includes(v)).map((v) => `${e.type}: ${v}`));
    expect(leaks).toEqual([]);
  });

  it('the server’s JSON log of the whole flow holds none of them', async () => {
    const text = await fsp.readFile(path.join(k.dataDir, 'logs', 'altis.log'), 'utf8').catch(() => '');
    const lines = text.split('\n').filter((l) => l !== '');
    const parsed = lines.map((line) => JSON.parse(line) as { msg: string });
    expect(parsed.map((l) => l.msg)).toContain('accreditation snapshot: the evidence file of the run is gone');
    const leaks = lines.flatMap((line) => NEEDLES.filter((v) => line.includes(v)).map((v) => `${v}: ${line.slice(0, 200)}`));
    expect(leaks).toEqual([]);
  });
});
