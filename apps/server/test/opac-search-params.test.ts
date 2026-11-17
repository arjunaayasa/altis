import { newId } from '@altis/shared';
import { describe, expect, it } from 'vitest';
import {
  OPAC_SEARCH_PARAMS,
  OPAC_SEARCH_TEXT_MAX,
  parseOpacSearchParams,
  searchPath,
  type OpacSearchLookups,
  type OpacSearchParam,
} from '../src/opac/catalog/search-params.js';
import { isLocalPath } from '../src/opac/catalog/urls.js';

// The query string of the OPAC search (Phase 2 Task 33; spec §4.4–§4.6, §9.1): `/cari` and `/cari/rss` take `q`, the
// codes `jenis`, `bahasa`, `koleksi`, `cabang`, the ids `lokasi`, `subjek`, `pengarang`, `tahun` (`1990-2000` or one
// year), `tersedia=1`, `lampiran`, `kelas` 0-9 (the `cl` facet, M4), `urut`, `hal` and `persis=1` (the original
// query of an applied correction). Every invalid or unknown value is ignored, never a 4xx: the parser never throws,
// and what it accepted comes back as `echo`, from which every link of the page is built (searchPath).

const BUKU = newId(Date.UTC(2026, 0, 1));
const EBOOK = newId(Date.UTC(2026, 0, 2));
const IND = newId(Date.UTC(2026, 0, 3));
const UMUM = newId(Date.UTC(2026, 0, 4));
const PUSAT = newId(Date.UTC(2026, 0, 5));
const ROOM = newId(Date.UTC(2026, 0, 6));
const SUBJECT = newId(Date.UTC(2026, 0, 7));
const AGENT = newId(Date.UTC(2026, 0, 8));

const LOOKUPS: OpacSearchLookups = {
  materialTypeByCode: new Map([
    ['BUKU', BUKU],
    ['EBOOK', EBOOK],
  ]),
  languageByCode: new Map([['IND', IND]]),
  collectionTypeByCode: new Map([['UMUM', UMUM]]),
  branchByCode: new Map([['PUSAT', PUSAT]]),
};

const parse = (query: string) => parseOpacSearchParams(new URLSearchParams(query), LOOKUPS);

