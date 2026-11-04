import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations, withTx, type DB, type DbHandle } from '@altis/db';
import { runWorkPath } from '@altis/platform';
import { newId } from '@altis/shared';
import type { MigrationSummary } from '@altis/shared/api/catalog/migration';
import { SelectQueryNode, type KyselyPlugin, type QueryId } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { codeKey } from '../../src/catalog/data/keys.js';
import { mapLegacy, type LegacyMapping } from '../../src/catalog/data/legacy-map.js';
import { titleKey } from '../../src/catalog/lib/title-key.js';
import { archiveRecord } from '../../src/catalog/records/service.js';
import type { CatalogJobDeps } from '../../src/catalog/jobs-deps.js';
import { txCtx, type Actor, type CoreLogger } from '../../src/context.js';
import type { KeyringEntry } from '../../src/crypto/secret-box.js';
import { localStorageDriver } from '../../src/files/serve.js';
import { claimById } from '../../src/jobs/claim.js';
import { createJobRegistry } from '../../src/jobs/registry.js';
import { runSlice } from '../../src/jobs/slice.js';
import { createCounters } from '../../src/migration/slims/counters.js';
import { __setSlimsSourceFactory, __setSlimsStages } from '../../src/migration/slims/factory.js';
import { startSlimsMigration, type SlimsStartInput } from '../../src/migration/slims/job.js';
import { slimsJobs } from '../../src/migration/slims/jobs.js';
import { slimsBarcode, withBarcodeSuffix } from '../../src/migration/slims/maps/barcode.js';
import { slimsAcqSource, slimsItemStatus } from '../../src/migration/slims/maps/item-status.js';
import { slimsPrice } from '../../src/migration/slims/maps/price.js';
import { cleanText } from '../../src/migration/slims/source/clean-text.js';
import { openFilesZip } from '../../src/migration/slims/source/files-source.js';
import type { SlimsRow } from '../../src/migration/slims/source/types.js';
import type { SlimsReportRow, SlimsStage, SlimsStageContext } from '../../src/migration/slims/stage.js';
import { archiveStage, fitArchiveRow } from '../../src/migration/slims/stages/archive.js';
import { attachableUrl, attachmentsStage } from '../../src/migration/slims/stages/attachments.js';
import { contentStage, droppedTags, slugOf } from '../../src/migration/slims/stages/content.js';
import { coversStage } from '../../src/migration/slims/stages/covers.js';
import { itemsStage, placeholderTitle } from '../../src/migration/slims/stages/items.js';
import { Ledger, __forgetSlimsStageBValues, __setSlimsStageBBatch } from '../../src/migration/slims/stages/stage-b-kit.js';
import { writeSettings } from '../../src/settings/service.js';
import { rawZip, type RawEntry } from '../helpers/raw-zip.js';
import { slimsFixtureBytes } from '../support/slims-fixture/index.js';

// The SLiMS migration's stages B (Phase 2 Task 38; spec §11.3 steps 5–9, §11.4, §11.5, §11.6; D2-27–D2-30; S4, S10,
// S13, M12, M13) on the synthetic fixture (Task 10) through the real framework (Task 23): the dump split for real, the
// files zip read for real, and a seeded stage in place of stages A (Task 37: records, rooms, collection types,
// suppliers and custom field definitions mapped the way its stages map them). Checked: the reconciliation of every
// table stages B read; the items (orphans under hidden placeholders, statuses, prices, barcodes, shelves); the
// attachments (S10, S4, missing files, access); covers; Halaman & Berita; the archive (M12); a dry run that writes
// nothing; a re-run that adds nothing; and a run stopped after every batch, or killed after its writes and before its
// counts were saved, that ends exactly as one never stopped.

const ctx = testDbContext();
const keyring: KeyringEntry[] = [{ kid: 'k1', key: randomBytes(32).toString('base64url'), active: true }];
const silent: CoreLogger = { info() {}, warn() {}, error() {} };
/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);
const MIB = 1024 * 1024;

/** The tables stages B read and account for (§11.4); `biblio` is the records stage's to count. */
const STAGE_B_TABLES = [
  'item',
  'item_custom',
  'mst_item_status',
  'biblio_attachment',
  'files',
  'files_read',
  'content',
  'serial',
  'kardex',
  'mst_frequency',
  'stock_take',
  'stock_take_item',
  'mst_label',
  'biblio_log',
] as const;
const ARCHIVED = ['serial', 'kardex', 'mst_frequency', 'stock_take', 'stock_take_item', 'mst_label', 'biblio_log', 'mst_item_status'] as const;

/** Every catalog table a run may write (the dry run must leave them all as they are). */
const CATALOG_TABLES = [
  'records',
  'items',
  'item_events',
  'locations',
  'collection_types',
  'suppliers',
  'attachments',
  'files',
  'pages',
  'page_translations',
  'search_doc',
  'search_facet',
  'migration_map',
  'migration_archive',
  'custom_field_defs',
  'custom_values',
] as const satisfies readonly (keyof DB)[];

// ---- images that hold metadata (the fixture's own cover and page image bytes are not well-formed images) ----------

/** A well-formed JPEG with an EXIF APP1 segment. */
function jpegWithExif(n: number): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1, 0x00, 0x10]),
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.alloc(8, 0x11),
    Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, n]),
    Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x00]),
    Buffer.alloc(32, n),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

