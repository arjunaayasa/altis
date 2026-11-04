import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { XmlWriter } from '../../src/xml/index.js';

// A local SRU server for the outbound-client and copy-cataloguing tests (spec §6.1-§6.2, K7): node:http on 127.0.0.1
// at a free port, so nothing leaves the machine. Its catalogue is three synthetic records. Routes:
// - `/sru`: searchRetrieve in SRU 1.1, 1.2 or 2.0 (each answers in its own namespace and namespace style). It checks
//   the request the way a strict server does (version, operation, recordSchema `marcxml`, `recordPacking=xml|string`
//   for 1.x, `recordXMLEscaping=xml|string` and no `recordPacking=xml` for 2.0, maximumRecords, startRecord, a CQL
//   query `<index>="<term>"` on `bath.isbn`, `dc.title`, `dc.creator` or `cql.serverChoice`) and answers a diagnostic
//   otherwise. Extra parameters for the tests, kept from a server URL's own query: `delay=<ms>` (≤ 5000) holds the
//   answer back, `packing=string` answers escaped records whatever was asked (a server that ignores recordPacking),
//   `charset=iso-8859-1` answers in ISO-8859-1 declared only in the XML declaration.
// - `/diag`: a fatal diagnostic whose message is longer than 200 characters (in the requested version, default 1.2).
// - `/hang`: never answers. `/huge`: 6 MB (`?bytes=<n>` another size, `?declared=1` with a Content-Length).
// - `/redirect/<n>`: n redirects (302) down to `/redirect/0`, which answers 200. `/goto?url=<u>[&status=<3xx>]`: one
//   redirect to `u`. `/gzip`: a gzip-encoded answer. `/echo`: the request as JSON (method, path, headers, body).
//   `/status/<code>`: that status.

export const SRU1_NS = 'http://www.loc.gov/zing/srw/';
export const SRU2_NS = 'http://docs.oasis-open.org/ns/search-ws/sruResponse';
export const MARC_NS = 'http://www.loc.gov/MARC21/slim';
const DIAG1_NS = 'http://www.loc.gov/zing/srw/diagnostic/';
const DIAG2_NS = 'http://docs.oasis-open.org/ns/search-ws/diagnostic';

/** The ISBN of the first record (Laskar pelangi). */
export const FAKE_SRU_ISBN = '9786020332956';

/** The fake's default `/huge` size: more than the 5 MB limit. */
export const FAKE_SRU_HUGE_BYTES = 6 * 1024 * 1024;

export interface FakeSruRequest {
  method: string;
  /** Path and query, as received. */
  path: string;
  headers: http.IncomingHttpHeaders;
}

export interface FakeSru {
  /** `http://127.0.0.1:<port>`; the routes are appended (`${url}/sru`). */
  url: string;
  /** Every request received so far, in order. */
  requests: FakeSruRequest[];
  /** Resolves once a request whose path starts with `prefix` has arrived (at once if one already has). */
  waitForRequest(prefix: string): Promise<void>;
  /** Requests being answered now, and the most at once so far (the lookup's concurrency cap, M13). */
  openRequests(): number;
  maxOpenRequests(): number;
  close(): Promise<void>;
}

interface FakeBook {
  id: string;
  isbn: string;
  title: string;
  author: string;
  year: string;
  pages: string;
  subjects: string[];
  note?: string;
}

const BOOKS: readonly FakeBook[] = [
  {
    id: 'FAKE0001',
    isbn: FAKE_SRU_ISBN,
    title: 'Laskar pelangi',
    author: 'Hirata, Andrea',
    year: '2005',
    pages: 'xxxiv, 529 halaman',
    subjects: ['Fiksi Indonesia'],
  },
  {
    id: 'FAKE0002',
    isbn: '9789793062921',
    title: 'Sang pemimpi',
    author: 'Hirata, Andrea',
    year: '2006',
    pages: 'x, 292 halaman',
    subjects: ['Fiksi Indonesia'],
  },
  {
    id: 'FAKE0003',
    isbn: '9789793062938',
    title: 'Edensor',
    author: 'Hirata, Andrea',
    year: '2007',
    pages: 'xii, 290 halaman',
    subjects: ['Fiksi Indonesia', 'Novel'],
    note: 'Latar cerita: Universit\u{e9} de Paris dan desa Edensor.',
  },
];

const LEADER = '00000nam a2200000 i 4500';

