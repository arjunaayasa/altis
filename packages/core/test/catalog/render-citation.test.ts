import { describe, expect, it } from 'vitest';
import { formatCitation } from '../../src/catalog/render/index.js';
import type { CitationPart } from '../../src/catalog/render/index.js';
import { agent, recordData } from '../support/record-data-fixtures.js';

// Spec §9.3 and D2-21: APA 7, MLA 9 and Chicago author-date. The connectors follow the UI language (`dkk.`/`et al.`,
// `dan`/`and`), APA keeps `&`, an `edt` agent alone is cited as the editor, and with no author the title comes first.

const text = (parts: readonly CitationPart[]): string => parts.map((p) => p.text).join('');

const hirata = () => agent('Hirata, Andrea', { isMain: true });
const toer = () => agent('Toer, Pramoedya Ananta');
const lestari = () => agent('Lestari, Dewi');
const TITLE = 'Laskar pelangi: Sebuah novel';

describe('formatCitation: APA 7', () => {
  it('one author: initials, year, the title in italics (subtitle capitalised), the publisher', () => {
    const parts = formatCitation(recordData(), 'apa', 'en');
    expect(parts).toEqual([{ text: 'Hirata, A. (2010). ' }, { text: TITLE, em: true }, { text: '. Bentang.' }]);
  });

  it('two authors are joined with a comma and & in both languages', () => {
    const d = recordData({ agents: [hirata(), toer()] });
    expect(text(formatCitation(d, 'apa', 'en'))).toBe(`Hirata, A., & Toer, P. A. (2010). ${TITLE}. Bentang.`);
    expect(text(formatCitation(d, 'apa', 'id'))).toBe(`Hirata, A., & Toer, P. A. (2010). ${TITLE}. Bentang.`);
  });

  it('three or more authors are all listed, & before the last; never et al. or dkk.', () => {
    const d = recordData({ agents: [hirata(), toer(), lestari()] });
    expect(text(formatCitation(d, 'apa', 'en'))).toBe(`Hirata, A., Toer, P. A., & Lestari, D. (2010). ${TITLE}. Bentang.`);
    expect(text(formatCitation(d, 'apa', 'id'))).toBe(`Hirata, A., Toer, P. A., & Lestari, D. (2010). ${TITLE}. Bentang.`);
  });

  it('more than 20 authors: the first 19, an ellipsis, the last', () => {
    const agents = Array.from({ length: 22 }, (_, i) => agent(`Penulis${i + 1}, Budi`));
    const first19 = Array.from({ length: 19 }, (_, i) => `Penulis${i + 1}, B.`).join(', ');
    expect(text(formatCitation(recordData({ agents }), 'apa', 'en'))).toBe(`${first19}, . . . Penulis22, B. (2010). ${TITLE}. Bentang.`);
  });

  it('an editor-only record names the editors with (Ed.) or (Eds.)', () => {
    const one = recordData({ agents: [agent('Hirata, Andrea', { role: 'edt' })] });
    expect(text(formatCitation(one, 'apa', 'id'))).toBe(`Hirata, A. (Ed.). (2010). ${TITLE}. Bentang.`);
    const two = recordData({ agents: [agent('Hirata, Andrea', { role: 'edt' }), agent('Toer, Pramoedya Ananta', { role: 'edt' })] });
    expect(text(formatCitation(two, 'apa', 'en'))).toBe(`Hirata, A., & Toer, P. A. (Eds.). (2010). ${TITLE}. Bentang.`);
  });

  it('an author makes the editor and other roles drop out of the author position', () => {
    const d = recordData({ agents: [agent('Toer, Pramoedya Ananta', { role: 'edt' }), hirata(), agent('Lestari, Dewi', { role: 'trl' })] });
    expect(text(formatCitation(d, 'apa', 'en'))).toBe(`Hirata, A. (2010). ${TITLE}. Bentang.`);
  });

  it('no author: the title comes first, then the year', () => {
    const parts = formatCitation(recordData({ agents: [] }), 'apa', 'en');
    expect(parts).toEqual([{ text: TITLE, em: true }, { text: '. (2010). Bentang.' }]);
  });

  it('no year: (n.d.) in English, (t.t.) in Indonesian', () => {
    const d = recordData({ publicationYear: undefined });
    expect(text(formatCitation(d, 'apa', 'en'))).toBe(`Hirata, A. (n.d.). ${TITLE}. Bentang.`);
    expect(text(formatCitation(d, 'apa', 'id'))).toBe(`Hirata, A. (t.t.). ${TITLE}. Bentang.`);
    expect(text(formatCitation(recordData({ publicationYear: '0000' }), 'apa', 'en'))).toBe(`Hirata, A. (n.d.). ${TITLE}. Bentang.`);
  });

  it('the edition follows the title in parentheses, without a doubled period', () => {
    expect(text(formatCitation(recordData({ edition: 'Cetakan ke-5.' }), 'apa', 'id'))).toBe(`Hirata, A. (2010). ${TITLE} (Cetakan ke-5). Bentang.`);
    expect(text(formatCitation(recordData({ edition: '2nd ed.' }), 'apa', 'en'))).toBe(`Hirata, A. (2010). ${TITLE} (2nd ed.). Bentang.`);
  });

  it('organisations and single names stand as written; particles, hyphens and suffixes are kept', () => {
    const cases: [ReturnType<typeof agent>, string][] = [
      [agent('Badan Pusat Statistik', { type: 'organization' }), 'Badan Pusat Statistik.'],
      [agent('Indonesia, Kementerian Agama', { type: 'organization' }), 'Indonesia, Kementerian Agama.'],
      [agent('Soekarno'), 'Soekarno.'],
      [agent('Beethoven, Ludwig van'), 'Beethoven, L. van.'],
      [agent('Sartre, Jean-Paul'), 'Sartre, J.-P.'],
      [agent('King, Martin Luther, Jr.'), 'King, M. L., Jr.'],
      [agent('Toer, Pramoedya Ananta,'), 'Toer, P. A.'],
    ];
    for (const [a, name] of cases) {
      expect(text(formatCitation(recordData({ agents: [a] }), 'apa', 'en')), a.name).toBe(`${name} (2010). ${TITLE}. Bentang.`);
    }
  });

  it('a title ending in ? takes no period; ISBD punctuation and line breaks are cleaned', () => {
    expect(text(formatCitation(recordData({ title: 'Siapa aku?', subtitle: undefined }), 'apa', 'en'))).toBe('Hirata, A. (2010). Siapa aku? Bentang.');
    const messy = recordData({ title: 'Laskar\r\npelangi :', subtitle: 'sebuah novel /', publisher: { id: 'p', name: 'Bentang,' } });
    expect(text(formatCitation(messy, 'apa', 'en'))).toBe(`Hirata, A. (2010). ${TITLE}. Bentang.`);
  });

  it('no publisher: the entry ends after the title', () => {
    expect(text(formatCitation(recordData({ publisher: null }), 'apa', 'en'))).toBe(`Hirata, A. (2010). ${TITLE}.`);
  });
});

