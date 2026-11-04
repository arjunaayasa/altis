import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  archiveRecord,
  createRecord,
  createSettingsCache,
  createXmlReader,
  mergeRecord,
  txCtx,
  writeSettings,
  type Actor,
  type KeyringEntry,
  type TxCtx,
} from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { newId, normalizeKey } from '@altis/shared';
import type { RecordCreateBody } from '@altis/shared/api/catalog/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { isCookielessRead } from '../../src/http/route.js';
import { opacText } from '../../src/opac/catalog/messages.js';
import { OAI_FORM_MAX_BYTES, OAI_ROUTES } from '../../src/opac/catalog/oai-routes.js';
import { OAI_PAGE_BYTES } from '../../src/opac/catalog/oai/records.js';
import { OAI_TOKEN_TTL_MS, oaiTokenKeys, verifyToken } from '../../src/opac/catalog/oai/token.js';
import { handleOai } from '../../src/opac/catalog/oai/verbs.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';

// OAI-PMH 2.0 (Phase 2 Task 35; spec §10, D2-24, D2-34, K11, S5, M15, Review Focus 4) on the engine picked by
// ALTIS_TEST_DB, through handleOai (most cases: a fake clock and keyring at hand) and through the app (`GET` and
// `POST /oai`, the 503 while OAI is off, the form body's limits):
// - every verb answers a document our own XML reader parses, rooted in the OAI-PMH namespace;
// - every protocol error code is triggered, with the `request` element's attributes left out for badVerb/badArgument;
// - `marc21` records are MARCXML (namespace, leader, control and data fields) of the public audience, without
//   acquisition, local or holdings data (S5) and without items; `oai_dc` is the renderer's element;
// - deleted (archived, hidden, merged) records are headers with `status="deleted"`, A→B→C included (Review Focus 4);
// - a ListRecords harvest of 2 500 records, edited between pages, yields every id exactly once (keyset by id);
// - resumption tokens: completeListSize from the first page, a changed character or an expired token (+25 h) is
//   badResumptionToken, a token signed before a keyring rotation keeps working (M15);
// - from/until at day and second granularity, the sets `material` and `material:<code>`.

const ctx = testDbContext();

const OAI_NS = 'http://www.openarchives.org/OAI/2.0/';
const OAI_XSD = 'http://www.openarchives.org/OAI/2.0/OAI-PMH.xsd';
const MARC_NS = 'http://www.loc.gov/MARC21/slim';
const OAI_DC_NS = 'http://www.openarchives.org/OAI/2.0/oai_dc/';

/** In the past (an audit entry may not be dated ahead of the real clock), at a whole second. */
const NOW = Date.UTC(2026, 9, 30, 9, 15, 5);
const SECOND = 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CONFIG = sampleConfig();
const BASE = CONFIG.baseUrl;
const HOST = new URL(BASE).hostname;
const ADMIN = 'pustakawan@perpus.sekolah.sch.id';
const LIBRARY = 'Perpustakaan SMA Negeri 1 <Bandung> & "Sekitarnya"';
const KEYS = oaiTokenKeys(CONFIG.keyring);
const ACTOR: Actor = { type: 'staff', id: newId(NOW - 30 * DAY), ip: null };

/** `ms` as an OAI datestamp (whole seconds, UTC). */
const stamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const oaiId = (recordId: string): string => `oai:${HOST}:${recordId}`;

/** A parsed element: its name, attributes, child elements and joined text. */
interface XNode {
  name: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
}

/** `xml` as a tree, read by Task 5's reader (which refuses anything that is not well-formed). */
function tree(xml: string): XNode {
  const reader = createXmlReader();
  const root: XNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  for (const e of [...reader.write(xml), ...reader.end()]) {
    const top = stack.at(-1)!;
    if (e.type === 'open') {
      const node: XNode = { name: e.name, attrs: { ...e.attrs }, children: [], text: '' };
      top.children.push(node);
      stack.push(node);
    } else if (e.type === 'close') stack.pop();
    else top.text += e.text;
  }
  expect(root.children).toHaveLength(1);
  return root.children[0]!;
}

const kids = (n: XNode, name: string): XNode[] => n.children.filter((c) => c.name === name);
const kid = (n: XNode, name: string): XNode => {
  const found = kids(n, name);
  expect(found.map((c) => c.name), `one <${name}> in <${n.name}>`).toEqual([name]);
  return found[0]!;
};

/**
 * The OAI-PMH envelope of `xml`, checked: the XML declaration, the root in the OAI-PMH namespace with its schema
 * location, `responseDate` (a datestamp) and `request` (the base URL) first.
 */
function envelope(xml: string): XNode {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  const root = tree(xml);
  expect(root.name).toBe('OAI-PMH');
  expect(root.attrs['xmlns']).toBe(OAI_NS);
  expect(root.attrs['xsi:schemaLocation']).toBe(`${OAI_NS} ${OAI_XSD}`);
  expect(root.children[0]?.name).toBe('responseDate');
  expect(root.children[0]?.text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(root.children[1]?.name).toBe('request');
  expect(root.children[1]?.text).toBe(`${BASE}/oai`);
  expect(root.children).toHaveLength(3);
  return root;
}

const errorCodes = (root: XNode): string[] => kids(root, 'error').map((e) => e.attrs['code'] ?? '');

/** A query string as the parameters handleOai takes (each name with all its values, in order). */
function params(query: string): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>;
  for (const [k, v] of new URLSearchParams(query)) (out[k] ??= []).push(v);
  return out;
}

/** The record id of an OAI header (`oai:<host>:<id>`). */
const headerId = (header: XNode): string => kid(header, 'identifier').text.replace(`oai:${HOST}:`, '');

/**
 * A check of a MARCXML record against the MARC21slim element structure: `record` in the MARC namespace, then
 * `leader` (24 characters), the control fields (tag 00X, text only), then the data fields (tag, one-character
 * indicators, at least one `subfield` with a one-character code). Returns the record's fields as `tag → node[]`.
 */
