import { RecordDraft, type RecordData } from '@altis/shared/api/catalog/record-data';
import { describe, expect, it } from 'vitest';
import { marcToDraft, recordToMarc } from '../../src/marc/index.js';
import type { MarcControlField, MarcDataField, MarcRecord } from '../../src/marc/index.js';
import { ASDATA_UPDATED, CORPUS, asData, cf, df, materialTypeCodeFor } from '../support/marc-corpus.js';

// Spec §5.1 (the mapping table, both directions), D2-13 (items from 852 and 952) and the precedence rules of B3, S4 and
// S5 for the export.

const NS_STAFF = { audience: 'staff', orgCode: null, baseUrl: 'https://perpus.example', includeItems: true } as const;

const L = '00000nam a2200000 i 4500';

function map(rec: MarcRecord): { draft: RecordDraft; warnings: string[] } {
  return marcToDraft(rec, { materialTypeCodeFor });
}

const corpus = (name: string): MarcRecord => {
  const entry = CORPUS.find((e) => e.name === name);
  if (!entry) throw new Error(`no corpus record ${name}`);
  return entry.record;
};

const field = (rec: MarcRecord, tag: string): MarcDataField | MarcControlField | undefined => rec.fields.find((f) => f.tag === tag);
const fields = (rec: MarcRecord, tag: string) => rec.fields.filter((f) => f.tag === tag);

describe('marcToDraft: the whole draft of a full record', () => {
  it('maps every §5.1 field and keeps the unmapped ones in tag order', () => {
    const { draft, warnings } = map(corpus('novel, 264 _1, RDA, full set'));
    expect(warnings).toEqual([]);
    expect(draft).toEqual({
      materialTypeCode: 'BUKU',
      title: 'Laskar pelangi',
      subtitle: 'sebuah novel',
      responsibility: 'Andrea Hirata',
      edition: 'Cetakan ke-5',
      publisher: { name: 'Bentang', place: 'Yogyakarta' },
      publicationPlace: 'Yogyakarta',
      publicationYear: '2010',
      publicationDateText: '2010',
      physicalDesc: 'xii, 529 halaman ; 20 cm',
      classification: '899.2213',
      callNumber: '899.2213 HIR l',
      languageCode: 'ind',
      contentType: 'txt',
      mediaType: 'n',
      carrierType: 'nc',
      summary: 'Kisah sepuluh anak di sebuah pulau timah.',
      notes: 'Novel pertama dari sebuah tetralogi.',
      identifiers: [
        { type: 'control', value: 'ID-JKPN:B0001' },
        { type: 'isbn', value: '9786020000011' },
      ],
      agents: [{ type: 'person', name: 'Hirata, Andrea', role: 'aut', isMain: true }],
      subjects: [{ type: 'topic', term: 'Fiksi Indonesia', isPrimary: true }],
      links: [],
      items: [{ barcode: 'B000001', branchCode: 'PUSAT', locationCode: 'RAK-FIK', callNumber: '899.2213 HIR l', collectionTypeCode: 'UMUM' }],
      marcExtra: [
        { tag: 'LDR', ind1: ' ', ind2: ' ', data: L },
        { tag: '008', ind1: ' ', ind2: ' ', data: '261001s2010    io             000 0ind d' },
        { tag: '040', ind1: ' ', ind2: ' ', data: '[["a","ID-JKPN"],["b","ind"],["e","rda"]]' },
        { tag: '041', ind1: '0', ind2: ' ', data: '[["a","ind"]]' },
        { tag: '245', ind1: '1', ind2: '0', data: '[]' },
      ],
    });
  });
});

describe('marcToDraft: the contract', () => {
  it('gives a draft the strict RecordDraft schema accepts, without warnings, for every corpus record', () => {
    for (const { name, record } of CORPUS) {
      const { draft, warnings } = map(record);
      const parsed = RecordDraft.safeParse(draft);
      expect(parsed.success ? [] : parsed.error.issues, name).toEqual([]);
      expect(warnings, name).toEqual([]);
    }
  });

  it('keeps a 500 or 520 that has nothing to map in marcExtra', () => {
    const { draft } = map({ leader: L, fields: [df('245', '00', 'aJudul.'), df('500', '  ', '5ID-JKPN'), df('500', '  ', 'aCatatan.')] });
    expect(draft.notes).toBe('Catatan.');
    expect(draft.marcExtra.filter((f) => f.tag === '500')).toEqual([{ tag: '500', ind1: ' ', ind2: ' ', data: '[["5","ID-JKPN"]]' }]);
  });
});

