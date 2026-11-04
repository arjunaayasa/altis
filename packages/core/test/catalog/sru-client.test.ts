import { isDomainError } from '@altis/shared';
import type { SruServer } from '@altis/shared/api/settings';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSruResponse, sruSearch, sruSearchUrl } from '../../src/catalog/copy/index.js';
import { createXmlReader, type XmlEvent } from '../../src/xml/index.js';
import { FAKE_SRU_ISBN, MARC_NS, SRU1_NS, SRU2_NS, startFakeSru, type FakeSru } from '../support/fake-sru.js';

// The SRU client of copy cataloguing (spec §6.2, K7): the searchRetrieve URL, the response parser for SRU 1.x and 2.0,
// and the search against the local fake server.

const INDEXES = { isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' };

function server(url: string, version: SruServer['version']): SruServer {
  return { id: `fake-${version.replace('.', '')}`, name: 'Fake', url, version, recordSchema: 'marcxml', indexes: INDEXES, enabled: true };
}

/** The DomainError `p` rejects with, as `{code, meta}`. */
async function domainFailure(p: Promise<unknown>): Promise<{ code: string; detail: string | undefined; meta: Record<string, unknown> | undefined }> {
  try {
    await p;
  } catch (e) {
    if (!isDomainError(e)) throw e;
    return { code: e.code, detail: e.detail, meta: e.meta };
  }
  throw new Error('did not fail');
}

function domainFailureSync(f: () => unknown): { code: string; meta: Record<string, unknown> | undefined } {
  try {
    f();
  } catch (e) {
    if (!isDomainError(e)) throw e;
    return { code: e.code, meta: e.meta };
  }
  throw new Error('did not fail');
}

/** Every event of `xml` (it must be well-formed). */
function events(xml: string): XmlEvent[] {
  const reader = createXmlReader();
  return [...reader.write(xml), ...reader.end()];
}

/** The `<subfield code="a">` values of `tag` in a MARCXML record string. */
function subfieldA(record: string, tag: string): string[] {
  const out: string[] = [];
  let inTag = false;
  let inA = false;
  for (const e of events(record)) {
    if (e.type === 'open' && e.name === 'datafield') inTag = e.attrs['tag'] === tag;
    else if (e.type === 'open' && e.name === 'subfield') inA = inTag && e.attrs['code'] === 'a';
    else if (e.type === 'close' && e.name === 'subfield') inA = false;
    else if (e.type === 'text' && inA) out.push(e.text);
  }
  return out;
}

describe('sruSearchUrl', () => {
  it('SRU 1.x: version, searchRetrieve, the CQL query, recordSchema, 20 records, startRecord and recordPacking=xml', () => {
    const url = new URL(sruSearchUrl(server('https://sru.example.org/db', '1.2'), 'isbn', FAKE_SRU_ISBN, 1));
    expect(url.origin + url.pathname).toBe('https://sru.example.org/db');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      version: '1.2',
      operation: 'searchRetrieve',
      query: `bath.isbn="${FAKE_SRU_ISBN}"`,
      recordSchema: 'marcxml',
      maximumRecords: '20',
      startRecord: '1',
      recordPacking: 'xml',
    });
    expect(new URL(sruSearchUrl(server('https://sru.example.org/db', '1.1'), 'title', 'laskar', 21)).searchParams.get('version')).toBe('1.1');
  });

  it('SRU 2.0: recordXMLEscaping=xml and no recordPacking', () => {
    const url = new URL(sruSearchUrl(server('http://sru.example.org/', '2.0'), 'author', 'hirata', 41, 10));
    expect(url.searchParams.get('version')).toBe('2.0');
    expect(url.searchParams.get('recordXMLEscaping')).toBe('xml');
    expect(url.searchParams.has('recordPacking')).toBe(false);
    expect(url.searchParams.get('query')).toBe('dc.creator="hirata"');
    expect(url.searchParams.get('maximumRecords')).toBe('10');
    expect(url.searchParams.get('startRecord')).toBe('41');
  });

  it('escapes quotes and backslashes in the term, and percent-encodes the query (spaces as %20)', () => {
    const text = sruSearchUrl(server('http://sru.example.org/', '1.2'), 'any', 'a "b" \\c & d', 1);
    expect(new URL(text).searchParams.get('query')).toBe('cql.serverChoice="a \\"b\\" \\\\c & d"');
    expect(text).toContain('query=cql.serverChoice%3D%22a%20%5C%22b%5C%22%20%5C%5Cc%20%26%20d%22');
  });

  it("keeps the server URL's own query parameters and replaces ours", () => {
    const url = new URL(sruSearchUrl(server('http://sru.example.org/sru?x-info=1&version=9&startRecord=5', '1.1'), 'title', 'laskar', 3));
    expect(url.searchParams.get('x-info')).toBe('1');
    expect(url.searchParams.getAll('version')).toEqual(['1.1']);
    expect(url.searchParams.getAll('startRecord')).toEqual(['3']);
  });

  it('refuses a start or a maximum that is not a positive integer, and a server URL that is not http(s)', () => {
    const s = server('http://sru.example.org/', '1.2');
    expect(() => sruSearchUrl(s, 'isbn', 'x', 0)).toThrow(RangeError);
    expect(() => sruSearchUrl(s, 'isbn', 'x', 1.5)).toThrow(RangeError);
    expect(() => sruSearchUrl(s, 'isbn', 'x', 1, 0)).toThrow(RangeError);
    expect(domainFailureSync(() => sruSearchUrl(server('', '1.2'), 'isbn', 'x', 1))).toEqual({ code: 'CATALOG_OUTBOUND_FAILED', meta: { reason: 'scheme' } });
    expect(domainFailureSync(() => sruSearchUrl(server('ftp://sru.example.org/', '1.2'), 'isbn', 'x', 1))).toEqual({
      code: 'CATALOG_OUTBOUND_FAILED',
      meta: { reason: 'scheme' },
    });
  });
});

