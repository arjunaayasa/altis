import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SLIMS_COLUMNS } from '../../src/migration/slims/source/detect.js';
import { SLIMS_USAGE_COLUMNS, SLIMS_USAGE_HASHED, memberHash, usageRowTransform } from '../../src/migration/slims/source/usage.js';

// The usage import's privacy core: a member id is replaced by a keyed hash (HMAC-SHA256, first 128 bits, the key
// random per run) as soon as a row is read or split, and only the columns the counts need are kept. The catalogue
// migration's column list is a separate list and stays exactly as it was: the member, loan and visitor tables never
// enter it, so the catalogue migration never stages their rows.

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OTHER = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);

describe('memberHash', () => {
  it('is 32 lower-case hex characters: the first 16 bytes of HMAC-SHA256 over the trimmed id', () => {
    const h = memberHash(KEY, 'SIS-0001');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(h).toBe(createHmac('sha256', KEY).update('SIS-0001', 'utf8').digest().subarray(0, 16).toString('hex'));
  });

  it('is stable for one key and differs for another key or another id', () => {
    expect(memberHash(KEY, 'M001')).toBe(memberHash(Uint8Array.from(KEY), 'M001'));
    expect(memberHash(OTHER, 'M001')).not.toBe(memberHash(KEY, 'M001'));
    expect(memberHash(KEY, 'M002')).not.toBe(memberHash(KEY, 'M001'));
  });

  it('keeps an empty id (a guest) empty, and trims the id first', () => {
    expect(memberHash(KEY, '')).toBe('');
    expect(memberHash(KEY, '   ')).toBe('');
    expect(memberHash(KEY, ' M001 ')).toBe(memberHash(KEY, 'M001'));
    expect(memberHash(KEY, '\tM001\n')).toBe(memberHash(KEY, 'M001'));
  });

  it('refuses a key shorter than 16 bytes', () => {
    expect(() => memberHash(new Uint8Array(8), 'M001')).toThrow(TypeError);
    expect(() => usageRowTransform(new Uint8Array(0))).toThrow(TypeError);
  });
});

describe('the usage column lists', () => {
  it('name exactly the columns the aggregate counts read, the paging keys included', () => {
    expect(SLIMS_USAGE_COLUMNS).toEqual({
      loan: ['loan_id', 'item_code', 'member_id', 'loan_date', 'is_lent', 'is_return'],
      loan_history: ['loan_id', 'item_code', 'biblio_id', 'classification', 'member_id', 'member_type_name', 'loan_date'],
      visitor_count: ['visitor_id', 'member_id', 'checkin_date'],
      member: ['member_id', 'member_type_id', 'expire_date'],
      mst_member_type: ['member_type_id', 'member_type_name'],
      item: ['item_code', 'biblio_id'],
      biblio: ['biblio_id', 'classification'],
      read_counter: ['id', 'item_code', 'created_at'],
    });
    expect(SLIMS_USAGE_HASHED).toEqual({ loan: ['member_id'], loan_history: ['member_id'], visitor_count: ['member_id'], member: ['member_id'] });
    expect(Object.isFrozen(SLIMS_USAGE_COLUMNS)).toBe(true);
    for (const [table, hashed] of Object.entries(SLIMS_USAGE_HASHED)) {
      for (const column of hashed ?? []) expect(SLIMS_USAGE_COLUMNS[table as keyof typeof SLIMS_USAGE_COLUMNS]).toContain(column);
    }
  });

  it("leave the catalogue migration's column list as it was: no member, loan or visitor table enters it", () => {
    expect(Object.keys(SLIMS_COLUMNS)).toEqual([
      'biblio', 'biblio_author', 'biblio_topic', 'biblio_relation', 'biblio_attachment', 'biblio_custom', 'files', 'files_read', 'item',
      'item_custom', 'mst_gmd', 'mst_content_type', 'mst_media_type', 'mst_carrier_type', 'mst_language', 'mst_publisher', 'mst_place',
      'mst_author', 'mst_topic', 'mst_voc_ctrl', 'mst_relation_term', 'mst_location', 'mst_coll_type', 'mst_item_status', 'mst_supplier',
      'mst_custom_field', 'mst_servers', 'setting', 'content', 'serial', 'kardex', 'mst_frequency', 'stock_take', 'stock_take_item',
      'mst_label', 'biblio_log',
    ]);
    // The whole list, columns and their order included, as a digest of its JSON.
    expect(createHash('sha256').update(JSON.stringify(SLIMS_COLUMNS)).digest('hex')).toBe('3c3c1f400aa3ced2bf137e12c822243025418cfebc8a3dea6136f7aa0db11883');
    for (const table of ['member', 'loan', 'loan_history', 'visitor_count', 'mst_member_type', 'read_counter']) expect(Object.hasOwn(SLIMS_COLUMNS, table), table).toBe(false);
  });
});

