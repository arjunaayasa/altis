// The SRU client of copy cataloguing (spec §6.2; plan Task 9): the searchRetrieve URL of a configured server, the
// parser of its answer (SRU 1.1/1.2 and 2.0), and the search through the outbound client (net/http.ts, with its SSRF
// guard and limits). The answer is untrusted: it goes through our bounded XML reader (no DOCTYPE, no entities but the
// five predefined ones), and each MARC record is rebuilt from the reader's events by our XML writer as a self-contained
// MARCXML `<record xmlns="http://www.loc.gov/MARC21/slim">`, with no prefix and no foreign namespace, for the MARCXML
// reader of Task 6. Mapping a record to a draft is Task 32's.

import { DomainError } from '@altis/shared';
import type { SruIndex } from '@altis/shared/api/catalog/copy';
import type { SruServer } from '@altis/shared/api/settings';
import { httpRequest } from '../../net/http.js';
import { XmlError, XmlWriter, createXmlReader, type XmlEvent } from '../../xml/index.js';

/** The SRU response namespaces: 1.1/1.2 and 2.0. */
const SRU1_NS = 'http://www.loc.gov/zing/srw/';
const SRU2_NS = 'http://docs.oasis-open.org/ns/search-ws/sruResponse';
const SRU_NAMESPACES = new Set([SRU1_NS, SRU2_NS]);
const MARC_NS = 'http://www.loc.gov/MARC21/slim';

/** Records asked for per page (§6.2), and the most a search returns. */
const SRU_PAGE_SIZE = 20;
/** The longest message of `CATALOG_SRU_INVALID` (§6.2). */
const SRU_MESSAGE_MAX = 200;
/** Diagnostics kept from one answer, and the length kept of each of their texts. */
const SRU_MAX_DIAGNOSTICS = 10;
const SRU_DIAGNOSTIC_TEXT_MAX = 500;

/** The parameters the client sets; the same names in a server URL's own query are replaced. */
const SRU_PARAMS = ['version', 'operation', 'query', 'recordSchema', 'maximumRecords', 'startRecord', 'recordPacking', 'recordXMLEscaping'];

/** Character sets an answer may use besides UTF-8 (all read as ISO-8859-1). */
const LATIN1_CHARSETS = new Set(['iso-8859-1', 'iso8859-1', 'latin1', 'l1', 'us-ascii', 'ascii']);

/** A diagnostic of an SRU answer: its URI, and its message with the details after a colon. */
export interface SruDiagnostic {
  uri: string;
  message: string;
}

/** An SRU answer: the hit count, the MARCXML records, the diagnostics, and the version (null when a 1.x one has none). */
export interface SruParsedResponse {
  total: number;
  /** Each a self-contained MARCXML `<record>` in the MARC 21 slim namespace. */
  records: string[];
  diagnostics: SruDiagnostic[];
  version: string | null;
}

/** One page of an SRU search. */
export interface SruSearchResult {
  total: number;
  records: string[];
}

function sruInvalid(message: string, cause?: unknown): DomainError {
  return new DomainError('CATALOG_SRU_INVALID', { meta: { message }, ...(cause === undefined ? {} : { cause }) });
}

/**
 * The server refused the search with a diagnostic (§6.2): `message` is its own text, cut to 200 characters, and is
 * also the error's `detail`, which the 502 shows (review L09). An answer that is not SRU has no detail: its message is
 * ours, and the client shows the code's text.
 */
function sruRefused(message: string): DomainError {
  return new DomainError('CATALOG_SRU_INVALID', { detail: message, meta: { message } });
}

/** `s` cut to `max` UTF-16 units without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return s.slice(0, end).trimEnd();
}

/** Text from the server: control characters and runs of white space become one space, trimmed, cut to `max`. */
function cleanText(s: string, max: number): string {
  return cut(s.replace(/[\p{Cc}\s]+/gu, ' ').trim(), max);
}

