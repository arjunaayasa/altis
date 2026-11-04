// SRU copy cataloguing (Phase 2 spec §6.2, §6.3; plan Task 32) on top of Task 9's client (sru-client.ts):
// - `sruSearchDrafts`: one page of a search of a configured server, each MARCXML record mapped to a draft by the MARC
//   import mapping (Task 6: `readMarcXml` fed the record's UTF-8 bytes, S21, then `marcToDraft`). A draft is never
//   stored here: the librarian picks one, the editor fills its form, and the save is `POST catalog/records` with
//   `source: 'sru:<id>'`.
// - `sruIsbnSource`: a server as a source of the ISBN lookup (`bath.isbn`-style index of the server).
// - `sruTestServer`: the settings screen's "Uji" for a base URL (`POST catalog/sru/test`, decision P2-17).
// - `copyMaterialTypeResolver`: the live material types by MARC leader type and level, for the mapping.
//
// The answers are untrusted: Task 9's parser rebuilds each record with our XML writer, the MARCXML reader refuses a
// DOCTYPE, and every draft is checked against the strict `RecordDraft` contract; a record that fails any of these is
// left out (the page can then hold fewer drafts than records). The remote library's items (852/952) are dropped: they
// describe its copies, not ours. Every outbound call goes through the guarded client (SSRF guard, limits) and never
// runs inside a database transaction.

import type { DB } from '@altis/db';
import { DomainError, isDomainError } from '@altis/shared';
import type { SruIndex, SruTestResponse, SruVersion } from '@altis/shared/api/catalog/copy';
import { RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { SruServer } from '@altis/shared/api/settings';
import type { Kysely } from 'kysely';
import { marcToDraft, readMarcXml } from '../../marc/index.js';
import { httpRequest } from '../../net/http.js';
import { XmlError } from '../../xml/index.js';
import type { IsbnSource, MarcMaterialTypeFn } from './isbn-source.js';
import { parseSruResponse, sruSearch, sruSearchUrl } from './sru-client.js';

/** No material type from the leader: the draft takes the default one. */
const DEFAULT_TYPE: MarcMaterialTypeFn = () => null;

/** The CQL indexes a server is tested with (the spec's defaults, §6.2): the test searches `any`. */
const TEST_INDEXES: SruServer['indexes'] = Object.freeze({ isbn: 'bath.isbn', title: 'dc.title', author: 'dc.creator', any: 'cql.serverChoice' });

/** The term of the test search, and its page size (the answer's shape is what is tested, not its hits). */
const TEST_TERM = 'test';
const TEST_RECORDS = 1;

/** The longest message of a failed test (`SruTestResponse.message`, §6.2: cut to 200 characters). */
const TEST_MESSAGE_MAX = 200;

/** Character sets an answer may use besides UTF-8 (all read as ISO-8859-1), as the client accepts them. */
const LATIN1_CHARSETS = new Set(['iso-8859-1', 'iso8859-1', 'latin1', 'l1', 'us-ascii', 'ascii']);

/** The drafts of `records` (self-contained MARCXML records): each mapped, without items, and kept when the contract holds. */
function sruDrafts(records: readonly string[], materialTypeCodeFor: MarcMaterialTypeFn): RecordDraft[] {
  const drafts: RecordDraft[] = [];
  for (const xml of records) {
    let results;
    try {
      const reader = readMarcXml();
      results = [...reader.push(Buffer.from(xml, 'utf8')), ...reader.end()];
    } catch (e) {
      if (e instanceof XmlError) continue;
      throw e;
    }
    for (const r of results) {
      if (!r.ok) continue;
      const { draft } = marcToDraft(r.record, { materialTypeCodeFor });
      const checked = RecordDraft.safeParse({ ...draft, items: [] });
      if (checked.success) drafts.push(checked.data);
    }
  }
  return drafts;
}

/**
 * One page (at most 20 records from `start`, 1-based) of a search of `server` for `term` in `index`, as drafts. `total`
 * is the server's hit count.
 *
 * @throws DomainError `CATALOG_OUTBOUND_BLOCKED`, `CATALOG_OUTBOUND_FAILED`, `CATALOG_SRU_INVALID` (sruSearch)
 */
export async function sruSearchDrafts(
  server: SruServer,
  index: SruIndex,
  term: string,
  o: { start: number; allowPrivate: boolean; materialTypeCodeFor?: MarcMaterialTypeFn; signal?: AbortSignal },
): Promise<{ total: number; drafts: RecordDraft[] }> {
  const page = await sruSearch(server, index, term, {
    start: o.start,
    allowPrivate: o.allowPrivate,
    ...(o.signal === undefined ? {} : { signal: o.signal }),
  });
  return { total: page.total, drafts: sruDrafts(page.records, o.materialTypeCodeFor ?? DEFAULT_TYPE) };
}

/**
 * `server` as a source of the ISBN lookup (`sru:<server.id>`): the first page of a search of its ISBN index for the
 * ISBN-13, as drafts. `allowPrivate` is `catalog.sru.allowPrivateHosts`.
 */
export function sruIsbnSource(server: SruServer, o: { allowPrivate: boolean; materialTypeCodeFor?: MarcMaterialTypeFn }): IsbnSource {
  const materialTypeCodeFor = o.materialTypeCodeFor ?? DEFAULT_TYPE;
  return {
    id: `sru:${server.id}`,
    async lookup(isbn13, signal) {
      const page = await sruSearch(server, 'isbn', isbn13, { start: 1, allowPrivate: o.allowPrivate, signal });
      return sruDrafts(page.records, materialTypeCodeFor);
    },
  };
}

/** `s` cut to `max` UTF-16 units without splitting a surrogate pair. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return s.slice(0, end).trimEnd();
}

function sruInvalid(message: string, cause?: unknown): DomainError {
  return new DomainError('CATALOG_SRU_INVALID', { meta: { message }, ...(cause === undefined ? {} : { cause }) });
}

/** The answer as text: UTF-8 (strict) or ISO-8859-1, from its Content-Type charset, else its XML declaration (as the client reads it). */
function answerText(body: Buffer, contentType: string | undefined): string {
  let charset = /;\s*charset\s*=\s*"?([A-Za-z0-9._:-]+)"?/i.exec(contentType ?? '')?.[1];
  if (charset === undefined) {
    const bom = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? 3 : 0;
    const head = body.subarray(bom, bom + 256).toString('latin1');
    charset = /^<\?xml\s[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1] ?? 'utf-8';
  }
  const name = charset.toLowerCase();
  if (name === 'utf-8' || name === 'utf8') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch (e) {
      throw sruInvalid('The answer is not valid UTF-8.', e);
    }
  }
  if (LATIN1_CHARSETS.has(name)) return body.toString('latin1');
  throw sruInvalid('The answer uses a character set other than UTF-8 or ISO-8859-1.');
}

