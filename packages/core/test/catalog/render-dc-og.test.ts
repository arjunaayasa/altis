import { describe, expect, it } from 'vitest';
import { dublinCoreMeta, openGraph, toOaiDc } from '../../src/catalog/render/index.js';
import { createXmlReader } from '../../src/xml/index.js';
import type { XmlEvent } from '../../src/xml/index.js';
import {
  RENDER_BASE_URL,
  RENDER_CANONICAL,
  RENDER_ISBN_KEY,
  RENDER_ISSN,
  RENDER_OPTIONS,
  agent,
  materialType,
  recordData,
  subject,
} from '../support/record-data-fixtures.js';

// Spec §9.3 (Dublin Core and OpenGraph in the detail's <head>) and §10 (`oai_dc`).

const OAI_DC_NS = 'http://www.openarchives.org/OAI/2.0/oai_dc/';
const DC_NS = 'http://purl.org/dc/elements/1.1/';

/** The root's attributes and the dc:* elements (name → texts) of an oai_dc document, read with Task 5's reader. */
function readOaiDc(xml: string): { root: string; attrs: Record<string, string>; dc: Record<string, string[]>; depth2: boolean } {
  const reader = createXmlReader();
  const events: XmlEvent[] = [...reader.write(xml), ...reader.end()];
  const first = events[0];
  if (first?.type !== 'open') throw new Error('no root');
  const dc: Record<string, string[]> = {};
  let depth = 0;
  let current: string | null = null;
  let depth2 = false;
  for (const e of events) {
    if (e.type === 'open') {
      depth++;
      if (depth > 2) depth2 = true;
      if (depth === 2) current = e.name;
      if (depth === 2 && e.selfClosing) (dc[e.name] ??= []).push('');
    } else if (e.type === 'close') {
      depth--;
      current = null;
    } else if (current !== null) {
      (dc[current] ??= []).push(e.text);
    }
  }
  return { root: first.name, attrs: { ...first.attrs }, dc, depth2 };
}

describe('dublinCoreMeta', () => {
  it('lists the DC.* elements of §9.3, the ISBN as urn:isbn', () => {
    expect(dublinCoreMeta(recordData(), RENDER_OPTIONS)).toEqual([
      { name: 'DC.title', content: 'Laskar pelangi: sebuah novel' },
      { name: 'DC.creator', content: 'Hirata, Andrea' },
      { name: 'DC.subject', content: 'Fiksi Indonesia' },
      { name: 'DC.subject', content: '899.2213' },
      { name: 'DC.date', content: '2010' },
      { name: 'DC.publisher', content: 'Bentang' },
      { name: 'DC.language', content: 'ind' },
      { name: 'DC.identifier', content: RENDER_CANONICAL },
      { name: 'DC.identifier', content: `urn:isbn:${RENDER_ISBN_KEY}` },
      { name: 'DC.type', content: 'Text' },
      { name: 'DC.type', content: 'Book' },
      { name: 'DC.format', content: 'xii, 529 hlm. ; 20 cm' },
    ]);
  });

  it('writes the ISSN as urn:issn, the DOI as a resolver URL and a public link as an identifier', () => {
    const d = recordData({
      identifiers: [
        { type: 'issn', value: '1411 4348' },
        { type: 'doi', value: 'doi:10.1234/ABC' },
        { type: 'isbn', value: 'bukan ISBN' },
      ],
      attachments: [],
    });
    d.attachments.push({ id: 'a1', kind: 'url', fileId: null, url: 'https://repo.example.org/laskar.pdf', title: 'PDF', access: 'public', mime: null });
    const ids = dublinCoreMeta(d, RENDER_OPTIONS).filter((m) => m.name === 'DC.identifier');
    expect(ids.map((m) => m.content)).toEqual([RENDER_CANONICAL, `urn:issn:${RENDER_ISSN}`, 'https://doi.org/10.1234/abc', 'https://repo.example.org/laskar.pdf']);
  });

  it('names the creator with dates, and writes no empty element', () => {
    const d = recordData({
      agents: [agent('Toer, Pramoedya Ananta', { isMain: true, dates: '1925-2006' })],
      publisher: null,
      publicationYear: undefined,
      physicalDesc: '   ',
      classification: undefined,
      subjects: [],
    });
    const meta = dublinCoreMeta(d, RENDER_OPTIONS);
    expect(meta.find((m) => m.name === 'DC.creator')?.content).toBe('Toer, Pramoedya Ananta, 1925-2006');
    expect(meta.map((m) => m.name)).not.toContain('DC.publisher');
    expect(meta.map((m) => m.name)).not.toContain('DC.date');
    expect(meta.map((m) => m.name)).not.toContain('DC.format');
    expect(meta.map((m) => m.name)).not.toContain('DC.subject');
    expect(meta.every((m) => m.content.trim() !== '')).toBe(true);
  });
});