describe('marcToDraft: identifiers', () => {
  it('020 $a 979-1234-56-7 (jil. 1) is an ISBN with the qualifier jil. 1; $q is a qualifier too; $z stays in marcExtra', () => {
    const { draft } = map(corpus('020 with $q, a qualifier in $a and a cancelled ISBN'));
    expect(draft.identifiers).toEqual([
      { type: 'control', value: 'B0011' },
      { type: 'isbn', value: '979-1234-56-7', qualifier: 'jil. 1' },
      { type: 'isbn', value: '9786020000042', qualifier: 'pbk.' },
      { type: 'isbn', value: '0-306-40615-2', qualifier: 'jil. 2' },
    ]);
    expect(draft.marcExtra.filter((f) => f.tag === '020')).toEqual([{ tag: '020', ind1: ' ', ind2: ' ', data: '[["z","9786020000099"]]' }]);
  });

  it('024 7_ $2 doi is a DOI, 024 8_ is another identifier, other 024 stay in marcExtra; 022 is an ISSN', () => {
    const { draft } = map(corpus('024 7_ doi, 024 8_ and an EAN 024 3_'));
    expect(draft.identifiers.slice(1)).toEqual([
      { type: 'doi', value: '10.1234/jpi.2020.0042' },
      { type: 'other', value: 'LAPORAN-2020-07', qualifier: 'versi cetak' },
    ]);
    expect(draft.marcExtra.filter((f) => f.tag === '024')).toEqual([{ tag: '024', ind1: '3', ind2: ' ', data: '[["a","9771234567003"]]' }]);
    expect(map(corpus('serial, 022 ISSN')).draft.identifiers.slice(1)).toEqual([{ type: 'issn', value: '0126-1238' }]);
  });

  it('the control identifier is <003>:<001>, or the 001 alone without a 003; 005 is not kept', () => {
    expect(map(corpus('novel, 264 _1, RDA, full set')).draft.identifiers[0]).toEqual({ type: 'control', value: 'ID-JKPN:B0001' });
    const { draft } = map(corpus('serial, 022 ISSN'));
    expect(draft.identifiers[0]).toEqual({ type: 'control', value: 'S0001' });
    expect(draft.marcExtra.some((f) => ['001', '003', '005'].includes(f.tag))).toBe(false);
  });

  it('drops the price in 020 $c (acquisition data)', () => {
    const { draft } = map(corpus('acquisition data: 541, 590 and a priced 952 (S5)'));
    expect(draft.identifiers[1]).toEqual({ type: 'isbn', value: '9786020000059' });
    expect(draft.marcExtra.some((f) => f.tag === '020')).toBe(false);
  });
});