describe('parseOpacSearchParams', () => {
  it('no parameter: no text, the opac scope, no filter, newest first (S14), page 1, nothing echoed', () => {
    const { query, echo } = parse('');
    expect(query).toEqual({ text: '', scope: 'opac', filters: {}, sort: 'newest', page: 1 });
    expect(echo).toEqual({});
  });

  it('q: trimmed, control characters and line separators become spaces, runs of spaces one, at most 500 code points', () => {
    expect(parse('q=%20%20laskar%20%20pelangi%20').query.text).toBe('laskar pelangi');
    expect(parse('q=laskar%00%0A%E2%80%A8pelangi%09x').query.text).toBe('laskar pelangi x');
    expect(parse('q=laskar').echo).toEqual({ q: 'laskar' });
    const long = '\u{1D538}'.repeat(OPAC_SEARCH_TEXT_MAX + 20);
    const cut = parse(`q=${encodeURIComponent(long)}`).query.text;
    expect(Array.from(cut)).toHaveLength(OPAC_SEARCH_TEXT_MAX);
    expect(cut).toBe('\u{1D538}'.repeat(OPAC_SEARCH_TEXT_MAX)); // never half a surrogate pair
    expect(parse('q=%20%0A%20').query.text).toBe('');
    expect(parse('q=%20%0A%20').echo).toEqual({});
  });

  it('with q the default order is relevance, without it newest (S14)', () => {
    expect(parse('q=laskar').query.sort).toBe('relevance');
    expect(parse('q=').query.sort).toBe('newest');
  });

  it('urut: relevansi|terbaru|judul|tahun_baru|tahun_lama; relevansi without q and anything else are ignored', () => {
    expect(parse('q=a&urut=terbaru')).toMatchObject({ query: { sort: 'newest' }, echo: { urut: 'terbaru' } });
    expect(parse('urut=judul')).toMatchObject({ query: { sort: 'title' }, echo: { urut: 'judul' } });
    expect(parse('urut=tahun_baru').query.sort).toBe('year_desc');
    expect(parse('urut=tahun_lama').query.sort).toBe('year_asc');
    expect(parse('q=a&urut=relevansi')).toMatchObject({ query: { sort: 'relevance' }, echo: { urut: 'relevansi' } });
    for (const bad of ['urut=relevansi', 'urut=xyz', 'urut=JUDUL', 'urut=']) {
      const { query, echo } = parse(bad);
      expect(query.sort, bad).toBe('newest');
      expect(echo.urut, bad).toBeUndefined();
    }
  });

  it('tahun=1990-2000 → yearFrom 1990, yearTo 2000; one year → both; a reversed range is put in order', () => {
    expect(parse('tahun=1990-2000')).toMatchObject({ query: { filters: { yearFrom: 1990, yearTo: 2000 } }, echo: { tahun: '1990-2000' } });
    expect(parse('tahun=1995')).toMatchObject({ query: { filters: { yearFrom: 1995, yearTo: 1995 } }, echo: { tahun: '1995' } });
    expect(parse('tahun=%201990%20%E2%80%93%202000%20')).toMatchObject({ query: { filters: { yearFrom: 1990, yearTo: 2000 } }, echo: { tahun: '1990-2000' } });
    expect(parse('tahun=2000-1990')).toMatchObject({ query: { filters: { yearFrom: 1990, yearTo: 2000 } }, echo: { tahun: '1990-2000' } });
  });

  it('tahun=abc (and other shapes) is ignored', () => {
    for (const bad of ['tahun=abc', 'tahun=', 'tahun=19900', 'tahun=1990-', 'tahun=-2000', 'tahun=1990-2000-2010', 'tahun=1e3', 'tahun=%EF%BC%91%EF%BC%99%EF%BC%99%EF%BC%90']) {
      const { query, echo } = parse(bad);
      expect(query.filters, bad).toEqual({});
      expect(echo, bad).toEqual({});
    }
  });

  it('kelas=8 → classDigit 8, kelas=0 → 0; kelas=12 and others are ignored', () => {
    expect(parse('kelas=8')).toMatchObject({ query: { filters: { classDigit: 8 } }, echo: { kelas: '8' } });
    expect(parse('kelas=0')).toMatchObject({ query: { filters: { classDigit: 0 } }, echo: { kelas: '0' } });
    for (const bad of ['kelas=12', 'kelas=-1', 'kelas=a', 'kelas=', 'kelas=8.0', 'kelas=%208']) {
      const { query, echo } = parse(bad);
      expect(query.filters, bad).toEqual({});
      expect(echo, bad).toEqual({});
    }
  });

  it('the codes jenis, bahasa, koleksi, cabang map to their ids (any case, NFKC); an unknown code is ignored', () => {
    const { query, echo } = parse('jenis=buku&bahasa=Ind&koleksi=%EF%BC%B5MUM&cabang=pusat');
    expect(query.filters).toEqual({ materialTypeIds: [BUKU], languageIds: [IND], collectionTypeIds: [UMUM], branchIds: [PUSAT] });
    expect(echo).toEqual({ jenis: 'BUKU', bahasa: 'IND', koleksi: 'UMUM', cabang: 'PUSAT' });
    for (const bad of ['jenis=NOPE', 'jenis=', 'bahasa=xx', 'koleksi=BUKU', 'cabang=IND']) {
      const r = parse(bad);
      expect(r.query.filters, bad).toEqual({});
      expect(r.echo, bad).toEqual({});
    }
  });

  it('the ids lokasi, subjek, pengarang: a ULID is taken (the route checks it exists); anything else is ignored', () => {
    const { query, echo } = parse(`lokasi=${ROOM}&subjek=${SUBJECT}&pengarang=${AGENT}`);
    expect(query.filters).toEqual({ locationIds: [ROOM], subjectIds: [SUBJECT], agentIds: [AGENT] });
    expect(echo).toEqual({ lokasi: ROOM, subjek: SUBJECT, pengarang: AGENT });
    for (const bad of ['lokasi=abc', `subjek=${SUBJECT.toLowerCase()}`, `pengarang=${AGENT}X`, 'lokasi=', "subjek=1' OR '1'='1"]) {
      const r = parse(bad);
      expect(r.query.filters, bad).toEqual({});
      expect(r.echo, bad).toEqual({});
    }
  });

  it('tersedia=1 → available; lampiran one of ATTACHMENT_MEDIA; other values ignored', () => {
    expect(parse('tersedia=1')).toMatchObject({ query: { filters: { available: true } }, echo: { tersedia: '1' } });
    expect(parse('lampiran=pdf')).toMatchObject({ query: { filters: { attachmentKinds: ['pdf'] } }, echo: { lampiran: 'pdf' } });
    expect(parse('lampiran=URL')).toMatchObject({ query: { filters: { attachmentKinds: ['url'] } }, echo: { lampiran: 'url' } });
    for (const bad of ['tersedia=0', 'tersedia=yes', 'tersedia=', 'lampiran=exe', 'lampiran=', 'lampiran=pdf,audio']) {
      const r = parse(bad);
      expect(r.query.filters, bad).toEqual({});
      expect(r.echo, bad).toEqual({});
    }
  });

  it('hal: a whole number from 1 (51 is passed on: the search reports the page cap); anything else is page 1', () => {
    expect(parse('hal=3')).toMatchObject({ query: { page: 3 }, echo: { hal: '3' } });
    expect(parse('hal=51')).toMatchObject({ query: { page: 51 }, echo: { hal: '51' } });
    expect(parse('hal=1')).toMatchObject({ query: { page: 1 }, echo: {} });
    for (const bad of ['hal=0', 'hal=-1', 'hal=abc', 'hal=1.5', 'hal=', 'hal=01', 'hal=99999999999999999999']) {
      const r = parse(bad);
      expect(r.query.page, bad).toBe(1);
      expect(r.echo, bad).toEqual({});
    }
  });

  it('persis=1 is echoed (the original query of an applied correction); other values are ignored', () => {
    expect(parse('q=pendidkan&persis=1').echo).toEqual({ q: 'pendidkan', persis: '1' });
    expect(parse('q=pendidkan&persis=0').echo).toEqual({ q: 'pendidkan' });
    // Without a text there is nothing to correct.
    expect(parse('persis=1').echo).toEqual({});
  });

  it('ruas=judul|pengarang|subjek with a text: the text searched in that field, echoed as typed; semua, others or no text: nothing', () => {
    const titled = parse('q=rumah+%22ujung+sawah%22&ruas=judul');
    expect(titled.query.text).toBe('judul:rumah judul:"ujung sawah"');
    expect(titled.echo).toEqual({ q: 'rumah "ujung sawah"', ruas: 'judul' });
    expect(parse('q=wibowo&ruas=pengarang').query.text).toBe('pengarang:wibowo');
    expect(parse('q=novel&ruas=subjek').query.text).toBe('subjek:novel');
    for (const query of ['q=rumah&ruas=semua', 'q=rumah&ruas=isbn', 'q=rumah&ruas=JUDUL', 'q=rumah&ruas=']) {
      expect(parse(query).query.text, query).toBe('rumah');
      expect(parse(query).echo, query).toEqual({ q: 'rumah' });
    }
    expect(parse('ruas=judul').echo).toEqual({});
    // Every link of the page keeps it, right after the text.
    expect(searchPath(parse('q=rumah&ruas=judul&jenis=buku').echo, {}, null)).toBe('/cari?q=rumah&ruas=judul&jenis=BUKU');
  });

  it('a repeated parameter: the first value counts; unknown parameters and lang are not echoed', () => {
    expect(parse('jenis=EBOOK&jenis=BUKU&kelas=3&kelas=4').query.filters).toEqual({ materialTypeIds: [EBOOK], classDigit: 3 });
    expect(parse('q=x&lang=en&utm_source=a&foo=bar').echo).toEqual({ q: 'x' });
  });

  it('all parameters at once: one query, one echo in a fixed order', () => {
    const { query, echo } = parse(
      `hal=2&urut=judul&kelas=8&lampiran=pdf&tersedia=1&tahun=1990-2000&pengarang=${AGENT}&subjek=${SUBJECT}&lokasi=${ROOM}&cabang=PUSAT&koleksi=UMUM&bahasa=IND&jenis=BUKU&q=laskar`,
    );
    expect(query).toEqual({
      text: 'laskar',
      scope: 'opac',
      sort: 'title',
      page: 2,
      filters: {
        materialTypeIds: [BUKU],
        languageIds: [IND],
        collectionTypeIds: [UMUM],
        branchIds: [PUSAT],
        locationIds: [ROOM],
        subjectIds: [SUBJECT],
        agentIds: [AGENT],
        yearFrom: 1990,
        yearTo: 2000,
        available: true,
        attachmentKinds: ['pdf'],
        classDigit: 8,
      },
    });
    expect(Object.keys(echo)).toEqual(['q', 'jenis', 'bahasa', 'koleksi', 'cabang', 'lokasi', 'subjek', 'pengarang', 'tahun', 'tersedia', 'lampiran', 'kelas', 'urut', 'hal']);
    expect(Object.keys(echo).every((k) => (OPAC_SEARCH_PARAMS as readonly string[]).includes(k))).toBe(true);
  });

  it('never throws, and echoes only what it accepted, for 500 random query strings', () => {
    let seed = 33;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const names = [...OPAC_SEARCH_PARAMS, 'lang', 'x', ''];
    const pieces = ['', '1', '0', '12', 'abc', '%00', '%ZZ', '%ED%A0%80', '1990-2000', 'BUKU', 'pdf', '<script>', '"', '&', '=', '+', '9'.repeat(30), ROOM];
    for (let i = 0; i < 500; i += 1) {
      const parts = Array.from({ length: rand(6) }, () => `${names[rand(names.length)]}=${pieces[rand(pieces.length)]}${pieces[rand(pieces.length)]}`);
      const qs = parts.join('&');
      const { query, echo } = parse(qs);
      expect(query.scope).toBe('opac');
      for (const [k, v] of Object.entries(echo)) {
        expect((OPAC_SEARCH_PARAMS as readonly string[]).includes(k), qs).toBe(true);
        expect(typeof v).toBe('string');
        // What is echoed reads back as itself.
        expect(parse(new URLSearchParams(echo).toString()).echo[k as OpacSearchParam], `${qs}: ${k}`).toBe(v);
      }
    }
  });
});