describe('formatCitation: MLA 9', () => {
  it('one author: the inverted full name, the title, publisher and year', () => {
    const parts = formatCitation(recordData(), 'mla', 'en');
    expect(parts).toEqual([{ text: 'Hirata, Andrea. ' }, { text: TITLE, em: true }, { text: '. Bentang, 2010.' }]);
  });

  it('two authors: the second in direct order after and / dan', () => {
    const d = recordData({ agents: [hirata(), toer()] });
    expect(text(formatCitation(d, 'mla', 'en'))).toBe(`Hirata, Andrea, and Pramoedya Ananta Toer. ${TITLE}. Bentang, 2010.`);
    expect(text(formatCitation(d, 'mla', 'id'))).toBe(`Hirata, Andrea, dan Pramoedya Ananta Toer. ${TITLE}. Bentang, 2010.`);
  });

  it('three or more authors: et al. in English, dkk. in Indonesian', () => {
    const d = recordData({ agents: [hirata(), toer(), lestari()] });
    expect(text(formatCitation(d, 'mla', 'en'))).toBe(`Hirata, Andrea, et al. ${TITLE}. Bentang, 2010.`);
    expect(text(formatCitation(d, 'mla', 'id'))).toBe(`Hirata, Andrea, dkk. ${TITLE}. Bentang, 2010.`);
  });

  it('editors only: editor / editors (editor in Indonesian)', () => {
    const one = recordData({ agents: [agent('Hirata, Andrea', { role: 'edt' })] });
    expect(text(formatCitation(one, 'mla', 'en'))).toBe(`Hirata, Andrea, editor. ${TITLE}. Bentang, 2010.`);
    const two = recordData({ agents: [agent('Hirata, Andrea', { role: 'edt' }), agent('Toer, Pramoedya Ananta', { role: 'edt' })] });
    expect(text(formatCitation(two, 'mla', 'en'))).toBe(`Hirata, Andrea, and Pramoedya Ananta Toer, editors. ${TITLE}. Bentang, 2010.`);
    expect(text(formatCitation(two, 'mla', 'id'))).toBe(`Hirata, Andrea, dan Pramoedya Ananta Toer, editor. ${TITLE}. Bentang, 2010.`);
    const three = recordData({ agents: ['Hirata, Andrea', 'Toer, Pramoedya Ananta', 'Lestari, Dewi'].map((n) => agent(n, { role: 'edt' })) });
    expect(text(formatCitation(three, 'mla', 'id'))).toBe(`Hirata, Andrea, dkk., editor. ${TITLE}. Bentang, 2010.`);
  });

  it('the edition is the version element; no author puts the title first; missing parts are left out', () => {
    expect(text(formatCitation(recordData({ edition: 'Cetakan ke-5.' }), 'mla', 'id'))).toBe(`Hirata, Andrea. ${TITLE}. Cetakan ke-5, Bentang, 2010.`);
    expect(text(formatCitation(recordData({ edition: '2nd ed.' }), 'mla', 'en'))).toBe(`Hirata, Andrea. ${TITLE}. 2nd ed., Bentang, 2010.`);
    expect(formatCitation(recordData({ agents: [] }), 'mla', 'en')).toEqual([{ text: TITLE, em: true }, { text: '. Bentang, 2010.' }]);
    expect(formatCitation(recordData({ agents: [], publisher: null, publicationYear: undefined }), 'mla', 'en')).toEqual([
      { text: TITLE, em: true },
      { text: '.' },
    ]);
  });
});