/** A CQL quoted term: `"` and `\` escaped. */
function cqlTerm(term: string): string {
  return `"${term.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * The searchRetrieve URL of `server` for `term` in `index` (§6.2): `version`, `operation=searchRetrieve`, the CQL query
 * `<server.indexes[index]>="<term>"`, `recordSchema`, `maximumRecords` (default 20), `startRecord` (1-based), and
 * `recordPacking=xml` for SRU 1.x or `recordXMLEscaping=xml` for 2.0. Other parameters of the server URL are kept.
 *
 * @throws DomainError `CATALOG_OUTBOUND_FAILED` (reason `scheme`) when the server URL is not an http(s) URL
 * @throws RangeError for a `start` or `max` that is not a positive integer
 */
export function sruSearchUrl(server: SruServer, index: SruIndex, term: string, start: number, max: number = SRU_PAGE_SIZE): string {
  if (!Number.isSafeInteger(start) || start < 1) throw new RangeError('sruSearchUrl: start must be a positive integer');
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('sruSearchUrl: max must be a positive integer');
  let url: URL;
  try {
    url = new URL(server.url);
  } catch (e) {
    throw new DomainError('CATALOG_OUTBOUND_FAILED', { meta: { reason: 'scheme' }, cause: e });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new DomainError('CATALOG_OUTBOUND_FAILED', { meta: { reason: 'scheme' } });
  const params: [string, string][] = [
    ['version', server.version],
    ['operation', 'searchRetrieve'],
    ['query', `${server.indexes[index]}=${cqlTerm(term)}`],
    ['recordSchema', server.recordSchema],
    ['maximumRecords', String(max)],
    ['startRecord', String(start)],
    server.version === '2.0' ? ['recordXMLEscaping', 'xml'] : ['recordPacking', 'xml'],
  ];
  for (const name of SRU_PARAMS) url.searchParams.delete(name);
  const ours = params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
  const kept = url.search.slice(1);
  url.search = kept === '' ? ours : `${kept}&${ours}`;
  return url.href;
}

/** Namespace bindings in scope: prefix → URI, '' for the default namespace. */
type Scope = ReadonlyMap<string, string>;

const NO_SCOPE: Scope = new Map();

/**
 * The namespace of a name that is no namespace-well-formed QName (`a:`, `:x`, `a:b:c`; the reader accepts them as XML
 * names). It matches nothing, so such an element is never a result and is dropped from a record (the answer is
 * untrusted, and the writer refuses an empty name).
 */
const INVALID_NS = '#invalid-qname';

/** Whether `s` is a name without a colon (an NCName, given that the reader already checked it is an XML name). */
function isNcName(s: string): boolean {
  return s !== '' && !s.includes(':');
}

/** `parent` with the `xmlns` / `xmlns:p` declarations of `attrs` (one with an empty or colon prefix is ignored). */
function scopeOf(attrs: Record<string, string>, parent: Scope): Scope {
  let scope: Map<string, string> | null = null;
  for (const name of Object.keys(attrs)) {
    if (name !== 'xmlns' && !(name.startsWith('xmlns:') && isNcName(name.slice(6)))) continue;
    scope ??= new Map(parent);
    scope.set(name === 'xmlns' ? '' : name.slice(6), attrs[name]!);
  }
  return scope ?? parent;
}

/** The namespace and local name of `qname` in `scope` (an unbound prefix counts as no namespace). */
function resolveName(qname: string, scope: Scope): { ns: string; local: string } {
  const colon = qname.indexOf(':');
  if (colon === -1) return { ns: scope.get('') ?? '', local: qname };
  const prefix = qname.slice(0, colon);
  const local = qname.slice(colon + 1);
  if (prefix === '' || !isNcName(local)) return { ns: INVALID_NS, local };
  return { ns: scope.get(prefix) ?? '', local };
}

/** A MARC record element: `record` in the MARC 21 slim namespace, or in none (servers that leave it out). */
function isMarcRecord(ns: string, local: string): boolean {
  return local === 'record' && (ns === MARC_NS || ns === '');
}

/** The attributes of `attrs` that are neither namespace declarations nor prefixed (`tag`, `ind1`, `code`, `type`). */
function plainAttrs(attrs: Record<string, string>): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const name of Object.keys(attrs)) if (name !== 'xmlns' && !name.includes(':')) out[name] = attrs[name]!;
  return out;
}

/**
 * Rebuilds MARC records from reader events as self-contained MARCXML: the MARC namespace as the default one, names
 * without prefix, prefixed attributes dropped, an element of another namespace dropped with everything in it. The
 * namespace the record element itself was in counts as MARC's (a server that leaves the record in its SRU default
 * namespace).
 */
class MarcCollector {
  readonly records: string[] = [];
  private writer: XmlWriter | null = null;
  /** The namespace of the record element being rebuilt. */
  private recordNs = MARC_NS;
  /** Open elements of the record being rebuilt, the record included. */
  private level = 0;
  /** The level of a foreign element being dropped (0: none). */
  private dropFrom = 0;

  /** Whether a record is being rebuilt, so that every event belongs to it. */
  get busy(): boolean {
    return this.writer !== null;
  }

  start(ns: string, attrs: Record<string, string>): void {
    this.writer = new XmlWriter().open('record', { xmlns: MARC_NS, ...plainAttrs(attrs) });
    this.recordNs = ns;
    this.level = 1;
    this.dropFrom = 0;
  }

  open(ns: string, local: string, attrs: Record<string, string>): void {
    this.level++;
    if (this.dropFrom !== 0) return;
    if (ns !== MARC_NS && ns !== '' && ns !== this.recordNs) {
      this.dropFrom = this.level;
      return;
    }
    this.writer!.open(local, plainAttrs(attrs));
  }

  text(text: string): void {
    if (this.dropFrom === 0) this.writer!.text(text);
  }

  close(): void {
    if (this.dropFrom !== 0) {
      if (this.level === this.dropFrom) this.dropFrom = 0;
      this.level--;
      return;
    }
    this.writer!.close();
    this.level--;
    if (this.level === 0) {
      this.records.push(this.writer!.toString());
      this.writer = null;
    }
  }
}

/**
 * The MARC records of an escaped recordData (string packing). A record that is not well-formed is left out, as is
 * anything that is not a MARC record.
 */
function escapedRecords(text: string): string[] {
  const reader = createXmlReader();
  const collector = new MarcCollector();
  const scopes: Scope[] = [];
  const feed = (events: XmlEvent[]): void => {
    for (const e of events) {
      if (e.type === 'open') {
        const scope = scopeOf(e.attrs, scopes[scopes.length - 1] ?? NO_SCOPE);
        scopes.push(scope);
        const { ns, local } = resolveName(e.name, scope);
        if (collector.busy) collector.open(ns, local, e.attrs);
        else if (isMarcRecord(ns, local)) collector.start(ns, e.attrs);
      } else if (e.type === 'close') {
        scopes.pop();
        if (collector.busy) collector.close();
      } else if (collector.busy) {
        collector.text(e.text);
      }
    }
  };
  try {
    feed(reader.write(text));
    feed(reader.end());
  } catch (e) {
    if (e instanceof XmlError) return [];
    throw e;
  }
  return collector.records;
}

interface Frame {
  ns: string;
  local: string;
  scope: Scope;
}

/**
 * Parses an SRU searchRetrieve answer (1.1/1.2 in `http://www.loc.gov/zing/srw/`, 2.0 in the OASIS
 * `.../search-ws/sruResponse` namespace): `numberOfRecords`, the MARC records of each `recordData` (as XML, or escaped
 * as text), and the response-level diagnostics. A record of another schema (Dublin Core, a surrogate diagnostic) is
 * skipped. `version` is the answer's `version`, `2.0` for a 2.0 answer without one.
 *
 * @throws DomainError `CATALOG_SRU_INVALID` (with our own `meta.message`, never a quote of the answer) for XML that is
 *   not well-formed, a root that is not a searchRetrieveResponse, or a missing or malformed `numberOfRecords`
 */
