import { describe, expect, it } from 'vitest';
import { toBibtex, toRis } from '../../src/catalog/render/index.js';
import { RENDER_CANONICAL, RENDER_ISBN, RENDER_ISSN, RENDER_OPTIONS, agent, materialType, recordData } from '../support/record-data-fixtures.js';

// Spec §9.1 (`/katalog/:id/ris`, `/bibtex`) and D2-21: the downloads of a record's citation.

const lines = (ris: string): string[] => ris.split('\r\n');

describe('toRis', () => {
  it('writes the tagged lines with CRLF and ends with ER', () => {
    const ris = toRis(recordData(), RENDER_OPTIONS);
    expect(ris).toBe(
      [
        'TY  - BOOK',
        'AU  - Hirata, Andrea',
        'TI  - Laskar pelangi: sebuah novel',
        'PY  - 2010',
        'CY  - Yogyakarta',
        'PB  - Bentang',
        `SN  - ${RENDER_ISBN}`,
        'LA  - Indonesia',
        'KW  - Fiksi Indonesia',
        'KW  - Belitung',
        'AB  - Kisah sepuluh anak di sebuah pulau timah.',
        'N1  - Novel pertama dari sebuah tetralogi.',
        `UR  - ${RENDER_CANONICAL}`,
        'ER  - ',
        '',
      ].join('\r\n'),
    );
    expect(ris.trimEnd()).toMatch(/\r\nER {2}-$/);
  });

  it('writes editors as A2, the series as T2, the edition, the ISSN and the DOI; the language follows the UI', () => {
    const d = recordData({
      agents: [agent('Hirata, Andrea', { role: 'edt' })],
      series: 'Tetralogi Laskar Pelangi ; 1',
      edition: 'Cetakan ke-5',
      identifiers: [
        { type: 'isbn', value: RENDER_ISBN },
        { type: 'issn', value: RENDER_ISSN },
        { type: 'doi', value: 'https://doi.org/10.1234/ABC.5' },
        { type: 'other', value: 'XYZ' },
      ],
    });
    const out = lines(toRis(d, { ...RENDER_OPTIONS, locale: 'en' }));
    expect(out.filter((l) => !/^(AU|A2|T2|ET|SN|DO|LA) {2}- /.test(l)).length).toBe(out.length - 7);
    expect(out).toContain('A2  - Hirata, Andrea');
    expect(out.some((l) => l.startsWith('AU  - '))).toBe(false);
    expect(out).toContain('T2  - Tetralogi Laskar Pelangi ; 1');
    expect(out).toContain('ET  - Cetakan ke-5');
    expect(out).toContain(`SN  - ${RENDER_ISSN}`);
    expect(out).toContain('DO  - 10.1234/abc.5');
    expect(out).toContain('LA  - Indonesian');
    expect(out.join('\n')).not.toContain('XYZ');
  });

  it('maps the schema.org type to the RIS type', () => {
    const ty = (code: Parameters<typeof materialType>[0]) => lines(toRis(recordData({ materialType: materialType(code) }), RENDER_OPTIONS))[0];
    expect(ty('BUKU')).toBe('TY  - BOOK');
    expect(ty('KARYA-ILMIAH')).toBe('TY  - THES');
    expect(ty('BERSERI')).toBe('TY  - SER');
    expect(ty('PETA')).toBe('TY  - MAP');
  });

  it('keeps every value on one line, so no data can start a tag of its own', () => {
    const d = recordData({ title: 'Judul\r\nUR  - https://evil.example/\nER  - ', summary: 'Baris satu.\n\nBaris\u0000 dua.\u2028Tiga.' });
    const out = lines(toRis(d, RENDER_OPTIONS));
    expect(out.filter((l) => l.startsWith('UR  - '))).toEqual([`UR  - ${RENDER_CANONICAL}`]);
    expect(out.filter((l) => l.startsWith('ER  - '))).toHaveLength(1);
    expect(out).toContain('TI  - Judul UR - https://evil.example/ ER -: sebuah novel');
    expect(out).toContain('AB  - Baris satu. Baris dua. Tiga.');
    for (const l of out) expect(/[\n\r]/.test(l) || l.includes(String.fromCharCode(0))).toBe(false);
  });
});