describe('marcToDraft: publication, title, series, call numbers', () => {
  it('260 and 264 _1 both fill publisher, place and date', () => {
    for (const name of ['MARC-8: German diacritics, 260, translator', 'novel, 264 _1, RDA, full set']) {
      const { draft } = map(corpus(name));
      expect(draft.publisher?.name, name).toMatch(/^(Springer|Bentang)$/);
      expect([draft.publicationPlace, draft.publicationYear], name).toEqual(name.startsWith('MARC-8') ? ['Wien', '1931'] : ['Yogyakarta', '2010']);
    }
    expect(map(corpus('MARC-8: German diacritics, 260, translator')).draft.publicationDateText).toBe('c1931');
  });

  it('prefers 264 _1 to 260 and keeps the others (264 _4 too) in marcExtra; the year falls back to 008', () => {
    const { draft } = map(corpus('260 and 264 _1 together, 264 _4 copyright date'));
    expect([draft.publisher?.name, draft.publicationYear]).toEqual(['Rumah Gadang', '2018']);
    expect(draft.marcExtra.filter((f) => f.tag === '260' || f.tag === '264').map((f) => f.tag + f.ind2)).toEqual(['260 ', '2644']);
    const yearOnly = map(corpus('year only in 008')).draft;
    expect([yearOnly.publicationYear, yearOnly.publicationDateText, yearOnly.publisher?.name]).toEqual(['1975', '1975', 'Departemen P dan K']);
    expect(map(corpus('date in brackets and a question mark')).draft).toMatchObject({ publicationPlace: '[Batavia]', publicationDateText: '[195-?]' });
  });

  it('245: $a $n $p make the title, ISBD punctuation is dropped, the indicators and other subfields ride in a marcExtra 245', () => {
    const { draft } = map(corpus('245 with $n, $p and a residual $h'));
    expect([draft.title, draft.subtitle, draft.responsibility]).toEqual(['Ensiklopedia flora Indonesia. Jilid 2, Tumbuhan obat', undefined, 'tim penyusun']);
    expect(draft.marcExtra.find((f) => f.tag === '245')).toEqual({ tag: '245', ind1: '0', ind2: '0', data: '[["h","[teks]"]]' });
    const the = map(corpus('nonfiling article, The')).draft;
    expect(the.title).toBe('The burrow, or, There and back again');
    expect(the.marcExtra.find((f) => f.tag === '245')).toMatchObject({ ind1: '1', ind2: '4' });
  });

  it('245 ind2 is kept only when it ends on a word boundary of the title', () => {
    const rec: MarcRecord = { leader: L, fields: [df('245', '15', 'aHobbit.')] };
    expect(map(rec).draft.marcExtra.find((f) => f.tag === '245')).toMatchObject({ ind2: '0' });
    const apostrophe: MarcRecord = { leader: L, fields: [df('245', '12', "aL'amour.")] };
    expect(map(apostrophe).draft.marcExtra.find((f) => f.tag === '245')).toMatchObject({ ind2: '2' });
  });

  it('series come from 490, else 440, else 830; the others stay in marcExtra', () => {
    const both = map(corpus('series in 490 and 830')).draft;
    expect(both.series).toBe('Seri pustaka nusantara ; 12');
    expect(both.marcExtra.map((f) => f.tag)).toContain('830');
    expect(map(corpus('series in 440')).draft.series).toBe('Kumpulan cerpen ; 3');
  });

  it('call_number comes from 090, else 050, else 852 $h; 082 $a is the classification', () => {
    expect(map(corpus('novel, 264 _1, RDA, full set')).draft.callNumber).toBe('899.2213 HIR l');
    const lc = map(corpus('call number from 050 (no 090)')).draft;
    expect([lc.callNumber, lc.classification]).toEqual(['PL5089.H57 L37 2011', '899.2213']);
    expect(lc.marcExtra.filter((f) => f.tag === '082')).toEqual([{ tag: '082', ind1: '0', ind2: '4', data: '[["a","899.221"]]' }]);
    expect(map(corpus('call number from 852 $h, both 090 and 050 absent')).draft.callNumber).toBe('630.3 KAM');
  });

  it('the language comes from 008/35-37, else 041 $a; 041 stays in marcExtra', () => {
    expect(map(corpus('no 008: language from 041')).draft.languageCode).toBe('jav');
    const d = map(corpus('008 without a language code, 041 with two languages')).draft;
    expect(d.languageCode).toBe('sun');
    expect(d.marcExtra.map((f) => f.tag)).toEqual(['LDR', '008', '041', '245']);
  });

  it('255 or 256 is the material detail, 300 joins $a $b $c', () => {
    expect(map(corpus('map, 255 scale')).draft).toMatchObject({ materialDetail: 'Skala 1:250.000', physicalDesc: '1 peta : berwarna ; 60 x 90 cm', materialTypeCode: 'PETA' });
    expect(map(corpus('computer file, 256')).draft).toMatchObject({ materialDetail: 'Data elektronik (1 berkas)', materialTypeCode: null });
  });

  it('several 500 and 520 fields become lines of notes and summary', () => {
    const d = map(corpus('several notes and summaries')).draft;
    expect(d.notes).toBe('Indeks.\nJudul sampul: Rampai pendidikan.\nEdisi terbatas.');
    expect(d.summary).toBe('Membahas pendidikan dasar.\nDisertai studi kasus dari tiga provinsi.');
  });
});

