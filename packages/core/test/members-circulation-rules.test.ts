import { describe, expect, it } from 'vitest';
import { dueDateFor } from '../src/circulation/dates.js';
import { pickPolicy, policyScopeKey } from '../src/circulation/policies.js';
import { parseDateCell, parseGenderCell, readMemberCsv } from '../src/members/import.js';
import { memberNameKey, memberNoDisplay, memberNoProblem, normalizeMemberNo } from '../src/members/keys.js';

// The pure rules of members and circulation: member number and name keys, loan rule resolution, the due date, and the
// CSV member file's reading.

describe('member keys', () => {
  it('a member number is shown like a barcode and compared without spaces, so `b 001` and `B001` collide', () => {
    expect(memberNoDisplay(' b  001\r\n')).toBe('B 001');
    expect(normalizeMemberNo(' b  001\r\n')).toBe('B001');
    expect(normalizeMemberNo('b\t001')).toBe('B001');
    expect(normalizeMemberNo('b 001')).toBe(normalizeMemberNo('B001'));
    expect(normalizeMemberNo('B 0 0 1')).toBe('B001');
    expect(memberNoProblem('B 001')).toBeNull();
    expect(memberNoProblem('')).toBe('invalid');
    expect(memberNoProblem('X'.repeat(65))).toBe('invalid');
    expect(memberNoProblem('NO-É')).toBe('invalid');
  });

  it('the name key drops accents and case and collapses spaces', () => {
    expect(memberNameKey('  ÁnDi   Śaputra ')).toBe('andi saputra');
    expect(Array.from(memberNameKey('a'.repeat(300)))).toHaveLength(191);
  });
});

describe('loan rule resolution', () => {
  const rule = (id: string, m: string | null, c: string | null = null, t: string | null = null) => ({
    id,
    member_type_id: m,
    collection_type_id: c,
    material_type_id: t,
    branch_id: null,
  });
  const loan = { memberTypeId: 'type-a', collectionTypeId: 'coll-a', materialTypeId: 'mat-a', branchId: 'branch-a' };

  it('the most specific rule wins; a tie goes to the earlier filled dimension; none applies → null', () => {
    const general = rule('general', null);
    const byType = rule('type', 'type-a');
    const byCollection = rule('coll', null, 'coll-a');
    expect(pickPolicy([general], loan)?.id).toBe('general');
    expect(pickPolicy([general, byType], loan)?.id).toBe('type');
    expect(pickPolicy([byCollection, byType, general], loan)?.id).toBe('type');
    expect(pickPolicy([rule('mt', 'type-a', null, 'mat-a'), rule('mc', 'type-a', 'coll-a')], loan)?.id).toBe('mc');
    expect(pickPolicy([rule('other', 'type-b')], loan)).toBeNull();
    expect(pickPolicy([], loan)).toBeNull();
  });

  it('the scope key names every dimension, `*` for all', () => {
    expect(policyScopeKey({ memberTypeId: null, collectionTypeId: null, materialTypeId: null, branchId: null })).toBe('*/*/*/*');
    expect(policyScopeKey({ memberTypeId: 'type-a', collectionTypeId: null, materialTypeId: null, branchId: null })).toBe('type-a/*/*/*');
  });
});

describe('the due date', () => {
  it('is loanedOn + days, cut to the expiry, never before the loan day', async () => {
    const db = null as never;
    expect(await dueDateFor(db, { loanedOn: '2026-11-14', days: 7, expiresOn: null, branchId: 'B' })).toEqual({ dueOn: '2026-11-21', capped: false });
    expect(await dueDateFor(db, { loanedOn: '2026-11-14', days: 7, expiresOn: '2026-11-18', branchId: 'B' })).toEqual({ dueOn: '2026-11-18', capped: true });
    expect(await dueDateFor(db, { loanedOn: '2026-11-14', days: 0, expiresOn: null, branchId: 'B' })).toEqual({ dueOn: '2026-11-14', capped: false });
    expect(await dueDateFor(db, { loanedOn: '2026-11-14', days: 7, expiresOn: '2026-11-01', branchId: 'B' })).toEqual({ dueOn: '2026-11-14', capped: true });
  });
});

describe('the CSV member file', () => {
  it('reads `;` and Windows-1252, any column order and case, skipping blank lines', () => {
    const rows = readMemberCsv(Buffer.from('NAME;member_no;Member_Type;\r\nB\xfadi;A-1;SISWA;\r\n\r\n;;;\r\nCitra;A-2;GURU;\r\n', 'latin1'));
    expect(rows).toEqual([
      { line: 2, cells: { name: 'Búdi', member_no: 'A-1', member_type: 'SISWA' } },
      { line: 5, cells: { name: 'Citra', member_no: 'A-2', member_type: 'GURU' } },
    ]);
  });

  it('refuses a file without its required columns, with an unknown column, or with an unclosed quote', () => {
    const reason = (text: string): unknown => {
      try {
        readMemberCsv(Buffer.from(text, 'utf8'));
        return 'read';
      } catch (error) {
        return (error as { meta?: { reason?: unknown } }).meta?.reason;
      }
    };
    expect(reason('')).toBe('empty');
    expect(reason('member_no,name\n1,A\n')).toBe('header');
    expect(reason('member_no,name,member_type,password\n1,A,B,x\n')).toBe('header');
    expect(reason('member_no,name,member_type\n1,"A,B\n')).toBe('unreadable');
  });

  it('genders and dates as Indonesian spreadsheets write them', () => {
    expect(['L', 'p', 'Laki-laki', 'PEREMPUAN', 'M', 'f', '', 'X'].map(parseGenderCell)).toEqual(['male', 'female', 'male', 'female', 'male', 'female', null, 'unknown']);
    expect(['2012-02-01', '1/2/2012', '01-02-2012', '31/02/2012', '', 'kemarin'].map(parseDateCell)).toEqual(['2012-02-01', '2012-02-01', '2012-02-01', 'invalid', null, 'invalid']);
  });
});