describe('searchPath', () => {
  it('no parameter: /cari; the parameters in their fixed order, form-encoded; the result is a local path', () => {
    expect(searchPath({}, {}, null)).toBe('/cari');
    const path = searchPath({ kelas: '8', q: 'laskar pelangi & co', jenis: 'BUKU' }, {}, null);
    expect(path).toBe('/cari?q=laskar+pelangi+%26+co&jenis=BUKU&kelas=8');
    expect(isLocalPath(path)).toBe(true);
    expect(isLocalPath(searchPath({ q: '\u00F1 "<x>" /\\ //evil' }, {}, 'en'))).toBe(true);
  });

  it('a change sets or removes a parameter; hal is dropped unless the change sets it; lang comes last', () => {
    const echo = { q: 'x', jenis: 'BUKU', hal: '3', urut: 'judul' };
    expect(searchPath(echo, { bahasa: 'IND' }, null)).toBe('/cari?q=x&jenis=BUKU&bahasa=IND&urut=judul');
    expect(searchPath(echo, { jenis: null }, 'en')).toBe('/cari?q=x&urut=judul&lang=en');
    expect(searchPath(echo, { hal: '4' }, 'id')).toBe('/cari?q=x&jenis=BUKU&urut=judul&hal=4&lang=id');
    expect(searchPath(echo, { hal: '1' }, null)).toBe('/cari?q=x&jenis=BUKU&urut=judul');
    expect(searchPath(echo, {}, null, '/cari/rss')).toBe('/cari/rss?q=x&jenis=BUKU&urut=judul');
  });
});