describe('marcToDraft: agents and subjects', () => {
  it('maps 1XX as the main agent and 7XX as others, sorted by export tag; relators from $4, then $e, else aut', () => {
    const d = map(corpus('many agents: editor, translator by $4, organisation and meeting added entries')).draft;
    expect(d.agents).toEqual([
      { type: 'person', name: 'Dewi, Sari', role: 'edt', isMain: false },
      { type: 'person', name: 'Baker, Tom', role: 'trl', isMain: false },
      { type: 'organization', name: 'Universitas Pantai. Perpustakaan', role: 'aut', isMain: false },
      { type: 'meeting', name: 'Temu Ilmiah Pustakawan (4 : 2017 : Semarang)', role: 'aut', isMain: false },
    ]);
    const r = map(corpus('relators: unknown code and a compiler term')).draft;
    expect(r.agents.map((a) => a.role)).toEqual(['ctb', 'ctb', 'ill', 'ill']);
    expect(map(corpus('personal name with numeration and title of honour')).draft.agents).toEqual([
      { type: 'person', name: 'Hamengkubuwono IX, Sri Sultan', dates: '1912-1988', role: 'aut', isMain: true },
    ]);
  });

  it('a 7XX with $t (a work, not a contributor) stays in marcExtra; a second 1XX becomes an added entry', () => {
    const d = map(corpus('unmapped 5XX, 7XX and 9XX fields')).draft;
    expect(d.agents).toEqual([{ type: 'person', name: 'Nugroho, Bayu', role: 'aut', isMain: true }]);
    expect(d.marcExtra.map((f) => f.tag)).toEqual(['LDR', '008', '245', '504', '505', '546', '700', '730', '740', '990', '999']);
    expect(map(corpus('two 1XX fields (bad data): the second becomes an added entry')).draft.agents.map((a) => [a.name, a.isMain])).toEqual([
      ['Wijaya, Kurnia', true],
      ['Saputra, Eko', false],
    ]);
  });

  it('every 6XX type: 600, 610 and 611 are names; ind2 and $2 give the authority source', () => {
    const d = map(corpus('every 6XX type, 610 and 611 as names')).draft;
    expect(d.subjects).toEqual([
      { type: 'name', term: 'Soekarno, 1901-1970 -- Pidato', authoritySource: 'lcsh', isPrimary: true },
      { type: 'name', term: 'Boedi Oetomo', authoritySource: 'lcsh', isPrimary: false },
      { type: 'name', term: 'Kongres Pemuda (2 : 1928 : Jakarta)', authoritySource: 'lcsh', isPrimary: false },
      { type: 'temporal', term: '1908-1945', authoritySource: 'fast', isPrimary: false },
      { type: 'topic', term: 'Nasionalisme -- Indonesia -- Sejarah -- 20th century', authoritySource: 'lcsh', isPrimary: false },
      { type: 'geographic', term: 'Indonesia -- Politics and government', authoritySource: 'lcsh', isPrimary: false },
      { type: 'genre', term: 'Histories', authoritySource: 'lcgft', isPrimary: false },
      { type: 'occupation', term: 'Sejarawan', authoritySource: 'local', isPrimary: false },
    ]);
    const sources = map(corpus('subject sources by second indicator')).draft.subjects.map((s) => s.authoritySource);
    expect(sources).toEqual(['lcsh', 'lcshac', 'mesh', 'nal', 'cash', 'rvm', 'idsubj']);
  });

  it('keeps an agent or subject field with no name or term in marcExtra instead of dropping it', () => {
    const rec: MarcRecord = {
      leader: L,
      fields: [df('100', '1 ', 'd1900-1950.'), df('245', '00', 'aJudul.'), df('650', ' 7', '2lokal'), df('700', '1 ', 'aSari, Dewi.')],
    };
    const d = map(rec).draft;
    expect(d.agents).toEqual([{ type: 'person', name: 'Sari, Dewi', role: 'aut', isMain: false }]);
    expect(d.subjects).toEqual([]);
    expect(d.marcExtra.map((f) => [f.tag, f.data])).toEqual([
      ['LDR', L],
      ['100', '[["d","1900-1950."]]'],
      ['245', '[]'],
      ['650', '[["2","lokal"]]'],
    ]);
  });

  it('drops duplicate agents and subjects (the same key twice in one record)', () => {
    const rec: MarcRecord = {
      leader: L,
      fields: [df('100', '1 ', 'aSari, Dewi.'), df('245', '00', 'aJudul.'), df('650', ' 4', 'aSejarah.'), df('650', ' 4', 'aSEJARAH'), df('700', '1 ', 'asari,  dewi')],
    };
    const d = map(rec).draft;
    expect(d.agents).toHaveLength(1);
    expect(d.subjects).toHaveLength(1);
  });
});

