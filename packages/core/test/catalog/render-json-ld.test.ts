import { describe, expect, it } from 'vitest';
import { recordJsonLd } from '../../src/catalog/render/index.js';
import { RENDER_CANONICAL, RENDER_ISBN_KEY, RENDER_ISSN, RENDER_OPTIONS, agent, materialType, recordData, subject } from '../support/record-data-fixtures.js';

// Spec §9.4 and D2-22: schema.org JSON-LD of a record, typed by `material_types.schema_type`.

describe('recordJsonLd', () => {
  it('describes a book', () => {
    expect(recordJsonLd(recordData(), RENDER_OPTIONS)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Book',
      '@id': RENDER_CANONICAL,
      url: RENDER_CANONICAL,
      name: 'Laskar pelangi',
      alternativeHeadline: 'sebuah novel',
      author: [{ '@type': 'Person', name: 'Andrea Hirata' }],
      publisher: { '@type': 'Organization', name: 'Bentang' },
      datePublished: '2010',
      isbn: RENDER_ISBN_KEY,
      inLanguage: 'id',
      about: [
        { '@type': 'Thing', name: 'Fiksi Indonesia' },
        { '@type': 'Place', name: 'Belitung' },
      ],
      description: 'Kisah sepuluh anak di sebuah pulau timah.',
    });
  });

  it('takes @type from the material type, with properties of that type only', () => {
    const thesis = recordJsonLd(recordData({ materialType: materialType('KARYA-ILMIAH'), physicalDesc: '245 hlm.', edition: 'Ed. 2' }), RENDER_OPTIONS);
    expect(thesis['@type']).toBe('Thesis');
    expect(thesis).not.toHaveProperty('isbn');
    expect(thesis).not.toHaveProperty('numberOfPages');
    expect(thesis).not.toHaveProperty('bookEdition');
    const map = recordJsonLd(recordData({ materialType: materialType('PETA'), physicalDesc: '1 peta : berwarna ; 60 x 90 cm' }), RENDER_OPTIONS);
    expect(map['@type']).toBe('Map');
    expect(map).not.toHaveProperty('numberOfPages');
    const serial = recordJsonLd(recordData({ materialType: materialType('BERSERI'), identifiers: [{ type: 'issn', value: RENDER_ISSN }] }), RENDER_OPTIONS);
    expect(serial['@type']).toBe('Periodical');
    expect(serial.issn).toBe(RENDER_ISSN);
    const book = recordJsonLd(recordData({ edition: 'Cetakan ke-5.', identifiers: [{ type: 'issn', value: RENDER_ISSN }] }), RENDER_OPTIONS);
    expect(book.bookEdition).toBe('Cetakan ke-5.');
    expect(book).not.toHaveProperty('issn');
    const odd = recordJsonLd(recordData({ materialType: { ...materialType('BUKU'), schemaType: '<script>' } }), RENDER_OPTIONS);
    expect(odd['@type']).toBe('CreativeWork');
  });

  it('gives numberOfPages only for a certain parse of the physical description', () => {
    const pages = (physicalDesc: string | undefined) => recordJsonLd(recordData({ physicalDesc }), RENDER_OPTIONS).numberOfPages;
    expect(pages('xii, 245 hlm.')).toBeUndefined();
    expect(pages('245 hlm.')).toBe(245);
    expect(pages('245 h.')).toBe(245);
    expect(pages('245 p. : ill.')).toBe(245);
    expect(pages(' 245 halaman ; 21 cm')).toBe(245);
    expect(pages('245 pages')).toBe(245);
    expect(pages('245hlm, ilus.')).toBe(245);
    expect(pages('245 hlmn.')).toBeUndefined();
    expect(pages('245 hal.')).toBeUndefined();
    expect(pages('0 hlm.')).toBeUndefined();
    expect(pages('99999999999999999999 hlm.')).toBeUndefined();
    expect(pages(undefined)).toBeUndefined();
  });

  it('always has a name: a title of ISBD punctuation alone is kept as written', () => {
    expect(recordJsonLd(recordData({ title: ' = ', subtitle: undefined }), RENDER_OPTIONS).name).toBe('=');
    expect(recordJsonLd(recordData({ title: 'Laskar pelangi :' }), RENDER_OPTIONS).name).toBe('Laskar pelangi');
  });

  it('has an image only with a cover', () => {
    expect(recordJsonLd(recordData(), RENDER_OPTIONS)).not.toHaveProperty('image');
    const cover = `${RENDER_OPTIONS.baseUrl}/files/01JRENDERCOVER000000000001`;
    expect(recordJsonLd(recordData(), { ...RENDER_OPTIONS, coverUrl: cover }).image).toBe(cover);
  });

  it('names authors and contributors in direct order, organisations as Organization', () => {
    const d = recordData({
      agents: [
        agent('Hirata, Andrea', { isMain: true }),
        agent('Badan Pusat Statistik', { type: 'organization' }),
        agent('Toer, Pramoedya Ananta', { role: 'edt' }),
        agent('Lestari, Dewi', { role: 'trl' }),
        agent('Hirata, Andrea', { role: 'ill' }),
      ],
    });
    d.agents[4]!.id = d.agents[0]!.id;
    const ld = recordJsonLd(d, RENDER_OPTIONS);
    expect(ld.author).toEqual([
      { '@type': 'Person', name: 'Andrea Hirata' },
      { '@type': 'Organization', name: 'Badan Pusat Statistik' },
    ]);
    expect(ld.contributor).toEqual([
      { '@type': 'Person', name: 'Pramoedya Ananta Toer' },
      { '@type': 'Person', name: 'Dewi Lestari' },
    ]);
  });

  it('writes inLanguage as a BCP 47 tag, and leaves out what is unknown or empty', () => {
    const lang = (code: string) => recordJsonLd(recordData({ languageCode: code, language: { code, nameId: code, nameEn: code } }), RENDER_OPTIONS).inLanguage;
    expect(lang('ind')).toBe('id');
    expect(lang('chi')).toBe('zh');
    expect(lang('jav')).toBe('jv');
    expect(lang('min')).toBe('min');
    expect(lang('IND')).toBe('id');
    expect(lang('x-1')).toBeUndefined();
    const bare = recordJsonLd(
      recordData({
        agents: [],
        subjects: [],
        publisher: null,
        publicationYear: undefined,
        subtitle: undefined,
        summary: undefined,
        notes: undefined,
        identifiers: [],
        languageCode: undefined,
        language: null,
      }),
      RENDER_OPTIONS,
    );
    expect(bare).toEqual({ '@context': 'https://schema.org', '@type': 'Book', '@id': RENDER_CANONICAL, url: RENDER_CANONICAL, name: 'Laskar pelangi' });
  });

  it('uses the notes when there is no summary, and keeps several ISBNs as a list', () => {
    const d = recordData({
      summary: undefined,
      identifiers: [
        { type: 'isbn', value: '978-602-291-135-7' },
        { type: 'isbn', value: '9786024246945' },
        { type: 'isbn', value: '9786022911357' },
      ],
      subjects: [subject('Fiksi')],
    });
    const ld = recordJsonLd(d, RENDER_OPTIONS);
    expect(ld.description).toBe('Novel pertama dari sebuah tetralogi.');
    expect(ld.isbn).toEqual(['9786022911357', '9786024246945']);
    expect(JSON.parse(JSON.stringify(ld))).toEqual(ld);
  });
});
