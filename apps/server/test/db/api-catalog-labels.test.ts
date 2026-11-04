import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS, labelDataFor, writeSettings } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { isDomainError, newId, normalizeKey } from '@altis/shared';
import type { LabelProfile } from '@altis/shared/api/settings';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { barsToModules, decodeCode128, decodeCode39 } from '../../../../packages/core/test/support/barcode-decode.js';
import { checkPdf, type CheckedPage, type CheckedPdf } from '../../../../packages/core/test/support/pdf-check.js';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The label PDF route of Phase 2 Task 36 (spec §7, §12.2, §12.3; K13) on the engine picked by ALTIS_TEST_DB:
// - labelDataFor: the items of `itemIds` in the order given, or the live items of each record of `recordIds` (a record
//   without one is skipped), the call number the item's else the record's, at most 1 000 ids and 1 000 labels;
// - `POST catalog/labels`: a PDF built from a profile of `catalog.labelProfiles` with `library.name` and
//   `catalog.barcode.symbology`, `X-Altis-Label-Skipped`, 422 `CATALOG_LABEL_LIMIT` past 1 000 ids or labels, an
//   unknown profile a field error; 1 000 labels on each seeded profile in under 5 s (K13).

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 29, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const LABELS = '/api/v1/catalog/labels';
const PT = 72 / 25.4;
const SEEDED = SETTINGS['catalog.labelProfiles'].default as LabelProfile[];

function seeded(id: string): LabelProfile {
  const p = SEEDED.find((s) => s.id === id);
  if (p === undefined) throw new Error(`no seeded profile ${id}`);
  return p;
}

interface Reply {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  json: { code?: string; errors?: { path: string; code: string }[] } | undefined;
}

/** The label slots of a page in PDF points (origin bottom left), row by row from the top left. */
function slotBoxes(profile: LabelProfile): { x0: number; x1: number; y0: number; y1: number }[] {
  const page = profile.page === 'A4' ? { w: 210, h: 297 } : null;
  if (page === null) throw new Error('an A4 profile only');
  const out: { x0: number; x1: number; y0: number; y1: number }[] = [];
  for (let row = 0; row < profile.rows; row++) {
    for (let col = 0; col < profile.cols; col++) {
      const left = profile.marginMm.l + col * (profile.labelWMm + profile.gapXMm);
      const top = profile.marginMm.t + row * (profile.labelHMm + profile.gapYMm);
      out.push({ x0: left * PT, x1: (left + profile.labelWMm) * PT, y1: (page.h - top) * PT, y0: (page.h - top - profile.labelHMm) * PT });
    }
  }
  return out;
}

/** The bars of each filled slot of a borderless page, read back with `symbology`'s decoder, in slot order. */
function barsBySlot(page: CheckedPage, profile: LabelProfile, symbology: 'code128' | 'code39'): string[] {
  const boxes = slotBoxes(profile);
  const bars = boxes.map(() => [] as { x: number; w: number }[]);
  for (const r of page.rects) {
    if (r.paint !== 'f') continue;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const k = boxes.findIndex((b) => cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1);
    if (k < 0) throw new Error('a bar outside every label');
    bars[k]!.push({ x: r.x, w: r.w });
  }
  return bars.filter((b) => b.length > 0).map((b) => (symbology === 'code128' ? decodeCode128(barsToModules(b)).text : decodeCode39(barsToModules(b))));
}

/** The human-readable barcodes of a PDF (the Courier lines), page by page in drawing order. */
const courierTexts = (pdf: CheckedPdf): string[] => pdf.pages.flatMap((p) => p.texts.filter((t) => t.font === 'Courier').map((t) => t.text));