describe('toBibtex', () => {
  it('writes a @book entry keyed <familyname><year>', () => {
    expect(toBibtex(recordData(), RENDER_OPTIONS)).toBe(
      [
        '@book{hirata2010,',
        '  author = {Hirata, Andrea},',
        '  title = {Laskar pelangi: sebuah novel},',
        '  publisher = {Bentang},',
        '  address = {Yogyakarta},',
        '  year = {2010},',
        `  isbn = {${RENDER_ISBN}},`,
        `  url = {${RENDER_CANONICAL}}`,
        '}',
        '',
      ].join('\n'),
    );
  });

  it('escapes { } & % $ # _ and the other LaTeX specials, so data cannot run a command', () => {
    const d = recordData({
      title: '100% {benar} $5 #1 a_b \\input{/etc/passwd} ~^',
      subtitle: undefined,
      publisher: { id: 'p', name: 'Gramedia & Co.', place: 'Jakarta' },
      publicationPlace: undefined,
    });
    const bib = toBibtex(d, RENDER_OPTIONS);
    expect(bib).toContain('  publisher = {Gramedia \\& Co.},');
    expect(bib).toContain('  title = {100\\% \\{benar\\} \\$5 \\#1 a\\_b \\textbackslash{}input\\{/etc/passwd\\} \\textasciitilde{}\\textasciicircum{}},');
    expect(bib).not.toMatch(/[^\\]\\input/);
  });

  it('keeps the entry brace-balanced when a value holds an unbalanced brace (BibTeX counts \\{ too)', () => {
    /** BibTeX matches a field's braces without regard to backslashes: every prefix must close no more than it opened. */
    const balanced = (s: string): boolean => {
      let depth = 0;
      for (const c of s) {
        if (c === '{') depth++;
        else if (c === '}' && --depth < 0) return false;
      }
      return depth === 0;
    };
    for (const title of ['Tanda { kurung', 'Tanda } kurung', 'x}, note = {y', '}{', '{a} } {b}']) {
      const bib = toBibtex(recordData({ title, subtitle: undefined, agents: [agent(`Nama ${title}`, { type: 'organization' })] }), RENDER_OPTIONS);
      expect(balanced(bib), title).toBe(true);
    }
    const bib = toBibtex(recordData({ title: 'x}, note = {y', subtitle: undefined }), RENDER_OPTIONS);
    expect(bib).toContain('  title = {x\\textbraceright{}, note = \\textbraceleft{}y},');
    // A balanced pair keeps the short form.
    expect(toBibtex(recordData({ title: 'a {b} c', subtitle: undefined }), RENDER_OPTIONS)).toContain('  title = {a \\{b\\} c},');
  });

  it('joins agents with and, braces a corporate name, and writes editors when there is no author', () => {
    const d = recordData({ agents: [agent('Hirata, Andrea'), agent('Food and Agriculture Organization', { type: 'organization' }), agent('Soekarno')] });
    expect(toBibtex(d, RENDER_OPTIONS)).toContain('  author = {Hirata, Andrea and {Food and Agriculture Organization} and {Soekarno}},');
    const eds = toBibtex(recordData({ agents: [agent('Toer, Pramoedya Ananta', { role: 'edt' })] }), RENDER_OPTIONS);
    expect(eds).toMatch(/^@book\{toer2010,\n/);
    expect(eds).toContain('  editor = {Toer, Pramoedya Ananta},');
    expect(eds).not.toContain('author =');
  });

  it('folds the key to a-z0-9, falls back to the title, then to ref, and leaves out a missing year', () => {
    const key = (over: Parameters<typeof recordData>[0]) => /^@\w+\{([^,]*),/.exec(toBibtex(recordData(over), RENDER_OPTIONS))![1];
    expect(key({ agents: [agent('Śaṅkara, Ādi')] })).toBe('sankara2010');
    expect(key({ agents: [agent("O'Brien, Flann")] })).toBe('obrien2010');
    expect(key({ agents: [agent('Badan Pusat Statistik', { type: 'organization' })] })).toBe('badan2010');
    expect(key({ agents: [] })).toBe('laskar2010');
    expect(key({ agents: [], title: 'كتاب', subtitle: undefined })).toBe('ref2010');
    expect(key({ publicationYear: undefined })).toBe('hirata');
  });

  it('writes @misc for every type but a book, with the edition, series, ISSN and DOI', () => {
    const d = recordData({
      materialType: materialType('KARYA-ILMIAH'),
      edition: 'Ed. 2',
      series: 'Seri Skripsi',
      identifiers: [
        { type: 'issn', value: RENDER_ISSN },
        { type: 'doi', value: '10.1234/abc_5' },
      ],
    });
    const bib = toBibtex(d, RENDER_OPTIONS);
    expect(bib).toMatch(/^@misc\{hirata2010,\n/);
    expect(bib).toContain('  edition = {Ed. 2},');
    expect(bib).toContain('  series = {Seri Skripsi},');
    expect(bib).toContain(`  issn = {${RENDER_ISSN}},`);
    expect(bib).toContain('  doi = {10.1234/abc_5},');
    expect(bib).not.toContain('isbn');
  });
});