describe('usageRowTransform', () => {
  const transform = usageRowTransform(KEY);

  it('keeps only the projected columns, in the list order, and hashes the member id', () => {
    const row = { visitor_id: 7, member_id: 'SIS-0001', member_name: 'Andi Ayu Saputra', institution: 'Yayasan Kenari 1', checkin_date: '2025-08-04 08:15:00' };
    const out = transform('visitor_count', row);
    expect(out).toEqual({ visitor_id: 7, member_id: memberHash(KEY, 'SIS-0001'), checkin_date: '2025-08-04 08:15:00' });
    expect(Object.keys(out)).toEqual(['visitor_id', 'member_id', 'checkin_date']);
    expect(row.member_id).toBe('SIS-0001'); // the input row is left as it was
    const member = transform('member', { member_id: ' GRU-0002 ', member_name: 'Budi', member_address: 'Jl. Kenari', member_type_id: 2, expire_date: '2026-06-30' });
    expect(member).toEqual({ member_id: memberHash(KEY, 'GRU-0002'), member_type_id: 2, expire_date: '2026-06-30' });
  });

  it('leaves a guest (empty or NULL member id) as it is, and a column the row lacks out', () => {
    expect(transform('visitor_count', { visitor_id: 1, member_id: '', checkin_date: '2025-08-04 08:15:00' })).toEqual({ visitor_id: 1, member_id: '', checkin_date: '2025-08-04 08:15:00' });
    expect(transform('visitor_count', { visitor_id: 2, member_id: null, checkin_date: '2025-08-04 08:15:00' })).toEqual({ visitor_id: 2, member_id: null, checkin_date: '2025-08-04 08:15:00' });
    expect(transform('loan_history', { loan_id: 3, item_code: 'B00041', member_id: 'M0001' })).toEqual({ loan_id: 3, item_code: 'B00041', member_id: memberHash(KEY, 'M0001') });
  });

  it('hashes an id held as bytes or as a number the same way as its text', () => {
    const bytes = transform('loan', { loan_id: 1, member_id: new TextEncoder().encode(' M001 ') });
    expect(bytes['member_id']).toBe(memberHash(KEY, 'M001'));
    const latin1 = transform('loan', { loan_id: 1, member_id: Uint8Array.from([0x4d, 0xe9, 0x20]) }); // "Mé" in latin1, not UTF-8
    expect(latin1['member_id']).toBe(createHmac('sha256', KEY).update(Uint8Array.from([0x4d, 0xe9])).digest().subarray(0, 16).toString('hex'));
    expect(transform('loan', { loan_id: 1, member_id: 1042 })['member_id']).toBe(memberHash(KEY, '1042'));
  });

  it('keeps hashing under the key it was made with after the caller wipes its own key', () => {
    const key = Uint8Array.from(KEY);
    const own = usageRowTransform(key);
    key.fill(0);
    const out = own('member', { member_id: 'M001', member_type_id: 1, expire_date: null });
    expect(out['member_id']).toBe(memberHash(KEY, 'M001'));
    expect(out['member_id']).not.toBe(memberHash(new Uint8Array(32), 'M001'));
  });

  it('does not hash the columns of other tables, and refuses a table that is not a usage table', () => {
    expect(transform('mst_member_type', { member_type_id: 1, member_type_name: 'Siswa', loan_limit: 2 })).toEqual({ member_type_id: 1, member_type_name: 'Siswa' });
    expect(transform('item', { item_id: 9, item_code: 'B00001', biblio_id: 1, price: 20000 })).toEqual({ item_code: 'B00001', biblio_id: 1 });
    expect(() => transform('mst_author', { author_id: 1 })).toThrow(TypeError);
    expect(() => transform('__proto__', {})).toThrow(TypeError);
  });
});