const RECORD = `<record xmlns="${MARC_NS}"><leader>00000nam a2200000 i 4500</leader><datafield tag="245" ind1="1" ind2="0"><subfield code="a">Judul &amp; anak judul</subfield></datafield></record>`;

describe('parseSruResponse', () => {
  it('SRU 1.2: total, the MARCXML records of recordData, the version; a record outside recordData is no result', () => {
    const xml = `<?xml version="1.0"?>
<zs:searchRetrieveResponse xmlns:zs="${SRU1_NS}">
  <zs:version>1.2</zs:version>
  <zs:numberOfRecords> 42 </zs:numberOfRecords>
  <zs:records><zs:record><zs:recordSchema>marcxml</zs:recordSchema><zs:recordPacking>xml</zs:recordPacking>
    <zs:recordData>${RECORD}</zs:recordData><zs:recordPosition>1</zs:recordPosition></zs:record></zs:records>
  <zs:echoedSearchRetrieveRequest><zs:version>9.9</zs:version><zs:numberOfRecords>7</zs:numberOfRecords></zs:echoedSearchRetrieveRequest>
  <zs:extraResponseData>${RECORD}</zs:extraResponseData>
</zs:searchRetrieveResponse>`;
    expect(parseSruResponse(xml)).toEqual({ total: 42, records: [RECORD], diagnostics: [], version: '1.2' });
  });

  it('resolves a MARC prefix declared on the root, drops other namespaces and attributes, and writes a self-contained record', () => {
    const xml = `<srw:searchRetrieveResponse xmlns:srw="${SRU1_NS}" xmlns:marc="${MARC_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<srw:version>1.1</srw:version><srw:numberOfRecords>1</srw:numberOfRecords><srw:records><srw:record><srw:recordData>
<marc:record type="Bibliographic" xsi:schemaLocation="x y"><marc:leader>L</marc:leader><x:extra xmlns:x="urn:x"><marc:leader>no</marc:leader></x:extra>
<marc:controlfield tag="001">A&lt;1</marc:controlfield></marc:record></srw:recordData></srw:record></srw:records></srw:searchRetrieveResponse>`;
    const parsed = parseSruResponse(xml);
    expect(parsed.records).toEqual([
      `<record xmlns="${MARC_NS}" type="Bibliographic"><leader>L</leader>\n<controlfield tag="001">A&lt;1</controlfield></record>`,
    ]);
    expect(parsed.version).toBe('1.1');
  });

  it('SRU 2.0: its namespace, version 2.0 without a version element, records with their own prefix', () => {
    const xml = `<s:searchRetrieveResponse xmlns:s="${SRU2_NS}"><s:numberOfRecords>3</s:numberOfRecords><s:records>
<s:record><s:recordSchema>marcxml</s:recordSchema><s:recordXMLEscaping>xml</s:recordXMLEscaping><s:recordData><m:record xmlns:m="${MARC_NS}"><m:leader>L</m:leader></m:record></s:recordData></s:record>
</s:records></s:searchRetrieveResponse>`;
    expect(parseSruResponse(xml)).toEqual({ total: 3, records: [`<record xmlns="${MARC_NS}"><leader>L</leader></record>`], diagnostics: [], version: '2.0' });
  });

  it('reads an escaped record (string packing) and a record without a namespace', () => {
    const escaped = RECORD.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const xml = `<zs:searchRetrieveResponse xmlns:zs="${SRU1_NS}"><zs:version>1.2</zs:version><zs:numberOfRecords>2</zs:numberOfRecords><zs:records>
<zs:record><zs:recordPacking>string</zs:recordPacking><zs:recordData>${escaped}</zs:recordData></zs:record>
<zs:record><zs:recordData><record><leader>N</leader></record></zs:recordData></zs:record>
</zs:records></zs:searchRetrieveResponse>`;
    expect(parseSruResponse(xml).records).toEqual([RECORD, `<record xmlns="${MARC_NS}"><leader>N</leader></record>`]);
  });

  it('reads a record a server left in its SRU default namespace (no MARC namespace declared)', () => {
    const xml = `<searchRetrieveResponse xmlns="${SRU1_NS}"><version>1.1</version><numberOfRecords>1</numberOfRecords><records><record>
<recordSchema>marcxml</recordSchema><recordData><record><leader>L</leader><datafield tag="245" ind1="0" ind2="0"><subfield code="a">T</subfield></datafield></record></recordData>
</record></records></searchRetrieveResponse>`;
    expect(parseSruResponse(xml)).toEqual({
      total: 1,
      records: [`<record xmlns="${MARC_NS}"><leader>L</leader><datafield tag="245" ind1="0" ind2="0"><subfield code="a">T</subfield></datafield></record>`],
      diagnostics: [],
      version: '1.1',
    });
  });

  it('drops an element whose name is no namespace-well-formed QName (`a:`, `:x`, `a:b:c`) and an empty-prefix declaration', () => {
    const inner = '<leader>L</leader><a:>x</a:><:x>y</:x><a:b:c>z</a:b:c><f xmlns:="urn:other"><subfield code="a">kept</subfield></f>';
    const xml = `<zs:searchRetrieveResponse xmlns:zs="${SRU1_NS}"><zs:numberOfRecords>1</zs:numberOfRecords><zs:records><zs:record><zs:recordData><record xmlns="${MARC_NS}">${inner}</record></zs:recordData></zs:record></zs:records></zs:searchRetrieveResponse>`;
    expect(parseSruResponse(xml).records).toEqual([`<record xmlns="${MARC_NS}"><leader>L</leader><f><subfield code="a">kept</subfield></f></record>`]);
    // The same in an escaped record (string packing).
    const escaped = `<record xmlns="${MARC_NS}">${inner}</record>`.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const packed = `<zs:searchRetrieveResponse xmlns:zs="${SRU1_NS}"><zs:numberOfRecords>1</zs:numberOfRecords><zs:records><zs:record><zs:recordData>${escaped}</zs:recordData></zs:record></zs:records></zs:searchRetrieveResponse>`;
    expect(parseSruResponse(packed).records).toEqual([`<record xmlns="${MARC_NS}"><leader>L</leader><f><subfield code="a">kept</subfield></f></record>`]);
  });

  it('skips a record of another schema (Dublin Core, a surrogate diagnostic) and keeps the rest', () => {
    const xml = `<zs:searchRetrieveResponse xmlns:zs="${SRU1_NS}"><zs:version>1.2</zs:version><zs:numberOfRecords>3</zs:numberOfRecords><zs:records>
<zs:record><zs:recordData><srw_dc:dc xmlns:srw_dc="info:srw/schema/1/dc-schema"><title>T</title></srw_dc:dc></zs:recordData></zs:record>
<zs:record><zs:recordData><diag:diagnostic xmlns:diag="http://www.loc.gov/zing/srw/diagnostic/"><diag:uri>info:srw/diagnostic/1/65</diag:uri></diag:diagnostic></zs:recordData></zs:record>
<zs:record><zs:recordData>${RECORD}</zs:recordData></zs:record>
</zs:records></zs:searchRetrieveResponse>`;
    expect(parseSruResponse(xml)).toMatchObject({ total: 3, records: [RECORD], diagnostics: [] });
  });

  it('returns the diagnostics (uri; message with its details), 1.x and 2.0', () => {
    const one = `<zs:searchRetrieveResponse xmlns:zs="${SRU1_NS}"><zs:version>1.2</zs:version><zs:numberOfRecords>0</zs:numberOfRecords>
<zs:diagnostics><diag:diagnostic xmlns:diag="http://www.loc.gov/zing/srw/diagnostic/"><diag:uri>info:srw/diagnostic/1/16</diag:uri>
<diag:details>bath.isbn</diag:details><diag:message>Unsupported
  index</diag:message></diag:diagnostic></zs:diagnostics></zs:searchRetrieveResponse>`;
    expect(parseSruResponse(one)).toEqual({
      total: 0,
      records: [],
      diagnostics: [{ uri: 'info:srw/diagnostic/1/16', message: 'Unsupported index: bath.isbn' }],
      version: '1.2',
    });
    const two = `<s:searchRetrieveResponse xmlns:s="${SRU2_NS}"><s:diagnostics><d:diagnostic xmlns:d="http://docs.oasis-open.org/ns/search-ws/diagnostic"><d:uri>info:srw/diagnostic/1/1</d:uri></d:diagnostic></s:diagnostics></s:searchRetrieveResponse>`;
    expect(parseSruResponse(two)).toEqual({ total: 0, records: [], diagnostics: [{ uri: 'info:srw/diagnostic/1/1', message: '' }], version: '2.0' });
  });

  it.each([
    ['an HTML page', '<html><body>Not found</body></html>'],
    ['another SRU operation', `<zs:explainResponse xmlns:zs="${SRU1_NS}"><zs:version>1.2</zs:version></zs:explainResponse>`],
    ['the right name in no namespace', '<searchRetrieveResponse><numberOfRecords>1</numberOfRecords></searchRetrieveResponse>'],
    ['no numberOfRecords and no diagnostic', `<zs:searchRetrieveResponse xmlns:zs="${SRU1_NS}"><zs:version>1.2</zs:version></zs:searchRetrieveResponse>`],
    ['a numberOfRecords that is not a number', `<zs:searchRetrieveResponse xmlns:zs="${SRU1_NS}"><zs:numberOfRecords>-1</zs:numberOfRecords></zs:searchRetrieveResponse>`],
    ['a DOCTYPE', `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><zs:searchRetrieveResponse xmlns:zs="${SRU1_NS}"/>`],
    ['an unknown entity', `<zs:searchRetrieveResponse xmlns:zs="${SRU1_NS}"><zs:numberOfRecords>&e;</zs:numberOfRecords></zs:searchRetrieveResponse>`],
    ['truncated XML', `<zs:searchRetrieveResponse xmlns:zs="${SRU1_NS}"><zs:numberOfRecords>1`],
    ['an empty answer', ''],
  ])('%s is CATALOG_SRU_INVALID', (_name, xml) => {
    const f = domainFailureSync(() => parseSruResponse(xml));
    expect(f.code).toBe('CATALOG_SRU_INVALID');
    expect(typeof f.meta?.['message']).toBe('string');
    // The message is ours: it never quotes the answer.
    expect(String(f.meta?.['message'])).not.toContain('passwd');
  });
});