describe('marcToDraft: items and links (D2-13)', () => {
  it('952 is an item with barcode, location code, call number and collection type; without $p it stays in marcExtra', () => {
    const d = map(corpus('items in 952 (Koha style) with prices')).draft;
    expect(d.items).toEqual([
      { barcode: 'B000101', branchCode: 'PUSAT', locationCode: 'RAK-PUI', callNumber: '811 ANT', collectionTypeCode: 'UMUM' },
      { barcode: 'B000102', branchCode: 'CAB1', locationCode: 'REF', callNumber: '811 ANT c.2', collectionTypeCode: 'REF' },
    ]);
    const partial = map(corpus('items with the record call number and a 952 without barcode')).draft;
    expect(partial.items.map((i) => i.barcode)).toEqual(['B005101', 'B005102']);
    expect(partial.marcExtra.filter((f) => f.tag === '952')).toEqual([{ tag: '952', ind1: ' ', ind2: ' ', data: '[["a","PUSAT"],["c","GUDANG"],["y","TANDON"]]' }]);
  });

  it('852 is an item from $p $c $h (+ $i) and $b; a holdings 852 without $p stays in marcExtra and gives the call number', () => {
    const d = map(corpus('items in 852 and a holdings 852 without a barcode')).draft;
    expect(d.items).toEqual([
      { barcode: 'B000201', branchCode: 'PUSAT', locationCode: 'RAK-598', callNumber: '598.0913 CAR f' },
      { barcode: 'B000202', branchCode: 'PUSAT', locationCode: 'RAK-598', callNumber: '598.0913 CAR f' },
    ]);
    expect(d.callNumber).toBe('598.0913');
    expect(d.marcExtra.filter((f) => f.tag === '852')).toHaveLength(1);
  });

  it('856 $u are links with $y as their title; an 856 without $u stays in marcExtra', () => {
    const d = map(corpus('856 links and an 856 without a URL')).draft;
    expect(d.links).toEqual([{ url: 'https://example.org/panduan.pdf', title: 'Teks lengkap' }, { url: 'http://example.org/sampul.jpg' }]);
    expect(d.marcExtra.filter((f) => f.tag === '856')).toHaveLength(1);
  });

  it('keeps the draft inside the contract widths and lists, with a warning for what it had to cut', () => {
    const rec: MarcRecord = {
      leader: L,
      fields: [df('245', '00', 'aJudul.'), df('250', '  ', `a${'e'.repeat(300)}`), df('ABC', '  ', 'ax'), df('500', '  ', `a${'n\u{1}'.repeat(3)}`)],
    };
    for (let i = 0; i < 210; i++) rec.fields.push(df('650', ' 4', `aTopik ${i}`));
    const { draft, warnings } = map(rec);
    expect(draft.edition).toHaveLength(191);
    expect(draft.subjects).toHaveLength(200);
    expect(draft.notes).toBe('n n n');
    expect(warnings).toEqual(expect.arrayContaining(['value_cut:edition', 'list_full:subjects', 'field_skipped:ABC']));
  });

  it('warns when the record has no title', () => {
    expect(map({ leader: L, fields: [df('500', '  ', 'aTanpa judul.')] }).warnings).toContain('title_missing');
  });

  it('drops trailing ISBD punctuation and relator punctuation in linear time, past a 1 MiB run of it inside a value', () => {
    // A run of separators that does not end the value: a regex `[…]+$` retries it from every start (quadratic; an
    // hour of blocked event loop for one MARCXML subfield, or for one record of an SRU answer).
    const run = ',:'.repeat(500_000);
    const rec: MarcRecord = {
      leader: L,
      fields: [df('245', '00', `ax${run}y`, `b${run} ;`), df('650', ' 4', `ax${run}y`), df('700', '1 ', 'aHirata, Andrea,', `ex${run}y`), df('710', '2 ', 'aBentang,', `eeditor${run}`)],
    };
    const started = performance.now();
    const { draft } = map(rec);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(draft.title.startsWith('x,:,:')).toBe(true);
    expect(draft.subtitle).toBeUndefined(); // separators only
    expect(draft.subjects.map((s) => s.term.length)).toEqual([191]);
    expect(draft.agents).toEqual([
      { type: 'person', name: 'Hirata, Andrea', role: 'ctb', isMain: false },
      { type: 'organization', name: 'Bentang', role: 'edt', isMain: false },
    ]);
  });
});