describe('toOaiDc', () => {
  it('parses with the reader: the oai_dc root with its namespaces and the §10 elements', () => {
    const related = '01JRENDERREL00000000000001';
    const d = recordData({
      agents: [agent('Hirata, Andrea', { isMain: true }), agent('Toer, Pramoedya Ananta', { role: 'edt' })],
      series: 'Tetralogi Laskar Pelangi',
      subjects: [subject('Fiksi Indonesia'), subject('Belitung', { type: 'geographic' }), subject('Persahabatan')],
      relations: [{ type: 'other_edition', direction: 'in', recordId: related, title: 'Laskar Pelangi (edisi baru)' }],
    });
    const { root, attrs, dc, depth2 } = readOaiDc(toOaiDc(d, RENDER_OPTIONS));
    expect(root).toBe('oai_dc:dc');
    expect(attrs['xmlns:oai_dc']).toBe(OAI_DC_NS);
    expect(attrs['xmlns:dc']).toBe(DC_NS);
    expect(attrs['xmlns:xsi']).toBe('http://www.w3.org/2001/XMLSchema-instance');
    expect(attrs['xsi:schemaLocation']).toBe(`${OAI_DC_NS} http://www.openarchives.org/OAI/2.0/oai_dc.xsd`);
    expect(depth2).toBe(false);
    expect(dc).toEqual({
      'dc:title': ['Laskar pelangi: sebuah novel'],
      'dc:creator': ['Hirata, Andrea'],
      'dc:contributor': ['Toer, Pramoedya Ananta'],
      'dc:subject': ['Fiksi Indonesia', 'Persahabatan', '899.2213'],
      'dc:description': ['Kisah sepuluh anak di sebuah pulau timah.', 'Novel pertama dari sebuah tetralogi.'],
      'dc:publisher': ['Bentang'],
      'dc:date': ['2010'],
      'dc:type': ['Text', 'Book'],
      'dc:format': ['xii, 529 hlm. ; 20 cm'],
      'dc:identifier': [RENDER_CANONICAL, `urn:isbn:${RENDER_ISBN_KEY}`],
      'dc:language': ['ind'],
      'dc:relation': ['Tetralogi Laskar Pelangi', `${RENDER_BASE_URL}/katalog/${related}/laskar-pelangi-edisi-baru`],
      'dc:coverage': ['Belitung'],
    });
  });

  it('dc:title is the title alone without a subtitle; text is escaped and forbidden characters dropped', () => {
    const plain = readOaiDc(toOaiDc(recordData({ subtitle: undefined }), RENDER_OPTIONS));
    expect(plain.dc['dc:title']).toEqual(['Laskar pelangi']);
    const tricky = readOaiDc(toOaiDc(recordData({ title: 'A & B <c> "d"', subtitle: ']]>', summary: 'x\u0001y\nz', notes: undefined }), RENDER_OPTIONS));
    expect(tricky.dc['dc:title']).toEqual(['A & B <c> "d": ]]>']);
    expect(tricky.dc['dc:description']).toEqual(['xy\nz']);
  });

  it('writes the material type of a map as its DCMI type and English name, and an ISSN and DOI as identifiers', () => {
    const d = recordData({
      materialType: materialType('PETA'),
      identifiers: [
        { type: 'issn', value: RENDER_ISSN },
        { type: 'doi', value: '10.1234/x' },
      ],
    });
    const { dc } = readOaiDc(toOaiDc(d, RENDER_OPTIONS));
    expect(dc['dc:type']).toEqual(['Image', 'Map']);
    expect(dc['dc:identifier']).toEqual([RENDER_CANONICAL, `urn:issn:${RENDER_ISSN}`, 'https://doi.org/10.1234/x']);
  });
});