/** The message of a failed test: the server's own (cut to 200), or the outbound failure's reason (`status 404`). */
function failureMessage(e: DomainError): string | undefined {
  const meta = e.meta ?? {};
  if (e.code === 'CATALOG_SRU_INVALID' && typeof meta['message'] === 'string' && meta['message'] !== '') return cut(meta['message'], TEST_MESSAGE_MAX);
  if (e.code === 'CATALOG_OUTBOUND_FAILED' && typeof meta['reason'] === 'string') {
    return typeof meta['status'] === 'number' ? `${meta['reason']} ${meta['status']}` : meta['reason'];
  }
  return undefined;
}

/**
 * Tries the SRU base URL `url` with `version` (`POST catalog/sru/test`, decision P2-17): a searchRetrieve of one MARCXML
 * record for the term `test` in `cql.serverChoice`. `ok` when the answer is an SRU response (whatever its hits), with
 * the version the server reported; otherwise the error code with the server's message (a diagnostic), or the outbound
 * failure's reason. Never throws a DomainError.
 */
export async function sruTestServer(body: { url: string; version: SruVersion }, o: { allowPrivate: boolean; signal?: AbortSignal }): Promise<SruTestResponse> {
  const server: SruServer = { id: 'test', name: 'test', url: body.url, version: body.version, recordSchema: 'marcxml', indexes: TEST_INDEXES, enabled: true };
  try {
    const res = await httpRequest({
      url: sruSearchUrl(server, 'any', TEST_TERM, 1, TEST_RECORDS),
      method: 'GET',
      headers: { accept: 'application/xml, text/xml;q=0.9, */*;q=0.5' },
      allowPrivate: o.allowPrivate,
      ...(o.signal === undefined ? {} : { signal: o.signal }),
    });
    const parsed = parseSruResponse(answerText(res.body, res.headers['content-type']));
    const diagnostic = parsed.diagnostics[0];
    const version = parsed.version === null ? {} : { version: parsed.version };
    if (parsed.records.length === 0 && diagnostic !== undefined) {
      const message = cut(diagnostic.message !== '' ? diagnostic.message : diagnostic.uri, TEST_MESSAGE_MAX);
      return { ok: false, code: 'CATALOG_SRU_INVALID', ...(message === '' ? {} : { message }), ...version };
    }
    return { ok: true, ...version };
  } catch (e) {
    if (!isDomainError(e)) throw e;
    const message = failureMessage(e);
    return { ok: false, code: e.code, ...(message === undefined ? {} : { message }) };
  }
}

/**
 * The material type of a copied record by its MARC leader (§5.1 mapping): the first live type, in the masters' order,
 * whose leader type (06) and level (07) both match; else the first whose type matches; else null (the default type).
 * Read once per request: the masters' code as displayed.
 */
export async function copyMaterialTypeResolver(db: Kysely<DB>): Promise<MarcMaterialTypeFn> {
  const rows = await db
    .selectFrom('material_types')
    .select(['code_display', 'marc_type', 'marc_level'])
    .where('archived_at', 'is', null)
    .orderBy('sort_order')
    .orderBy('code_key')
    .execute();
  return (leader06, leader07) =>
    rows.find((r) => r.marc_type === leader06 && r.marc_level === leader07)?.code_display ?? rows.find((r) => r.marc_type === leader06)?.code_display ?? null;
}