describe('recordToMarc: precedence (B3)', () => {
  const base = (): RecordData => asData(map(corpus('novel, 264 _1, RDA, full set')).draft);

  it('takes the leader from marcExtra LDR with 00-04, 09 and 12-16 recomputed; generates one otherwise', () => {
    const marc8 = map(CORPUS.find((e) => e.marc8)!.record).draft;
    const out = recordToMarc(asData(marc8), NS_STAFF);
    expect(out.leader.slice(5, 9) + out.leader.slice(10, 12) + out.leader.slice(17)).toBe('nam 22 a 4500');
    expect(out.leader[9]).toBe('a');
    expect(Number(out.leader.slice(0, 5))).toBeGreaterThan(100);
    const plain: RecordData = { ...base(), marcExtra: [] };
    expect(recordToMarc(plain, NS_STAFF).leader.slice(5)).toMatch(/^nam a22\d{5} i 4500$/);
  });

  it('always generates 001, 003 and 005 and drops them from marcExtra', () => {
    const data: RecordData = {
      ...base(),
      marcExtra: [
        ...base().marcExtra,
        { tag: '001', ind1: ' ', ind2: ' ', data: 'OLD' },
        { tag: '003', ind1: ' ', ind2: ' ', data: 'OLD' },
        { tag: '005', ind1: ' ', ind2: ' ', data: '19990101000000.0' },
      ],
    };
    const out = recordToMarc(data, { ...NS_STAFF, orgCode: 'ID-ALTIS' });
    expect(fields(out, '001')).toEqual([cf('001', data.id)]);
    expect(fields(out, '003')).toEqual([cf('003', 'ID-ALTIS')]);
    expect(fields(out, '005')).toEqual([cf('005', '20261002093015.0')]);
    expect(ASDATA_UPDATED).toBe(Date.UTC(2026, 9, 2, 9, 30, 15));
    expect(field(recordToMarc(data, NS_STAFF), '003')).toBeUndefined();
  });

  it('uses the marcExtra 008 (its language set from the record), else generates one from createdAt, year and language', () => {
    expect(field(recordToMarc(base(), NS_STAFF), '008')).toEqual(cf('008', '261001s2010    io             000 0ind d'));
    const fromOld = recordToMarc({ ...base(), languageCode: 'eng', language: { code: 'eng', nameId: '', nameEn: '' } }, NS_STAFF);
    expect((field(fromOld, '008') as MarcControlField).value.slice(35, 38)).toBe('eng');
    const generated = recordToMarc({ ...base(), marcExtra: [] }, NS_STAFF);
    expect(field(generated, '008')).toEqual(cf('008', `261001s2010    xx ${'|'.repeat(17)}ind d`));
    const noYear = recordToMarc({ ...base(), marcExtra: [], publicationYear: undefined, language: null, languageCode: undefined }, NS_STAFF);
    expect(field(noYear, '008')).toEqual(cf('008', `261001nuuuu    xx ${'|'.repeat(17)}||| d`));
  });

  it('generates 040 $a orgCode only when marcExtra holds no 040 and an org code is set', () => {
    expect(fields(recordToMarc(base(), { ...NS_STAFF, orgCode: 'ID-ALTIS' }), '040')).toEqual([df('040', '  ', 'aID-JKPN', 'bind', 'erda')]);
    const without = { ...base(), marcExtra: base().marcExtra.filter((f) => f.tag !== '040') };
    expect(fields(recordToMarc(without, { ...NS_STAFF, orgCode: 'ID-ALTIS' }), '040')).toEqual([df('040', '  ', 'aID-ALTIS')]);
    expect(fields(recordToMarc(without, NS_STAFF), '040')).toEqual([]);
  });

  it('never emits a non-repeatable tag twice: the generated or mapped field wins over marcExtra', () => {
    const data: RecordData = {
      ...base(),
      marcExtra: [
        ...base().marcExtra,
        { tag: '008', ind1: ' ', ind2: ' ', data: 'x'.repeat(40) },
        { tag: '100', ind1: '1', ind2: ' ', data: '[["a","Lain, Orang"]]' },
        { tag: '245', ind1: '0', ind2: '0', data: '[["a","Judul lain"]]' },
        { tag: '090', ind1: ' ', ind2: ' ', data: '[["a","000 X"]]' },
      ],
    };
    const out = recordToMarc(data, NS_STAFF);
    for (const tag of ['008', '100', '245', '090']) expect(fields(out, tag), tag).toHaveLength(1);
    // One name main entry (100, 110 or 111): the generated one wins over another 1XX tag in marcExtra too.
    const other = recordToMarc({ ...data, marcExtra: [...data.marcExtra, { tag: '110', ind1: '2', ind2: ' ', data: '[["a","Badan lain"]]' }] }, NS_STAFF);
    expect(other.fields.filter((f) => /^1(00|10|11)$/.test(f.tag)).map((f) => f.tag)).toEqual(['100']);
    const noMain = recordToMarc({ ...data, agents: [], marcExtra: [...data.marcExtra.filter((f) => f.tag !== '100'), { tag: '111', ind1: '2', ind2: ' ', data: '[["a","Rapat"]]' }, { tag: '110', ind1: '2', ind2: ' ', data: '[["a","Badan"]]' }] }, NS_STAFF);
    expect(noMain.fields.filter((f) => /^1(00|10|11)$/.test(f.tag)).map((f) => f.tag)).toEqual(['110']);
    expect(field(out, '100')).toEqual(df('100', '1 ', 'aHirata, Andrea,', 'eauthor', '4aut'));
    expect(field(out, '245')).toEqual(df('245', '10', 'aLaskar pelangi :', 'bsebuah novel /', 'cAndrea Hirata.'));
  });

  it('writes the mapped fields: 264 _1, 490 0_, 090, 300 $a, ISBD punctuation, subjects by type', () => {
    const out = recordToMarc(base(), NS_STAFF);
    expect(field(out, '264')).toEqual(df('264', ' 1', 'aYogyakarta :', 'bBentang,', 'c2010'));
    expect(field(out, '090')).toEqual(df('090', '  ', 'a899.2213 HIR l'));
    expect(field(out, '300')).toEqual(df('300', '  ', 'axii, 529 halaman ; 20 cm'));
    expect(field(out, '650')).toEqual(df('650', ' 4', 'aFiksi Indonesia'));
    const series = recordToMarc(asData(map(corpus('series in 490 and 830')).draft), NS_STAFF);
    expect(field(series, '490')).toEqual(df('490', '0 ', 'aSeri pustaka nusantara ;', 'v12'));
    const six = recordToMarc(asData(map(corpus('every 6XX type, 610 and 611 as names')).draft), NS_STAFF);
    expect(six.fields.filter((f) => f.tag.startsWith('6')).map((f) => f.tag)).toEqual(['600', '600', '600', '648', '650', '651', '655', '656']);
    expect(field(six, '655')).toEqual(df('655', ' 7', 'aHistories', '2lcgft'));
  });

  it('writes an authority source it has no indicator for as ind2 7 + $2, whatever its name', () => {
    const data: RecordData = { ...base(), subjects: [{ id: 'S1', type: 'topic', term: 'Kota -- Sejarah', authoritySource: 'constructor', isPrimary: true }] };
    expect(field(recordToMarc(data, NS_STAFF), '650')).toEqual(df('650', ' 7', 'aKota', 'xSejarah', '2constructor'));
  });

  it('writes 852 only with includeItems ($b branch, $c location, $h call number, $p barcode)', () => {
    const data = base();
    expect(fields(recordToMarc(data, { ...NS_STAFF, includeItems: false }), '852')).toEqual([]);
    expect(fields(recordToMarc(data, NS_STAFF), '852')).toEqual([df('852', '  ', 'bPUSAT', 'cRAK-FIK', 'h899.2213 HIR l', 'pB000001')]);
  });

  it('writes 856 for public attachments only: an http(s) URL re-checked (S4), or <baseUrl>/files/<id> for a file', () => {
    const data: RecordData = {
      ...base(),
      attachments: [
        { id: 'A1', kind: 'url', fileId: null, url: 'https://example.org/a.pdf', title: 'Teks', access: 'public', mime: null },
        { id: 'A2', kind: 'url', fileId: null, url: 'https://example.org/staff.pdf', title: 'Staf', access: 'staff', mime: null },
        { id: 'A3', kind: 'file', fileId: '01JFILE0000000000000000001', url: null, title: 'Berkas PDF', access: 'public', mime: 'application/pdf' },
        { id: 'A4', kind: 'url', fileId: null, url: 'javascript:alert(1)', title: 'x', access: 'public', mime: null },
        { id: 'A5', kind: 'url', fileId: null, url: ' JAVASCRIPT:alert(1)', title: 'x', access: 'public', mime: null },
        { id: 'A6', kind: 'url', fileId: null, url: 'https://example.org/b', title: 'https://example.org/b', access: 'public', mime: null },
      ],
    };
    expect(fields(recordToMarc(data, { ...NS_STAFF, baseUrl: 'https://perpus.example/' }), '856')).toEqual([
      df('856', '40', 'uhttps://example.org/a.pdf', 'yTeks'),
      df('856', '40', 'uhttps://perpus.example/files/01JFILE0000000000000000001', 'yBerkas PDF'),
      df('856', '40', 'uhttps://example.org/b'),
    ]);
  });

  it('S4: an 856 whose $u is javascript:x is not written back, from a link or from marcExtra', () => {
    const rec: MarcRecord = { leader: L, fields: [df('245', '00', 'aJudul.'), df('856', '40', 'ujavascript:x', 'yKlik')] };
    const { draft } = map(rec);
    expect(draft.links).toEqual([{ url: 'javascript:x', title: 'Klik' }]);
    const data = asData({ ...draft, marcExtra: [...draft.marcExtra, { tag: '856', ind1: '4', ind2: '0', data: '[["u","javascript:y"]]' }] });
    for (const audience of ['staff', 'public'] as const) {
      const out = recordToMarc(data, { ...NS_STAFF, audience });
      expect(fields(out, '856'), audience).toEqual([]);
      expect(JSON.stringify(out)).not.toMatch(/javascript/i);
    }
  });

  it('S5: public output drops 541, 561, 583, 590-599, 852, 876-878 and every 9XX of marcExtra; staff keeps them', () => {
    const data = asData(map(corpus('acquisition data: 541, 590 and a priced 952 (S5)')).draft);
    const pub = recordToMarc(data, { ...NS_STAFF, audience: 'public', includeItems: false });
    expect(pub.fields.map((f) => f.tag).filter((t) => /^(541|561|583|59\d|852|87[6-8]|9\d\d)$/.test(t))).toEqual([]);
    expect(JSON.stringify(pub)).not.toMatch(/125[.]?000|Rp/);
    const staff = recordToMarc(data, NS_STAFF);
    expect(staff.fields.map((f) => f.tag)).toEqual(expect.arrayContaining(['541', '561', '583', '590', '877', '952']));
    expect(JSON.stringify(fields(staff, '852'))).not.toMatch(/125000/);
  });

  it('never writes acquisition data into generated fields', () => {
    const out = recordToMarc(base(), { ...NS_STAFF, includeItems: true });
    expect(JSON.stringify(out.fields.filter((f) => f.tag === '852'))).not.toMatch(/price|supplier|invoice/i);
  });
});