/** A well-formed PNG with a tEXt chunk. */
function pngWithText(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk('tEXt', Buffer.from('Author\0Pustakawan Satu', 'latin1')),
    pngChunk('IDAT', Buffer.alloc(12, 3)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function bytesOf(it: AsyncIterable<Uint8Array> | null): Promise<Buffer> {
  if (it === null) throw new Error('no such file');
  const parts: Buffer[] = [];
  for await (const p of it) parts.push(Buffer.from(p));
  return Buffer.concat(parts);
}

// ---- the stand-in for stages A (Task 37) ---------------------------------------------------------------------------

async function allRows(c: SlimsStageContext, table: string): Promise<SlimsRow[]> {
  const rows: SlimsRow[] = [];
  let cursor: string | null = null;
  do {
    const batch: { rows: SlimsRow[]; next: string | null } = await c.source.rows(table, cursor, 500);
    rows.push(...batch.rows);
    cursor = batch.rows.length === 0 ? null : batch.next;
  } while (cursor !== null);
  return rows;
}

const text = (v: SlimsRow[string] | undefined): string => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : cleanText(v).value.trim());

/**
 * What stages A leave for stages B, the way Task 37 maps it: a record per `biblio` (entity `biblio`, hidden when
 * `opac_hide`), a room per `mst_location`, a collection type per `mst_coll_type`, a supplier per `mst_supplier`
 * (`SUP<id>`), and the custom field definitions of `item` and `biblio` (entity `mst_custom_field`, key `dbfield`, code =
 * `dbfield`). It counts what it reads, so the run reconciles.
 */
function seededStagesA(): SlimsStage {
  const tables = ['biblio', 'mst_location', 'mst_coll_type', 'mst_supplier', 'mst_custom_field'];
  return {
    name: 'masters',
    reads: tables,
    async run(c) {
      const data = new Map<string, SlimsRow[]>();
      for (const t of tables) data.set(t, await allRows(c, t));
      const fields = data.get('mst_custom_field')!.filter((r) => ['biblio', 'item'].includes(text(r['primary_table'])));
      c.counters.skipped('mst_custom_field', 'phase3', data.get('mst_custom_field')!.length - fields.length);
      // A second run of the same source finds every row mapped (Task 37: `already_migrated`, never updated).
      const mapped = await c.h.db.selectFrom('migration_map').select('legacy_key').where('source', '=', c.options.sourceName).where('entity', '=', 'biblio').limit(1).execute();
      const count = mapped.length > 0 ? (t: string, n: number) => c.counters.skipped(t, 'already_migrated', n) : (t: string, n: number) => c.counters.migrated(t, n);
      for (const t of tables.filter((t) => t !== 'mst_custom_field')) count(t, data.get(t)!.length);
      count('mst_custom_field', fields.length);
      if (c.dryRun || mapped.length > 0) return { done: true, cursor: null };
      await withTx(c.h, async (trx) => {
        const maps: LegacyMapping[] = [];
        const map = (entity: string, legacyKey: string, targetId: string): void => {
          maps.push({ source: c.options.sourceName, entity, legacyKey, targetId, runId: c.runId });
        };
        const buku = (await trx.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
        const trail = { archived_at: null, created_at: c.now, created_by: null, updated_at: c.now, updated_by: null };
        const records = data.get('biblio')!.map((r) => {
          const id = newId(c.now);
          const title = text(r['title']) || '-';
          map('biblio', text(r['biblio_id']), id);
          return {
            id,
            material_type_id: buku,
            title,
            subtitle: null,
            responsibility: null,
            title_key: titleKey(title),
            edition: null,
            material_detail: null,
            publisher_id: null,
            publication_place: null,
            publication_year: null,
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
            opac_visible: Number(r['opac_hide']) === 1 ? 0 : 1,
            source: `slims:${text(r['biblio_id'])}`,
            merged_into: null,
            changed_at: c.now,
            ...trail,
          };
        });
        for (let i = 0; i < records.length; i += 100) await trx.insertInto('records').values(records.slice(i, i + 100)).execute();
        // Masters a code of which exists already are merged into it (as Task 37 does): a second source shares them.
        for (const r of data.get('mst_location')!) {
          const code = text(r['location_id']);
          const found = await trx.selectFrom('locations').select('id').where('branch_id', '=', c.options.branchId).where('code_key', '=', code.toUpperCase()).executeTakeFirst();
          const id = found?.id ?? newId(c.now);
          if (found === undefined) {
            await trx
              .insertInto('locations')
              .values({
                id,
                branch_id: c.options.branchId,
                parent_id: null,
                kind: 'room',
                code_display: code,
                code_key: code.toUpperCase(),
                name: text(r['location_name']),
                shelf_hint: null,
                class_from: null,
                class_to: null,
                map_file_id: null,
                map_x: null,
                map_y: null,
                map_w: null,
                map_h: null,
                is_public: 1,
                sort_order: 0,
                ...trail,
              })
              .execute();
          }
          map('mst_location', code, id);
        }
        for (const r of data.get('mst_coll_type')!) {
          const name = text(r['coll_type_name']);
          const code = `SLIMS-${name.toUpperCase()}`;
          const found = await trx.selectFrom('collection_types').select('id').where('code_key', '=', code).executeTakeFirst();
          const id = found?.id ?? newId(c.now);
          if (found === undefined) {
            await trx
              .insertInto('collection_types')
              .values({ id, code_display: code, code_key: code, name_id: name, name_en: name, loanable: 1, self_service: 1, sort_order: 1000, ...trail })
              .execute();
          }
          map('mst_coll_type', text(r['coll_type_id']), id);
        }
        for (const r of data.get('mst_supplier')!) {
          const code = `SUP${text(r['supplier_id'])}`;
          const found = await trx.selectFrom('suppliers').select('id').where('code_key', '=', code).executeTakeFirst();
          const id = found?.id ?? newId(c.now);
          if (found === undefined) {
            await trx
              .insertInto('suppliers')
              .values({ id, code_display: code, code_key: code, name: text(r['supplier_name']), contact_name: null, phone: null, email: null, address: null, note: null, ...trail })
              .execute();
          }
          map('mst_supplier', text(r['supplier_id']), id);
        }
        for (const r of fields) {
          const dbfield = text(r['dbfield']);
          const item = text(r['primary_table']) === 'item';
          const select = text(r['type']) === 'dropdown';
          const entity = item ? 'items' : 'records';
          const found = await trx.selectFrom('custom_field_defs').select('id').where('entity', '=', entity).where('code_key', '=', dbfield.toUpperCase()).executeTakeFirst();
          const id = found?.id ?? newId(c.now);
          if (found === undefined) {
            await trx
              .insertInto('custom_field_defs')
              .values({
                id,
                entity,
                code_key: dbfield.toUpperCase(),
                code_display: dbfield,
                label: text(r['label']),
                label_en: null,
                type: select ? 'select' : text(r['type']) === 'longtext' ? 'longtext' : 'text',
                options: select
                  ? JSON.stringify([
                      { value: '1', label_id: 'Satu', label_en: null },
                      { value: '2', label_id: 'Dua', label_en: null },
                      { value: '3', label_id: 'Tiga', label_en: null },
                    ])
                  : null,
                is_required: 0,
                sort_order: 0,
                is_public: 0,
                is_searchable: 0,
                ...trail,
              })
              .execute();
          }
          map('mst_custom_field', dbfield, id);
        }
        await mapLegacy(trx, maps);
      });
      return { done: true, cursor: null };
    },
  };
}

/** Stages B as the run list has them. */
const stagesB = (): SlimsStage[] => [itemsStage, attachmentsStage, coversStage, contentStage, archiveStage];

/**
 * `stage`, whose first call runs once more after a "crash": its writes commit, but its counts and report rows are lost
 * with the process (the framework saves them only after the slice), so the framework calls it again from the same
 * cursor, as the next process would.
 */
function killedOnce(stage: SlimsStage): SlimsStage {
  let killed = false;
  return {
    name: stage.name,
    reads: stage.reads,
    async run(c, cursor) {
      if (!killed) {
        killed = true;
        const lost: SlimsStageContext = { ...c, counters: createCounters(null), report: () => {} };
        await stage.run(lost, cursor);
      }
      return stage.run(c, cursor);
    },
  };
}

describe('SLiMS stage B value maps (§11.4)', () => {
  it("statuses: '' and '0' → available; NL or no_loan → not_for_loan; R → repair; MIS → missing; others → available + note", () => {
    expect(slimsItemStatus('', null)).toEqual({ status: 'available', note: null, unknown: false });
    expect(slimsItemStatus('0', null)).toEqual({ status: 'available', note: null, unknown: false });
    expect(slimsItemStatus('NL', { name: 'No Loan', noLoan: true })).toEqual({ status: 'not_for_loan', note: null, unknown: false });
    expect(slimsItemStatus('XL', { name: 'Koleksi Langka', noLoan: true })).toEqual({ status: 'not_for_loan', note: null, unknown: false });
    expect(slimsItemStatus('R', { name: 'Repair', noLoan: true })).toEqual({ status: 'repair', note: null, unknown: false });
    expect(slimsItemStatus('MIS', { name: 'Missing', noLoan: true })).toEqual({ status: 'missing', note: null, unknown: false });
    expect(slimsItemStatus('RSV', { name: 'Dipesan', noLoan: false })).toEqual({ status: 'available', note: 'SLiMS: Dipesan (RSV)', unknown: true });
    expect(slimsItemStatus('ZZ', null)).toEqual({ status: 'available', note: 'SLiMS: ZZ', unknown: true });
    expect([1, 2, 0, null, '1', 'x'].map((s) => slimsAcqSource(s))).toEqual(['purchase', 'gift', 'other', 'other', 'purchase', 'other']);
  });

  it('barcodes: normalised; 1–2 characters nonstandard; outside 0x20–0x7E, too long or an ISBN → MIG<item_id> with the original; empty → MIG<id>', () => {
    expect(slimsBarcode(' b  0010 ', '10')).toEqual({ barcode: 'B 0010', outcome: 'ok', original: null });
    expect(slimsBarcode('7', '12')).toEqual({ barcode: '7', outcome: 'nonstandard', original: null });
    expect(slimsBarcode('B\u20130013', '13')).toEqual({ barcode: 'MIG13', outcome: 'replaced', reason: 'charset', original: 'B\u20130013' });
    expect(slimsBarcode('', '14')).toEqual({ barcode: 'MIG14', outcome: 'replaced', reason: 'empty', original: null });
    expect(slimsBarcode('X'.repeat(65), '15')).toMatchObject({ barcode: 'MIG15', outcome: 'replaced', reason: 'length' });
    expect(slimsBarcode('9786020332956', '16')).toMatchObject({ barcode: 'MIG16', outcome: 'replaced', reason: 'isbn_not_barcode' });
  });

  it('prices: major ×100, minor as it is, skip; an empty or invalid currency → IDR (fallback); no price, no currency', () => {
    expect(slimsPrice(125000, 'IDR', 'major')).toEqual({ price: 12500000, currency: 'IDR', invalidPrice: false, currencyFallback: false });
    expect(slimsPrice(125000, 'Rp', 'major')).toEqual({ price: 12500000, currency: 'IDR', invalidPrice: false, currencyFallback: true });
    expect(slimsPrice('75000', '', 'major')).toEqual({ price: 7500000, currency: 'IDR', invalidPrice: false, currencyFallback: true });
    expect(slimsPrice(50, 'usd', 'major')).toEqual({ price: 5000, currency: 'USD', invalidPrice: false, currencyFallback: false });
    expect(slimsPrice('12.5', 'IDR', 'major')).toEqual({ price: 1250, currency: 'IDR', invalidPrice: false, currencyFallback: false });
    expect(slimsPrice(125000, 'IDR', 'minor')).toEqual({ price: 125000, currency: 'IDR', invalidPrice: false, currencyFallback: false });
    expect(slimsPrice(125000, 'IDR', 'skip')).toEqual({ price: null, currency: null, invalidPrice: false, currencyFallback: false });
    expect(slimsPrice(null, null, 'major')).toEqual({ price: null, currency: null, invalidPrice: false, currencyFallback: false });
    expect(slimsPrice('dua ribu', 'IDR', 'major')).toEqual({ price: null, currency: null, invalidPrice: true, currencyFallback: false });
    expect(slimsPrice(-5, 'IDR', 'major')).toMatchObject({ price: null, invalidPrice: true });
  });
});

describe('SLiMS stage B helpers', () => {
  it('a barcode suffix keeps the whole within 64 characters and never leaves a blank before it', () => {
    expect(withBarcodeSuffix('B 0010', 2)).toBe('B 0010-2');
    expect(withBarcodeSuffix('X'.repeat(64), 3)).toBe(`${'X'.repeat(62)}-3`);
    expect(withBarcodeSuffix(`${'X'.repeat(61)} AB`, 12)).toBe(`${'X'.repeat(61)}-12`);
  });

  it('a stage writes at most 500 report rows of one code, then one rows_omitted row at its end; missing_file rows always', () => {
    const rows: SlimsReportRow[] = [];
    const c = { report: (r: SlimsReportRow) => rows.push(r), counters: createCounters(null) } as unknown as SlimsStageContext;
    // Carried in the cursor: 499 rows of the code were written by the stage's earlier batches.
    const l = Ledger.of({ s: {}, r: { currency_invalid: 499 } });
    for (let i = 0; i < 3; i += 1) l.report('item', String(i), 'currency_invalid', 'Rp -> IDR');
    for (let i = 0; i < 600; i += 1) l.report('files', String(i), 'missing_file', 'x');
    expect(l.state().r).toEqual({ currency_invalid: 502 });
    l.omitted('items');
    l.apply(c);
    expect(rows.filter((r) => r.code === 'currency_invalid').map((r) => r.legacyKey)).toEqual(['0']);
    expect(rows.filter((r) => r.code === 'missing_file')).toHaveLength(600);
    expect(rows.at(-1)).toEqual({ table: 'items', legacyKey: null, code: 'rows_omitted', detail: 'currency_invalid: 2 baris lagi / more rows' });
  });

  it('an archived row past 60 000 bytes of JSON has its longest texts cut and listed under _truncated (§11.4)', () => {
    const doc = { serial_id: 1, notes: '\u00e9'.repeat(40_000), period: 'x'.repeat(30_000), short: 'ok' };
    const fitted = fitArchiveRow(doc);
    expect(Buffer.byteLength(fitted.json, 'utf8')).toBeLessThanOrEqual(60_000);
    expect(fitted.cut).toEqual(['notes', 'period']);
    const back = JSON.parse(fitted.json) as Record<string, unknown>;
    expect(back).toMatchObject({ serial_id: 1, short: 'ok', _truncated: ['notes', 'period'] });
    expect(fitArchiveRow({ a: 1, b: 'small' })).toEqual({ json: '{"a":1,"b":"small"}', cut: [] });
  });

  it('content: slugs from paths, the tags the sanitizer drops, and only http/https links (S4)', () => {
    expect(slugOf('Berita Pameran_2023')).toBe('berita-pameran-2023');
    expect(slugOf('Caf\u00e9 & Buku!')).toBe('cafe-buku');
    expect(droppedTags('<P>a</P><span>b</span><script>x</script><div><b>c</b></div><img src="x">')).toEqual(['script', 'span']);
    expect(attachableUrl(' https://example.org/a b ')).toBe('https://example.org/a%20b');
    for (const bad of ['javascript:alert(1)', 'ftp://example.org/x', 'data:text/html,x', '/relative', `https://example.org/${'a'.repeat(2000)}`]) {
      expect(attachableUrl(bad), bad).toBeNull();
    }
    expect(placeholderTitle('9001')).toBe('[Cantuman hilang \u2014 SLiMS #9001]');
  });
});

describe.skipIf(!ctx.available)(`SLiMS stages B on the fixture [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let root: string;
  let dataDir: string;
  let branchId: string;
  let staff: Actor;
  const fixture = slimsFixtureBytes();
  const traps = fixture.expected.traps;
  /** The fixture's files zip with well-formed cover and page images (each with metadata to strip). */
  let goodZip: Buffer;
  const deps = (): CatalogJobDeps => ({ dataDir, baseUrl: 'https://perpus.example.sch.id/', keyring, storage: localStorageDriver(dataDir), log: silent });
  const registry = createJobRegistry(slimsJobs(deps));

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-slims-stages-b-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir, { recursive: true });
    await runMigrations(h, { appVersion: '0.1.0', dataDir: path.join(root, 'migrations'), migrations: PHASE1_MIGRATIONS });
    branchId = newId(NOW);
    await h.db
      .insertInto('branches')
      .values({ id: branchId, code_key: 'PUSAT', code_display: 'PUSAT', name: 'Perpustakaan Pusat', timezone: 'Asia/Jakarta', is_default: 1, created_at: NOW, updated_at: NOW })
      .execute();
    const staffId = newId(NOW);
    await h.db
      .insertInto('staff_users')
      .values({ id: staffId, username_key: 'MIGRATOR', username_display: 'migrator', name: 'migrator', password_hash: 'x', status: 'active', created_at: NOW, updated_at: NOW })
      .execute();
    staff = { type: 'staff', id: staffId, ip: null };
    await withTx(h, (trx) => writeSettings(trx, { 'catalog.attachment.maxMb': 1, 'library.name': 'Perpustakaan Uji' }, { now: NOW, actorId: null, keyring: [] }));
    // The fixture's zip, its covers and page image replaced by well-formed images that carry metadata.
    const probe = runWorkPath(dataDir, newId(NOW), 'files.bin');
    await fsp.mkdir(path.dirname(probe), { recursive: true });
    await fsp.writeFile(probe, fixture.filesZip);
    const zip = await openFilesZip(probe);
    const entries: RawEntry[] = [];
    for (const name of fixture.expected.zipFiles) {
      const data = name === 'images/docs/cover-1.jpg' ? jpegWithExif(1) : name === 'images/docs/cover-20.jpg' ? jpegWithExif(20) : name === 'images/content/peta.png' ? pngWithText() : await bytesOf(await zip.open(name));
      entries.push({ name, data, method: 8 });
    }
    await zip.close();
    goodZip = rawZip(entries);
  }, 120_000);

  afterAll(async () => {
    __setSlimsSourceFactory(null);
    __setSlimsStages(null);
    __setSlimsStageBBatch(null);
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  afterEach(() => {
    __setSlimsStages(null);
    __setSlimsStageBBatch(null);
  });

  /** Every catalog row a run made, and the run rows: the catalogue as the seeds left it. */
  async function wipe(): Promise<void> {
    const migrated = async (entity: string): Promise<string[]> =>
      (await h.db.selectFrom('migration_map').select('target_id').where('entity', '=', entity).execute()).map((r) => r.target_id);
    const collectionTypes = await migrated('mst_coll_type');
    const suppliers = await migrated('mst_supplier');
    const defs = await migrated('mst_custom_field');
    for (const table of ['custom_values', 'item_events', 'items', 'attachments', 'page_translations', 'pages', 'search_facet', 'search_doc', 'record_agents', 'record_subjects', 'records', 'locations', 'migration_map', 'migration_archive', 'jobs', 'catalog_runs', 'events', 'search_state'] as const) {
      await h.db.deleteFrom(table).execute();
    }
    if (collectionTypes.length > 0) await h.db.deleteFrom('collection_types').where('id', 'in', collectionTypes).execute();
    if (suppliers.length > 0) await h.db.deleteFrom('suppliers').where('id', 'in', suppliers).execute();
    if (defs.length > 0) await h.db.deleteFrom('custom_field_defs').where('id', 'in', defs).execute();
    await h.db.deleteFrom('files').execute();
  }

  async function staged(bytes: Buffer): Promise<string> {
    const id = newId(NOW);
    await fsp.mkdir(path.join(dataDir, 'tmp', id), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'tmp', id, 'upload.bin'), bytes);
    return id;
  }

  /**
   * Runs job `id` slice by slice until it ends. The split and analyze slices get 20 s; the others `budgetMs` (2 000 =
   * the framework's save margin: one stage call per slice, one batch or file per call).
   */
  async function runToEnd(id: string, budgetMs: number, via: DbHandle = h): Promise<{ outcome: string; slices: number }> {
    for (let slices = 1; slices <= 2000; slices += 1) {
      const payload = JSON.parse((await h.db.selectFrom('jobs').select('payload').where('id', '=', id).executeTakeFirstOrThrow()).payload) as { stage: number };
      const job = await claimById(via, registry, id, { worker: 'test', now: NOW });
      if (job === null) throw new Error(`job ${id} cannot be claimed`);
      const r = await runSlice(via, registry, job, { mode: 'worker', budgetMs: payload.stage < 2 ? 20_000 : budgetMs, keyring, log: silent, clock: () => NOW, env: {} });
      if (r.outcome !== 'continued') return { outcome: r.outcome, slices };
    }
    throw new Error('no end after 2000 slices');
  }

  async function migrate(
    o: { dryRun?: boolean; zip?: Buffer; sourceName?: string; again?: boolean; budgetMs?: number; stages?: SlimsStage[]; via?: DbHandle } = {},
  ): Promise<string> {
    __setSlimsStages([seededStagesA(), ...(o.stages ?? stagesB())]);
    const input: SlimsStartInput = {
      dryRun: o.dryRun ?? false,
      sourceKind: 'dump',
      db: null,
      password: null,
      dumpStagingId: await staged(fixture.dump),
      files: 'zip',
      filesStagingId: await staged(o.zip ?? goodZip),
      filesDir: null,
      branchId,
      priceMode: 'major',
      sourceName: o.sourceName ?? 'slims',
      allowNonEmpty: o.again === true,
      confirmLibraryName: o.again === true ? 'Perpustakaan Uji' : null,
      fromRunId: null,
    };
    const { runId, jobId } = await withTx(h, (trx) => startSlimsMigration(txCtx(trx, NOW, staff), registry, input, { keyring }));
    const end = await runToEnd(jobId, o.budgetMs ?? 20_000, o.via);
    expect(end.outcome).toBe('succeeded');
    const run = await h.db.selectFrom('catalog_runs').select(['status', 'summary']).where('id', '=', runId).executeTakeFirstOrThrow();
    expect(run.status).toBe('succeeded');
    return runId;
  }

  const summaryOf = async (runId: string): Promise<MigrationSummary> =>
    JSON.parse((await h.db.selectFrom('catalog_runs').select('summary').where('id', '=', runId).executeTakeFirstOrThrow()).summary) as MigrationSummary;

  /** The report of run `runId` as rows of cells (BOM and CRLF stripped, the `"` quoting undone). */
  async function reportRows(runId: string): Promise<string[][]> {
    const fileId = (await h.db.selectFrom('catalog_runs').select('report_file_id').where('id', '=', runId).executeTakeFirstOrThrow()).report_file_id;
    if (fileId === null) throw new Error('the run has no report');
    const content = (await bytesOf(await localStorageDriver(dataDir).get(fileId))).toString('utf8').replace(/^\uFEFF/, '');
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < content.length; i += 1) {
      const ch = content[i]!;
      if (quoted) {
        if (ch === '"' && content[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\r') continue;
      else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += ch;
    }
    return rows;
  }

  /** The stages' own report rows (after the framework's header rows), each as its cells `[table, key, code, detail]`. */
  async function stageRows(runId: string): Promise<string[][]> {
    const rows = await reportRows(runId);
    const end = rows.findIndex((r) => r[2] === 'phase3_tables');
    return rows.slice(end + 1);
  }

  const rowsWith = (rows: readonly string[][], table: string, code: string): string[][] => rows.filter((r) => r[0] === table && r[2] === code);
  const keysWith = (rows: readonly string[][], table: string, code: string): string[] => rowsWith(rows, table, code).map((r) => r[1]!);

  /** The rows of every catalog table (`files` without the runs' reports, which a dry run writes too). */
  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const t of CATALOG_TABLES) {
      let q = h.db.selectFrom(t as 'files').select((eb) => eb.fn.countAll<number>().as('n'));
      if (t === 'files') q = q.where('context', '<>', 'catalog.report');
      out[t] = Number((await q.executeTakeFirstOrThrow()).n);
    }
    return out;
  };

  /** The target of legacy key `key` of `entity` (source `slims`). */
  const target = async (entity: string, key: string, source = 'slims'): Promise<string> =>
    (await h.db.selectFrom('migration_map').select('target_id').where('source', '=', source).where('entity', '=', entity).where('legacy_key', '=', key).executeTakeFirstOrThrow()).target_id;

  const item = async (itemId: number) => h.db.selectFrom('items').selectAll().where('id', '=', await target('item', String(itemId))).executeTakeFirstOrThrow();

  /**
   * The catalogue a run made, without its ids and times: each map row by its source key, each item, attachment, page
   * and archive row by its legacy key, a target named by the legacy key that maps to it.
   */
  async function snapshot(): Promise<Record<string, unknown>> {
    const maps = await h.db.selectFrom('migration_map').select(['source', 'entity', 'legacy_key', 'target_id']).orderBy('entity').orderBy('legacy_key').execute();
    const names = new Map<string, string>();
    for (const m of maps) if (!names.has(m.target_id)) names.set(m.target_id, `${m.entity}:${m.legacy_key}`);
    const name = (id: string | null): string | null => (id === null ? null : (names.get(id) ?? 'unmapped'));
    const items = await h.db.selectFrom('items').selectAll().execute();
    const locations = await h.db.selectFrom('locations').selectAll().execute();
    const attachments = await h.db.selectFrom('attachments as a').leftJoin('files as f', 'f.id', 'a.file_id').select(['a.record_id', 'a.kind', 'a.url', 'a.title', 'a.access', 'a.legacy_access_limit', 'a.read_count', 'f.status', 'f.size', 'f.sha256', 'f.mime', 'f.access as file_access']).execute();
    const pages = await h.db.selectFrom('pages').select(['id', 'kind', 'slug_key', 'status', 'published_at']).execute();
    const translations = await h.db.selectFrom('page_translations').select(['page_id', 'locale', 'title', 'body']).execute();
    const archive = await h.db.selectFrom('migration_archive').select(['source', 'table_name', 'legacy_key', 'row_json']).execute();
    const sorted = <T>(list: T[]): T[] => list.map((x) => JSON.stringify(x)).sort().map((x) => JSON.parse(x) as T);
    const body = (b: string): string => b.replace(/\/files\/[0-9A-Z]{26}/g, '/files/<id>');
    return {
      maps: maps.map((m) => `${m.source}|${m.entity}|${m.legacy_key}`),
      items: sorted(
        items.map((i) => ({
          item: name(i.id),
          record: name(i.record_id),
          barcode: i.barcode_key,
          status: i.status,
          note: i.status_note,
          location: i.location_id === null ? null : (locations.find((l) => l.id === i.location_id)?.code_display ?? '?'),
          collectionType: name(i.collection_type_id),
          supplier: name(i.supplier_id),
          acq: i.acq_source,
          price: i.price === null ? null : Number(i.price),
          currency: i.currency,
          inventory: i.inventory_no,
          received: i.received_date,
        })),
      ),
      shelves: sorted(locations.filter((l) => l.kind === 'shelf').map((l) => ({ code: l.code_display, name: l.name, hint: l.shelf_hint, parent: name(l.parent_id) }))),
      attachments: sorted(attachments.map((a) => ({ ...a, record_id: name(a.record_id), read_count: Number(a.read_count), size: a.size === null ? null : Number(a.size) }))),
      pages: sorted(pages.map((p) => ({ ...p, id: name(p.id), published_at: p.published_at === null ? null : Number(p.published_at) }))),
      translations: sorted(translations.map((t) => ({ ...t, page_id: name(t.page_id), body: body(t.body) }))),
      covers: sorted((await h.db.selectFrom('records').select(['id', 'cover_file_id']).where('cover_file_id', 'is not', null).execute()).map((r) => name(r.id))),
      archive: sorted(archive),
      events: Number((await h.db.selectFrom('item_events').select((eb) => eb.fn.countAll<number>().as('n')).where('type', '=', 'migrated').executeTakeFirstOrThrow()).n),
      custom: Number((await h.db.selectFrom('custom_values').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n),
    };
  }

  describe('a real run', () => {
    let runId: string;
    let summary: MigrationSummary;
    let rows: string[][];

    beforeAll(async () => {
      await wipe();
      runId = await migrate();
      summary = await summaryOf(runId);
      rows = await stageRows(runId);
    }, 300_000);

    it('reconciles every table stages B read (diff 0), with the counts the fixture holds', () => {
      expect(summary.reconciliation?.ok).toBe(true);
      for (const table of STAGE_B_TABLES) {
        const r = summary.reconciliation!.tables.find((t) => t.table === table);
        expect(r, table).toMatchObject({ table, source: fixture.expected.tables[table]!.source, diff: 0, unread: false });
      }
      expect(summary.tables['item']).toEqual({ source: 600, migrated: 600, merged: 0, skipped: {}, archived: 0 });
      expect(summary.tables['item_custom']).toEqual({ source: 30, migrated: 30, merged: 0, skipped: {}, archived: 0 });
      expect(summary.tables['files']).toEqual({ source: 11, migrated: 9, merged: 0, skipped: { invalid_url: 1, unlinked: 1 }, archived: 0 });
      expect(summary.tables['biblio_attachment']).toEqual({ source: 11, migrated: 9, merged: 0, skipped: { invalid_url: 1, orphan_file: 1 }, archived: 0 });
      expect(summary.tables['files_read']).toEqual({ source: 4, migrated: 0, merged: 4, skipped: {}, archived: 0 });
      expect(summary.tables['content']).toEqual({ source: 6, migrated: 6, merged: 0, skipped: {}, archived: 0 });
      for (const table of ARCHIVED) expect(summary.tables[table], table).toEqual({ source: fixture.expected.tables[table]!.source, migrated: 0, merged: 0, skipped: {}, archived: fixture.expected.tables[table]!.source });
    });

    it('orphan items stay, under one hidden placeholder record per missing biblio_id, each mapped as biblio_missing (M13)', async () => {
      expect(traps.orphans.missingBiblioIds).toEqual([9001, 9002]);
      for (const n of traps.orphans.missingBiblioIds) {
        const record = await h.db.selectFrom('records').selectAll().where('id', '=', await target('biblio_missing', String(n))).executeTakeFirstOrThrow();
        expect(record).toMatchObject({ title: `[Cantuman hilang \u2014 SLiMS #${n}]`, opac_visible: 0, source: `slims:${n}`, archived_at: null });
        const under = traps.orphans.items.filter((o) => o.biblioId === n).map((o) => o.itemId);
        for (const itemId of under) expect((await item(itemId)).record_id).toBe(record.id);
        expect(await h.db.selectFrom('search_doc').select('is_public').where('record_id', '=', record.id).executeTakeFirst()).toEqual({ is_public: 0 });
      }
      expect(await h.db.selectFrom('migration_map').select('legacy_key').where('entity', '=', 'biblio_missing').orderBy('legacy_key').execute()).toEqual([{ legacy_key: '9001' }, { legacy_key: '9002' }]);
      expect(rowsWith(rows, 'item', 'orphan_item')).toHaveLength(traps.orphans.items.length);
      expect(Number((await h.db.selectFrom('items').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(600);
    });

    it("statuses: '' and '0' → available, R → repair, NL → not_for_loan, MIS → missing, another one → available with its name in status_note", async () => {
      const byStatus = new Map<string, number[]>();
      const statusRows = await allItemsOf();
      for (const [key, it] of statusRows) byStatus.set(it.slimsStatus, [...(byStatus.get(it.slimsStatus) ?? []), key]);
      for (const [stored, expected] of Object.entries(traps.itemStatuses)) {
        const ids = byStatus.get(stored) ?? [];
        expect(ids.length, stored).toBe(expected.items);
        for (const id of ids) {
          const row = await item(id);
          // A replaced barcode leaves its original in the note too.
          if (traps.barcodes.some((b) => b.itemId === id && b.outcome === 'replaced' && b.stored !== '')) continue;
          expect([stored, row.status], stored).toEqual([stored, expected.status]);
          expect(row.status_note !== null, stored).toBe(expected.note);
        }
      }
      expect((await item(byStatus.get('RSV')![0]!)).status_note).toBe('SLiMS: Dipesan (RSV)');
      expect(rowsWith(rows, 'item', 'status_unknown')).toHaveLength(traps.itemStatuses['RSV']!.items);
    });

    /** Item id → its SLiMS status, from the fixture's own rule (the dump is the fixture's). */
    async function allItemsOf(): Promise<Map<number, { slimsStatus: string }>> {
      const statusOf = (i: number): string => (['', '', '', '', '', '', '', '', '0', '0', '0', '0', '0', '0', 'R', 'NL', 'MIS', 'RSV', '', ''] as const)[i % 20]!;
      return new Map(Array.from({ length: 600 }, (_, k) => [k + 1, { slimsStatus: statusOf(k + 1) }] as const));
    }

    it('prices per priceMode major (×100); an empty or invalid currency → IDR and a report row; no price, no currency', async () => {
      for (const p of traps.prices) {
        const row = await item(p.itemId);
        expect([p.itemId, row.price === null ? null : Number(row.price), row.currency]).toEqual([p.itemId, p.major, p.major === null ? null : p.currencyFallback ? 'IDR' : p.currency]);
      }
      expect(Number((await item(21)).price)).toBe(12_500_000);
      const fallbacks = keysWith(rows, 'item', 'currency_invalid');
      expect(fallbacks).toEqual(['20', '25']);
    });

    it('barcodes: normalised, a collision gets -2, 1–2 characters are kept and flagged, a non-ASCII or empty one becomes MIG<item_id>', async () => {
      expect((await item(10)).barcode_key).toBe('B 0010');
      expect((await item(11)).barcode_key).toBe('B 0010-2');
      expect((await item(12)).barcode_key).toBe('7');
      expect(await item(13)).toMatchObject({ barcode_key: 'MIG13', barcode_display: 'MIG13', status_note: 'SLiMS: B\u20130013' });
      expect((await item(14)).barcode_key).toBe('MIG14');
      expect((await item(15)).barcode_key).toBe('B00015');
      expect((await item(16)).barcode_key).toBe('B00016');
      expect(keysWith(rows, 'item', 'barcode_nonstandard')).toEqual(['12']);
      expect(keysWith(rows, 'item', 'barcode_replaced')).toEqual(['13', '14']);
      expect(rowsWith(rows, 'item', 'barcode_collision')).toEqual([['item', '11', 'barcode_collision', 'B 0010 -> B 0010-2']]);
      expect(summary.nonstandardBarcodes).toBe(1);
    });

    it('shelves: one per normalised site text per room (hint cut to 40); an unknown room or collection type and other fixes are reported', async () => {
      const shelves = await h.db.selectFrom('locations').selectAll().where('kind', '=', 'shelf').execute();
      const sl = await target('mst_location', 'SL');
      const slShelves = shelves.filter((s) => s.parent_id === sl);
      // A shelf is named as its first item wrote it (item 1: `rak  a1 `, item 6: `Rak A1`), its blanks collapsed.
      expect(slShelves.map((s) => s.name).sort()).toEqual(['Lemari Koleksi Khusus Sejarah Lokal Nusantara Lt 2', 'Rak B2', 'rak a1']);
      for (const s of shelves) expect(s.branch_id).toBe(branchId);
      const lemari = slShelves.find((s) => s.name.startsWith('Lemari'))!;
      expect(lemari.shelf_hint).toBe('Lemari Koleksi Khusus Sejarah Lokal Nusa');
      // Items 6 (`Rak A1`) and 1 (`rak  a1 `) of room SL share one shelf; item 10 is in room SL with no site.
      expect((await item(6)).location_id).toBe((await item(1)).location_id);
      expect(slShelves.map((s) => s.id)).toContain((await item(6)).location_id);
      expect((await item(10)).location_id).toBe(sl);
      // Item 50: room `XX` is not a SLiMS location.
      expect((await item(50)).location_id).toBeNull();
      expect(keysWith(rows, 'item', 'location_unknown')).toEqual(['50']);
      expect(keysWith(rows, 'item', 'site_unplaced')).toEqual(['50']);
      // Collection types 0 and 9 → the default (UMUM) and a report row each.
      const umum = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
      expect((await item(7)).collection_type_id).toBe(umum);
      expect((await item(8)).collection_type_id).toBe(umum);
      expect((await item(9)).collection_type_id).toBe(await target('mst_coll_type', '1'));
      expect(rowsWith(rows, 'item', 'collection_type_default')).toHaveLength(Array.from({ length: 600 }, (_, k) => k + 1).filter((i) => i % 7 === 0 || i % 7 === 1).length);
      // Source 1 → purchase, 2 → gift, else other; supplier '77' unknown; '' none.
      expect([(await item(1)).acq_source, (await item(2)).acq_source, (await item(3)).acq_source]).toEqual(['gift', 'other', 'purchase']);
      expect((await item(30)).supplier_id).toBeNull();
      expect((await item(1)).supplier_id).toBe(await target('mst_supplier', '2'));
      expect(keysWith(rows, 'item', 'supplier_unknown')).toEqual(['30']);
      // A zero date → null, counted as a repair.
      expect((await item(11)).received_date).toBeNull();
      expect((await item(12)).received_date).toBe('2019-01-13');
      expect(summary.fixes['item.received_date']).toEqual({ date: traps.zeroDates.filter((z) => z.table === 'item').length + 53 });
    });

    it('each item has one `migrated` history row by the system; item custom values; the records are indexed', async () => {
      const events = await h.db.selectFrom('item_events').selectAll().execute();
      expect(events).toHaveLength(600);
      const first = events.find((e) => e.item_id === events[0]!.item_id)!;
      expect(first).toMatchObject({ type: 'migrated', actor_type: 'system', actor_id: null, from_status: null, meta: '{"fields":[]}' });
      const condition = (await h.db.selectFrom('custom_field_defs').select('id').where('code_key', '=', 'CF_9C8D7').executeTakeFirstOrThrow()).id;
      const one = await h.db.selectFrom('custom_values').select('value').where('field_id', '=', condition).where('entity_id', '=', (await item(1)).id).executeTakeFirstOrThrow();
      expect(JSON.parse(one.value)).toBe('2');
      const note = (await h.db.selectFrom('custom_field_defs').select('id').where('code_key', '=', 'CF_5E6F7').executeTakeFirstOrThrow()).id;
      expect(await h.db.selectFrom('custom_values').select('value').where('field_id', '=', note).where('entity_id', '=', (await item(4)).id).executeTakeFirst()).toEqual({ value: '"Sampul robek"' });
      expect(await h.db.selectFrom('custom_values').select('value').where('field_id', '=', note).where('entity_id', '=', (await item(5)).id).executeTakeFirst()).toBeUndefined();
      const record = await target('biblio', '1');
      expect(await h.db.selectFrom('search_facet').select('value_key').where('record_id', '=', record).where('facet', '=', 'av').execute()).not.toEqual([]);
    });

    it('S10: an entry that inflates past catalog.attachment.maxMb (1) → file_too_large and a files row status missing', async () => {
      const big = traps.attachments.tooLarge[0]!;
      expect(big.bytes).toBeGreaterThan(MIB);
      const attachment = await h.db.selectFrom('attachments').selectAll().where('id', '=', await target('files', String(big.fileId))).executeTakeFirstOrThrow();
      const file = await h.db.selectFrom('files').selectAll().where('id', '=', attachment.file_id!).executeTakeFirstOrThrow();
      expect(file).toMatchObject({ status: 'missing', size: 0, context: 'catalog.attachment', owner_type: 'attachments', owner_id: attachment.id });
      expect(await localStorageDriver(dataDir).stat(file.id)).toBeNull();
      expect(keysWith(rows, 'files', 'file_too_large')).toEqual([String(big.fileId)]);
    });

    it("S4: a file_url of javascript: → invalid_url and no attachment; an https URL → a url attachment", async () => {
      expect(keysWith(rows, 'biblio_attachment', 'invalid_url')).toEqual(['6|6']);
      expect(await h.db.selectFrom('attachments').select('id').where('url', 'like', 'javascript%').execute()).toEqual([]);
      expect(await h.db.selectFrom('attachments').select('id').where('record_id', '=', await target('biblio', '6')).execute()).toEqual([]);
      const url = await h.db.selectFrom('attachments').selectAll().where('record_id', '=', await target('biblio', '5')).executeTakeFirstOrThrow();
      expect(url).toMatchObject({ kind: 'url', url: 'https://example.org/ebook.pdf', title: 'E-book Daring', access: 'public', file_id: null });
    });

    it('a file missing from the zip → a files row status missing (size 0) and a missing_file report row; an unsafe path likewise', async () => {
      for (const m of traps.missingFiles) {
        const attachment = await h.db.selectFrom('attachments').selectAll().where('id', '=', await target('files', m.key)).executeTakeFirstOrThrow();
        const file = await h.db.selectFrom('files').selectAll().where('id', '=', attachment.file_id!).executeTakeFirstOrThrow();
        expect([m.key, file.status, Number(file.size)]).toEqual([m.key, 'missing', 0]);
      }
      expect(keysWith(rows, 'files', 'missing_file')).toEqual(traps.missingFiles.map((m) => m.key));
      expect(summary.missingFiles).toBe(traps.missingFiles.length + traps.covers.missing.length + traps.content.images.missing.length);
    });

    it('access: private → staff; public with an access_limit → staff + legacy_access_limit; file_key is not migrated (D2-30)', async () => {
      const limited = await h.db.selectFrom('attachments').selectAll().where('id', '=', await target('files', '4')).executeTakeFirstOrThrow();
      expect(limited).toMatchObject({ access: 'staff', legacy_access_limit: '["1","2"]' });
      expect(await h.db.selectFrom('files').select('access').where('id', '=', limited.file_id!).executeTakeFirst()).toEqual({ access: 'staff' });
      expect(await h.db.selectFrom('attachments').select(['access', 'legacy_access_limit']).where('id', '=', await target('files', '3')).executeTakeFirst()).toEqual({ access: 'staff', legacy_access_limit: null });
      expect(keysWith(rows, 'files', 'file_key_not_migrated')).toEqual(['7']);
      const locked = await h.db.selectFrom('attachments').select(['access', 'file_id']).where('id', '=', await target('files', '7')).executeTakeFirstOrThrow();
      expect(locked.access).toBe('public');
    });

    it('a stored attachment: its bytes from repository/<dir>/<name>, typed by its magic, owned by its attachment; read counts summed', async () => {
      const laskar = await h.db.selectFrom('attachments').selectAll().where('id', '=', await target('files', '1')).executeTakeFirstOrThrow();
      expect(laskar).toMatchObject({ kind: 'file', title: 'Laskar Pelangi (PDF)', access: 'public', record_id: await target('biblio', '1') });
      expect(Number(laskar.read_count)).toBe(traps.readCounts['1']);
      expect(Number((await h.db.selectFrom('attachments').select('read_count').where('id', '=', await target('files', '4')).executeTakeFirstOrThrow()).read_count)).toBe(traps.readCounts['4']);
      const file = await h.db.selectFrom('files').selectAll().where('id', '=', laskar.file_id!).executeTakeFirstOrThrow();
      const stored = await bytesOf(await localStorageDriver(dataDir).get(file.id));
      expect(file).toMatchObject({ status: 'ok', mime: 'application/pdf', original_name: 'laskar.pdf', context: 'catalog.attachment', owner_type: 'attachments', owner_id: laskar.id, access: 'public', sha256: sha256(stored) });
      expect(stored.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(Number(file.size)).toBe(stored.length);
      // The files row no attachment links to, and the attachment whose files row is missing.
      expect(keysWith(rows, 'files', 'unlinked_file')).toEqual(['10']);
      expect(keysWith(rows, 'biblio_attachment', 'orphan_file')).toEqual(['12|999']);
    });

    it('covers: images/docs/<image> → a catalog.cover file without its metadata, set as the cover; a missing one → missing_file', async () => {
      for (const c of traps.covers.present) {
        const record = await h.db.selectFrom('records').select(['id', 'cover_file_id']).where('id', '=', await target('biblio', String(c.biblioId))).executeTakeFirstOrThrow();
        expect(record.cover_file_id).not.toBeNull();
        const file = await h.db.selectFrom('files').selectAll().where('id', '=', record.cover_file_id!).executeTakeFirstOrThrow();
        expect(file).toMatchObject({ context: 'catalog.cover', owner_type: 'records', owner_id: record.id, access: 'public', status: 'ok', mime: 'image/jpeg' });
        const stored = await bytesOf(await localStorageDriver(dataDir).get(file.id));
        expect(stored.includes(Buffer.from('Exif', 'latin1'))).toBe(false);
        expect([stored[0], stored[1], stored.at(-2), stored.at(-1)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
        expect(file.sha256).toBe(sha256(stored));
      }
      const missing = traps.covers.missing[0]!;
      expect((await h.db.selectFrom('records').select('cover_file_id').where('id', '=', await target('biblio', String(missing.biblioId))).executeTakeFirstOrThrow()).cover_file_id).toBeNull();
      expect(keysWith(rows, 'biblio', 'missing_file')).toEqual([String(missing.biblioId)]);
    });

    it('content → Halaman & Berita: pages are drafts (D2-27), news keeps its state, _id/_en are translations, HTML sanitized, images re-uploaded', async () => {
      const pages = await h.db.selectFrom('pages').selectAll().orderBy('slug_key').execute();
      expect(pages.map((p) => [p.kind, p.slug_key, p.status])).toEqual([
        ['news', 'berita-draf', 'draft'],
        ['news', 'berita-pameran', 'published'],
        ['page', 'help', 'draft'],
        ['page', 'libinfo', 'draft'],
        ['page', 'profil', 'draft'],
      ]);
      expect(Number(pages.find((p) => p.slug_key === 'berita-pameran')!.published_at)).toBe(Date.UTC(2023, 7, 17));
      for (const p of pages.filter((p) => p.kind === 'page')) expect(p.published_at).toBeNull();
      const profil = pages.find((p) => p.slug_key === 'profil')!;
      const translations = await h.db.selectFrom('page_translations').selectAll().where('page_id', '=', profil.id).orderBy('locale').execute();
      expect(translations.map((t) => [t.locale, t.title, t.body_format])).toEqual([
        ['en', 'Library Profile', 'html'],
        ['id', 'Profil Perpustakaan', 'html'],
      ]);
      const id = translations.find((t) => t.locale === 'id')!.body;
      expect(id).not.toContain('script');
      expect(id).not.toContain('hilang.png');
      expect(id).not.toContain('images/content');
      const src = /<img src="\/files\/([0-9A-Z]{26})"/.exec(id);
      expect(src).not.toBeNull();
      expect(translations.find((t) => t.locale === 'en')!.body).toContain(`/files/${src![1]!}`);
      const image = await h.db.selectFrom('files').selectAll().where('id', '=', src![1]!).executeTakeFirstOrThrow();
      expect(image).toMatchObject({ context: 'opac.page_image', owner_type: 'pages', owner_id: profil.id, access: 'public', status: 'ok', mime: 'image/png' });
      const stored = await bytesOf(await localStorageDriver(dataDir).get(image.id));
      expect(stored.includes(Buffer.from('tEXt', 'latin1'))).toBe(false);
      expect(keysWith(rows, 'content', 'missing_file')).toEqual(['3']);
      expect(rowsWith(rows, 'content', 'html_tags_dropped')).toEqual([['content', '3', 'html_tags_dropped', 'script']]);
    });

    it('the archive: one raw row per row of each archived table (legacy_key = the PK, source = sourceName); biblio_log without IP or realname (M12)', async () => {
      for (const table of ARCHIVED) {
        const n = Number((await h.db.selectFrom('migration_archive').select((eb) => eb.fn.countAll<number>().as('n')).where('table_name', '=', table).executeTakeFirstOrThrow()).n);
        expect([table, n]).toEqual([table, fixture.expected.tables[table]!.source]);
      }
      const log = await h.db.selectFrom('migration_archive').selectAll().where('table_name', '=', 'biblio_log').orderBy('legacy_key').execute();
      for (const row of log) {
        const json = JSON.parse(row.row_json) as Record<string, unknown>;
        for (const column of traps.biblioLogPersonal) expect(Object.hasOwn(json, column), column).toBe(false);
        expect(json['user_id']).toBe(1);
        expect(row.row_json).not.toMatch(/192\.168\.|Pustakawan Satu/);
        expect([row.source, row.run_id]).toEqual(['slims', runId]);
      }
      expect(log.map((r) => r.legacy_key).sort()).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)).sort());
      expect(rowsWith(rows, 'biblio_log', 'columns_dropped')).toEqual([['biblio_log', '', 'columns_dropped', 'ip, realname']]);
      const takeItem = await h.db.selectFrom('migration_archive').select(['legacy_key', 'row_json']).where('table_name', '=', 'stock_take_item').orderBy('legacy_key').executeTakeFirstOrThrow();
      expect(takeItem.legacy_key).toBe('1|101');
      expect(JSON.parse(takeItem.row_json)).toMatchObject({ stock_take_id: 1, item_id: 101, item_code: 'B00101' });
      // biblio.labels and biblio.frequency_id (§11.4) of the records that have them.
      const labels = await h.db.selectFrom('migration_archive').select(['legacy_key', 'row_json']).where('table_name', '=', 'biblio').orderBy('legacy_key').execute();
      expect(labels.map((r) => [r.legacy_key, Object.keys(JSON.parse(r.row_json) as object)])).toEqual([
        ['15', ['biblio_id', 'labels']],
        ['16', ['biblio_id', 'labels']],
        ['17', ['biblio_id', 'frequency_id']],
      ]);
    });

    it('a re-run of the same source adds nothing: every row already_migrated, no second placeholder', async () => {
      const before = await snapshot();
      const again = await migrate({ again: true });
      expect(await snapshot()).toEqual(before);
      const s = await summaryOf(again);
      expect(s.reconciliation?.ok).toBe(true);
      expect(s.tables['item']).toEqual({ source: 600, migrated: 0, merged: 0, skipped: { already_migrated: 600 }, archived: 0 });
      expect(s.tables['content']!.skipped).toEqual({ already_migrated: 6 });
      expect(s.tables['biblio_log']!.skipped).toEqual({ already_migrated: 10 });
      expect(s.tables['files_read']!.skipped).toEqual({ already_migrated: 4 });
      expect(await h.db.selectFrom('migration_map').select('legacy_key').where('entity', '=', 'biblio_missing').execute()).toHaveLength(2);
      expect(Number((await h.db.selectFrom('attachments').select('read_count').where('id', '=', await target('files', '1')).executeTakeFirstOrThrow()).read_count)).toBe(3);
    });
  });

  describe('a dry run, and runs stopped or killed in the middle', () => {
    let whole: { snapshot: Record<string, unknown>; summary: MigrationSummary; rows: string[][] };

    beforeAll(async () => {
      await wipe();
      const runId = await migrate();
      whole = { snapshot: await snapshot(), summary: await summaryOf(runId), rows: await stageRows(runId) };
    }, 300_000);

    it('a dry run writes nothing, reconciles, and reports what a real run would (orphans, missing and broken files)', async () => {
      await wipe();
      const before = await counts();
      const runId = await migrate({ dryRun: true, zip: fixture.filesZip });
      expect(await counts()).toEqual(before);
      const s = await summaryOf(runId);
      expect(s.reconciliation?.ok).toBe(true);
      for (const table of STAGE_B_TABLES) expect(s.tables[table], table).toEqual(whole.summary.tables[table]);
      const rows = await stageRows(runId);
      expect(rowsWith(rows, 'item', 'orphan_item')).toHaveLength(traps.orphans.items.length);
      expect(rowsWith(rows, 'files', 'file_too_large')).toHaveLength(1);
      expect(keysWith(rows, 'files', 'missing_file')).toEqual(traps.missingFiles.map((m) => m.key));
      // The fixture's own cover bytes are no well-formed JPEG: reported, as a real run would.
      expect(keysWith(rows, 'biblio', 'cover_invalid')).toEqual(traps.covers.present.map((c) => String(c.biblioId)));
      expect(rowsWith(rows, 'item', 'barcode_collision')).toEqual([['item', '11', 'barcode_collision', 'B 0010 -> B 0010-2']]);
    }, 300_000);

    it('a dry run taken over by another process at every call (batches of 5) still reports a collision two batches apart', async () => {
      await wipe();
      __setSlimsStageBBatch(5);
      // Each call starts as a new process would: nothing kept from the calls before.
      const anew = (stage: SlimsStage): SlimsStage => ({
        name: stage.name,
        reads: stage.reads,
        run: (c, cursor) => {
          __forgetSlimsStageBValues();
          return stage.run(c, cursor);
        },
      });
      const before = await counts();
      const runId = await migrate({ dryRun: true, stages: [anew(itemsStage)], budgetMs: 2_000 });
      expect(await counts()).toEqual(before);
      const rows = await stageRows(runId);
      expect(rowsWith(rows, 'item', 'barcode_collision')).toEqual([['item', '11', 'barcode_collision', 'B 0010 -> B 0010-2']]);
      expect(keysWith(rows, 'item', 'orphan_item')).toEqual(traps.orphans.items.map((o) => String(o.itemId)));
      expect((await summaryOf(runId)).tables['item']).toEqual(whole.summary.tables['item']);
    }, 300_000);

    it('items (and every stage B) stopped after each batch and resumed → the same catalogue, counts and report', async () => {
      await wipe();
      __setSlimsStageBBatch(50);
      const runId = await migrate({ budgetMs: 2_000 });
      expect(await snapshot()).toEqual(whole.snapshot);
      const s = await summaryOf(runId);
      expect([s.tables, s.fixes, s.missingFiles, s.nonstandardBarcodes]).toEqual([whole.summary.tables, whole.summary.fixes, whole.summary.missingFiles, whole.summary.nonstandardBarcodes]);
      expect(await stageRows(runId)).toEqual(whole.rows);
    }, 300_000);

    it('every stage B killed after its writes committed and before its counts were saved → resumed with identical results (K15)', async () => {
      await wipe();
      const runId = await migrate({ stages: stagesB().map(killedOnce) });
      expect(await snapshot()).toEqual(whole.snapshot);
      const s = await summaryOf(runId);
      expect([s.tables, s.fixes, s.missingFiles, s.nonstandardBarcodes]).toEqual([whole.summary.tables, whole.summary.fixes, whole.summary.missingFiles, whole.summary.nonstandardBarcodes]);
      expect(await stageRows(runId)).toEqual(whole.rows);
    }, 300_000);

    it("S13: a second source name migrates the same dump again beside the first, its map rows under its own name", async () => {
      const before = Number((await h.db.selectFrom('items').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
      const runId = await migrate({ sourceName: 'kampus', again: true });
      const s = await summaryOf(runId);
      expect(s.tables['item']).toMatchObject({ migrated: 600, skipped: {} });
      expect(Number((await h.db.selectFrom('items').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(before + 600);
      expect((await h.db.selectFrom('items').select('barcode_key').where('id', '=', await target('item', '1', 'kampus')).executeTakeFirstOrThrow()).barcode_key).toBe('B00001-2');
      expect(await h.db.selectFrom('migration_map').select('legacy_key').where('source', '=', 'kampus').where('entity', '=', 'biblio_missing').execute()).toHaveLength(2);
      const archived = await h.db.selectFrom('migration_archive').select('source').where('source', '=', 'kampus').execute();
      expect(archived.length).toBeGreaterThan(0);
      expect((await h.db.selectFrom('records').select('id').where('id', '=', await target('biblio', '1', 'kampus')).execute()).length).toBe(1);
    }, 300_000);
  });

  describe('rows archived by an admin after they were migrated and before they hold an item (review X1-2)', () => {
    /** Item ids 1–600 with `pick`. */
    const itemsWhere = (pick: (i: number) => boolean): number[] => Array.from({ length: 600 }, (_, k) => k + 1).filter(pick);
    const biblioOf = (i: number): number => (i <= 597 ? ((i - 1) % 297) + 1 : i === 600 ? 9002 : 9001);
    /** The fixture's rule of each item's cells (generate.ts). */
    const collTypeOf = (i: number): number => (i % 7 === 0 ? 0 : i % 7 === 1 ? 9 : (i % 3) + 1);
    const roomOf = (i: number): string => (i === 50 ? 'XX' : (['SL', 'SL', 'SL', 'REF', 'lt2'] as const)[i % 5]!);
    const siteOf = (i: number): string => ['Rak A1', 'rak  a1 ', 'Rak B2', '', '', 'Lemari Koleksi Khusus Sejarah Lokal Nusantara Lt 2'][i % 6]!;
    const supplierOf = (i: number): string => (i === 30 ? '77' : (['1', '2', '', '3'] as const)[i % 4]!);
    const stranded = (i: number): boolean => biblioOf(i) === 2 || biblioOf(i) === 3;

    /**
     * A stage between stages A and the items stage: while the run is between slices, an admin archives rows it
     * migrated, none of which holds an item yet (so each archive passes its check): the record of biblio 2, the record
     * of biblio 3 merged into biblio 4's, the collection type of coll_type_id 3, the room REF, the supplier 3, and the
     * shelf `Rak B2` of room SL (made by an earlier run of the stage and archived since).
     */
    function admin(): SlimsStage {
      return {
        name: 'relations',
        reads: [],
        async run(c) {
          if (c.dryRun) return { done: true, cursor: null };
          const at = c.now;
          const two = await target('biblio', '2');
          await h.db.updateTable('records').set({ archived_at: at }).where('id', '=', two).execute();
          await h.db.updateTable('records').set({ archived_at: at, merged_into: await target('biblio', '4') }).where('id', '=', await target('biblio', '3')).execute();
          await h.db.updateTable('collection_types').set({ archived_at: at }).where('id', '=', await target('mst_coll_type', '3')).execute();
          await h.db.updateTable('locations').set({ archived_at: at }).where('id', '=', await target('mst_location', 'REF')).execute();
          await h.db.updateTable('suppliers').set({ archived_at: at }).where('id', '=', await target('mst_supplier', '3')).execute();
          const shelf = newId(at);
          await h.db
            .insertInto('locations')
            .values({
              id: shelf,
              branch_id: branchId,
              parent_id: await target('mst_location', 'SL'),
              kind: 'shelf',
              code_display: 'SL-RAK-B2-LAMA',
              code_key: 'SL-RAK-B2-LAMA',
              name: 'Rak B2',
              shelf_hint: 'Rak B2',
              class_from: null,
              class_to: null,
              map_file_id: null,
              map_x: null,
              map_y: null,
              map_w: null,
              map_h: null,
              is_public: 1,
              sort_order: 0,
              archived_at: at,
              created_at: at,
              created_by: null,
              updated_at: at,
              updated_by: null,
            })
            .execute();
          await withTx(h, (trx) => mapLegacy(trx, [{ source: c.options.sourceName, entity: 'item_site', legacyKey: `SL|${codeKey('Rak B2')}`, targetId: shelf, runId: c.runId }]));
          return { done: true, cursor: null };
        },
      };
    }

    /** The live items that point to an archived record, collection type, location or supplier. */
    async function onArchived(): Promise<number> {
      const live = () => h.db.selectFrom('items as i').select((eb) => eb.fn.countAll<number>().as('n')).where('i.archived_at', 'is', null);
      const rows = [
        await live().innerJoin('records as m', 'm.id', 'i.record_id').where('m.archived_at', 'is not', null).executeTakeFirstOrThrow(),
        await live().innerJoin('collection_types as m', 'm.id', 'i.collection_type_id').where('m.archived_at', 'is not', null).executeTakeFirstOrThrow(),
        await live().innerJoin('locations as m', 'm.id', 'i.location_id').where('m.archived_at', 'is not', null).executeTakeFirstOrThrow(),
        await live().innerJoin('suppliers as m', 'm.id', 'i.supplier_id').where('m.archived_at', 'is not', null).executeTakeFirstOrThrow(),
      ];
      return rows.reduce((a, r) => a + Number(r.n), 0);
    }

    it('no live item lands on them: the items of an archived or merged record are skipped and reported, the others take the stage’s fallbacks with a report row each', async () => {
      await wipe();
      const runId = await migrate({ stages: [admin(), itemsStage] });
      const s = await summaryOf(runId);
      const skipped = itemsWhere(stranded);
      expect(skipped).toEqual([2, 3, 299, 300, 596, 597]);
      expect(s.tables['item']).toEqual({ source: 600, migrated: 594, merged: 0, skipped: { record_archived: 6 }, archived: 0 });
      expect(s.reconciliation?.tables.find((t) => t.table === 'item')).toMatchObject({ diff: 0 });
      expect(await onArchived()).toBe(0);
      const rows = await stageRows(runId);
      expect(keysWith(rows, 'item', 'record_archived')).toEqual(skipped.map(String));
      expect(rowsWith(rows, 'item', 'record_archived')[0]).toEqual(['item', '2', 'record_archived', 'biblio_id=2']);
      for (const i of skipped) expect(await h.db.selectFrom('migration_map').select('target_id').where('entity', '=', 'item').where('legacy_key', '=', String(i)).executeTakeFirst()).toBeUndefined();
      expect(await h.db.selectFrom('items').select('id').where('record_id', 'in', [await target('biblio', '2'), await target('biblio', '3')]).execute()).toEqual([]);
      // The collection type of coll_type_id 3 → the default.
      const umum = (await h.db.selectFrom('collection_types').select('id').where('code_key', '=', 'UMUM').executeTakeFirstOrThrow()).id;
      const fiction = itemsWhere((i) => !stranded(i) && collTypeOf(i) === 3);
      expect(keysWith(rows, 'item', 'collection_type_archived')).toEqual(fiction.map(String));
      for (const i of fiction.slice(0, 5)) expect((await item(i)).collection_type_id).toBe(umum);
      // The room REF → no location (and its site unplaced); the shelf `Rak B2` of SL → the room SL.
      const ref = itemsWhere((i) => !stranded(i) && roomOf(i) === 'REF');
      expect(rowsWith(rows, 'item', 'location_archived').filter((r) => r[3] === 'location_id=REF').map((r) => r[1])).toEqual(ref.map(String));
      for (const i of ref.slice(0, 5)) expect((await item(i)).location_id).toBeNull();
      expect(keysWith(rows, 'item', 'site_unplaced')).toEqual(itemsWhere((i) => !stranded(i) && (roomOf(i) === 'REF' || roomOf(i) === 'XX') && siteOf(i).trim() !== '').map(String));
      const rakB2 = itemsWhere((i) => !stranded(i) && roomOf(i) === 'SL' && siteOf(i) === 'Rak B2');
      expect(rowsWith(rows, 'item', 'location_archived').filter((r) => r[3] === 'site=Rak B2').map((r) => r[1])).toEqual(rakB2.map(String));
      const sl = await target('mst_location', 'SL');
      for (const i of rakB2.slice(0, 5)) expect((await item(i)).location_id).toBe(sl);
      // The supplier 3 → none.
      const third = itemsWhere((i) => !stranded(i) && supplierOf(i) === '3');
      expect(keysWith(rows, 'item', 'supplier_archived')).toEqual(third.map(String));
      for (const i of third.slice(0, 5)) expect((await item(i)).supplier_id).toBeNull();

      // Killed after the items stage's writes committed and before its counts were saved: the same run (K15).
      const whole = { snapshot: await snapshot(), tables: s.tables, rows };
      await wipe();
      const again = await migrate({ stages: [admin(), killedOnce(itemsStage)] });
      expect(await snapshot()).toEqual(whole.snapshot);
      expect((await summaryOf(again)).tables).toEqual(whole.tables);
      expect(await stageRows(again)).toEqual(whole.rows);

      // The record of biblio 2 restored: a re-run of the source migrates its items (they were never mapped).
      await h.db.updateTable('records').set({ archived_at: null }).where('id', '=', await target('biblio', '2')).execute();
      const rerun = await migrate({ again: true, stages: [itemsStage] });
      expect((await summaryOf(rerun)).tables['item']).toEqual({ source: 600, migrated: 3, merged: 0, skipped: { already_migrated: 594, record_archived: 3 }, archived: 0 });
      expect((await h.db.selectFrom('items').select('record_id').where('id', '=', await target('item', '299')).executeTakeFirstOrThrow()).record_id).toBe(await target('biblio', '2'));
      expect(await onArchived()).toBe(0);
    }, 300_000);

    it.skipIf(ctx.engine === 'sqlite')('a record archived after the items batch began (its snapshot from before): the batch still sees it archived and writes none of its items', async () => {
      await wipe();
      // The handle the run goes through holds the items stage's first batch right after its first read (the legacy
      // map of its items), which starts its MySQL/MariaDB snapshot; meanwhile an admin archives the record of biblio 2
      // on another connection (it has no item yet), and commits.
      let seen = false;
      const held = new Set<QueryId>();
      let archived!: Promise<void>;
      const plugin: KyselyPlugin = {
        transformQuery({ node, queryId }) {
          if (!seen && SelectQueryNode.is(node) && (JSON.stringify(node.from) ?? '').includes('"migration_map"') && (JSON.stringify(node.where) ?? '').includes('"value":"item"')) {
            seen = true;
            held.add(queryId);
          }
          return node;
        },
        async transformResult({ queryId, result }) {
          if (held.delete(queryId)) {
            archived = (async () => {
              const id = await target('biblio', '2');
              const { version } = await h.db.selectFrom('records').select('version').where('id', '=', id).executeTakeFirstOrThrow();
              await withTx(h, (trx) => archiveRecord(txCtx(trx, NOW, staff), id, Number(version)));
            })();
            await archived;
          }
          return result;
        },
      };
      const runId = await migrate({ stages: [itemsStage], via: { ...h, db: h.db.withPlugin(plugin) } });
      expect(seen).toBe(true);
      await archived;
      const two = await h.db.selectFrom('records').select(['archived_at']).where('id', '=', await target('biblio', '2')).executeTakeFirstOrThrow();
      expect(two.archived_at).not.toBeNull();
      expect(await h.db.selectFrom('items').select('id').where('record_id', '=', await target('biblio', '2')).execute()).toEqual([]);
      expect(keysWith(await stageRows(runId), 'item', 'record_archived')).toEqual(['2', '299', '596']);
      expect((await summaryOf(runId)).tables['item']).toEqual({ source: 600, migrated: 597, merged: 0, skipped: { record_archived: 3 }, archived: 0 });
      expect(await onArchived()).toBe(0);
    }, 300_000);
  });
});