/** The 40 characters of a book's 008. */
function field008(b: FakeBook): string {
  // Entered, type of date, date 1, date 2 (blank), place, book positions 18-34, language, modified, source.
  const value = `250101s${b.year}${' '.repeat(4)}io${' '.repeat(12)}000 1 ind d`;
  if (value.length !== 40) throw new Error(`fake 008 is ${value.length} characters`);
  return value;
}

/** Writes `b` as a MARCXML record; `prefix` '' for the default namespace, `declare` puts the xmlns on the record. */
function writeMarc(w: XmlWriter, b: FakeBook, prefix: string, declare: boolean): void {
  const n = (local: string): string => (prefix === '' ? local : `${prefix}:${local}`);
  const field = (tag: string, ind1: string, ind2: string, subfields: [string, string][]): void => {
    w.open(n('datafield'), { tag, ind1, ind2 });
    for (const [code, value] of subfields) w.leaf(n('subfield'), value, { code });
    w.close();
  };
  w.open(n('record'), { ...(declare ? { [prefix === '' ? 'xmlns' : `xmlns:${prefix}`]: MARC_NS } : {}), type: 'Bibliographic' });
  w.leaf(n('leader'), LEADER);
  w.leaf(n('controlfield'), b.id, { tag: '001' });
  w.leaf(n('controlfield'), field008(b), { tag: '008' });
  field('020', ' ', ' ', [['a', b.isbn]]);
  field('100', '1', ' ', [
    ['a', `${b.author},`],
    ['e', 'pengarang.'],
  ]);
  field('245', '1', '0', [
    ['a', `${b.title} /`],
    ['c', 'Andrea Hirata.'],
  ]);
  field('264', ' ', '1', [
    ['a', 'Yogyakarta :'],
    ['b', 'Bentang Pustaka,'],
    ['c', `${b.year}.`],
  ]);
  field('300', ' ', ' ', [
    ['a', `${b.pages} ;`],
    ['c', '20 cm'],
  ]);
  if (b.note !== undefined) field('500', ' ', ' ', [['a', b.note]]);
  for (const s of b.subjects) field('650', ' ', '4', [['a', s]]);
  w.close();
}

/** `b` as a self-contained MARCXML record (default namespace). */
export function fakeMarcRecord(b: FakeBook): string {
  const w = new XmlWriter();
  writeMarc(w, b, '', true);
  return w.toString();
}

type Version = '1.1' | '1.2' | '2.0';

interface Diagnostic {
  uri: string;
  details: string;
  message: string;
}

interface Answer {
  total: number;
  books: readonly FakeBook[];
  start: number;
  packing: 'xml' | 'string';
  query: string;
  diagnostics: Diagnostic[];
}

/** A searchRetrieveResponse: 1.1 `srw:` with `marc:` declared on the root, 1.2 `zs:` with default-namespace records, 2.0 `sruResponse:` with `marc:` declared on each record. */
function sruAnswer(version: Version, a: Answer): string {
  const v2 = version === '2.0';
  const p = v2 ? 'sruResponse' : version === '1.1' ? 'srw' : 'zs';
  const e = (local: string): string => `${p}:${local}`;
  const w = new XmlWriter();
  w.raw('<?xml version="1.0" encoding="UTF-8"?>\n');
  w.open(e('searchRetrieveResponse'), { [`xmlns:${p}`]: v2 ? SRU2_NS : SRU1_NS, ...(version === '1.1' ? { 'xmlns:marc': MARC_NS } : {}) });
  if (!v2) w.leaf(e('version'), version);
  w.leaf(e('numberOfRecords'), a.total);
  if (a.books.length > 0) {
    w.open(e('records'));
    a.books.forEach((b, i) => {
      w.open(e('record'));
      w.leaf(e('recordSchema'), 'info:srw/schema/1/marcxml-v1.1');
      w.leaf(e(v2 ? 'recordXMLEscaping' : 'recordPacking'), a.packing);
      w.open(e('recordData'));
      if (a.packing === 'string') w.text(fakeMarcRecord(b));
      else if (version === '1.1') writeMarc(w, b, 'marc', false);
      else if (version === '1.2') writeMarc(w, b, '', true);
      else writeMarc(w, b, 'marc', true);
      w.close();
      w.leaf(e('recordPosition'), a.start + i);
      w.close();
    });
    w.close();
    if (a.start + a.books.length <= a.total) w.leaf(e('nextRecordPosition'), a.start + a.books.length);
  }
  w.open(e('echoedSearchRetrieveRequest'));
  if (!v2) w.leaf(e('version'), version);
  w.leaf(e('query'), a.query);
  w.close();
  if (a.diagnostics.length > 0) {
    w.open(e('diagnostics'));
    for (const d of a.diagnostics) {
      w.open('diag:diagnostic', { 'xmlns:diag': v2 ? DIAG2_NS : DIAG1_NS });
      w.leaf('diag:uri', d.uri);
      w.leaf('diag:details', d.details);
      w.leaf('diag:message', d.message);
      w.close();
    }
    w.close();
  }
  if (version === '1.2') {
    // A decoy: a MARC record outside recordData is not a result.
    w.open(e('extraResponseData'));
    w.raw(`<record xmlns="${MARC_NS}"><leader>decoy</leader></record>`);
    w.close();
  }
  w.close();
  return w.toString();
}