describe('sruSearch against the fake server (K7)', () => {
  let fake: FakeSru;

  beforeAll(async () => {
    fake = await startFakeSru();
  });

  afterAll(async () => {
    await fake.close();
  });

  it.each(['1.1', '1.2', '2.0'] as const)('SRU %s: the ISBN finds one record, a well-formed MARCXML record in its namespace', async (version) => {
    const result = await sruSearch(server(`${fake.url}/sru`, version), 'isbn', FAKE_SRU_ISBN, { start: 1, allowPrivate: true });
    expect(result.total).toBe(1);
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.startsWith(`<record xmlns="${MARC_NS}"`)).toBe(true);
    expect(subfieldA(record, '020')).toEqual([FAKE_SRU_ISBN]);
    expect(subfieldA(record, '245')).toEqual(['Laskar pelangi /']);
    expect(Object.keys(result).sort()).toEqual(['records', 'total']);
  });

  it('every version gives the same record text', async () => {
    const texts = await Promise.all(
      (['1.1', '1.2', '2.0'] as const).map(async (v) => (await sruSearch(server(`${fake.url}/sru`, v), 'isbn', FAKE_SRU_ISBN, { start: 1, allowPrivate: true })).records),
    );
    expect(texts[1]).toEqual(texts[0]);
    expect(texts[2]).toEqual(texts[0]);
  });

  it('title and author searches, and paging by start', async () => {
    const s = server(`${fake.url}/sru`, '1.2');
    const title = await sruSearch(s, 'title', 'laskar', { start: 1, allowPrivate: true });
    expect(title.total).toBe(1);
    expect(subfieldA(title.records[0]!, '245')).toEqual(['Laskar pelangi /']);
    const author = await sruSearch(s, 'author', 'hirata', { start: 1, allowPrivate: true });
    expect(author.total).toBe(3);
    expect(author.records.map((r) => subfieldA(r, '245')[0])).toEqual(['Laskar pelangi /', 'Sang pemimpi /', 'Edensor /']);
    const second = await sruSearch(s, 'author', 'hirata', { start: 2, allowPrivate: true });
    expect(second.total).toBe(3);
    expect(second.records).toEqual(author.records.slice(1));
    const none = await sruSearch(s, 'any', 'tidak ada', { start: 1, allowPrivate: true });
    expect(none).toEqual({ total: 0, records: [] });
  });

  it('a server that answers escaped records (string packing) gives the same records', async () => {
    const xml = await sruSearch(server(`${fake.url}/sru`, '1.2'), 'author', 'hirata', { start: 1, allowPrivate: true });
    for (const version of ['1.1', '2.0'] as const) {
      const escaped = await sruSearch(server(`${fake.url}/sru?packing=string`, version), 'author', 'hirata', { start: 1, allowPrivate: true });
      expect(escaped.records).toEqual(xml.records);
    }
  });

  it('decodes an ISO-8859-1 answer by its XML declaration', async () => {
    const result = await sruSearch(server(`${fake.url}/sru?charset=iso-8859-1`, '1.2'), 'title', 'edensor', { start: 1, allowPrivate: true });
    expect(subfieldA(result.records[0]!, '500')).toEqual(['Latar cerita: Universit\u{e9} de Paris dan desa Edensor.']);
  });

  it('a diagnostic is CATALOG_SRU_INVALID with the server message cut to 200 characters', async () => {
    for (const version of ['1.1', '1.2', '2.0'] as const) {
      const f = await domainFailure(sruSearch(server(`${fake.url}/diag`, version), 'isbn', FAKE_SRU_ISBN, { start: 1, allowPrivate: true }));
      expect(f.code).toBe('CATALOG_SRU_INVALID');
      const message = String(f.meta?.['message']);
      expect(message.length).toBeLessThanOrEqual(200);
      expect(message.length).toBeGreaterThan(150);
      expect(message.startsWith('Unsupported index: this server does not support')).toBe(true);
      // L09: the server's message is the error's detail, which the 502 shows (§6.2 "dengan pesan server").
      expect(f.detail).toBe(message);
    }
    // An answer that is not SRU has no detail: its message is ours, and the client shows its own text for the code.
    const notSru = await domainFailure(sruSearch(server(`${fake.url}/redirect/0`, '1.2'), 'isbn', FAKE_SRU_ISBN, { start: 1, allowPrivate: true }));
    expect([notSru.code, notSru.detail]).toEqual(['CATALOG_SRU_INVALID', undefined]);
  });

  it("the fake server's own checks answer a diagnostic for a request it does not support", async () => {
    const odd = { ...server(`${fake.url}/sru`, '1.2'), indexes: { ...INDEXES, title: 'bib.unknown' } };
    const f = await domainFailure(sruSearch(odd, 'title', 'laskar', { start: 1, allowPrivate: true }));
    expect(f.code).toBe('CATALOG_SRU_INVALID');
    expect(String(f.meta?.['message'])).toBe('Unsupported index: bib.unknown');
  });

  it('the SSRF guard applies: the local server without allowPrivate is CATALOG_OUTBOUND_BLOCKED', async () => {
    const f = await domainFailure(sruSearch(server(`${fake.url}/sru`, '1.2'), 'isbn', FAKE_SRU_ISBN, { start: 1, allowPrivate: false }));
    expect(f.code).toBe('CATALOG_OUTBOUND_BLOCKED');
  });

  it('a hanging server ends as CATALOG_OUTBOUND_FAILED timeout (shorter test timeout), and so does a caller abort', async () => {
    const f = await domainFailure(sruSearch(server(`${fake.url}/hang`, '1.2'), 'isbn', FAKE_SRU_ISBN, { start: 1, allowPrivate: true, timeoutMs: 300 }));
    expect(f).toEqual({ code: 'CATALOG_OUTBOUND_FAILED', meta: { reason: 'timeout' } });
    const controller = new AbortController();
    const pending = domainFailure(sruSearch(server(`${fake.url}/hang?abort=1`, '1.2'), 'isbn', FAKE_SRU_ISBN, { start: 1, allowPrivate: true, signal: controller.signal }));
    await fake.waitForRequest('/hang?abort=1');
    controller.abort();
    expect(await pending).toEqual({ code: 'CATALOG_OUTBOUND_FAILED', meta: { reason: 'timeout' } });
  });

  it('a non-SRU answer is CATALOG_SRU_INVALID', async () => {
    const f = await domainFailure(sruSearch(server(`${fake.url}/redirect/0`, '1.2'), 'isbn', FAKE_SRU_ISBN, { start: 1, allowPrivate: true }));
    expect(f.code).toBe('CATALOG_SRU_INVALID');
  });
});