export function parseSruResponse(xml: string): SruParsedResponse {
  const stack: Frame[] = [];
  const collector = new MarcCollector();
  const diagnostics: SruDiagnostic[] = [];
  let rootNs = '';
  let version: string | null = null;
  let total: number | null = null;
  /** The text of the leaf being read (version, numberOfRecords, a diagnostic field) and its depth. */
  let leafText = '';
  let leafDepth = 0;
  /** The recordData being read: its text (string packing) and how many records it held before it opened. */
  let dataText: string | null = null;
  let dataFirst = 0;
  let diagnostic: { uri: string; details: string; message: string } | null = null;

  /** Whether the open elements below the root are `locals`, in the root's namespace. */
  const at = (...locals: string[]): boolean =>
    stack.length === locals.length + 1 && locals.every((local, i) => stack[i + 1]!.local === local && stack[i + 1]!.ns === rootNs);
  const inDiagnostic = (): boolean =>
    stack.length >= 3 && stack[1]!.local === 'diagnostics' && stack[1]!.ns === rootNs && stack[2]!.local === 'diagnostic';

  const onOpen = (e: Extract<XmlEvent, { type: 'open' }>): void => {
    const scope = scopeOf(e.attrs, stack[stack.length - 1]?.scope ?? NO_SCOPE);
    const { ns, local } = resolveName(e.name, scope);
    stack.push({ ns, local, scope });
    if (collector.busy) {
      collector.open(ns, local, e.attrs);
      return;
    }
    const depth = stack.length;
    if (depth === 1) {
      if (local !== 'searchRetrieveResponse' || !SRU_NAMESPACES.has(ns)) throw sruInvalid('The answer is not an SRU searchRetrieve response.');
      rootNs = ns;
      return;
    }
    if (depth > 4 && stack[3]!.local === 'recordData' && stack[3]!.ns === rootNs && dataText !== null) {
      // A `record` in the SRU namespace cannot be an SRU record here: a server that left out the MARC namespace.
      if (isMarcRecord(ns, local) || (local === 'record' && ns === rootNs)) collector.start(ns, e.attrs);
      return;
    }
    if (at('version') || at('numberOfRecords')) {
      leafText = '';
      leafDepth = depth;
    } else if (at('records', 'record', 'recordData')) {
      dataText = '';
      dataFirst = collector.records.length;
    } else if (depth === 3 && inDiagnostic()) {
      diagnostic = { uri: '', details: '', message: '' };
    } else if (depth === 4 && inDiagnostic() && (local === 'uri' || local === 'details' || local === 'message')) {
      leafText = '';
      leafDepth = depth;
    }
  };

  const onClose = (): void => {
    const depth = stack.length;
    const frame = stack[depth - 1]!;
    if (collector.busy) {
      collector.close();
      stack.pop();
      return;
    }
    if (depth === leafDepth) {
      const text = leafText;
      leafDepth = 0;
      if (depth === 2 && frame.local === 'version') version = cleanText(text, 16);
      else if (depth === 2 && frame.local === 'numberOfRecords') {
        if (!/^\d{1,15}$/.test(text.trim())) throw sruInvalid('The numberOfRecords of the answer is not a number.');
        total = Number(text.trim());
      } else if (diagnostic !== null && (frame.local === 'uri' || frame.local === 'details' || frame.local === 'message')) {
        diagnostic[frame.local] = cleanText(text, SRU_DIAGNOSTIC_TEXT_MAX);
      }
    } else if (depth === 4 && dataText !== null && at('records', 'record', 'recordData')) {
      if (collector.records.length === dataFirst && dataText.trim() !== '') collector.records.push(...escapedRecords(dataText));
      dataText = null;
    } else if (depth === 3 && diagnostic !== null && inDiagnostic()) {
      const d: { uri: string; details: string; message: string } = diagnostic;
      if (diagnostics.length < SRU_MAX_DIAGNOSTICS) {
        diagnostics.push({ uri: d.uri, message: [d.message, d.details].filter((s) => s !== '').join(': ') });
      }
      diagnostic = null;
    }
    stack.pop();
  };

  const onText = (text: string): void => {
    if (collector.busy) collector.text(text);
    else if (leafDepth !== 0 && stack.length === leafDepth) leafText += text;
    else if (dataText !== null && stack.length === 4) dataText += text;
  };

  const reader = createXmlReader();
  const feed = (events: XmlEvent[]): void => {
    for (const e of events) {
      if (e.type === 'open') onOpen(e);
      else if (e.type === 'close') onClose();
      else onText(e.text);
    }
  };
  try {
    feed(reader.write(xml));
    feed(reader.end());
  } catch (e) {
    if (e instanceof XmlError) throw sruInvalid(`The answer is not well-formed XML (${e.reason}).`, e);
    throw e;
  }
  if (total === null) {
    if (diagnostics.length === 0) throw sruInvalid('The answer has no numberOfRecords.');
    total = 0;
  }
  return { total, records: collector.records, diagnostics, version: version ?? (rootNs === SRU2_NS ? '2.0' : null) };
}

