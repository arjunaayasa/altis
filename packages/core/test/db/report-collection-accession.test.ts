import { newId, normalizeKey, t } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDbContext } from '../../../../tools/test/test-db.js';
import { collectionAccessionRegisterReport as def } from '../../src/reports/collection/accession-register.js';
import { stockAt } from '../support/stock-fixture.js';
import { addTitle, ctxFor, drain, openCollectionDb, type CollectionDb } from './report-collection-support.js';

// The accession register over the stock fixture plus copies of its own: every received copy by receiving date, then
// inventory number (a copy without one first within its day), the copies without a receiving date last; ordered copies
// are not in it. A receiving-date range leaves the undated copies out.

const ctx = testDbContext();

describe.skipIf(!ctx.available)(`collection.accession_register [${engineLabel()}]`, () => {
  let c: CollectionDb;

  beforeAll(async () => {
    c = await openCollectionDb('report-accession');
    const at = stockAt('2017-01-04');
    const supplierId = newId(at);
    await c.db
      .insertInto('suppliers')
      .values({ id: supplierId, code_display: 'CVP', code_key: 'CVP', name: 'CV Pustaka', contact_name: null, phone: null, email: null, address: null, note: null, archived_at: null, created_at: at, created_by: null, updated_at: at, updated_by: null })
      .execute();
    const publisherId = newId(at);
    await c.db
      .insertInto('publishers')
      .values({ id: publisherId, name_display: 'Balai Pustaka', name_key: 'BALAI PUSTAKA', place: 'Jakarta', merged_into: null, archived_at: null, created_at: at, created_by: null, updated_at: at, updated_by: null })
      .execute();
    const { recordId } = await addTitle(c.db, c.branchId, {
      title: 'Siti Nurbaya',
      subtitle: 'kasih tak sampai',
      responsibility: 'Marah Rusli',
      classification: '899.221 3',
      callNumber: '899.221 3 RUS s',
      edition: 'Cet. 40',
      place: 'Jakarta',
      year: '2008',
      physicalDesc: '271 hlm. ; 21 cm',
      items: [
        { barcode: 'REG-0001', receivedDate: '2024-03-15', inventoryNo: 'INV/2024/003', price: 85_000_00, acqSource: 'purchase', supplierId },
        { barcode: 'REG-0002', receivedDate: '2024-03-15', inventoryNo: 'INV/2024/002', acqSource: 'gift' },
        { barcode: 'REG-0003', receivedDate: '2024-03-15' },
        { barcode: 'REG-0004', receivedDate: '2022-01-05', inventoryNo: 'INV/2022/001', callNumber: '899.221 3 RUS s c.2' },
      ],
    });
    await c.db.updateTable('records').set({ publisher_id: publisherId }).where('id', '=', recordId).execute();
    const agents = [
      ['Marah Rusli', 1, 0],
      ['Sutan Takdir', 0, 1],
    ] as const;
    for (const [name, isMain, sort] of agents) {
      const agentId = newId(at);
      await c.db
        .insertInto('agents')
        .values({ id: agentId, type: 'person', name_display: name, name_key: normalizeKey(name), dates: null, authority_source: null, authority_ref: null, note: null, merged_into: null, archived_at: null, created_at: at, created_by: null, updated_at: at, updated_by: null })
        .execute();
      await c.db.insertInto('record_agents').values({ record_id: recordId, agent_id: agentId, role: isMain === 1 ? 'aut' : 'edt', is_main: isMain, sort_order: sort }).execute();
    }
    await c.db
      .insertInto('record_identifiers')
      .values({ id: newId(at), record_id: recordId, type: 'isbn', value_display: '978-979-407-167-3', value_key: '9789794071673', qualifier: null, is_valid: 1, sort_order: 0 })
      .execute();
  });

  afterAll(async () => {
    await c?.close();
  });

  it('lists the copies by receiving date, then inventory number, the undated ones last', async () => {
    const { rows } = await drain(def, ctxFor(c, def, {}));
    expect(rows.slice(0, 7).map((r) => [r[1], r[2], r[0]])).toEqual([
      ['STK-0008', '2019-08-01', null],
      ['STK-0009', '2021-04-12', null],
      ['REG-0004', '2022-01-05', 'INV/2022/001'],
      ['REG-0003', '2024-03-15', null],
      ['STK-0001', '2024-03-15', 'INV/2024/001'],
      ['REG-0002', '2024-03-15', 'INV/2024/002'],
      ['REG-0001', '2024-03-15', 'INV/2024/003'],
    ]);
    // The copies without a receiving date; the ordered copy is not in the register.
    expect(rows.slice(7).map((r) => r[1]).sort()).toEqual(['STK-0002', 'STK-0003', 'STK-0004', 'STK-0005', 'STK-0006', 'STK-0010', 'STK-0011']);
    expect(rows.slice(7).every((r) => r[2] === null)).toBe(true);
    expect(rows.find((r) => r[1] === 'REG-0001')).toEqual([
      'INV/2024/003',
      'REG-0001',
      '2024-03-15',
      'Siti Nurbaya : kasih tak sampai',
      'Marah Rusli; Sutan Takdir',
      'Cet. 40',
      '978-979-407-167-3',
      'Jakarta',
      'Balai Pustaka',
      '2008',
      '271 hlm. ; 21 cm',
      85_000,
      `${t('id', 'vocab.acq_source.purchase')}, CV Pustaka`,
      '899.221 3 RUS s',
    ]);
    expect(rows.find((r) => r[1] === 'REG-0004')![13]).toBe('899.221 3 RUS s c.2');
    expect(await def.count!(ctxFor(c, def, {}))).toBe(rows.length);
  });

  it('keeps to a receiving-date range, without the undated copies', async () => {
    const { rows } = await drain(def, ctxFor(c, def, { received: { from: '2021-01-01', to: '2022-12-31' } }));
    expect(rows.map((r) => r[1])).toEqual(['STK-0009', 'REG-0004']);
  });

  it('gives the same rows in keyset pages of two as in one page', async () => {
    for (const params of [{}, { received: { from: '2024-03-15' } }]) {
      const one = await drain(def, ctxFor(c, def, params));
      const paged = await drain(def, ctxFor(c, def, params), 2);
      expect(paged.rows, JSON.stringify(params)).toEqual(one.rows);
      expect(paged.pages).toBeGreaterThan(1);
    }
  });
});
