import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createRecord,
  createSettingsCache,
  createXmlReader,
  localStorageDriver,
  mergeRecord,
  recordUrlPath,
  txCtx,
  writeSettings,
  type Actor,
  type MaintenanceFlag,
  type XmlEvent,
} from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations, withTx } from '@altis/db';
import { OPAC_CSS } from '@altis/opac-theme';
import { newId, normalizeKey, t } from '@altis/shared';
import type { RecordCreateBody } from '@altis/shared/api/catalog/records';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import { OPAC_DETAIL_ROUTES } from '../../src/opac/catalog/detail-routes.js';
import { opacText } from '../../src/opac/catalog/messages.js';
import { imageSize } from '../../src/opac/catalog/shelf-map.js';
import { ALL_ROUTES } from '../../src/routes.js';
import { flagOf } from '../ops-support.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { stripImageMetadata } from '../../../../packages/core/src/files/strip-metadata.js';

// The OPAC record detail (Phase 2 Task 34; spec §9.1, §9.3, §9.4, §9.8, §8 read count; K10, K12; Review Focus 4;
// preflight S4, S5, S6, S17, M10) through the app, on the engine picked by ALTIS_TEST_DB:
// - `/katalog/:id[/:slug]`: a missing or wrong slug → 301 to the canonical URL; a merged record → one 301 to the live
//   target's canonical URL (A→B→C); hidden, archived or unknown → the OPAC 404 page (HTML, never a thrown error);
// - the page: cover, title, agents and subjects linking to the search, summary and notes, the description, relations
//   both ways, public custom fields, at most 20 public attachments (a non-http(s) URL never linked), the availability
//   table (no lost or withdrawn item, "Dalam pemesanan", the shelf path), the shelf map, the citations, and in <head>
//   the description, canonical, hreflang, Dublin Core, OpenGraph, the Twitter card and JSON-LD with the nonce;
// - `/katalog/:id/ris|bibtex|marcxml`: downloads without acquisition data (no price, no 541/952 of marcExtra);
// - `/katalog/:id/lampiran/:aid`: the viewer of each kind, `noindex`, its read count (+1 per view, not per file request,
//   none during maintenance), and 404 for a staff, archived or foreign attachment.

const ctx = testDbContext();
/** In the past: an audit entry may not be dated ahead of the real clock (R51). */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const DAY = 86_400_000;
const CONFIG = sampleConfig();
const BASE = CONFIG.baseUrl;
const HTML = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const ACTOR: Actor = { type: 'staff', id: newId(NOW - DAY), ip: null };

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const esc = (s: string): string => s.replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch]!);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A PNG of `width` × `height` as far as its header goes (signature, IHDR, IEND): what a floor plan's size is read from. */
function pngHeader(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(8 + 25 + 12);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b.set([8, 2, 0, 0, 0], 24);
  b.writeUInt32BE(0, 29);
  b.writeUInt32BE(0, 33);
  b.write('IEND', 37, 'latin1');
  return new Uint8Array(b);
}

/**
 * A JPEG as a phone writes it: a frame of `width` × `height` pixels, and an EXIF block (little endian, the camera's
 * make next to it) whose Orientation is `orientation` (none for null). 6 is a portrait photo: the pixels are stored
 * landscape and the browser turns them a quarter.
 */
function phoneJpeg(width: number, height: number, orientation: number | null): Uint8Array {
  const out = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  if (orientation !== null) {
    const tiff = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x02, 0x00];
    tiff.push(0x0f, 0x01, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, ...Buffer.from('Cam\0', 'latin1')); // Make, ASCII
    tiff.push(0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00); // Orientation, SHORT
    tiff.push(0x00, 0x00, 0x00, 0x00);
    const length = 2 + 6 + tiff.length;
    out.push(0xff, 0xe1, length >> 8, length & 0xff, ...Buffer.from('Exif\0\0', 'latin1'), ...tiff);
  }
  out.push(0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array<number>(64).fill(1)); // a quantization table
  out.push(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0);
  out.push(0xff, 0xda, 0x00, 0x0c, 0x03, 1, 0x00, 2, 0x11, 3, 0x11, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0x00, 0x56);
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}

/** The events of `xml` by our own reader, which refuses anything that is not well-formed. */
function readXml(xml: string): XmlEvent[] {
  const reader = createXmlReader();
  return [...reader.write(xml), ...reader.end()];
}

/** The text of every `<script type="application/ld+json">` element of `html`, parsed. */
function jsonLd(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
}

/** The markup of the `<section>` whose heading has the id `id`. */
function section(html: string, id: string): string {
  return new RegExp(`<section[^>]*aria-labelledby="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html)?.[1] ?? '';
}

/** The hrefs of the links of `markup`, in order (entity-decoded `&amp;`). */
const hrefs = (markup: string): string[] => [...markup.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]!.replaceAll('&amp;', '&'));

/** The content of `<meta name|property="key">` in `html` (entity-decoded `&amp;`), all of them. */
const metas = (html: string, key: string): string[] =>
  [...html.matchAll(new RegExp(`<meta (?:name|property)="${key.replace(/[.:]/g, '\\$&')}" content="([^"]*)"`, 'g'))].map((m) => m[1]!.replaceAll('&amp;', '&'));

/** The rows (`<tr>` of `<tbody>`) of the availability table, each as its cells' text. */
function availabilityRows(html: string): string[][] {
  const body = /<table class="availability"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? '';
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => cell[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()),
  );
}