/** The character set of an answer: its Content-Type charset, else its XML declaration, else UTF-8. */
function answerCharset(body: Buffer, contentType: string | undefined): string {
  const fromHeader = /;\s*charset\s*=\s*"?([A-Za-z0-9._:-]+)"?/i.exec(contentType ?? '')?.[1];
  if (fromHeader !== undefined) return fromHeader.toLowerCase();
  const bom = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? 3 : 0;
  const head = body.subarray(bom, bom + 256).toString('latin1');
  const declared = /^<\?xml\s[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1];
  return (declared ?? 'utf-8').toLowerCase();
}

/** The answer as text: UTF-8 (strict) or ISO-8859-1; any other character set is refused. */
function decodeAnswer(body: Buffer, contentType: string | undefined): string {
  const charset = answerCharset(body, contentType);
  if (charset === 'utf-8' || charset === 'utf8') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch (e) {
      throw sruInvalid('The answer is not valid UTF-8.', e);
    }
  }
  if (LATIN1_CHARSETS.has(charset)) return body.toString('latin1');
  throw sruInvalid('The answer uses a character set other than UTF-8 or ISO-8859-1.');
}

/**
 * Searches `server` for `term` in `index` (§6.2): one page of at most 20 records from `start` (1-based), through the
 * outbound client (`allowPrivate` = `catalog.sru.allowPrivateHosts`). A diagnostic without any record (the server
 * refused the search) is `CATALOG_SRU_INVALID` with the server's message cut to 200 characters (its `meta.message` and
 * its `detail`); a diagnostic next to
 * records is a warning and the records are kept. `timeoutMs` shortens the 10 s total (the ISBN lookup, tests).
 *
 * @throws DomainError `CATALOG_OUTBOUND_BLOCKED` / `CATALOG_OUTBOUND_FAILED` from the outbound client;
 *   `CATALOG_SRU_INVALID` for a diagnostic or an answer that is not SRU
 */
export async function sruSearch(
  server: SruServer,
  index: SruIndex,
  term: string,
  o: { start: number; allowPrivate: boolean; signal?: AbortSignal; timeoutMs?: number },
): Promise<SruSearchResult> {
  const res = await httpRequest({
    url: sruSearchUrl(server, index, term, o.start),
    method: 'GET',
    headers: { accept: 'application/xml, text/xml;q=0.9, */*;q=0.5' },
    allowPrivate: o.allowPrivate,
    ...(o.signal === undefined ? {} : { signal: o.signal }),
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
  });
  const parsed = parseSruResponse(decodeAnswer(res.body, res.headers['content-type']));
  const first = parsed.diagnostics[0];
  if (parsed.records.length === 0 && first !== undefined) {
    throw sruRefused(cut(first.message !== '' ? first.message : first.uri, SRU_MESSAGE_MAX));
  }
  return { total: parsed.total, records: parsed.records.slice(0, SRU_PAGE_SIZE) };
}
