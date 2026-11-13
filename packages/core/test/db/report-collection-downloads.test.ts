import { newId, t } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { collectionAttachmentDownloadsReport as def } from '../../src/reports/collection/attachment-downloads.js';
import { stockAt } from '../support/stock-fixture.js';
import { addTitle, ctxFor, drain, openCollectionDb, type CollectionDb } from './report-collection-support.js';

// How often each attachment was opened: the count kept on the attachment (a SLiMS migration carries its counts over),
// never who opened it. Filters: when the record was created, its material type, the attachment's access.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`collection.attachment_downloads [${engineLabel()}]`, () => {
  let c: CollectionDb;

  async function attach(recordId: string, o: { title: string; kind: 'file' | 'url'; access: 'public' | 'staff'; readCount: number; archived?: boolean }): Promise<void> {
    const at = stockAt('2024-06-01');
    let fileId: string | null = null;
    if (o.kind === 'file') {
      fileId = newId(at);
      await c.db
        .insertInto('files')
        .values({ id: fileId, original_name: `${o.title}.pdf`, mime: 'application/pdf', size: 1024, sha256: 'c'.repeat(64), context: 'catalog.attachment', owner_type: 'records', owner_id: recordId, access: o.access, status: 'ok', created_at: at, created_by: null })
        .execute();
    }
    await c.db
      .insertInto('attachments')
      .values({
        id: newId(at),
        record_id: recordId,
        kind: o.kind,
        file_id: fileId,
        url: o.kind === 'url' ? 'https://contoh.example/modul' : null,
        title: o.title,
        description: null,
        access: o.access,
        legacy_access_limit: null,
        read_count: o.readCount,
        sort_order: 0,
        archived_at: o.archived === true ? at : null,
        created_at: at,
        created_by: null,
        updated_at: at,
        updated_by: null,
      })
      .execute();
  }

  beforeAll(async () => {
    c = await openCollectionDb('report-downloads', { fixture: false });
    const modul = await addTitle(c.db, c.branchId, { title: 'Modul Biologi', createdAt: stockAt('2024-06-01') });
    await attach(modul.recordId, { title: 'Bab 1', kind: 'file', access: 'public', readCount: 12 });
    await attach(modul.recordId, { title: 'Tautan video', kind: 'url', access: 'public', readCount: 0 });
    await attach(modul.recordId, { title: 'Lama', kind: 'file', access: 'public', readCount: 40, archived: true });
    const arsip = await addTitle(c.db, c.branchId, { title: 'Arsip Kurikulum', materialType: 'EBOOK', createdAt: stockAt('2023-02-01') });
    await attach(arsip.recordId, { title: 'Dokumen', kind: 'file', access: 'staff', readCount: 3 });
  });

  afterAll(async () => {
    await c?.close();
  });

  it('answers the count of each attachment, migrated counts and zeros included', async () => {
    const { rows, totals } = await drain(def, ctxFor(c, def, {}));
    expect(rows).toEqual([
      ['Arsip Kurikulum', 'Dokumen', 'application/pdf', 3],
      ['Modul Biologi', 'Bab 1', 'application/pdf', 12],
      ['Modul Biologi', 'Tautan video', null, 0],
    ]);
    expect(totals).toEqual([t('id', 'report.row.total'), null, null, 15]);
    expect(await def.count!(ctxFor(c, def, {}))).toBe(3);
  });

  it('filters by access, material type and the creation of the record', async () => {
    expect((await drain(def, ctxFor(c, def, { access: 'public' }))).rows.map((r) => r[3])).toEqual([12, 0]);
    const ebook = await c.db.selectFrom('material_types').select('id').where('code_key', '=', 'EBOOK').executeTakeFirstOrThrow();
    expect((await drain(def, ctxFor(c, def, { materialTypeId: ebook.id }))).rows.map((r) => r[1])).toEqual(['Dokumen']);
    const created = await drain(def, ctxFor(c, def, { created: { from: '2024-01-01', to: '2024-12-31' } }));
    expect(created.rows.map((r) => r[1])).toEqual(['Bab 1', 'Tautan video']);
    expect(created.totals).toEqual([t('id', 'report.row.total'), null, null, 12]);
  });

  it('gives the same rows in pages of one', async () => {
    const one = await drain(def, ctxFor(c, def, {}));
    const paged = await drain(def, ctxFor(c, def, {}), 1);
    expect(paged.rows).toEqual(one.rows);
  });
});