const INDEXES: Readonly<Record<string, 'isbn' | 'title' | 'author' | 'any'>> = {
  'bath.isbn': 'isbn',
  'dc.title': 'title',
  'dc.creator': 'author',
  'cql.serverChoice': 'any',
};

/** `<index>="<term>"` with `\"` and `\\` escapes, or null. */
function parseCql(query: string): { index: string; term: string } | null {
  const m = /^\s*([A-Za-z0-9._-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(query);
  if (m === null) return null;
  return { index: m[1]!, term: m[2]!.replace(/\\(.)/g, '$1') };
}

function matches(b: FakeBook, index: 'isbn' | 'title' | 'author' | 'any', term: string): boolean {
  const t = term.toLowerCase();
  const isbn = b.isbn === term.replace(/-/g, '');
  const title = b.title.toLowerCase().includes(t);
  const author = b.author.toLowerCase().includes(t);
  if (index === 'isbn') return isbn;
  if (index === 'title') return title;
  if (index === 'author') return author;
  return isbn || title || author || b.subjects.some((s) => s.toLowerCase().includes(t));
}

const LONG_MESSAGE = `Unsupported index: ${'this server does not support the index that was asked for, see its explain record; '.repeat(4)}`;

function sendXml(res: http.ServerResponse, xml: string, charset: string | null): void {
  if (charset === 'iso-8859-1') {
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(Buffer.from(xml.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'), 'latin1'));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
  res.end(xml);
}

function handleSru(p: URLSearchParams, res: http.ServerResponse): void {
  const asked = p.get('version') ?? '';
  const version: Version = asked === '1.1' || asked === '2.0' ? asked : '1.2';
  const charset = p.get('charset');
  const query = p.get('query') ?? '';
  const diag = (n: number, details: string, message: string): void =>
    sendXml(
      res,
      sruAnswer(version, { total: 0, books: [], start: 1, packing: 'xml', query, diagnostics: [{ uri: `info:srw/diagnostic/1/${n}`, details, message }] }),
      charset,
    );
  if (asked !== '1.1' && asked !== '1.2' && asked !== '2.0') return diag(5, asked, 'Unsupported version');
  if (p.get('operation') !== 'searchRetrieve') return diag(4, p.get('operation') ?? '', 'Unsupported operation');
  if (p.get('recordSchema') !== 'marcxml') return diag(66, p.get('recordSchema') ?? '', 'Unknown schema for retrieval');
  let packing: 'xml' | 'string';
  if (version === '2.0') {
    const escaping = p.get('recordXMLEscaping');
    if (escaping === null) return diag(7, 'recordXMLEscaping', 'Mandatory parameter not supplied');
    if (escaping !== 'xml' && escaping !== 'string') return diag(6, 'recordXMLEscaping', 'Unsupported parameter value');
    const packed = p.get('recordPacking');
    if (packed !== null && packed !== 'packed' && packed !== 'unpacked') return diag(6, 'recordPacking', 'Unsupported parameter value');
    packing = escaping;
  } else {
    if (p.has('recordXMLEscaping')) return diag(8, 'recordXMLEscaping', 'Unsupported parameter');
    const packed = p.get('recordPacking');
    if (packed === null) return diag(7, 'recordPacking', 'Mandatory parameter not supplied');
    if (packed !== 'xml' && packed !== 'string') return diag(6, 'recordPacking', 'Unsupported parameter value');
    packing = packed;
  }
  const max = p.get('maximumRecords') ?? '';
  const start = p.get('startRecord') ?? '';
  if (!/^\d{1,3}$/.test(max) || Number(max) > 100) return diag(6, 'maximumRecords', 'Unsupported parameter value');
  if (!/^[1-9]\d{0,5}$/.test(start)) return diag(6, 'startRecord', 'Unsupported parameter value');
  const cql = parseCql(query);
  if (cql === null) return diag(10, query, 'Query syntax error');
  const index = INDEXES[cql.index];
  if (index === undefined) return diag(16, cql.index, 'Unsupported index');
  const hits = BOOKS.filter((b) => matches(b, index, cql.term));
  const first = Number(start);
  if (hits.length > 0 && first > hits.length) return diag(61, start, 'First record position out of range');
  if (p.get('packing') === 'string') packing = 'string';
  const books = hits.slice(first - 1, first - 1 + Number(max));
  const answer = (): void => sendXml(res, sruAnswer(version, { total: hits.length, books, start: first, packing, query, diagnostics: [] }), charset);
  const delay = Math.min(Number(p.get('delay') ?? '0') || 0, 5000);
  if (delay > 0) setTimeout(answer, delay);
  else answer();
}

/** Writes `bytes` bytes of `a` in 64 KiB chunks, following backpressure, until the client goes away. */
function pump(res: http.ServerResponse, bytes: number): void {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let left = bytes;
  const next = (): void => {
    while (left > 0 && !res.destroyed) {
      const n = Math.min(left, chunk.length);
      left -= n;
      if (!res.write(chunk.subarray(0, n))) {
        res.once('drain', next);
        return;
      }
    }
    if (left === 0 && !res.destroyed) res.end();
  };
  next();
}

/** Starts the fake server on 127.0.0.1 at a free port. */
export async function startFakeSru(): Promise<FakeSru> {
  const requests: FakeSruRequest[] = [];
  const waiters: { prefix: string; resolve: () => void }[] = [];
  let open = 0;
  let maxOpen = 0;

  const server = http.createServer((req, res) => {
    // A client that gives up mid-answer (a timeout, a size limit) is expected here.
    res.on('error', () => {});
    req.on('error', () => {});
    const path = req.url ?? '/';
    requests.push({ method: req.method ?? 'GET', path, headers: req.headers });
    for (const w of waiters.splice(0)) {
      if (path.startsWith(w.prefix)) w.resolve();
      else waiters.push(w);
    }
    open++;
    maxOpen = Math.max(maxOpen, open);
    res.on('close', () => open--);

    const url = new URL(path, 'http://fake.invalid');
    const p = url.searchParams;
    const route = url.pathname;
    if (route === '/sru') return handleSru(p, res);
    if (route === '/diag') {
      const asked = p.get('version');
      const version: Version = asked === '1.1' || asked === '2.0' ? asked : '1.2';
      const xml = sruAnswer(version, {
        total: 0,
        books: [],
        start: 1,
        packing: 'xml',
        query: p.get('query') ?? '',
        diagnostics: [{ uri: 'info:srw/diagnostic/1/16', details: 'bath.isbn', message: LONG_MESSAGE }],
      });
      return sendXml(res, xml, null);
    }
    if (route === '/hang') return;
    if (route === '/huge') {
      const bytes = p.has('bytes') ? Number(p.get('bytes')) : FAKE_SRU_HUGE_BYTES;
      res.writeHead(200, { 'content-type': 'application/octet-stream', ...(p.get('declared') === '1' ? { 'content-length': String(bytes) } : {}) });
      return pump(res, bytes);
    }
    const redirect = /^\/redirect\/(\d{1,2})$/.exec(route);
    if (redirect !== null) {
      const n = Number(redirect[1]);
      if (n === 0) {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-fake': 'arrived' });
        return void res.end('arrived');
      }
      res.writeHead(302, { location: `/redirect/${n - 1}` });
      return void res.end();
    }
    if (route === '/goto') {
      res.writeHead(Number(p.get('status') ?? '302'), { location: p.get('url') ?? '/' });
      return void res.end();
    }
    if (route === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/xml', 'content-encoding': 'gzip' });
      return void res.end(gzipSync('<x/>'));
    }
    if (route === '/echo') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, path, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      return;
    }
    const status = /^\/status\/(\d{3})$/.exec(route);
    if (status !== null) {
      res.writeHead(Number(status[1]), { 'content-type': 'text/plain' });
      return void res.end('status');
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake SRU server has no port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    waitForRequest(prefix) {
      if (requests.some((r) => r.path.startsWith(prefix))) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ prefix, resolve }));
    },
    openRequests: () => open,
    maxOpenRequests: () => maxOpen,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