describe('imageSize: the size of a floor plan from its first bytes', () => {
  it('reads PNG, GIF, JPEG (after other segments), and WebP VP8X, VP8 and VP8L', () => {
    expect(imageSize(pngHeader(1600, 800))).toEqual({ width: 1600, height: 800 });
    expect(imageSize(new Uint8Array([...Buffer.from('GIF89a'), 0x20, 0x03, 0x58, 0x02, 0, 0, 0]))).toEqual({ width: 800, height: 600 });
    const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
    jpeg.push(0xff, 0xdb, 0x00, 0x04, 0x00, 0x00); // a table first
    jpeg.push(0xff, 0xc2, 0x00, 0x11, 0x08, 0x02, 0x58, 0x04, 0x00, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1); // progressive SOF: 600 × 1024
    expect(imageSize(new Uint8Array(jpeg))).toEqual({ width: 1024, height: 600 });
    const riff = (chunk: string, payload: number[]): Uint8Array => {
      const b = Buffer.alloc(20 + payload.length);
      b.write('RIFF', 0, 'latin1');
      b.writeUInt32LE(12 + payload.length, 4);
      b.write('WEBP', 8, 'latin1');
      b.write(chunk, 12, 'latin1');
      b.writeUInt32LE(payload.length, 16);
      Buffer.from(payload).copy(b, 20);
      return new Uint8Array(b);
    };
    // VP8X: canvas 1200 × 900 (minus one, 24-bit little endian).
    expect(imageSize(riff('VP8X', [0, 0, 0, 0, 0xaf, 0x04, 0x00, 0x83, 0x03, 0x00]))).toEqual({ width: 1200, height: 900 });
    // VP8: the key frame's start code, then 14-bit width and height.
    expect(imageSize(riff('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00]))).toEqual({ width: 320, height: 240 });
    // VP8L: the signature 0x2f, then width - 1 and height - 1 in 14 bits each: 640 × 480.
    const bits = 639 | (479 << 14);
    expect(imageSize(riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff]))).toEqual({ width: 640, height: 480 });
  });

  it('a JPEG whose EXIF Orientation turns it a quarter (5-8) is as wide as its frame is high, as a browser draws it (review C15)', () => {
    // As stored: the metadata stripper keeps an Orientation of 2-8 alone, in a block of its own.
    for (const o of [1, 2, 3, 4]) expect(imageSize(stripImageMetadata(phoneJpeg(1600, 800, o), 'jpeg')), `orientation ${o}`).toEqual({ width: 1600, height: 800 });
    for (const o of [5, 6, 7, 8]) expect(imageSize(stripImageMetadata(phoneJpeg(1600, 800, o), 'jpeg')), `orientation ${o}`).toEqual({ width: 800, height: 1600 });
    // As the camera wrote it (little endian, other tags next to it): read the same way.
    expect(imageSize(phoneJpeg(1600, 800, 6))).toEqual({ width: 800, height: 1600 });
    expect(imageSize(phoneJpeg(1600, 800, null))).toEqual({ width: 1600, height: 800 });
    // An EXIF block whose structure does not hold (not TIFF 42) turns nothing, as in the browser and the stripper.
    const broken = phoneJpeg(1600, 800, 6);
    broken[Buffer.from(broken).indexOf('II*\0', 0, 'latin1') + 2] = 43;
    expect(imageSize(broken)).toEqual({ width: 1600, height: 800 });
  });

  it('answers null for anything else, a truncated header and an empty size', () => {
    expect(imageSize(new Uint8Array(0))).toBeNull();
    expect(imageSize(new Uint8Array(Buffer.from('%PDF-1.4\n')))).toBeNull();
    expect(imageSize(pngHeader(1600, 800).subarray(0, 20))).toBeNull();
    expect(imageSize(pngHeader(0, 800))).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBeNull();
  });
});

describe.skipIf(!ctx.available)(`OPAC record detail [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  /** The same database behind an app whose ops fence says a maintenance is on. */
  let maintenanceApp: ReturnType<typeof createApp>;
  let peerSerial = 0;

  let buku: string;
  let indonesian: string;
  let branchId: string;
  let umum: string;
  let planId: string;
  let roomId: string;
  let shelfId: string;
  let hiddenShelfId: string;

  // The main record and what it holds.
  let main: string;
  let coverId: string;
  let pdf: { attachmentId: string; fileId: string };
  let staffPdf: { attachmentId: string; fileId: string };
  let audio: { attachmentId: string; fileId: string };
  let video: { attachmentId: string; fileId: string };
  let image: { attachmentId: string; fileId: string };
  let zip: { attachmentId: string; fileId: string };
  let archivedAttachment: string;
  let jsLink: string;
  let webLink: string;
  let agentId: string;
  let illustratorId: string;
  let subjectId: string;
  let sangPemimpi: string;
  let maryamah: string;
  let rahasia: string;
  // Other records.
  let hidden: string;
  let archived: string;
  let chain: { a: string; b: string; c: string };
  let many: string;

  async function request(p: string, o: { method?: string; headers?: Record<string, string>; app?: ReturnType<typeof createApp> } = {}) {
    peerSerial += 1;
    const res = await (o.app ?? app).request(
      p,
      { method: o.method ?? 'GET', headers: new Headers(o.headers ?? HTML) },
      { incoming: { socket: { remoteAddress: `198.18.34.${(peerSerial % 250) + 1}` } } },
    );
    return { status: res.status, headers: res.headers, text: await res.text() };
  }
  const get = (p: string, headers?: Record<string, string>) => request(p, headers === undefined ? {} : { headers });

  async function setSettings(patch: Record<string, unknown>): Promise<void> {
    await withTx(h, (trx) => writeSettings(trx, patch, { keyring: CONFIG.keyring, now: NOW, actorId: null }).then(() => undefined));
  }

  const run = <T>(fn: (tx: ReturnType<typeof txCtx>) => Promise<T>): Promise<T> => withTx(h, (trx) => fn(txCtx(trx, NOW, ACTOR)));

  async function record(body: Omit<RecordCreateBody, 'materialTypeId'>): Promise<string> {
    return (await run((tx) => createRecord(tx, { materialTypeId: buku, ...body }))).id;
  }

  /** Merges `source` into `target` (its version read first: a read through `h` inside the transaction would wait for it on SQLite). */
  async function merge(target: string, source: string): Promise<void> {
    const version = Number((await h.db.selectFrom('records').select('version').where('id', '=', target).executeTakeFirstOrThrow()).version);
    await run((tx) => mergeRecord(tx, target, source, version));
  }

  /** A stored file: its blob in DATA_DIR and its `files` row. */
  async function storedFile(data: Uint8Array, o: { mime: string; name: string; context: string; access: 'public' | 'staff'; ownerType?: string; ownerId?: string }): Promise<string> {
    const id = newId();
    await localStorageDriver(dataDir).put(id, data, { size: data.byteLength, sha256: sha(data) });
    await h.db
      .insertInto('files')
      .values({
        id,
        original_name: o.name,
        mime: o.mime,
        size: data.byteLength,
        sha256: sha(data),
        context: o.context,
        owner_type: o.ownerType ?? null,
        owner_id: o.ownerId ?? null,
        access: o.access,
        status: 'ok',
        created_at: NOW,
        created_by: null,
      })
      .execute();
    return id;
  }

  let attachmentOrder = 100;
  /** An attachment row of `recordId`, written directly (a file one with its stored file). */
  async function attachment(
    recordId: string,
    o: { title: string; access?: 'public' | 'staff'; url?: string; file?: { mime: string; name: string; data?: Uint8Array }; archived?: boolean; description?: string },
  ): Promise<{ attachmentId: string; fileId: string }> {
    const attachmentId = newId();
    const access = o.access ?? 'public';
    const fileId =
      o.file === undefined
        ? ''
        : await storedFile(o.file.data ?? new Uint8Array(Buffer.from(`isi ${o.title}`)), {
            mime: o.file.mime,
            name: o.file.name,
            context: 'catalog.attachment',
            access: o.archived === true ? 'staff' : access,
            ownerType: 'attachments',
            ownerId: attachmentId,
          });
    attachmentOrder += 1;
    await h.db
      .insertInto('attachments')
      .values({
        id: attachmentId,
        record_id: recordId,
        kind: o.file === undefined ? 'url' : 'file',
        file_id: o.file === undefined ? null : fileId,
        url: o.url ?? null,
        title: o.title,
        description: o.description ?? null,
        access,
        legacy_access_limit: null,
        read_count: 0,
        sort_order: attachmentOrder,
        archived_at: o.archived === true ? NOW : null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return { attachmentId, fileId };
  }

  async function location(o: {
    kind: 'room' | 'area' | 'shelf';
    code: string;
    name: string;
    parentId?: string;
    hint?: string;
    mapFileId?: string;
    box?: { x: number; y: number; w: number; h: number };
    isPublic?: boolean;
  }): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('locations')
      .values({
        id,
        branch_id: branchId,
        parent_id: o.parentId ?? null,
        kind: o.kind,
        code_display: o.code,
        code_key: normalizeKey(o.code),
        name: o.name,
        shelf_hint: o.hint ?? null,
        class_from: null,
        class_to: null,
        map_file_id: o.mapFileId ?? null,
        map_x: o.box?.x ?? null,
        map_y: o.box?.y ?? null,
        map_w: o.box?.w ?? null,
        map_h: o.box?.h ?? null,
        is_public: o.isPublic === false ? 0 : 1,
        archived_at: null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return id;
  }

  /** An item of `recordId`, written directly (Task 17 writes them through its service), with a purchase price. */
  async function item(recordId: string, o: { barcode: string; status: string; locationId?: string; callNumber?: string; archived?: boolean }): Promise<void> {
    await h.db
      .insertInto('items')
      .values({
        id: newId(),
        record_id: recordId,
        branch_id: branchId,
        barcode_display: o.barcode,
        barcode_key: o.barcode.toUpperCase(),
        inventory_no: null,
        call_number: o.callNumber ?? null,
        location_id: o.locationId ?? null,
        collection_type_id: umum,
        status: o.status,
        status_note: null,
        acq_source: 'purchase',
        order_no: 'PO-7731',
        order_date: null,
        received_date: null,
        invoice_date: null,
        supplier_id: null,
        invoice_no: 'INV-5521',
        // 125 000.00 in the minor unit (§3.4).
        price: 12_500_000,
        currency: 'IDR',
        note: null,
        archived_at: o.archived === true ? NOW : null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
  }

  async function customField(code: string, o: { isPublic: boolean; type?: string; options?: unknown }): Promise<void> {
    await h.db
      .insertInto('custom_field_defs')
      .values({
        id: newId(),
        entity: 'records',
        code_key: normalizeKey(code),
        code_display: code,
        label: `Label ${code}`,
        label_en: `Label EN ${code}`,
        type: o.type ?? 'text',
        options: o.options === undefined ? null : JSON.stringify(o.options),
        is_required: 0,
        is_public: o.isPublic ? 1 : 0,
        archived_at: null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
  }

  const readCount = async (attachmentId: string): Promise<number> =>
    Number((await h.db.selectFrom('attachments').select('read_count').where('id', '=', attachmentId).executeTakeFirstOrThrow()).read_count);

  /** Waits until `attachmentId` has been read `n` times (the count runs after the response), at most 5 s. */
  async function readCountReaches(attachmentId: string, n: number): Promise<number> {
    const until = Date.now() + 5000;
    let count = await readCount(attachmentId);
    while (count < n && Date.now() < until) {
      await sleep(20);
      count = await readCount(attachmentId);
    }
    return count;
  }

  const pageOf = (id: string, title: string): string => recordUrlPath(id, title);

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-opac-detail-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir);
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    buku = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
    indonesian = (await h.db.selectFrom('languages').select('id').where('code_key', '=', 'IND').executeTakeFirstOrThrow()).id;
    umum = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
    branchId = newId();
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'Pusat', name: 'Perpustakaan Pusat', address: null, timezone: 'Asia/Jakarta', created_at: NOW, created_by: null, updated_at: NOW, updated_by: null })
      .execute();
    await setSettings({ 'library.name': 'Perpustakaan SMA Negeri 1', 'catalog.marcOrgCode': 'SMAN1' });

    // The floor plan of "Lantai 2" (1600 × 800) and two shelves on it, one not public.
    roomId = newId();
    planId = await storedFile(pngHeader(1600, 800), { mime: 'image/png', name: 'denah.png', context: 'catalog.floor_plan', access: 'public', ownerType: 'locations', ownerId: roomId });
    await h.db
      .insertInto('locations')
      .values({
        id: roomId,
        branch_id: branchId,
        parent_id: null,
        kind: 'room',
        code_display: 'L2',
        code_key: 'L2',
        name: 'Lantai 2',
        shelf_hint: null,
        class_from: null,
        class_to: null,
        map_file_id: planId,
        map_x: null,
        map_y: null,
        map_w: null,
        map_h: null,
        is_public: 1,
        archived_at: null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    shelfId = await location({ kind: 'shelf', code: 'R800', name: 'Rak 800-899', parentId: roomId, hint: '800-899 Lt. 2', box: { x: 100, y: 200, w: 150, h: 300 } });
    hiddenShelfId = await location({ kind: 'shelf', code: 'GUDANG', name: 'Rak gudang', parentId: roomId, box: { x: 700, y: 100, w: 100, h: 100 }, isPublic: false });

    await customField('catatan_publik', { isPublic: true });
    await customField('format_asli', { isPublic: true, type: 'select', options: [{ value: 'hc', label_id: 'Sampul keras', label_en: 'Hardcover' }] });
    await customField('catatan_staf', { isPublic: false });

    sangPemimpi = await record({ title: 'Sang Pemimpi' });
    main = await record({
      title: 'Laskar Pelangi',
      subtitle: 'sebuah novel',
      responsibility: 'Andrea Hirata',
      edition: 'Cet. 5',
      publisher: { name: 'Bentang Pustaka', place: 'Yogyakarta' },
      publicationPlace: 'Yogyakarta',
      publicationYear: '2005',
      physicalDesc: '529 hlm. ; 20 cm',
      classification: '899.221 3',
      callNumber: '899.221 3 HIR l',
      languageId: indonesian,
      summary: `Kisah sepuluh anak Belitung yang bersekolah di SD Muhammadiyah. ${'Persahabatan dan mimpi mereka. '.repeat(10)}`,
      notes: 'Novel pertama dari tetralogi.',
      identifiers: [{ type: 'isbn', value: '978-0-306-40615-7' }],
      agents: [
        { ref: { type: 'person', name: 'Hirata, Andrea' }, role: 'aut', isMain: true },
        { ref: { type: 'person', name: 'Sasongko, Dodi' }, role: 'ill', isMain: false },
      ],
      subjects: [
        { ref: { type: 'topic', term: 'Persahabatan' }, isPrimary: true },
        { ref: { type: 'geographic', term: 'Belitung' }, isPrimary: false },
      ],
      relations: [{ relatedId: sangPemimpi, type: 'related' }],
      custom: { catatan_publik: 'Bertanda tangan penulis', format_asli: 'hc', catatan_staf: 'Rak gudang nomor tiga' },
      links: [{ url: 'https://penerbit.example/laskar-pelangi', title: 'Situs penerbit' }],
      marcExtra: [
        { tag: '541', ind1: ' ', ind2: ' ', data: JSON.stringify([['a', 'Toko Buku Sinar'], ['c', 'Rp125.000']]) },
        { tag: '952', ind1: ' ', ind2: ' ', data: JSON.stringify([['g', '125000']]) },
        { tag: '586', ind1: ' ', ind2: ' ', data: JSON.stringify([['a', 'Pemenang lomba novel']]) },
      ],
    });
    maryamah = await record({ title: 'Maryamah Karpov', relations: [{ relatedId: main, type: 'part_of' }] });
    rahasia = await record({ title: 'Rahasia Dapur', opacVisible: false, relations: [{ relatedId: main, type: 'related' }] });

    const row = await h.db.selectFrom('record_agents as ra').innerJoin('agents as a', 'a.id', 'ra.agent_id').select(['a.id', 'ra.role']).where('ra.record_id', '=', main).execute();
    agentId = row.find((r) => r.role === 'aut')!.id;
    illustratorId = row.find((r) => r.role === 'ill')!.id;
    subjectId = (await h.db.selectFrom('subjects').select('id').where('term_display', '=', 'Persahabatan').executeTakeFirstOrThrow()).id;
    webLink = (await h.db.selectFrom('attachments').select('id').where('record_id', '=', main).where('kind', '=', 'url').executeTakeFirstOrThrow()).id;

    coverId = await storedFile(new Uint8Array(Buffer.from('sampul')), { mime: 'image/webp', name: 'sampul.webp', context: 'catalog.cover', access: 'public', ownerType: 'records', ownerId: main });
    await h.db.updateTable('records').set({ cover_file_id: coverId }).where('id', '=', main).execute();

    pdf = await attachment(main, { title: 'Bab 1 (PDF)', description: 'Cuplikan bab pertama.', file: { mime: 'application/pdf', name: 'bab-1.pdf', data: new Uint8Array(Buffer.from('%PDF-1.4\n% isi bab satu\n')) } });
    staffPdf = await attachment(main, { title: 'Catatan internal', access: 'staff', file: { mime: 'application/pdf', name: 'internal.pdf' } });
    audio = await attachment(main, { title: 'Wawancara penulis', file: { mime: 'audio/mpeg', name: 'wawancara.mp3' } });
    video = await attachment(main, { title: 'Cuplikan film', file: { mime: 'video/mp4', name: 'cuplikan.mp4' } });
    image = await attachment(main, { title: 'Foto sampul asli', file: { mime: 'image/png', name: 'foto.png' } });
    zip = await attachment(main, { title: 'Data penelitian', file: { mime: 'application/zip', name: 'data.zip' } });
    archivedAttachment = (await attachment(main, { title: 'Lampiran lama', archived: true, file: { mime: 'application/pdf', name: 'lama.pdf' } })).attachmentId;
    // S4: written straight into the table, past insertUrlAttachments.
    jsLink = (await attachment(main, { title: 'Tautan berbahaya', url: 'javascript:alert(1)' })).attachmentId;

    await item(main, { barcode: 'B0001', status: 'available', locationId: shelfId });
    await item(main, { barcode: 'B0002', status: 'on_order', callNumber: '899.221 3 HIR l c.2' });
    await item(main, { barcode: 'B0003', status: 'lost', locationId: shelfId });
    await item(main, { barcode: 'B0004', status: 'withdrawn', archived: true });
    await item(main, { barcode: 'B0005', status: 'not_for_loan', locationId: hiddenShelfId });

    hidden = await record({ title: 'Buku Tersembunyi', opacVisible: false });
    archived = await record({ title: 'Akan Diarsipkan' });
    await h.db.updateTable('records').set({ archived_at: NOW }).where('id', '=', archived).execute();

    // Review Focus 4: A merged into B, then B into C.
    chain = { a: await record({ title: 'Cantuman A' }), b: await record({ title: 'Cantuman B' }), c: await record({ title: 'Cantuman C' }) };
    await merge(chain.b, chain.a);
    await merge(chain.c, chain.b);

    many = await record({ title: 'Banyak Lampiran' });
    for (let i = 1; i <= 22; i += 1) await attachment(many, { title: `Tautan ${String(i).padStart(2, '0')}`, url: `https://contoh.example/${i}` });

    const clock = () => NOW;
    const settings = createSettingsCache({ ttlMs: 0 });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'opac-detail', log: recordingLogger(), clock, env: {}, dataDir, services: { settings } });
    const flag: MaintenanceFlag = flagOf('manual', null, NOW);
    const opsFence = createOpsFence({
      dataDir,
      intervalMs: 0,
      clock: () => Date.now(),
      onEpoch() {},
      onOpEnded() {},
      reads: { maintenance: async () => flag, epoch: async () => 0, op: async () => null },
    });
    maintenanceApp = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'opac-detail-maintenance',
      log: recordingLogger(),
      clock,
      env: {},
      dataDir,
      services: { settings, opsFence },
    });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  it('the routes: ris, bibtex, marcxml and lampiran before /katalog/:id and /katalog/:id/:slug; public, session none, read, maintenance allow', () => {
    expect(OPAC_DETAIL_ROUTES.map((d) => `${d.method} ${d.path} ${d.id}`)).toEqual([
      'GET /katalog/:id/ris opac.record.ris',
      'GET /katalog/:id/bibtex opac.record.bibtex',
      'GET /katalog/:id/marcxml opac.record.marcxml',
      'GET /katalog/:id/lampiran/:aid opac.record.attachment',
      'GET /katalog/:id opac.record',
      'GET /katalog/:id/:slug opac.record.slug',
    ]);
    for (const d of OPAC_DETAIL_ROUTES) {
      expect(d, d.id).toMatchObject({ public: true, session: 'none', maintenance: 'allow', idempotency: 'none', audit: null });
      expect(d.mode ?? 'read').toBe('read');
      expect(d.query).toBeUndefined();
      expect(ALL_ROUTES).toContain(d);
    }
    const ids = ALL_ROUTES.map((d) => d.id);
    expect(ids.indexOf('opac.record.ris')).toBeLessThan(ids.indexOf('opac.record.slug'));
  });

  describe('URLs and redirects', () => {
    it('no slug or a wrong slug → 301 to the canonical URL (the language kept); the canonical URL → 200', async () => {
      const canonical = pageOf(main, 'Laskar Pelangi');
      expect(canonical).toBe(`/katalog/${main}/laskar-pelangi`);
      for (const p of [`/katalog/${main}`, `/katalog/${main}/judul-lama`, `/katalog/${main}/Laskar-Pelangi`]) {
        const res = await get(p);
        expect([res.status, res.headers.get('location')], p).toEqual([301, canonical]);
        // C13: the slug follows the title, which can change back: a kept 301 would loop.
        expect(res.headers.get('cache-control'), p).toBe('no-store');
      }
      const en = await get(`/katalog/${main}/salah?lang=en&utm_source=x`);
      expect([en.status, en.headers.get('location')]).toEqual([301, `${canonical}?lang=en`]);
      const page = await get(canonical);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    });

    it('Review Focus 4: after A→B→C, /katalog/A answers one 301 to C, which is 200; so does B', async () => {
      const target = pageOf(chain.c, 'Cantuman C');
      for (const p of [`/katalog/${chain.a}`, `/katalog/${chain.a}/cantuman-a`, `/katalog/${chain.b}/cantuman-b`, `/katalog/${chain.b}`]) {
        const res = await get(p);
        expect([res.status, res.headers.get('location')], p).toEqual([301, target]);
        expect(res.headers.get('cache-control'), p).toBe('no-store');
      }
      expect((await get(target)).status).toBe(200);
      const en = await get(`/katalog/${chain.a}?lang=en`);
      expect(en.headers.get('location')).toBe(`${target}?lang=en`);
    });

    it('S17: hidden, archived, unknown or malformed → the OPAC 404 page in HTML, noindex, never a thrown NOT_FOUND', async () => {
      for (const p of [
        pageOf(hidden, 'Buku Tersembunyi'),
        `/katalog/${hidden}`,
        pageOf(archived, 'Akan Diarsipkan'),
        `/katalog/${newId()}/judul`,
        '/katalog/bukan-ulid',
        `/katalog/${main.toLowerCase()}/laskar-pelangi`,
      ]) {
        const res = await get(p);
        expect(res.status, p).toBe(404);
        expect(res.headers.get('content-type'), p).toBe('text/html; charset=utf-8');
        expect(res.text, p).toContain(esc(t('id', 'opac.not_found.title')));
        expect(res.text, p).toContain('<meta name="robots" content="noindex"');
        expect(res.text, p).not.toContain('Buku Tersembunyi');
      }
    });

    it('a record titled "RIS": its canonical URL /katalog/<id>/ris is its page, and its RIS download asks with ?unduh=1', async () => {
      const ris = await record({ title: 'RIS' });
      expect(pageOf(ris, 'RIS')).toBe(`/katalog/${ris}/ris`);
      expect((await get(`/katalog/${ris}`)).headers.get('location')).toBe(`/katalog/${ris}/ris`);
      const page = await get(`/katalog/${ris}/ris`);
      expect([page.status, page.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8']);
      expect(page.text).toContain('<h1>RIS</h1>');
      const cite = /<details class="citations">([\s\S]*?)<\/details>/.exec(page.text)?.[1] ?? '';
      expect(hrefs(cite)).toEqual([`/katalog/${ris}/ris?unduh=1`, `/katalog/${ris}/bibtex`, `/katalog/${ris}/marcxml`]);
      const file = await get(`/katalog/${ris}/ris?unduh=1`);
      expect([file.status, file.headers.get('content-disposition')]).toEqual([200, 'attachment; filename="ris.ris"']);
      expect((await get(`/katalog/${ris}/bibtex`)).headers.get('content-type')).toBe('application/x-bibtex; charset=utf-8');
    });

    it('a merged record titled "RIS": its old page /katalog/<id>/ris → 301 to the live record page; ?unduh=1 → its download', async () => {
      const source = await record({ title: 'RIS' });
      const target = await record({ title: 'Tujuan Gabungan' });
      await merge(target, source);
      const page = await get(`/katalog/${source}/ris`);
      expect([page.status, page.headers.get('location')]).toEqual([301, pageOf(target, 'Tujuan Gabungan')]);
      const en = await get(`/katalog/${source}/ris?lang=en`);
      expect(en.headers.get('location')).toBe(`${pageOf(target, 'Tujuan Gabungan')}?lang=en`);
      const file = await get(`/katalog/${source}/ris?unduh=1`);
      expect([file.status, file.headers.get('location')]).toEqual([301, `/katalog/${target}/ris`]);
      // A download of a source whose slug is another name still goes to the download.
      const bib = await get(`/katalog/${source}/bibtex`);
      expect([bib.status, bib.headers.get('location')]).toEqual([301, `/katalog/${target}/bibtex`]);
    });

    it('a merge chain whose live record is hidden ends at the 404 page, not at a redirect', async () => {
      const x = await record({ title: 'Sumber X' });
      const y = await record({ title: 'Tujuan Y', opacVisible: false });
      await merge(y, x);
      const res = await get(`/katalog/${x}`);
      expect(res.status).toBe(404);
    });
  });

  describe('the page', () => {
    let html: string;
    let csp: string;
    beforeAll(async () => {
      const res = await get(pageOf(main, 'Laskar Pelangi'), { ...HTML, Host: 'evil.example' });
      expect(res.status).toBe(200);
      html = res.text;
      csp = res.headers.get('content-security-policy') ?? '';
    });

    it('title, subtitle, cover, agents to /cari?pengarang=, subjects to /cari?subjek=, summary and notes', () => {
      expect(html).toContain('<h1>Laskar Pelangi<span class="record-subtitle">: sebuah novel</span></h1>');
      expect(html).toContain(`<title>Laskar Pelangi: sebuah novel · Perpustakaan SMA Negeri 1</title>`);
      expect(html).toContain(`src="/files/${coverId}"`);
      expect(hrefs(html)).toEqual(expect.arrayContaining([`/cari?pengarang=${agentId}`, `/cari?pengarang=${illustratorId}`, `/cari?subjek=${subjectId}`]));
      expect(html).toContain('Hirata, Andrea');
      expect(html).toContain(esc(t('id', 'vocab.relator.ill')));
      expect(section(html, 'ringkasan')).toContain('Kisah sepuluh anak Belitung');
      expect(section(html, 'catatan')).toContain('Novel pertama dari tetralogi.');
    });

    it('the description: publisher, year, edition, physical description, call number, language, ISBN', () => {
      const d = section(html, 'deskripsi');
      for (const text of ['Bentang Pustaka', 'Yogyakarta', '2005', 'Cet. 5', '529 hlm. ; 20 cm', '899.221 3 HIR l', 'Indonesia', '978-0-306-40615-7']) {
        expect(d, text).toContain(text);
      }
      expect(d).toContain(esc(t('id', 'vocab.field.publisher')));
    });

    it('relations both ways, only to visible records; public custom fields under "Informasi lain", never a staff one', () => {
      const r = section(html, 'relasi');
      expect(hrefs(r)).toEqual(expect.arrayContaining([pageOf(sangPemimpi, 'Sang Pemimpi'), pageOf(maryamah, 'Maryamah Karpov')]));
      expect(r).not.toContain(rahasia);
      expect(html).not.toContain('Rahasia Dapur');
      const custom = section(html, 'informasi-lain');
      expect(html).toContain(esc(opacText('id', 'detail.custom')));
      expect(custom).toContain('Label catatan_publik');
      expect(custom).toContain('Bertanda tangan penulis');
      expect(custom).toContain('Sampul keras');
      expect(html).not.toContain('Rak gudang nomor tiga');
      expect(html).not.toContain('Label catatan_staf');
    });

    it('attachments: the public ones link to their viewer; no staff or archived one; S4: javascript: is never linked', () => {
      const a = section(html, 'lampiran');
      const viewer = (aid: string): string => `/katalog/${main}/lampiran/${aid}`;
      // In their order: the link the record was created with first, then the files.
      expect(hrefs(a)).toEqual([viewer(webLink), ...[pdf, audio, video, image, zip].map((x) => viewer(x.attachmentId))]);
      expect(a).toContain('Tautan berbahaya');
      expect(html).not.toContain('javascript:');
      expect(hrefs(html)).not.toContain(viewer(jsLink));
      for (const gone of ['Catatan internal', 'Lampiran lama', staffPdf.attachmentId, staffPdf.fileId, archivedAttachment]) expect(html, gone).not.toContain(gone);
    });

    it('at most 20 attachments are listed', async () => {
      const res = await get(pageOf(many, 'Banyak Lampiran'));
      const links = hrefs(section(res.text, 'lampiran'));
      expect(links).toHaveLength(20);
      expect(res.text).toContain('Tautan 20');
      expect(res.text).not.toContain('Tautan 21');
    });

    it('availability: branch, room › shelf with its hint, call number (the item own or the record one), barcode, status; no lost or withdrawn item; on_order reads "Dalam pemesanan"', () => {
      expect(section(html, 'ketersediaan')).toContain(esc(opacText('id', 'detail.availability')));
      const rows = availabilityRows(html);
      expect(rows.map((r) => r[3])).toEqual(['B0001', 'B0002', 'B0005']);
      expect(rows[0]).toEqual(['Perpustakaan Pusat', 'Lantai 2 › Rak 800-899 800-899 Lt. 2', '899.221 3 HIR l', 'B0001', t('id', 'vocab.item_status.available')]);
      expect(rows[1]).toEqual(['Perpustakaan Pusat', '—', '899.221 3 HIR l c.2', 'B0002', 'Dalam pemesanan']);
      // A shelf that is not public is not shown.
      expect(rows[2]![1]).toBe('—');
      expect(html).not.toContain('B0003');
      expect(html).not.toContain('B0004');
      expect(html).not.toContain('Rak gudang');
    });

    it('the shelf map: an inline SVG in <details> with the plan image and the shelf box, its <title> and aria-label', () => {
      const map = /<details class="shelf-map">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? '';
      expect(map).toContain('<svg');
      // The plan is 1600 × 800: the view box keeps its shape, and the box (per mille) is scaled to it.
      expect(map).toContain('viewBox="0 0 1000 500"');
      expect(map).toMatch(/<rect class="shelf shelf-here" x="100" y="100" width="150" height="150"/);
      // Review (Task 39e finding 1): the plan is a lazy <img> under the SVG, not an SVG <image>, which a browser fetches
      // at page load with the <details> closed (up to 10 plans of 5 MB a page); a lazy image that is not rendered is not
      // fetched until the map is opened. Its size is the plan's (no layout shift); the SVG over it carries the label.
      expect(map).not.toContain('<image');
      expect(map).toContain(`<div class="shelf-map-plan"><img src="/files/${planId}" alt="" width="1600" height="800" loading="lazy" decoding="async"/><svg`);
      expect(map).toContain('preserveAspectRatio="none" role="img"');
      expect(map).toContain('<title>Rak 800-899, Lantai 2</title>');
      expect(map).toContain('aria-label="Rak 800-899, Lantai 2"');
      // One map per shelf shown; the shelf that is not public has none.
      expect(html.match(/<details class="shelf-map">/g)).toHaveLength(1);
    });

    it('citations in <details>: APA, MLA and Chicago, with the RIS and BibTeX downloads', () => {
      const cite = /<details class="citations">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? '';
      for (const key of ['detail.cite.apa', 'detail.cite.mla', 'detail.cite.chicago'] as const) expect(cite).toContain(esc(opacText('id', key)));
      expect(cite).toContain('Hirata, A.');
      expect(cite).toContain('<em>Laskar Pelangi');
      expect(hrefs(cite)).toEqual(expect.arrayContaining([`/katalog/${main}/ris`, `/katalog/${main}/bibtex`]));
    });

    it('<head>: description ≤ 160, canonical and hreflang from baseUrl, Dublin Core, OpenGraph, the Twitter card', () => {
      const description = metas(html, 'description')[0]!;
      expect(Array.from(description).length).toBeLessThanOrEqual(160);
      expect(description.startsWith('Kisah sepuluh anak Belitung')).toBe(true);
      // Cut at a word, the sentence's own period replaced by the ellipsis.
      expect(description).toMatch(/mereka…$/);
      const canonical = `${BASE}${pageOf(main, 'Laskar Pelangi')}`;
      expect(html).toContain(`<link rel="canonical" href="${canonical}"/>`);
      expect(html).toContain(`<link rel="alternate" hreflang="en" href="${canonical}?lang=en"/>`);
      expect(html).not.toContain('evil.example');
      expect(html).toContain('<link rel="schema.DC" href="http://purl.org/dc/elements/1.1/"/>');
      expect(metas(html, 'DC.title')).toEqual(['Laskar Pelangi: sebuah novel']);
      expect(metas(html, 'DC.identifier')).toEqual(expect.arrayContaining(['urn:isbn:9780306406157']));
      for (const name of ['DC.creator', 'DC.subject', 'DC.date', 'DC.publisher', 'DC.language', 'DC.type', 'DC.format']) expect(metas(html, name).length, name).toBeGreaterThan(0);
      expect(metas(html, 'og:type')).toEqual(['book']);
      expect(metas(html, 'og:url')).toEqual([canonical]);
      expect(metas(html, 'og:image')).toEqual([`${BASE}/files/${coverId}`]);
      expect(metas(html, 'book:isbn')).toEqual(['9780306406157']);
      expect(metas(html, 'twitter:card')).toEqual(['summary']);
      // No OpenGraph property twice.
      for (const p of ['og:type', 'og:title', 'og:description', 'og:locale', 'og:image']) expect(metas(html, p), p).toHaveLength(1);
    });

    it('JSON-LD parses with @type Book and the ISBN; every <script> carries the response nonce (S6)', () => {
      const nonce = /'nonce-([A-Za-z0-9_-]+)'/.exec(csp)?.[1];
      expect(nonce).toBeDefined();
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const s of scripts) expect(s).toContain(`nonce="${nonce}"`);
      const [ld] = jsonLd(html);
      expect(ld).toMatchObject({ '@context': 'https://schema.org', '@type': 'Book', isbn: '9780306406157', name: 'Laskar Pelangi' });
      expect(ld!['@id']).toBe(`${BASE}${pageOf(main, 'Laskar Pelangi')}`);
      expect(ld!['image']).toBe(`${BASE}/files/${coverId}`);
    });

    it('?lang=en: the page in English, its links keep the language', async () => {
      const res = await get(`${pageOf(main, 'Laskar Pelangi')}?lang=en`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<html lang="en"');
      expect(res.text).toContain(esc(opacText('en', 'detail.availability')));
      expect(res.text).toContain(t('en', 'vocab.item_status.on_order'));
      expect(hrefs(res.text)).toEqual(expect.arrayContaining([`/cari?pengarang=${agentId}&lang=en`, `/katalog/${main}/lampiran/${pdf.attachmentId}?lang=en`]));
      expect(res.text).toContain('Label EN catatan_publik');
      expect(res.text).toContain('Hardcover');
    });

    it('every class the page and its viewers write is styled by the theme; no inline style', async () => {
      const pages = [html];
      for (const aid of [pdf.attachmentId, audio.attachmentId, image.attachmentId, zip.attachmentId, webLink]) pages.push((await get(`/katalog/${main}/lampiran/${aid}`)).text);
      pages.push((await get(pageOf(many, 'Banyak Lampiran'))).text);
      const classes = new Set(pages.flatMap((p) => [...p.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/))));
      expect(classes.size).toBeGreaterThan(40);
      // Names without a rule of their own: each marks an element whose look comes from the classes or the block around it.
      for (const hook of ['akun-link', 'foot-about', 'foot-tagline', 'top-today']) classes.delete(hook);
      for (const cls of classes) expect(OPAC_CSS, cls).toMatch(new RegExp(`\\.${cls}(?![\\w-])`));
      for (const p of pages) expect(p).not.toMatch(/<[a-z][^>]*\sstyle=/i);
    });

    it('a shelf without its own hint: the place is shown once, not again as the hint cut from its name', async () => {
      const longName = 'Rak koleksi referensi dan terbitan berkala lama';
      const shelf = await location({ kind: 'shelf', code: 'REF', name: longName, parentId: roomId });
      const r = await record({ title: 'Ensiklopedia Nusantara' });
      await item(r, { barcode: 'E0001', status: 'available', locationId: shelf });
      const res = await get(pageOf(r, 'Ensiklopedia Nusantara'));
      expect(availabilityRows(res.text)[0]![1]).toBe(`Lantai 2 › ${longName}`);
    });

    it('a floor plan from a phone held upright (a JPEG stored with EXIF Orientation 6): the map has the shape the browser draws it in (review C15)', async () => {
      // 1600 × 800 pixels turned a quarter by the browser: 800 wide, 1600 high. The <img> keeps that space before it
      // loads (no jump when the map is opened) and the view box has that shape, so the box is not stretched.
      const plan = await storedFile(stripImageMetadata(phoneJpeg(1600, 800, 6), 'jpeg'), { mime: 'image/jpeg', name: 'denah-l3.jpg', context: 'catalog.floor_plan', access: 'public' });
      const room = await location({ kind: 'room', code: 'L3', name: 'Lantai 3', mapFileId: plan });
      await h.db.updateTable('files').set({ owner_type: 'locations', owner_id: room }).where('id', '=', plan).execute();
      const shelf = await location({ kind: 'shelf', code: 'R900', name: 'Rak 900-999', parentId: room, box: { x: 100, y: 200, w: 150, h: 300 } });
      const r = await record({ title: 'Sejarah Nusantara' });
      await item(r, { barcode: 'S0001', status: 'available', locationId: shelf });
      const res = await get(pageOf(r, 'Sejarah Nusantara'));
      const map = /<details class="shelf-map">([\s\S]*?)<\/details>/.exec(res.text)?.[1] ?? '';
      expect(map).toContain(`<img src="/files/${plan}" alt="" width="800" height="1600" loading="lazy" decoding="async"/>`);
      expect(map).toContain('viewBox="0 0 1000 2000"');
      expect(map).toMatch(/<rect class="shelf shelf-here" x="100" y="400" width="150" height="600"/);
    });

    it('opac.showShelfMap off: no shelf map, the shelf path stays', async () => {
      await setSettings({ 'opac.showShelfMap': false });
      try {
        const res = await get(pageOf(main, 'Laskar Pelangi'));
        // The page's icons are small inline drawings; the map is the `<details class="shelf-map">` with the plan.
        expect(res.text).not.toContain('shelf-map');
        expect(res.text).not.toContain('viewBox="0 0 1000');
        expect(res.text).not.toContain(`/files/${planId}`);
        expect(availabilityRows(res.text)[0]![1]).toBe('Lantai 2 › Rak 800-899 800-899 Lt. 2');
      } finally {
        await setSettings({ 'opac.showShelfMap': true });
      }
    });
  });

  describe('downloads', () => {
    it('RIS: an attachment of type RIS, no price, no supplier, no order or invoice number (S5)', async () => {
      const res = await get(`/katalog/${main}/ris`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/x-research-info-systems; charset=utf-8');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="laskar-pelangi.ris"');
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
      expect(res.text).toMatch(/^TY {2}- BOOK\r\n/);
      expect(res.text).toContain('TI  - Laskar Pelangi');
      expect(res.text).toContain(`UR  - ${BASE}${pageOf(main, 'Laskar Pelangi')}`);
      for (const secret of ['125000', '125.000', '12500000', 'PO-7731', 'INV-5521', 'Toko Buku Sinar']) expect(res.text, secret).not.toContain(secret);
    });

    it('BibTeX: an attachment with a @book entry', async () => {
      const res = await get(`/katalog/${main}/bibtex`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/x-bibtex; charset=utf-8');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="laskar-pelangi.bib"');
      expect(res.text).toMatch(/^@book\{hirata2005,/);
      for (const secret of ['125000', '125.000', 'PO-7731']) expect(res.text, secret).not.toContain(secret);
    });

    it('S5: MARCXML for the public, without the 541 and 952 of marcExtra (their prices), with the 586 it keeps', async () => {
      const res = await get(`/katalog/${main}/marcxml`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/marcxml+xml; charset=utf-8');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="laskar-pelangi.xml"');
      const events = readXml(res.text);
      const tags = events.flatMap((e) => (e.type === 'open' && e.name === 'datafield' ? [e.attrs['tag']] : []));
      expect(tags).toEqual(expect.arrayContaining(['245', '586']));
      expect(tags).not.toContain('541');
      expect(tags).not.toContain('952');
      expect(tags).not.toContain('852');
      for (const secret of ['125000', '125.000', 'Toko Buku Sinar', 'PO-7731']) expect(res.text, secret).not.toContain(secret);
      expect(res.text).toContain('Pemenang lomba novel');
      expect(res.text).toContain('<controlfield tag="003">SMAN1</controlfield>');
    });

    it('a hidden record → the 404 page; a merged one → 301 to the live record download', async () => {
      for (const kind of ['ris', 'bibtex', 'marcxml']) {
        const gone = await get(`/katalog/${hidden}/${kind}`);
        expect([gone.status, gone.headers.get('content-type')], kind).toEqual([404, 'text/html; charset=utf-8']);
        const merged = await get(`/katalog/${chain.a}/${kind}`);
        expect([merged.status, merged.headers.get('location')], kind).toEqual([301, `/katalog/${chain.c}/${kind}`]);
      }
    });
  });

  describe('the attachment viewer', () => {
    const viewer = (aid: string, recordId = main): string => `/katalog/${recordId}/lampiran/${aid}`;

    it('PDF: "Buka PDF" in a new tab and "Unduh"; noindex; the record and its canonical viewer URL', async () => {
      const res = await get(viewer(pdf.attachmentId));
      expect(res.status).toBe(200);
      expect(res.text).toContain('<meta name="robots" content="noindex"');
      expect(res.text).toContain(`<link rel="canonical" href="${BASE}${viewer(pdf.attachmentId)}"/>`);
      expect(res.text).toContain('<h1>Bab 1 (PDF)</h1>');
      expect(res.text).toContain('Cuplikan bab pertama.');
      expect(res.text).toMatch(new RegExp(`<a [^>]*href="/files/${pdf.fileId}"[^>]*target="_blank"[^>]*rel="noopener"[^>]*>${esc(opacText('id', 'detail.viewer.pdf_open'))}</a>`));
      expect(res.text).toMatch(new RegExp(`<a [^>]*href="/files/${pdf.fileId}"[^>]*download="bab-1.pdf"[^>]*>${esc(opacText('id', 'detail.viewer.download'))}`));
      expect(hrefs(res.text)).toContain(pageOf(main, 'Laskar Pelangi'));
    });

    it('audio and video: <audio>/<video controls> on /files/<id>; image: <img> and a full-size link; anything else: a download link', async () => {
      const a = await get(viewer(audio.attachmentId));
      expect(a.text).toMatch(new RegExp(`<audio [^>]*controls[^>]*src="/files/${audio.fileId}"`));
      const v = await get(viewer(video.attachmentId));
      expect(v.text).toMatch(new RegExp(`<video [^>]*controls[^>]*src="/files/${video.fileId}"`));
      const i = await get(viewer(image.attachmentId));
      expect(i.text).toMatch(new RegExp(`<img [^>]*src="/files/${image.fileId}"[^>]*alt="Foto sampul asli"`));
      expect(i.text).toMatch(new RegExp(`<a href="/files/${image.fileId}">${esc(opacText('id', 'detail.viewer.image_full'))}</a>`));
      const z = await get(viewer(zip.attachmentId));
      expect(z.text).toMatch(new RegExp(`<a [^>]*href="/files/${zip.fileId}"[^>]*download="data.zip"`));
      expect(z.text).not.toContain('<audio');
      for (const res of [a, v, i, z]) expect(res.status).toBe(200);
    });

    it('URL: a leaving-the-site notice with rel="noopener nofollow"', async () => {
      const res = await get(viewer(webLink));
      expect(res.status).toBe(200);
      expect(res.text).toContain(esc(opacText('id', 'detail.viewer.leaving_title')));
      expect(res.text).toContain('<a href="https://penerbit.example/laskar-pelangi" rel="noopener nofollow">');
    });

    it('404 for a staff, archived or unknown attachment, a non-http(s) URL (S4), another record attachment, and a hidden record', async () => {
      for (const p of [
        viewer(staffPdf.attachmentId),
        viewer(archivedAttachment),
        viewer(newId()),
        viewer('bukan-ulid'),
        viewer(jsLink),
        viewer(pdf.attachmentId, sangPemimpi),
        viewer(pdf.attachmentId, hidden),
      ]) {
        const res = await get(p);
        expect([res.status, res.headers.get('content-type')], p).toEqual([404, 'text/html; charset=utf-8']);
        expect(res.text, p).not.toContain('javascript:');
      }
      // The staff file itself stays refused to a visitor (Task 18).
      expect((await get(`/files/${staffPdf.fileId}`)).status).toBe(401);
    });

    it('a merged record viewer → 301 to the live record viewer', async () => {
      const moved = await attachment(chain.c, { title: 'Pindahan', file: { mime: 'application/pdf', name: 'p.pdf' } });
      const res = await get(viewer(moved.attachmentId, chain.a));
      expect([res.status, res.headers.get('location')]).toEqual([301, viewer(moved.attachmentId, chain.c)]);
    });

    it('opening the viewer counts one read; a Range GET of the file, a HEAD of the viewer and a view during maintenance count none', async () => {
      const before = await readCount(pdf.attachmentId);
      expect((await get(viewer(pdf.attachmentId))).status).toBe(200);
      expect(await readCountReaches(pdf.attachmentId, before + 1)).toBe(before + 1);

      const range = await get(`/files/${pdf.fileId}`, { range: 'bytes=0-9' });
      expect(range.status).toBe(206);
      expect((await request(viewer(pdf.attachmentId), { method: 'HEAD' })).status).toBe(200);
      const during = await request(viewer(pdf.attachmentId), { app: maintenanceApp });
      expect(during.status).toBe(200);
      await sleep(300);
      expect(await readCount(pdf.attachmentId)).toBe(before + 1);

      // A second view counts again.
      await get(viewer(pdf.attachmentId));
      expect(await readCountReaches(pdf.attachmentId, before + 2)).toBe(before + 2);
    });
  });
});