describe('formatCitation: Chicago author-date', () => {
  it('one author: name, year, title, place: publisher', () => {
    const parts = formatCitation(recordData(), 'chicago', 'en');
    expect(parts).toEqual([{ text: 'Hirata, Andrea. 2010. ' }, { text: TITLE, em: true }, { text: '. Yogyakarta: Bentang.' }]);
  });

  it('up to ten authors are all listed, and / dan before the last', () => {
    const d = recordData({ agents: [hirata(), toer(), lestari()] });
    expect(text(formatCitation(d, 'chicago', 'en'))).toBe(`Hirata, Andrea, Pramoedya Ananta Toer, and Dewi Lestari. 2010. ${TITLE}. Yogyakarta: Bentang.`);
    expect(text(formatCitation(d, 'chicago', 'id'))).toBe(`Hirata, Andrea, Pramoedya Ananta Toer, dan Dewi Lestari. 2010. ${TITLE}. Yogyakarta: Bentang.`);
    const two = recordData({ agents: [hirata(), toer()] });
    expect(text(formatCitation(two, 'chicago', 'id'))).toBe(`Hirata, Andrea, dan Pramoedya Ananta Toer. 2010. ${TITLE}. Yogyakarta: Bentang.`);
  });

  it('more than ten authors: the first seven and et al. / dkk.', () => {
    const agents = Array.from({ length: 11 }, (_, i) => agent(`Penulis${i + 1}, Budi`));
    const seven = ['Penulis1, Budi', ...Array.from({ length: 6 }, (_, i) => `Budi Penulis${i + 2}`)].join(', ');
    expect(text(formatCitation(recordData({ agents }), 'chicago', 'en'))).toBe(`${seven}, et al. 2010. ${TITLE}. Yogyakarta: Bentang.`);
    expect(text(formatCitation(recordData({ agents }), 'chicago', 'id'))).toBe(`${seven}, dkk. 2010. ${TITLE}. Yogyakarta: Bentang.`);
  });

  it('editors only: ed. / eds.', () => {
    const one = recordData({ agents: [agent('Hirata, Andrea', { role: 'edt' })] });
    expect(text(formatCitation(one, 'chicago', 'en'))).toBe(`Hirata, Andrea, ed. 2010. ${TITLE}. Yogyakarta: Bentang.`);
    const two = recordData({ agents: [agent('Hirata, Andrea', { role: 'edt' }), agent('Toer, Pramoedya Ananta', { role: 'edt' })] });
    expect(text(formatCitation(two, 'chicago', 'en'))).toBe(`Hirata, Andrea, and Pramoedya Ananta Toer, eds. 2010. ${TITLE}. Yogyakarta: Bentang.`);
  });

  it('no author: the title, then the year; no year: n.d. / t.t.', () => {
    expect(formatCitation(recordData({ agents: [] }), 'chicago', 'en')).toEqual([{ text: TITLE, em: true }, { text: '. 2010. Yogyakarta: Bentang.' }]);
    expect(text(formatCitation(recordData({ publicationYear: undefined }), 'chicago', 'id'))).toBe(`Hirata, Andrea. t.t. ${TITLE}. Yogyakarta: Bentang.`);
    expect(text(formatCitation(recordData({ publicationYear: undefined }), 'chicago', 'en'))).toBe(`Hirata, Andrea. n.d. ${TITLE}. Yogyakarta: Bentang.`);
  });

  it('the edition, then place and publisher as far as they are known', () => {
    expect(text(formatCitation(recordData({ edition: 'Cetakan ke-5.' }), 'chicago', 'id'))).toBe(`Hirata, Andrea. 2010. ${TITLE}. Cetakan ke-5. Yogyakarta: Bentang.`);
    expect(text(formatCitation(recordData({ publisher: null }), 'chicago', 'en'))).toBe(`Hirata, Andrea. 2010. ${TITLE}. Yogyakarta.`);
    expect(text(formatCitation(recordData({ publicationPlace: undefined, publisher: { id: 'p', name: 'Bentang' } }), 'chicago', 'en'))).toBe(
      `Hirata, Andrea. 2010. ${TITLE}. Bentang.`,
    );
    // The record's place of publication comes first; the publisher authority's place is the fallback.
    expect(text(formatCitation(recordData({ publicationPlace: undefined }), 'chicago', 'en'))).toBe(`Hirata, Andrea. 2010. ${TITLE}. Yogyakarta: Bentang.`);
  });
});