describe.skipIf(!ctx.available)(`label PDF route [${engineLabel()}]`, () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let readerToken: string;
  let branchId: string;
  let umum: string;
  let buku: string;

  /** `POST catalog/labels` as a holder of `catalog.records.read`; the body as bytes, and its JSON for a problem. */
  async function post(body: unknown): Promise<Reply> {
    const res = await app.request(
      LABELS,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${SID}=${readerToken}`,
          'x-csrf-token': sessionCsrfFor(CONFIG, readerToken),
        },
        body: JSON.stringify(body),
      },
      { incoming: { socket: { remoteAddress: '203.0.113.36' } } },
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const type = res.headers.get('content-type') ?? '';
    const json = type.includes('json') ? (JSON.parse(new TextDecoder().decode(bytes)) as Reply['json']) : undefined;
    return { status: res.status, headers: res.headers, bytes, json };
  }

  /** A live record (BUKU) with `title` and `callNumber`; its id. */
  async function seedRecord(title: string, callNumber: string | null): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('records')
      .values({
        id,
        material_type_id: buku,
        title,
        subtitle: null,
        responsibility: null,
        title_key: title.toLowerCase(),
        edition: null,
        material_detail: null,
        publisher_id: null,
        publication_place: null,
        publication_year: null,
        publication_date_text: null,
        physical_desc: null,
        series: null,
        classification: null,
        call_number: callNumber,
        language_id: null,
        content_type: null,
        media_type: null,
        carrier_type: null,
        summary: null,
        notes: null,
        cover_file_id: null,
        source: 'manual',
        merged_into: null,
        changed_at: NOW,
        archived_at: null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return id;
  }

  /** Items of `recordId`, one per barcode (the barcode is already in its normal form); their ids in that order. */
  async function seedItems(recordId: string, items: { barcode: string; callNumber?: string | null; archived?: boolean }[]): Promise<string[]> {
    const rows = items.map((it) => ({
      id: newId(),
      record_id: recordId,
      branch_id: branchId,
      barcode_display: it.barcode,
      barcode_key: it.barcode,
      inventory_no: null,
      call_number: it.callNumber ?? null,
      location_id: null,
      collection_type_id: umum,
      status: it.archived === true ? 'withdrawn' : 'available',
      status_note: null,
      acq_source: null,
      order_no: null,
      order_date: null,
      received_date: null,
      invoice_date: null,
      supplier_id: null,
      invoice_no: null,
      price: null,
      currency: null,
      note: null,
      archived_at: it.archived === true ? NOW : null,
      created_at: NOW,
      created_by: null,
      updated_at: NOW,
      updated_by: null,
    }));
    for (let i = 0; i < rows.length; i += 100) await h.db.insertInto('items').values(rows.slice(i, i + 100)).execute();
    return rows.map((r) => r.id);
  }

  const barcodes = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(4, '0')}`);

  // Thirty items of one record (spec §7: a spine sheet of 3 × 10); every third has a call number of its own.
  let thirty: string[];
  // Two records with three live items (and an archived one) and a record without items.
  let recA: string;
  let recB: string;
  let recEmpty: string;
  let itemsA: string[];
  let itemB: string;
  // A thousand items over four records (K13), and one more record with one item.
  let thousand: string[];
  let thousandRecords: string[];
  let oneMoreRecord: string;

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-api-labels-'));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    branchId = newId();
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: normalizeKey('PUSAT'), code_display: 'PUSAT', name: 'Cabang Pusat', timezone: 'Asia/Jakarta', is_default: 1, created_at: NOW, updated_at: NOW })
      .execute();
    buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    umum = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;

    const ronggeng = await seedRecord('Ronggeng Dukuh Paruk', '899.221 TOH r');
    thirty = await seedItems(
      ronggeng,
      barcodes('LB-', 30).map((barcode, i) => ({ barcode, callNumber: i % 3 === 0 ? 'REF 899.221 TOH r' : null })),
    );

    recA = await seedRecord('Laskar Pelangi', 'A 001');
    recB = await seedRecord('Bumi Manusia', null);
    recEmpty = await seedRecord('Cantuman Tanpa Eksemplar', '000 KOS');
    itemsA = await seedItems(recA, [
      { barcode: 'LA-0002' },
      { barcode: 'LA-0001', callNumber: 'A 001 c.1' },
      { barcode: 'LA-0003', archived: true },
    ]);
    [itemB] = (await seedItems(recB, [{ barcode: 'LB-9001' }])) as [string];

    thousandRecords = [];
    thousand = [];
    for (let r = 0; r < 4; r++) {
      const id = await seedRecord(`Ensiklopedia Nusantara Jilid ${r + 1}`, `030 ENS e.${r + 1}`);
      thousandRecords.push(id);
      thousand.push(...(await seedItems(id, barcodes(`K${r}-`, 250).map((barcode) => ({ barcode })))));
    }
    oneMoreRecord = await seedRecord('Satu Lagi', null);
    await seedItems(oneMoreRecord, [{ barcode: 'LX-0001' }]);

    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW });
    const reader = await seedStaff(h, { username: 'cetak_label', now: NOW, roles: [{ permissions: ['catalog.records.read'] }] });
    readerToken = await sessionCookieFor(h, reader.id, { now: NOW });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  describe('labelDataFor', () => {
    it('expands records to their live items in the order given (by barcode within a record); a record without items is skipped', async () => {
      const r = await labelDataFor(h.db, { recordIds: [recB, recEmpty, recA] });
      expect(r).toEqual({
        labels: [
          { callNumber: null, barcode: 'LB-9001', title: 'Bumi Manusia' },
          { callNumber: 'A 001 c.1', barcode: 'LA-0001', title: 'Laskar Pelangi' },
          { callNumber: 'A 001', barcode: 'LA-0002', title: 'Laskar Pelangi' },
        ],
        skipped: 1,
      });
    });

    it('keeps the order of itemIds; an unknown or archived item is skipped, a repeated id counts once', async () => {
      const [a2, a1, a3] = itemsA as [string, string, string];
      const r = await labelDataFor(h.db, { itemIds: [a2, newId(), itemB, a3, a1, a2] });
      expect(r).toEqual({
        labels: [
          { callNumber: 'A 001', barcode: 'LA-0002', title: 'Laskar Pelangi' },
          { callNumber: null, barcode: 'LB-9001', title: 'Bumi Manusia' },
          { callNumber: 'A 001 c.1', barcode: 'LA-0001', title: 'Laskar Pelangi' },
        ],
        skipped: 2,
      });
      expect(await labelDataFor(h.db, { recordIds: [newId(), recEmpty] })).toEqual({ labels: [], skipped: 2 });
    });

    it('refuses more than 1 000 ids, and records whose items make more than 1 000 labels: CATALOG_LABEL_LIMIT {max: 1000}', async () => {
      const limit = async (o: Parameters<typeof labelDataFor>[1]): Promise<unknown> => {
        try {
          await labelDataFor(h.db, o);
        } catch (e) {
          return isDomainError(e) ? { code: e.code, status: e.status, meta: e.meta } : e;
        }
        return 'no error';
      };
      const refused = { code: 'CATALOG_LABEL_LIMIT', status: 422, meta: { max: 1000 } };
      expect(await limit({ itemIds: [...thousand, itemB] })).toEqual(refused);
      expect(await limit({ recordIds: Array.from({ length: 1001 }, () => newId()) })).toEqual(refused);
      expect(await limit({ recordIds: [...thousandRecords, oneMoreRecord] })).toEqual(refused);
      const all = await labelDataFor(h.db, { recordIds: thousandRecords });
      expect([all.labels.length, all.skipped]).toEqual([1000, 0]);
    });
  });

  describe('POST catalog/labels', () => {
    it('30 items on the seeded spine profile → one A4 page that passes pdf-check, inline label.pdf, nothing skipped', async () => {
      const res = await post({ profileId: 'spine-a4', itemIds: thirty, startPosition: 1, copies: 1 });
      expect(res.status, new TextDecoder().decode(res.bytes)).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toBe('inline; filename="label.pdf"');
      expect(res.headers.get('x-altis-label-skipped')).toBe('0');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('content-length')).toBe(String(res.bytes.length));
      const pdf = checkPdf(res.bytes);
      expect(pdf.title).toBe(seeded('spine-a4').name);
      expect(pdf.pages).toHaveLength(1);
      const texts = pdf.pages[0]!.texts.map((t) => t.text);
      // The call number split per space: the item's own on every third label, else the record's.
      expect(texts.filter((t) => t === 'REF')).toHaveLength(10);
      expect(texts.filter((t) => t === '899.221')).toHaveLength(30);
      expect(texts.filter((t) => t === 'TOH')).toHaveLength(30);
    });

    it('2 records with 3 items and 1 record without items → 3 labels and X-Altis-Label-Skipped: 1', async () => {
      const res = await post({ profileId: 'barcode-a4', recordIds: [recA, recEmpty, recB], startPosition: 1, copies: 1 });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-altis-label-skipped')).toBe('1');
      const pdf = checkPdf(res.bytes);
      expect(courierTexts(pdf)).toEqual(['LA-0001', 'LA-0002', 'LB-9001']);
      expect(barsBySlot(pdf.pages[0]!, seeded('barcode-a4'), 'code128')).toEqual(['LA-0001', 'LA-0002', 'LB-9001']);
      // copies: each label twice, side by side.
      const twice = checkPdf((await post({ profileId: 'barcode-a4', recordIds: [recA, recEmpty, recB], startPosition: 1, copies: 2 })).bytes);
      expect(courierTexts(twice)).toEqual(['LA-0001', 'LA-0001', 'LA-0002', 'LA-0002', 'LB-9001', 'LB-9001']);
    });

    it('more than 1 000 ids, or records making more than 1 000 labels → 422 CATALOG_LABEL_LIMIT', async () => {
      const items = await post({ profileId: 'spine-a4', itemIds: [...thousand, itemB], startPosition: 1, copies: 1 });
      expect([items.status, items.json?.code]).toEqual([422, 'CATALOG_LABEL_LIMIT']);
      const records = await post({ profileId: 'spine-a4', recordIds: Array.from({ length: 1001 }, () => newId()), startPosition: 1, copies: 1 });
      expect([records.status, records.json?.code]).toEqual([422, 'CATALOG_LABEL_LIMIT']);
      const expanded = await post({ profileId: 'spine-a4', recordIds: [...thousandRecords, oneMoreRecord], startPosition: 1, copies: 1 });
      expect([expanded.status, expanded.json?.code]).toEqual([422, 'CATALOG_LABEL_LIMIT']);
    });

    it('an unknown profileId → VALIDATION_FAILED {path: profileId, code: not_found}', async () => {
      const res = await post({ profileId: 'tidak-ada', itemIds: [itemB], startPosition: 1, copies: 1 });
      expect([res.status, res.json?.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(res.json?.errors).toEqual([{ path: 'profileId', code: 'not_found' }]);
    });

    it('a startPosition past one sheet is taken (§7 does not refuse it) and wraps to the same slot of a fresh sheet', async () => {
      const res = await post({ profileId: 'spine-a4', itemIds: [itemsA[1]], startPosition: 31, copies: 1 });
      expect(res.status).toBe(200);
      const pdf = checkPdf(res.bytes);
      expect(pdf.pages).toHaveLength(1);
      const texts = pdf.pages[0]!.texts;
      expect(texts.map((t) => t.text)).toEqual(['A', '001', 'c.1']);
      // Slot 1: the top left label of the sheet.
      const first = slotBoxes(seeded('spine-a4'))[0]!;
      for (const t of texts) expect(t.x >= first.x0 && t.x <= first.x1 && t.y >= first.y0 && t.y <= first.y1, JSON.stringify(t)).toBe(true);
    });

    it.each(['spine-a4', 'barcode-a4', 'spine-barcode-a4'])('K13: 1 000 labels on %s through the route in under 5 s', async (profileId) => {
      const started = performance.now();
      const res = await post({ profileId, itemIds: thousand, startPosition: 1, copies: 1 });
      const took = performance.now() - started;
      expect(res.status).toBe(200);
      expect(took).toBeLessThan(5000);
      const profile = seeded(profileId);
      const pdf = checkPdf(res.bytes);
      expect(pdf.pages).toHaveLength(Math.ceil(1000 / (profile.cols * profile.rows)));
      if (profileId !== 'spine-a4') expect(courierTexts(pdf)).toHaveLength(1000);
    });

    it('takes the library name and the symbology from the settings; a profile naming its own symbology keeps it', async () => {
      const custom: LabelProfile = { ...seeded('barcode-a4'), id: 'barcode-128', name: 'Barkod Code 128', symbology: 'code128' };
      await withTx(h, (trx) =>
        writeSettings(
          trx,
          { 'library.name': 'Perpustakaan Uji Label', 'catalog.barcode.symbology': 'code39', 'catalog.labelProfiles': [...SEEDED, custom] },
          { now: NOW, actorId: null, keyring: CONFIG.keyring },
        ),
      );
      try {
        const body = { itemIds: [itemsA[1], itemB], startPosition: 1, copies: 1 };
        const setting = checkPdf((await post({ ...body, profileId: 'barcode-a4' })).bytes);
        expect(setting.pages[0]!.texts.map((t) => t.text)).toContain('Perpustakaan Uji Label');
        expect(barsBySlot(setting.pages[0]!, seeded('barcode-a4'), 'code39')).toEqual(['LA-0001', 'LB-9001']);
        const own = checkPdf((await post({ ...body, profileId: 'barcode-128' })).bytes);
        expect(own.title).toBe('Barkod Code 128');
        expect(barsBySlot(own.pages[0]!, custom, 'code128')).toEqual(['LA-0001', 'LB-9001']);
      } finally {
        await withTx(h, (trx) =>
          writeSettings(
            trx,
            { 'library.name': 'Perpustakaan', 'catalog.barcode.symbology': 'code128', 'catalog.labelProfiles': SEEDED },
            { now: NOW, actorId: null, keyring: CONFIG.keyring },
          ),
        );
      }
    });
  });
});
