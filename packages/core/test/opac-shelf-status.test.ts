import { describe, expect, it } from 'vitest';
import { addShelfCopy, copyShelfState, emptyShelfCounts, shelfStatusOf, type CopyShelfState } from '../src/opac-home/shelf-status.js';

// What the OPAC says of a title's copies (the cards, the result rows, the record page): each copy in one state, in a
// fixed order (an open loan first, then a hold shelf, then what its status and collection type allow), and the title's
// words from the counts: available (all, or n of m), else on loan with the earliest due date, else for use in the
// library only, else not on the shelf; nothing for a title without copies.

const counts = (copies: [CopyShelfState, string | null][]) => copies.reduce((c, [state, due]) => addShelfCopy(c, state, due), emptyShelfCounts());

describe('copyShelfState', () => {
  it('an open loan or a hold shelf first, whatever the status', () => {
    expect(copyShelfState({ status: 'available', collectionLoanable: true, onLoan: true, kept: true })).toBe('loan');
    expect(copyShelfState({ status: 'not_for_loan', collectionLoanable: false, onLoan: true, kept: false })).toBe('loan');
    expect(copyShelfState({ status: 'available', collectionLoanable: true, onLoan: false, kept: true })).toBe('held');
  });

  it('available in a lent collection: on the shelf; not for loan, or in a collection not lent: library use; else other', () => {
    expect(copyShelfState({ status: 'available', collectionLoanable: true, onLoan: false, kept: false })).toBe('shelf');
    expect(copyShelfState({ status: 'available', collectionLoanable: false, onLoan: false, kept: false })).toBe('library');
    expect(copyShelfState({ status: 'not_for_loan', collectionLoanable: true, onLoan: false, kept: false })).toBe('library');
    for (const status of ['on_order', 'processing', 'repair', 'missing']) {
      expect(copyShelfState({ status, collectionLoanable: true, onLoan: false, kept: false }), status).toBe('other');
    }
  });
});

describe('shelfStatusOf', () => {
  it('no copy: nothing to say', () => {
    expect(shelfStatusOf(emptyShelfCounts())).toBeNull();
  });

  it('every copy on the shelf: available; some: n of all the copies', () => {
    expect(shelfStatusOf(counts([['shelf', null], ['shelf', null]]))).toEqual({ kind: 'available', shelf: 2, total: 2 });
    expect(shelfStatusOf(counts([['shelf', null], ['loan', '2026-11-30'], ['library', null]]))).toEqual({ kind: 'available', shelf: 1, total: 3 });
  });

  it('none on the shelf but some on loan: the earliest due date, never who holds it', () => {
    const status = shelfStatusOf(counts([['loan', '2026-12-05'], ['loan', '2026-11-21'], ['library', null], ['held', null]]));
    expect(status).toEqual({ kind: 'on_loan', dueOn: '2026-11-21' });
    expect(Object.keys(status!)).toEqual(['kind', 'dueOn']);
  });

  it('only copies for use in the library: library use; nothing reachable at all: not on the shelf', () => {
    expect(shelfStatusOf(counts([['library', null], ['other', null]]))).toEqual({ kind: 'library_use' });
    expect(shelfStatusOf(counts([['held', null], ['other', null]]))).toEqual({ kind: 'unavailable' });
  });
});