describe('formatCitation: punctuation as catalogued', () => {
  it('a final period of the place or publisher is not doubled by a style; an abbreviation keeps its period', () => {
    const d = recordData({ publicationPlace: 'Yogyakarta.', publisher: { id: 'p', name: 'Bentang.' } });
    expect(text(formatCitation(d, 'apa', 'en'))).toBe(`Hirata, A. (2010). ${TITLE}. Bentang.`);
    expect(text(formatCitation(d, 'mla', 'en'))).toBe(`Hirata, Andrea. ${TITLE}. Bentang, 2010.`);
    expect(text(formatCitation(d, 'chicago', 'en'))).toBe(`Hirata, Andrea. 2010. ${TITLE}. Yogyakarta: Bentang.`);
    const co = recordData({ publisher: { id: 'p', name: 'Gramedia & Co.' } });
    expect(text(formatCitation(co, 'mla', 'en'))).toBe(`Hirata, Andrea. ${TITLE}. Gramedia & Co., 2010.`);
    expect(text(formatCitation(co, 'chicago', 'en'))).toBe(`Hirata, Andrea. 2010. ${TITLE}. Yogyakarta: Gramedia & Co.`);
  });
});

describe('formatCitation: parts', () => {
  it('only the title is emphasised, no part is empty, and adjacent plain parts are joined', () => {
    for (const style of ['apa', 'mla', 'chicago'] as const) {
      for (const d of [recordData(), recordData({ agents: [] }), recordData({ subtitle: undefined, edition: 'Ed. 2' })]) {
        const parts = formatCitation(d, style, 'id');
        expect(parts.filter((p) => p.em === true)).toHaveLength(1);
        expect(parts.every((p) => p.text !== '')).toBe(true);
        for (let i = 1; i < parts.length; i++) expect(parts[i]!.em === true || parts[i - 1]!.em === true, `${style} ${i}`).toBe(true);
        for (const p of parts) if (p.em !== true) expect(Object.keys(p)).toEqual(['text']);
      }
    }
  });
});