describe('openGraph', () => {
  it('describes a book page', () => {
    expect(openGraph(recordData(), RENDER_OPTIONS)).toEqual([
      { property: 'og:type', content: 'book' },
      { property: 'og:title', content: 'Laskar pelangi: sebuah novel' },
      { property: 'og:description', content: 'Kisah sepuluh anak di sebuah pulau timah.' },
      { property: 'og:url', content: RENDER_CANONICAL },
      { property: 'og:locale', content: 'id_ID' },
      { property: 'og:locale:alternate', content: 'en_US' },
      { property: 'book:isbn', content: RENDER_ISBN_KEY },
      { property: 'book:release_date', content: '2010' },
      { property: 'book:tag', content: 'Fiksi Indonesia' },
      { property: 'book:tag', content: 'Belitung' },
    ]);
  });

  it('adds the cover as og:image, follows the UI language, and is a website for other types', () => {
    const cover = `${RENDER_BASE_URL}/files/01JRENDERCOVER000000000001`;
    const og = openGraph(recordData({ materialType: materialType('PETA') }), { ...RENDER_OPTIONS, locale: 'en', coverUrl: cover });
    expect(og).toContainEqual({ property: 'og:type', content: 'website' });
    expect(og).toContainEqual({ property: 'og:image', content: cover });
    expect(og).toContainEqual({ property: 'og:image:alt', content: 'Laskar pelangi: sebuah novel' });
    expect(og).toContainEqual({ property: 'og:locale', content: 'en_US' });
    expect(og).toContainEqual({ property: 'og:locale:alternate', content: 'id_ID' });
    expect(og.some((m) => m.property.startsWith('book:'))).toBe(false);
  });

  it('cuts a long description at a word to at most 300 characters', () => {
    const long = `${'kata '.repeat(100)}akhir`;
    const desc = openGraph(recordData({ summary: long }), RENDER_OPTIONS).find((m) => m.property === 'og:description')!.content;
    expect(desc.length).toBeLessThanOrEqual(300);
    expect(desc.endsWith('kata\u{2026}')).toBe(true);
    const none = openGraph(recordData({ summary: undefined, notes: undefined }), RENDER_OPTIONS);
    expect(none.some((m) => m.property === 'og:description')).toBe(false);
  });
});

describe('characters XML 1.0 forbids', () => {
  it('leave no separator or empty element behind: they are dropped before a value is judged empty', () => {
    const d = recordData({ subtitle: '\u{FFFF}', summary: '\u{FFFE} \u{D800}', series: '\u{DFFF}', physicalDesc: 'xii, 529 hlm.\u{FFFF}' });
    const { dc } = readOaiDc(toOaiDc(d, RENDER_OPTIONS));
    expect(dc['dc:title']).toEqual(['Laskar pelangi']);
    expect(dc['dc:description']).toEqual(['Novel pertama dari sebuah tetralogi.']);
    expect(dc['dc:relation']).toBeUndefined();
    expect(dc['dc:format']).toEqual(['xii, 529 hlm.']);
    const meta = dublinCoreMeta(d, RENDER_OPTIONS);
    expect(meta.find((m) => m.name === 'DC.title')?.content).toBe('Laskar pelangi');
    expect(openGraph(d, RENDER_OPTIONS).find((m) => m.property === 'og:title')?.content).toBe('Laskar pelangi');
  });
});