function marcStructure(record: XNode): Map<string, XNode[]> {
  expect(record.name).toBe('record');
  expect(record.attrs['xmlns']).toBe(MARC_NS);
  const [leader, ...fields] = record.children;
  expect(leader?.name).toBe('leader');
  expect(leader?.text).toMatch(/^[0-9 ]{5}[a-z ][a-z][a-z ][ a][a ]22[0-9 ]{5}[ -~]{3}4500$/);
  const out = new Map<string, XNode[]>();
  let seenData = false;
  for (const f of fields) {
    const tag = f.attrs['tag'] ?? '';
    if (f.name === 'controlfield') {
      expect(seenData, 'control fields come first').toBe(false);
      expect(tag).toMatch(/^00[1-9]$/);
      expect(f.children).toEqual([]);
    } else {
      expect(f.name).toBe('datafield');
      seenData = true;
      expect(tag).toMatch(/^(0[1-9]\d|[1-9]\d\d)$/);
      expect(f.attrs['ind1']).toMatch(/^[ -~]$/);
      expect(f.attrs['ind2']).toMatch(/^[ -~]$/);
      expect(f.children.length).toBeGreaterThan(0);
      for (const sf of f.children) {
        expect(sf.name).toBe('subfield');
        expect(sf.attrs['code']).toMatch(/^[!-~]$/);
        expect(sf.children).toEqual([]);
      }
    }
    out.set(tag, [...(out.get(tag) ?? []), f]);
  }
  return out;
}

describe.skipIf(!ctx.available)(`OAI-PMH 2.0 [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let app: ReturnType<typeof createApp>;
  let branchId: string;
  let buku: string;
  let peerSerial = 0;

  /** Records by role: `rich` (S5), `hidden`, `archived`, and the merge chain A→B→C. */
  const ids = { rich: '', hidden: '', archived: '', a: '', b: '', c: '' };

  async function setSettings(patch: Record<string, unknown>): Promise<void> {
    await withTx(h, (trx) => writeSettings(trx, patch, { keyring: CONFIG.keyring, now: NOW, actorId: null }).then(() => undefined));
  }

  const run = <T>(fn: (tx: TxCtx) => Promise<T>, now: number): Promise<T> => withTx(h, (trx) => fn(txCtx(trx, now, ACTOR)));

  const create = async (body: Partial<RecordCreateBody>, now: number): Promise<string> =>
    (await run((tx) => createRecord(tx, { materialTypeId: buku, title: 'Tanpa Judul', ...body }), now)).id;

  /** handleOai on `query` at `o.now` (default NOW) with `o.keys` (default the config's keyring). */
  async function oai(query: string, o: { now?: number; keys?: readonly Buffer[] } = {}): Promise<{ xml: string; doc: XNode }> {
    const res = await handleOai(params(query), {
      db: h.db,
      baseUrl: BASE,
      libraryName: LIBRARY,
      adminEmail: ADMIN,
      orgCode: null,
      now: o.now ?? NOW,
      keys: o.keys ?? KEYS,
    });
    expect(res.status).toBe(200);
    return { xml: res.xml, doc: envelope(res.xml) };
  }

  /** The one error of `query`, its code, and the `request` element's attributes. */
  async function oaiError(query: string, o: { now?: number; keys?: readonly Buffer[] } = {}): Promise<{ code: string; request: Record<string, string> }> {
    const { doc } = await oai(query, o);
    const codes = errorCodes(doc);
    expect(codes, query).toHaveLength(1);
    expect(doc.children.slice(2).map((c) => c.name)).toEqual(['error']);
    expect(kid(doc, 'error').text.trim(), 'a message').not.toBe('');
    return { code: codes[0]!, request: kid(doc, 'request').attrs };
  }

  /**
   * Every page of a list verb from `query` (each next page with its resumptionToken, `between` run before it): the
   * headers or records of each page, and each page's resumptionToken element (or null).
   */
  async function harvest(
    query: string,
    o: { now?: (page: number) => number; between?: (page: number, seen: string[]) => Promise<void> } = {},
  ): Promise<{ pages: XNode[][]; tokens: (XNode | null)[]; ids: string[] }> {
    const verb = new URLSearchParams(query).get('verb')!;
    const pages: XNode[][] = [];
    const tokens: (XNode | null)[] = [];
    const seen: string[] = [];
    let next = query;
    for (let page = 0; page < 1000; page++) {
      if (page > 0) await o.between?.(page, seen);
      const { doc } = await oai(next, { now: o.now?.(page) ?? NOW });
      expect(errorCodes(doc), next).toEqual([]);
      const list = kid(doc, verb);
      const entries = list.children.filter((c) => c.name !== 'resumptionToken');
      pages.push(entries);
      for (const e of entries) seen.push(headerId(e.name === 'record' ? kid(e, 'header') : e));
      const token = kids(list, 'resumptionToken')[0] ?? null;
      expect(list.children.at(-1) === token || token === null, 'the token comes last').toBe(true);
      tokens.push(token);
      if (token === null || token.text === '') return { pages, tokens, ids: seen };
      next = `verb=${verb}&resumptionToken=${encodeURIComponent(token.text)}`;
    }
    throw new Error('the harvest did not end');
  }

  async function insertMaterialType(code: string, nameEn: string, o: { archived?: boolean } = {}): Promise<string> {
    const id = newId(NOW - 60 * DAY);
    await h.db
      .insertInto('material_types')
      .values({
        id,
        code_display: code,
        code_key: normalizeKey(code),
        name_id: `${nameEn} (id)`,
        name_en: nameEn,
        marc_type: 'a',
        template: JSON.stringify({ fields: {}, defaults: {}, customFields: [] }),
        sort_order: 900,
        archived_at: o.archived === true ? NOW - 50 * DAY : null,
        version: 0,
        created_at: NOW - 60 * DAY,
        created_by: null,
        updated_at: NOW - 60 * DAY,
        updated_by: null,
      })
      .execute();
    return id;
  }

  /** Plain record rows (no authorities, no lists), 500 per statement; their ids in order. */
  async function insertRecords(n: number, o: { materialTypeId?: string; changedAt?: (i: number) => number; title?: string } = {}): Promise<string[]> {
    const rows = Array.from({ length: n }, (_, i) => {
      const created = NOW - 20 * DAY + i;
      const title = `${o.title ?? 'Panen'} ${i}`;
      return {
        id: newId(created),
        material_type_id: o.materialTypeId ?? buku,
        title,
        subtitle: null,
        responsibility: null,
        title_key: title.toLowerCase(),
        edition: null,
        material_detail: null,
        publisher_id: null,
        publication_place: null,
        publication_year: '2020',
        publication_date_text: null,
        physical_desc: null,
        series: null,
        classification: null,
        call_number: null,
        language_id: null,
        content_type: null,
        media_type: null,
        carrier_type: null,
        summary: null,
        notes: null,
        cover_file_id: null,
        opac_visible: 1 as const,
        promoted: 0 as const,
        source: 'manual',
        merged_into: null,
        changed_at: o.changedAt?.(i) ?? created,
        archived_at: null,
        version: 0,
        created_at: created,
        created_by: null,
        updated_at: created,
        updated_by: null,
      };
    });
    for (let i = 0; i < rows.length; i += 500) await h.db.insertInto('records').values(rows.slice(i, i + 500)).execute();
    return rows.map((r) => r.id);
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-oai-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    await setSettings({ 'library.name': LIBRARY, 'opac.oai.adminEmail': ADMIN });
    branchId = newId(NOW - 60 * DAY);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'Pusat', name: 'Pusat', address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    const ind = (await h.db.selectFrom('languages').select('id').where('code_key', '=', 'IND').executeTakeFirstOrThrow()).id;

    // S5: acquisition (541) and local item data (952) in marcExtra, beside a field a public record keeps (246).
    ids.rich = await create(
      {
        title: 'Laskar Pelangi',
        subtitle: 'Sebuah novel',
        identifiers: [{ type: 'isbn', value: '979-3062-79-7' }],
        agents: [{ ref: { type: 'person', name: 'Hirata, Andrea' }, role: 'aut', isMain: true }],
        subjects: [
          { ref: { type: 'topic', term: 'Persahabatan' }, isPrimary: true },
          { ref: { type: 'geographic', term: 'Belitung' }, isPrimary: false },
        ],
        publisher: { name: 'Bentang Pustaka', place: 'Yogyakarta' },
        publicationYear: '2005',
        physicalDesc: 'xiv, 529 hlm. ; 20 cm',
        languageId: ind,
        summary: 'Kisah sepuluh anak Belitung & sekolah mereka <SD Muhammadiyah>.',
        marcExtra: [
          { tag: '246', ind1: '3', ind2: ' ', data: JSON.stringify([['a', 'Laskar pelangi : novel']]) },
          { tag: '541', ind1: ' ', ind2: ' ', data: JSON.stringify([['a', 'Toko Buku Rahasia'], ['c', 'Pembelian']]) },
          { tag: '952', ind1: ' ', ind2: ' ', data: JSON.stringify([['g', '85000'], ['p', 'B0000999']]) },
        ],
      },
      NOW - 10 * DAY,
    );
    // An item with a price: never part of a public record (includeItems: false, no acquisition data).
    const umum = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    await h.db
      .insertInto('items')
      .values({
        id: newId(NOW - 9 * DAY),
        record_id: ids.rich,
        branch_id: branchId,
        barcode_display: 'B0000777',
        barcode_key: 'B0000777',
        inventory_no: null,
        call_number: null,
        location_id: null,
        collection_type_id: umum,
        status: 'available',
        status_note: null,
        acq_source: 'purchase',
        order_no: 'PO-7731',
        order_date: null,
        received_date: null,
        invoice_date: null,
        supplier_id: null,
        invoice_no: 'INV-5521',
        price: 99000,
        currency: 'IDR',
        note: null,
        archived_at: null,
        created_at: NOW - 9 * DAY,
        created_by: null,
        updated_at: NOW - 9 * DAY,
        updated_by: null,
      })
      .execute();

    ids.hidden = await create({ title: 'Arsip Internal', opacVisible: false }, NOW - 9 * DAY);
    ids.archived = await create({ title: 'Buku Rusak' }, NOW - 9 * DAY);
    await run((tx) => archiveRecord(tx, ids.archived, 0), NOW - 8 * DAY);

    // Review Focus 4: A merged into B, then B into C.
    ids.a = await create({ title: 'Ronggeng Dukuh Paruk (A)' }, NOW - 7 * DAY);
    ids.b = await create({ title: 'Ronggeng Dukuh Paruk (B)' }, NOW - 7 * DAY);
    ids.c = await create({ title: 'Ronggeng Dukuh Paruk (C)' }, NOW - 7 * DAY);
    await run((tx) => mergeRecord(tx, ids.b, ids.a, 0), NOW - 6 * DAY);
    await run((tx) => mergeRecord(tx, ids.c, ids.b, 0), NOW - 5 * DAY);

    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'oai',
      log: recordingLogger(),
      clock: () => NOW,
      env: {},
      // No cache: a setting this test writes is read by the next request.
      services: { settings: createSettingsCache({ ttlMs: 0 }) },
    });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('the routes: GET and POST /oai, public, session none, read, maintenance allow, ip:oai, POST cookieless (tx self)', () => {
    expect(OAI_ROUTES.map((d) => `${d.method} ${d.path} ${d.id}`)).toEqual(['GET /oai oai.get', 'POST /oai oai.post']);
    for (const d of OAI_ROUTES) {
      expect(d, d.id).toMatchObject({ public: true, session: 'none', maintenance: 'allow', idempotency: 'none', audit: null, ipLimits: ['oai'] });
      expect(d.mode ?? 'read').toBe('read');
      expect(d.query).toBeUndefined();
      expect(d.body).toBeUndefined();
      expect(ALL_ROUTES).toContain(d);
    }
    const post = OAI_ROUTES[1]!;
    expect(post).toMatchObject({ mode: 'read', tx: 'self' });
    expect(isCookielessRead(post)).toBe(true);
    expect(OAI_FORM_MAX_BYTES).toBe(16 * 1024);
  });

  describe('the six verbs', () => {
    it('Identify: the library name, baseURL from config.baseUrl, deletedRecord persistent, earliestDatestamp = min changed_at', async () => {
      const { doc } = await oai('verb=Identify');
      expect(kid(doc, 'request').attrs).toEqual({ verb: 'Identify' });
      const min = await h.db.selectFrom('records').select((eb) => eb.fn.min('changed_at').as('m')).executeTakeFirstOrThrow();
      expect(kid(doc, 'Identify').children.map((c) => [c.name, c.text])).toEqual([
        ['repositoryName', LIBRARY],
        ['baseURL', `${BASE}/oai`],
        ['protocolVersion', '2.0'],
        ['adminEmail', ADMIN],
        ['earliestDatestamp', stamp(Number(min.m))],
        ['deletedRecord', 'persistent'],
        ['granularity', 'YYYY-MM-DDThh:mm:ssZ'],
      ]);
      expect(kid(doc, 'responseDate').text).toBe(stamp(NOW));
    });

    it('ListMetadataFormats: oai_dc and marc21, for the repository and for a live record', async () => {
      const formats = [
        ['oai_dc', 'http://www.openarchives.org/OAI/2.0/oai_dc.xsd', OAI_DC_NS],
        ['marc21', 'http://www.loc.gov/standards/marcxml/schema/MARC21slim.xsd', MARC_NS],
      ];
      for (const query of ['verb=ListMetadataFormats', `verb=ListMetadataFormats&identifier=${oaiId(ids.rich)}`]) {
        const { doc } = await oai(query);
        const list = kid(doc, 'ListMetadataFormats');
        expect(list.children.map((f) => f.children.map((c) => c.text)), query).toEqual(formats);
        expect(list.children.map((f) => f.children.map((c) => c.name))).toEqual([0, 1].map(() => ['metadataPrefix', 'schema', 'metadataNamespace']));
      }
    });

    it('ListSets: `material`, then `material:<code in lower case>` of every live material type (codes escaped to setSpec)', async () => {
      await insertMaterialType('LAMA', 'Old type', { archived: true });
      await insertMaterialType('Peta Lama', 'Old map');
      const { doc } = await oai('verb=ListSets');
      const sets = kid(doc, 'ListSets').children.map((s) => [kid(s, 'setSpec').text, kid(s, 'setName').text]);
      expect(sets[0]).toEqual(['material', 'Material type']);
      expect(sets).toContainEqual(['material:buku', 'Book']);
      expect(sets).toContainEqual(['material:karya-ilmiah', 'Academic work']);
      expect(sets).toContainEqual(['material:peta~20lama', 'Old map']);
      expect(sets.map(([spec]) => spec)).not.toContain('material:lama');
      for (const [spec] of sets) expect(spec).toMatch(/^[A-Za-z0-9\-_.!~*'()]+(:[A-Za-z0-9\-_.!~*'()]+)*$/);
      expect(sets).toHaveLength(new Set(sets.map(([spec]) => spec)).size);
    });

    it('GetRecord oai_dc: header (identifier, datestamp = changed_at, sets) and the oai_dc element of the record', async () => {
      const { doc } = await oai(`verb=GetRecord&identifier=${oaiId(ids.rich)}&metadataPrefix=oai_dc`);
      expect(kid(doc, 'request').attrs).toEqual({ verb: 'GetRecord', identifier: oaiId(ids.rich), metadataPrefix: 'oai_dc' });
      const record = kid(kid(doc, 'GetRecord'), 'record');
      const header = kid(record, 'header');
      const row = await h.db.selectFrom('records').select('changed_at').where('id', '=', ids.rich).executeTakeFirstOrThrow();
      expect(header.attrs).toEqual({});
      expect(header.children.map((c) => [c.name, c.text])).toEqual([
        ['identifier', oaiId(ids.rich)],
        ['datestamp', stamp(Number(row.changed_at))],
        ['setSpec', 'material'],
        ['setSpec', 'material:buku'],
      ]);
      const dc = kid(kid(record, 'metadata'), 'oai_dc:dc');
      expect(dc.attrs['xmlns:oai_dc']).toBe(OAI_DC_NS);
      expect(dc.attrs['xmlns:dc']).toBe('http://purl.org/dc/elements/1.1/');
      const values = (name: string): string[] => kids(dc, `dc:${name}`).map((e) => e.text);
      expect(values('title')).toEqual(['Laskar Pelangi: Sebuah novel']);
      expect(values('creator')).toEqual(['Hirata, Andrea']);
      expect(values('subject')).toEqual(['Persahabatan']);
      expect(values('coverage')).toEqual(['Belitung']);
      expect(values('description')).toEqual(['Kisah sepuluh anak Belitung & sekolah mereka <SD Muhammadiyah>.']);
      expect(values('date')).toEqual(['2005']);
      expect(values('language')).toEqual(['ind']);
      expect(values('identifier')).toEqual([`${BASE}/katalog/${ids.rich}/laskar-pelangi`, 'urn:isbn:9789793062792']);
    });

    it('GetRecord marc21: MARCXML of the public audience, without 541, 952, items or prices (S5)', async () => {
      const { xml, doc } = await oai(`verb=GetRecord&identifier=${oaiId(ids.rich)}&metadataPrefix=marc21`);
      const metadata = kid(kid(kid(doc, 'GetRecord'), 'record'), 'metadata');
      expect(metadata.children).toHaveLength(1);
      const fields = marcStructure(metadata.children[0]!);
      expect(fields.get('001')?.[0]?.text).toBe(ids.rich);
      const f245 = fields.get('245')?.[0];
      expect(f245?.children.map((s) => [s.attrs['code'], s.text])).toContainEqual(['a', expect.stringContaining('Laskar Pelangi')]);
      expect(fields.has('246')).toBe(true);
      for (const tag of ['541', '952', '852', '876', '877', '878']) expect(fields.has(tag), tag).toBe(false);
      for (const secret of ['Pembelian', 'Toko Buku Rahasia', '85000', '99000', 'PO-7731', 'INV-5521', 'B0000777', 'B0000999']) {
        expect(xml, secret).not.toContain(secret);
      }
    });

    it('GetRecord of an archived, hidden or merged record: the header with status="deleted", no metadata', async () => {
      for (const id of [ids.archived, ids.hidden, ids.a, ids.b]) {
        for (const prefix of ['oai_dc', 'marc21']) {
          const { doc } = await oai(`verb=GetRecord&identifier=${oaiId(id)}&metadataPrefix=${prefix}`);
          const record = kid(kid(doc, 'GetRecord'), 'record');
          expect(record.children.map((c) => c.name)).toEqual(['header']);
          expect(kid(record, 'header').attrs).toEqual({ status: 'deleted' });
          expect(headerId(kid(record, 'header'))).toBe(id);
        }
      }
    });

    it('Review Focus 4: after A→B→C, A and B are deleted headers in ListIdentifiers and C is live', async () => {
      const { pages } = await harvest('verb=ListIdentifiers&metadataPrefix=oai_dc');
      const headers = new Map(pages.flat().map((hd) => [headerId(hd), hd]));
      expect(headers.get(ids.a)?.attrs).toEqual({ status: 'deleted' });
      expect(headers.get(ids.b)?.attrs).toEqual({ status: 'deleted' });
      expect(headers.get(ids.c)?.attrs).toEqual({});
      expect(headers.get(ids.hidden)?.attrs).toEqual({ status: 'deleted' });
      expect(headers.get(ids.archived)?.attrs).toEqual({ status: 'deleted' });
      expect(headers.get(ids.rich)?.attrs).toEqual({});
      // ListRecords: a deleted record is its header alone, a live one carries metadata.
      const records = (await harvest('verb=ListRecords&metadataPrefix=marc21')).pages.flat();
      const byId = new Map(records.map((r) => [headerId(kid(r, 'header')), r]));
      expect(byId.get(ids.a)?.children.map((c) => c.name)).toEqual(['header']);
      expect(byId.get(ids.c)?.children.map((c) => c.name)).toEqual(['header', 'metadata']);
      marcStructure(kid(byId.get(ids.c)!, 'metadata').children[0]!);
    });

    it('ListMetadataFormats of a deleted record: noMetadataFormats; ListRecords and ListIdentifiers parse in the namespace', async () => {
      expect(await oaiError(`verb=ListMetadataFormats&identifier=${oaiId(ids.archived)}`)).toEqual({
        code: 'noMetadataFormats',
        request: { verb: 'ListMetadataFormats', identifier: oaiId(ids.archived) },
      });
      for (const verb of ['ListRecords', 'ListIdentifiers']) {
        const { doc } = await oai(`verb=${verb}&metadataPrefix=oai_dc&set=material:buku`);
        expect(kid(doc, 'request').attrs).toEqual({ verb, metadataPrefix: 'oai_dc', set: 'material:buku' });
        expect(kid(doc, verb).children.length).toBeGreaterThan(0);
      }
    });
  });

  describe('protocol errors', () => {
    const live = (): string => oaiId(ids.rich);

    it('badVerb: no verb, an unknown one, a repeated one; the request element then has no attributes', async () => {
      for (const query of ['', 'metadataPrefix=oai_dc', 'verb=Foo', 'verb=identify', 'verb=', 'verb=Identify&verb=Identify']) {
        expect(await oaiError(query), query).toEqual({ code: 'badVerb', request: {} });
      }
    });

    it('badArgument: an illegal, missing, repeated or empty argument, a token mixed with others, bad dates; no attributes', async () => {
      const cases = [
        'verb=Identify&set=material',
        'verb=Identify&resumptionToken=x',
        'verb=ListSets&metadataPrefix=oai_dc',
        'verb=ListMetadataFormats&metadataPrefix=oai_dc',
        `verb=ListMetadataFormats&identifier=${live()}&identifier=${live()}`,
        `verb=GetRecord&identifier=${live()}`,
        'verb=GetRecord&metadataPrefix=oai_dc',
        `verb=GetRecord&identifier=${live()}&metadataPrefix=oai_dc&metadataPrefix=oai_dc`,
        `verb=GetRecord&identifier=${live()}&metadataPrefix=oai_dc&from=2026-01-01`,
        'verb=ListRecords',
        'verb=ListIdentifiers&set=material',
        'verb=ListRecords&metadataPrefix=',
        'verb=ListRecords&metadataPrefix=oai_dc&resumptionToken=x',
        'verb=ListIdentifiers&resumptionToken=x&set=material',
        'verb=ListRecords&metadataPrefix=oai_dc&foo=1',
        'verb=ListRecords&metadataPrefix=oai_dc&from=2026-13-01',
        'verb=ListRecords&metadataPrefix=oai_dc&from=2026-02-30',
        'verb=ListRecords&metadataPrefix=oai_dc&from=2026-10-01T00:00:00',
        'verb=ListRecords&metadataPrefix=oai_dc&from=2026-10-01T24:00:00Z',
        'verb=ListRecords&metadataPrefix=oai_dc&from=2026-10-01T10:00:00.5Z',
        'verb=ListRecords&metadataPrefix=oai_dc&until=20261001',
        'verb=ListRecords&metadataPrefix=oai_dc&from=2026-10-01&until=2026-10-30T00:00:00Z',
        'verb=ListRecords&metadataPrefix=oai_dc&from=2026-10-30&until=2026-10-01',
        'verb=ListRecords&metadataPrefix=oai_dc&from=2026-10-01&from=2026-10-02',
        'verb=ListRecords&metadataPrefix=oai_dc&set=',
        'verb=ListRecords&metadataPrefix=oai_dc&set=material%3Aa%20b',
        'verb=ListRecords&metadataPrefix=oai_dc&set=material%3A',
      ];
      for (const query of cases) expect(await oaiError(query), query).toEqual({ code: 'badArgument', request: {} });
    });

    it('badResumptionToken: garbage, a changed character, an expired token (+25 h), another verb’s token; ListSets has none', async () => {
      // A list long enough for a token: ListRecords pages hold 100 records.
      await insertRecords(150, { title: 'Token' });
      const { doc } = await oai('verb=ListRecords&metadataPrefix=oai_dc');
      const token = kid(kid(doc, 'ListRecords'), 'resumptionToken').text;
      expect(token).not.toBe('');
      const q = (t: string): string => `verb=ListRecords&resumptionToken=${encodeURIComponent(t)}`;
      const flipped = token.slice(0, 10) + (token[10] === 'A' ? 'B' : 'A') + token.slice(11);
      for (const [query, now] of [
        [q('garbage'), NOW],
        [q(flipped), NOW],
        [q(token.slice(0, -1) + (token.at(-1) === 'A' ? 'B' : 'A')), NOW],
        [q(token), NOW + 25 * HOUR],
        [`verb=ListIdentifiers&resumptionToken=${encodeURIComponent(token)}`, NOW],
        [`verb=ListSets&resumptionToken=${encodeURIComponent(token)}`, NOW],
      ] as const) {
        const { code, request } = await oaiError(query, { now });
        expect(code, query).toBe('badResumptionToken');
        expect(request['resumptionToken'], 'the token is echoed').toBeDefined();
      }
      // The same token is fine within its 24 hours.
      const later = await oai(q(token), { now: NOW + 23 * HOUR });
      expect(errorCodes(later.doc)).toEqual([]);
    });

    it('cannotDisseminateFormat: a prefix other than oai_dc and marc21', async () => {
      for (const query of [
        `verb=GetRecord&identifier=${live()}&metadataPrefix=mods`,
        'verb=ListRecords&metadataPrefix=MARC21',
        'verb=ListIdentifiers&metadataPrefix=oai_marc',
      ]) {
        expect((await oaiError(query)).code, query).toBe('cannotDisseminateFormat');
      }
    });

    it('idDoesNotExist: an unknown record, another repository’s host, no oai: prefix, an id that is no ULID', async () => {
      for (const identifier of [oaiId(newId(NOW)), `oai:evil.example:${ids.rich}`, ids.rich, `oai:${HOST}:slims-7`, `oai:${HOST}:${ids.rich.toLowerCase()}`]) {
        const query = `verb=GetRecord&identifier=${encodeURIComponent(identifier)}&metadataPrefix=oai_dc`;
        expect(await oaiError(query), identifier).toEqual({ code: 'idDoesNotExist', request: { verb: 'GetRecord', identifier, metadataPrefix: 'oai_dc' } });
        expect((await oaiError(`verb=ListMetadataFormats&identifier=${encodeURIComponent(identifier)}`)).code).toBe('idDoesNotExist');
      }
    });

    it('noRecordsMatch: an unknown set, a range after the last change or before the first', async () => {
      for (const query of [
        'verb=ListRecords&metadataPrefix=oai_dc&set=material:tidak-ada',
        'verb=ListRecords&metadataPrefix=oai_dc&set=koleksi',
        'verb=ListIdentifiers&metadataPrefix=marc21&from=2099-01-01',
        'verb=ListIdentifiers&metadataPrefix=oai_dc&until=2000-01-01T00:00:00Z',
      ]) {
        expect((await oaiError(query)).code, query).toBe('noRecordsMatch');
      }
    });
  });

  describe('selective harvesting', () => {
    let waktu: string;
    const t1 = Date.UTC(2026, 9, 1, 0, 0, 0);
    const t2 = Date.UTC(2026, 9, 1, 23, 59, 59, 999);
    const t3 = Date.UTC(2026, 9, 2, 0, 0, 0);
    const t4 = Date.UTC(2026, 9, 2, 12, 0, 0, 500);
    let timed: string[];

    beforeAll(async () => {
      waktu = await insertMaterialType('UJIWAKTU', 'Time test');
      timed = await insertRecords(4, { materialTypeId: waktu, changedAt: (i) => [t1, t2, t3, t4][i]!, title: 'Waktu' });
    });

    const listed = async (extra: string): Promise<string[]> =>
      (await harvest(`verb=ListIdentifiers&metadataPrefix=oai_dc&set=material:ujiwaktu${extra}`)).ids;

    it('from/until at day granularity cover whole days; at second granularity a datestamp is inclusive', async () => {
      expect(await listed('')).toEqual(timed);
      expect(await listed('&from=2026-10-01&until=2026-10-01')).toEqual(timed.slice(0, 2));
      expect(await listed('&from=2026-10-02')).toEqual(timed.slice(2));
      expect(await listed('&until=2026-10-02T12:00:00Z')).toEqual(timed);
      expect(await listed('&until=2026-10-02T11:59:59Z')).toEqual(timed.slice(0, 3));
      expect(await listed('&from=2026-10-02T12:00:00Z')).toEqual(timed.slice(3));
      expect(await listed('&from=2026-10-01T23:59:59Z&until=2026-10-02T00:00:00Z')).toEqual(timed.slice(1, 3));
      expect((await oaiError('verb=ListIdentifiers&metadataPrefix=oai_dc&set=material:ujiwaktu&from=2026-10-02T12:00:01Z')).code).toBe('noRecordsMatch');
      // The datestamps are the changes, cut to the second.
      const { doc } = await oai('verb=ListIdentifiers&metadataPrefix=oai_dc&set=material:ujiwaktu');
      expect(kids(kid(doc, 'ListIdentifiers'), 'header').map((hd) => kid(hd, 'datestamp').text)).toEqual([
        '2026-10-01T00:00:00Z',
        '2026-10-01T23:59:59Z',
        '2026-10-02T00:00:00Z',
        '2026-10-02T12:00:00Z',
      ]);
    });

    it('sets: material:<code> holds that type only, `material` every record; a code with a space is escaped', async () => {
      const all = (await h.db.selectFrom('records').select('id').orderBy('id').execute()).map((r) => r.id);
      expect(await listed('')).toEqual(timed);
      expect((await harvest('verb=ListIdentifiers&metadataPrefix=oai_dc&set=material')).ids).toEqual(all);
      const lama = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'PETA LAMA').executeTakeFirstOrThrow()).id;
      const peta = await insertRecords(2, { materialTypeId: lama, title: 'Peta' });
      expect((await harvest('verb=ListIdentifiers&metadataPrefix=oai_dc&set=material:peta~20lama')).ids).toEqual(peta);
      const { doc } = await oai(`verb=GetRecord&identifier=${oaiId(peta[0]!)}&metadataPrefix=oai_dc`);
      expect(kids(kid(kid(kid(doc, 'GetRecord'), 'record'), 'header'), 'setSpec').map((s) => s.text)).toEqual(['material', 'material:peta~20lama']);
    });
  });

  describe('a harvest of 2 500 records', () => {
    let harvested: string[];

    beforeAll(async () => {
      harvested = await insertRecords(2500);
    }, 120_000);

    it('ListRecords: 100 per page, edits between pages (changed_at moves) → every id exactly once; completeListSize from page 1', async () => {
      const all = (await h.db.selectFrom('records').select('id').execute()).map((r) => r.id);
      const archivedMidway = harvested[2400]!;
      let clock = NOW;
      const { pages, tokens, ids: seen } = await harvest('verb=ListRecords&metadataPrefix=oai_dc', {
        now: () => clock,
        between: async (page, sofar) => {
          clock += 10 * SECOND;
          // 5 records already harvested and 5 not yet: their changed_at moves past every other record's.
          const done = sofar.slice(-5);
          const seenSet = new Set(sofar);
          const ahead = harvested.filter((id) => !seenSet.has(id)).slice(0, 5);
          await h.db
            .updateTable('records')
            .set({ changed_at: clock, title: `Disunting ${page}` })
            .where('id', 'in', [...done, ...ahead])
            .execute();
          if (page === 3) {
            await h.db.updateTable('records').set({ archived_at: clock, changed_at: clock }).where('id', '=', archivedMidway).execute();
          }
        },
      });
      expect(seen).toHaveLength(all.length);
      expect(new Set(seen).size).toBe(all.length);
      expect([...seen].sort()).toEqual([...all].sort());
      expect(pages.slice(0, -1).every((p) => p.length === 100)).toBe(true);
      expect(pages.at(-1)!.length).toBe(all.length - 100 * (pages.length - 1));
      for (const token of tokens.slice(0, -1)) {
        expect(token?.attrs['completeListSize']).toBe(String(all.length));
        expect(token?.attrs['expirationDate']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      }
      // The last page closes the list with an empty token that keeps the size.
      expect(tokens.at(-1)?.text).toBe('');
      expect(tokens.at(-1)?.attrs['completeListSize']).toBe(String(all.length));
      // The record archived during the harvest arrives as a deleted header (it was not harvested before).
      const last = pages.flat().find((r) => headerId(kid(r, 'header')) === archivedMidway)!;
      expect(kid(last, 'header').attrs).toEqual({ status: 'deleted' });
    }, 120_000);

    it('ListIdentifiers: 500 per page, every id once; the expirationDate is 24 hours after the response', async () => {
      const all = (await h.db.selectFrom('records').select('id').orderBy('id').execute()).map((r) => r.id);
      const { pages, tokens, ids: seen } = await harvest('verb=ListIdentifiers&metadataPrefix=marc21');
      expect(seen).toEqual(all);
      expect(pages.slice(0, -1).every((p) => p.length === 500)).toBe(true);
      expect(tokens[0]?.attrs['expirationDate']).toBe(stamp(NOW + OAI_TOKEN_TTL_MS));
      expect(verifyToken(tokens[0]!.text, KEYS, NOW)).toMatchObject({ v: 1, verb: 'ListIdentifiers', prefix: 'marc21', set: null, from: null, until: null, size: all.length });
      // The widest range a harvester may ask for, its bounds before 1970 and far ahead, carried page after page.
      for (const range of ['from=0001-01-01&until=9999-12-31', 'from=1900-01-01T00:00:00Z']) {
        expect((await harvest(`verb=ListIdentifiers&metadataPrefix=oai_dc&${range}`)).ids, range).toEqual(all);
      }
    }, 60_000);

    it('M15: a harvest started before a keyring rotation goes on after it; the next token is signed with the new key', async () => {
      const old: KeyringEntry = { kid: 'lama', key: randomBytes(32).toString('base64url'), active: true };
      const fresh: KeyringEntry = { kid: 'baru', key: randomBytes(32).toString('base64url'), active: true };
      const before = oaiTokenKeys([old]);
      const after = oaiTokenKeys([{ ...old, active: false }, fresh]);
      const first = await oai('verb=ListRecords&metadataPrefix=marc21', { keys: before });
      const token = kid(kid(first.doc, 'ListRecords'), 'resumptionToken').text;
      const second = await oai(`verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`, { keys: after });
      expect(errorCodes(second.doc)).toEqual([]);
      expect(kids(kid(second.doc, 'ListRecords'), 'record')).toHaveLength(100);
      const next = kid(kid(second.doc, 'ListRecords'), 'resumptionToken').text;
      expect(verifyToken(next, oaiTokenKeys([fresh]), NOW)).not.toBeNull();
      expect(verifyToken(next, before, NOW)).toBeNull();
      // Without the old entry, its tokens are refused.
      expect((await oaiError(`verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`, { keys: oaiTokenKeys([fresh]) })).code).toBe(
        'badResumptionToken',
      );
    });
  });

  it('a ListRecords page stops at its byte budget (OAI_PAGE_BYTES) and the next page starts after it: every record once', async () => {
    // Three records of about 4.5 MB of MARC each (500 public 500 fields of 9 000 characters): two do not fit in 8 MiB.
    const besar = await insertMaterialType('BESAR', 'Large');
    const big = await insertRecords(3, { materialTypeId: besar, title: 'Besar' });
    const value = 'x'.repeat(9000);
    for (const id of big) {
      const rows = Array.from({ length: 500 }, (_, i) => ({ id: newId(NOW), record_id: id, tag: '500', ind1: ' ', ind2: ' ', data: JSON.stringify([['a', value]]), sort_order: i }));
      for (let i = 0; i < rows.length; i += 100) await h.db.insertInto('record_marc_extra').values(rows.slice(i, i + 100)).execute();
    }
    const { pages, tokens, ids: seen } = await harvest('verb=ListRecords&metadataPrefix=marc21&set=material:besar');
    expect(seen).toEqual(big);
    expect(pages.map((p) => p.length)).toEqual([1, 1, 1]);
    expect(tokens.map((t) => t?.attrs['completeListSize'])).toEqual(['3', '3', '3']);
    for (const page of pages) {
      const fields = marcStructure(kid(page[0]!, 'metadata').children[0]!);
      expect(fields.get('500')).toHaveLength(500);
    }
    // ListIdentifiers is not cut: headers are small.
    expect((await harvest('verb=ListIdentifiers&metadataPrefix=marc21&set=material:besar')).pages.map((p) => p.length)).toEqual([3]);
    expect(OAI_PAGE_BYTES).toBe(8 * 1024 * 1024);
  }, 60_000);

  describe('through the app', () => {
    const agent = () => createAgent(app, { peer: `198.18.35.${(peerSerial++ % 250) + 1}` });
    const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

    const identify = (res: AgentReply): XNode => {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/xml; charset=utf-8');
      return kid(envelope(res.text), 'Identify');
    };

    it('GET /oai answers text/xml with absolute URLs from config.baseUrl, whatever the Host header says', async () => {
      const res = await agent().get('/oai?verb=Identify', undefined, { host: 'evil.example' });
      expect(kid(identify(res), 'baseURL').text).toBe(`${BASE}/oai`);
      expect(res.headers.get('set-cookie')).toBeNull();
      const record = await agent().get(`/oai?verb=GetRecord&metadataPrefix=oai_dc&identifier=${encodeURIComponent(oaiId(ids.rich))}`);
      expect(record.status).toBe(200);
      expect(record.text).toContain(`${BASE}/katalog/${ids.rich}/laskar-pelangi`);
      expect(record.text).not.toContain('evil.example');
    });

    it('POST /oai without an Origin → 200; a foreign Origin and Sec-Fetch-Site: cross-site change nothing (no CSRF step)', async () => {
      const plain = await agent().post('/oai', 'verb=Identify', FORM);
      expect(kid(identify(plain), 'repositoryName').text).toBe(LIBRARY);
      const foreign = await agent().post('/oai', `verb=GetRecord&metadataPrefix=marc21&identifier=${encodeURIComponent(oaiId(ids.rich))}`, {
        ...FORM,
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      });
      expect(foreign.status).toBe(200);
      const metadata = kid(kid(kid(envelope(foreign.text), 'GetRecord'), 'record'), 'metadata');
      marcStructure(metadata.children[0]!);
      // The arguments are read from the body only, with the charset utf-8 allowed.
      const charset = await agent().post('/oai', 'verb=Identify', { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' });
      identify(charset);
      const queryOnly = await agent().post('/oai?verb=Identify', '', FORM);
      expect(errorCodes(envelope(queryOnly.text))).toEqual(['badVerb']);
    });

    it('POST /oai reads at most 16 KiB of application/x-www-form-urlencoded UTF-8; anything else → badArgument', async () => {
      const exact = 'verb=Identify' + '&'.repeat(OAI_FORM_MAX_BYTES - 'verb=Identify'.length);
      identify(await agent().post('/oai', exact, FORM));
      const bad: [string, string | Uint8Array, Record<string, string>][] = [
        ['one byte over', `${exact}&`, FORM],
        ['JSON', '{"verb":"Identify"}', { 'content-type': 'application/json' }],
        ['multipart', 'verb=Identify', { 'content-type': 'multipart/form-data; boundary=x' }],
        ['latin-1', 'verb=Identify', { 'content-type': 'application/x-www-form-urlencoded; charset=iso-8859-1' }],
        ['no content type', 'verb=Identify', { 'content-type': '' }],
        ['a declared length over the limit', 'verb=Identify', { ...FORM, 'content-length': String(OAI_FORM_MAX_BYTES + 1) }],
      ];
      for (const [label, body, headers] of bad) {
        const res = await agent().post('/oai', body as string, headers);
        expect(res.status, label).toBe(200);
        const doc = envelope(res.text);
        expect(errorCodes(doc), label).toEqual(['badArgument']);
        expect(kid(doc, 'request').attrs, label).toEqual({});
      }
      // Bytes that are not UTF-8.
      const res = await app.request(
        '/oai',
        { method: 'POST', headers: FORM, body: new Uint8Array([...Buffer.from('verb=Identify&x='), 0xff, 0xfe]) },
        { incoming: { socket: { remoteAddress: '198.18.35.251' } } },
      );
      expect(errorCodes(envelope(await res.text()))).toEqual(['badArgument']);
    });

    it('a chunked body over 16 KiB (no Content-Length) is cut off at the limit → badArgument', async () => {
      const chunk = new TextEncoder().encode('&'.repeat(4096));
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 64) controller.close();
          else {
            sent += 1;
            controller.enqueue(sent === 1 ? new TextEncoder().encode('verb=Identify') : chunk);
          }
        },
      });
      const res = await app.request(
        '/oai',
        { method: 'POST', headers: FORM, body, duplex: 'half' } as RequestInit,
        { incoming: { socket: { remoteAddress: '198.18.35.252' } } },
      );
      expect(errorCodes(envelope(await res.text()))).toEqual(['badArgument']);
      expect(sent, 'the stream is not read to its end').toBeLessThan(64);
    });

    it('OAI off, or on without an admin e-mail → 503 text for GET and POST; ?lang=en answers in English', async () => {
      try {
        for (const patch of [{ 'opac.oai.enabled': false }, { 'opac.oai.enabled': true, 'opac.oai.adminEmail': '' }]) {
          await setSettings(patch);
          const get = await agent().get('/oai?verb=Identify');
          expect({ status: get.status, type: get.headers.get('content-type') }, JSON.stringify(patch)).toEqual({ status: 503, type: 'text/plain; charset=utf-8' });
          expect(get.text).toBe(opacText('id', 'oai.unavailable'));
          const post = await agent().post('/oai', 'verb=Identify', FORM);
          expect(post.status).toBe(503);
          const en = await agent().get('/oai?verb=Identify&lang=en');
          expect(en.text).toBe(opacText('en', 'oai.unavailable'));
        }
      } finally {
        await setSettings({ 'opac.oai.enabled': true, 'opac.oai.adminEmail': ADMIN });
      }
      identify(await agent().get('/oai?verb=Identify'));
    });
  });
});
