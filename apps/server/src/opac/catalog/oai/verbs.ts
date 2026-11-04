import { XmlWriter } from '@altis/core';
import type { DbHandle } from '@altis/db';
import { isUlid } from '@altis/shared';
import { absoluteUrl } from '../urls.js';
import {
  MATERIAL_SET,
  OAI_ARGUMENTS,
  OAI_FORMATS,
  OAI_VERBS,
  isOaiPrefix,
  isOaiSetSpec,
  oaiDatestamp,
  oaiDocument,
  oaiErrorDocument,
  parseOaiDate,
  type OaiArgument,
  type OaiErrorCode,
  type OaiListVerb,
  type OaiPrefix,
  type OaiVerb,
} from './protocol.js';
import {
  earliestChange,
  materialSets,
  oaiCount,
  oaiItem,
  oaiPage,
  recordsXml,
  writeHeader,
  type OaiItem,
  type OaiRenderOptions,
  type OaiSelection,
} from './records.js';
import { OAI_TOKEN_TTL_MS, signToken, verifyToken, type OaiTokenPayload } from './token.js';

// The six OAI-PMH 2.0 verbs (Phase 2 spec §10, D2-24, K11; Task 35), over the request's arguments as received (each
// name with every value given), whatever the HTTP method. Checks, in this order:
//   1. `verb`: missing, repeated or unknown → badVerb;
//   2. the other arguments: a repeated, unknown, missing or empty one, a resumptionToken beside another argument, a
//      malformed date or setSpec, `from` and `until` of different granularities or `from` after `until` → badArgument;
//   3. the verb's own: badResumptionToken, cannotDisseminateFormat, idDoesNotExist, noRecordsMatch, noMetadataFormats.
//
// Lists (ListIdentifiers 500, ListRecords 100 per page, a ListRecords page also ending before 8 MiB of XML) are a
// keyset over the record id. The first page counts the list (completeListSize) and every later page carries that count
// in its signed token, with the selection and the last id sent (token.ts). The last page of a resumed list ends with
// an empty resumptionToken. ListMetadataFormats of a deleted record is noMetadataFormats: no metadata of it is given
// out any more (GetRecord answers its header with status="deleted").

/** Records per ListRecords page and headers per ListIdentifiers page (§10). */
export const OAI_PAGE_RECORDS = 100;
export const OAI_PAGE_IDENTIFIERS = 500;

export interface OaiContext {
  db: DbHandle['db'];
  /** `config.baseUrl`: the baseURL, the identifiers' host and every OPAC URL (never the Host header). */
  baseUrl: string;
  /** `library.name`: the repositoryName. */
  libraryName: string;
  /** `opac.oai.adminEmail`. */
  adminEmail: string;
  now: number;
  /** oaiTokenKeys(config.keyring): signs with [0], verifies with all (M15). */
  keys: readonly Buffer[];
  /** `catalog.marcOrgCode` for the 003 of `marc21` records (null or absent: none, P2-32). */
  orgCode?: string | null;
}

export interface OaiResult {
  /** 200: OAI-PMH answers its errors inside the document. */
  status: number;
  xml: string;
}

/** The arguments each verb takes: required, optional, and the exclusive one (a resumptionToken stands alone). */
const VERB_ARGUMENTS: Readonly<Record<OaiVerb, { required: readonly OaiArgument[]; optional: readonly OaiArgument[]; exclusive?: OaiArgument }>> = {
  Identify: { required: [], optional: [] },
  ListMetadataFormats: { required: [], optional: ['identifier'] },
  ListSets: { required: [], optional: [], exclusive: 'resumptionToken' },
  GetRecord: { required: ['identifier', 'metadataPrefix'], optional: [] },
  ListIdentifiers: { required: ['metadataPrefix'], optional: ['from', 'until', 'set'], exclusive: 'resumptionToken' },
  ListRecords: { required: ['metadataPrefix'], optional: ['from', 'until', 'set'], exclusive: 'resumptionToken' },
};

const isVerb = (value: string): value is OaiVerb => (OAI_VERBS as readonly string[]).includes(value);

class OaiProtocolError extends Error {
  constructor(readonly code: OaiErrorCode) {
    super(code);
  }
}

const fail = (code: OaiErrorCode): never => {
  throw new OaiProtocolError(code);
};

/**
 * The arguments besides `verb`, each given once, all known to `verb`, none empty, required ones present, an exclusive
 * one alone. @throws OaiProtocolError badArgument
 */
function checkArguments(verb: OaiVerb, params: Readonly<Record<string, readonly string[]>>): Map<OaiArgument, string> {
  const spec = VERB_ARGUMENTS[verb];
  const allowed = new Set<string>([...spec.required, ...spec.optional, ...(spec.exclusive === undefined ? [] : [spec.exclusive])]);
  const args = new Map<OaiArgument, string>();
  for (const name of Object.keys(params)) {
    if (name === 'verb') continue;
    const values = params[name] ?? [];
    if (!allowed.has(name) || values.length !== 1 || values[0] === '') fail('badArgument');
    args.set(name as OaiArgument, values[0]!);
  }
  if (spec.exclusive !== undefined && args.has(spec.exclusive)) {
    if (args.size !== 1) fail('badArgument');
  } else if (!spec.required.every((name) => args.has(name))) fail('badArgument');
  return args;
}

/** The record id of an identifier of this repository (`oai:<host>:<ULID>`), or null. */
function recordIdOf(identifier: string, host: string): string | null {
  const prefix = `oai:${host}:`;
  if (identifier.length > 200 || identifier.slice(0, prefix.length).toLowerCase() !== prefix) return null;
  const id = identifier.slice(prefix.length);
  return isUlid(id) ? id : null;
}

/** `from`/`until` and `set` of a first list request, checked. @throws OaiProtocolError badArgument */
function selectionArguments(args: ReadonlyMap<OaiArgument, string>): { from: number | null; until: number | null; set: string | null } {
  const from = args.has('from') ? parseOaiDate(args.get('from')!) : null;
  const until = args.has('until') ? parseOaiDate(args.get('until')!) : null;
  if ((args.has('from') && from === null) || (args.has('until') && until === null)) fail('badArgument');
  if (from !== null && until !== null && (from.granularity !== until.granularity || from.ms > until.ms)) fail('badArgument');
  const set = args.get('set') ?? null;
  if (set !== null && !isOaiSetSpec(set)) fail('badArgument');
  return {
    from: from?.ms ?? null,
    // `until` is inclusive at its granularity: the whole day, or the whole second.
    until: until === null ? null : until.ms + (until.granularity === 'day' ? 86_400_000 : 1000),
    set,
  };
}

/** The renderer's options and the material sets, read once per request. */
async function renderOptions(ctx: OaiContext): Promise<{ render: OaiRenderOptions; sets: Awaited<ReturnType<typeof materialSets>> }> {
  const sets = await materialSets(ctx.db);
  return {
    sets,
    render: {
      baseUrl: ctx.baseUrl,
      host: new URL(ctx.baseUrl).hostname,
      sets: new Map(sets.map((s) => [s.id, s.spec])),
      orgCode: ctx.orgCode ?? null,
    },
  };
}

/** Identify (§10): `earliest` is the earliest `changed_at` (the response time while the catalogue is empty). */
function writeIdentify(ctx: OaiContext, earliest: number, w: XmlWriter): void {
  w.open('Identify');
  w.leaf('repositoryName', ctx.libraryName);
  w.leaf('baseURL', absoluteUrl(ctx.baseUrl, '/oai'));
  w.leaf('protocolVersion', '2.0');
  w.leaf('adminEmail', ctx.adminEmail);
  w.leaf('earliestDatestamp', oaiDatestamp(earliest));
  w.leaf('deletedRecord', 'persistent');
  w.leaf('granularity', 'YYYY-MM-DDThh:mm:ssZ');
  w.close();
}

function writeFormats(w: XmlWriter): void {
  w.open('ListMetadataFormats');
  for (const f of OAI_FORMATS) {
    w.open('metadataFormat').leaf('metadataPrefix', f.prefix).leaf('schema', f.schema).leaf('metadataNamespace', f.namespace).close();
  }
  w.close();
}

/** The item an identifier names. @throws OaiProtocolError idDoesNotExist */
async function itemOf(ctx: OaiContext, identifier: string): Promise<OaiItem> {
  const id = recordIdOf(identifier, new URL(ctx.baseUrl).hostname);
  const item = id === null ? null : await oaiItem(ctx.db, id);
  return item ?? fail('idDoesNotExist');
}

/** One page of ListIdentifiers or ListRecords. */
async function listPage(ctx: OaiContext, verb: OaiListVerb, args: ReadonlyMap<OaiArgument, string>): Promise<(w: XmlWriter) => void> {
  const tokenText = args.get('resumptionToken');
  let state: Omit<OaiTokenPayload, 'v' | 'verb' | 'exp' | 'after' | 'size'> & { after: string | null; size: number | null };
  if (tokenText !== undefined) {
    const payload = verifyToken(tokenText, ctx.keys, ctx.now);
    if (payload === null || payload.verb !== verb) fail('badResumptionToken');
    state = payload!;
  } else {
    const selection = selectionArguments(args);
    const prefix = args.get('metadataPrefix')!;
    if (!isOaiPrefix(prefix)) fail('cannotDisseminateFormat');
    state = { prefix: prefix as OaiPrefix, ...selection, after: null, size: null };
  }

  const { render, sets } = await renderOptions(ctx);
  let materialTypeId: string | null = null;
  if (state.set !== null && state.set !== MATERIAL_SET) {
    materialTypeId = sets.find((s) => s.spec === state.set)?.id ?? fail('noRecordsMatch');
  }
  const selection: OaiSelection = { from: state.from, until: state.until, materialTypeId };
  const size = state.size ?? (await oaiCount(ctx.db, selection));
  if (size === 0) fail('noRecordsMatch');
  const limit = verb === 'ListRecords' ? OAI_PAGE_RECORDS : OAI_PAGE_IDENTIFIERS;
  const page = await oaiPage(ctx.db, selection, state.after, limit + 1);
  if (page.length === 0) fail('noRecordsMatch');
  const candidates = page.slice(0, limit);

  // The page is written before the document: a failure is an error answer, never half a document. ListRecords may
  // stop early at its byte budget; the next page then starts after the last record sent (a keyset never skips).
  let body: string;
  let sent: number;
  if (verb === 'ListRecords') {
    ({ xml: body, count: sent } = await recordsXml(ctx.db, candidates, state.prefix, render));
  } else {
    const headers = new XmlWriter();
    for (const item of candidates) writeHeader(headers, item, render);
    body = headers.toString();
    sent = candidates.length;
  }
  const items = candidates.slice(0, sent);
  const more = page.length > sent;

  let token: { text: string; attrs: Record<string, string | number> } | null = null;
  if (more) {
    const exp = ctx.now + OAI_TOKEN_TTL_MS;
    const payload: OaiTokenPayload = { v: 1, verb, prefix: state.prefix, set: state.set, from: state.from, until: state.until, after: items.at(-1)!.id, size, exp };
    token = { text: signToken(payload, ctx.keys[0]!), attrs: { expirationDate: oaiDatestamp(exp), completeListSize: size } };
  } else if (tokenText !== undefined) {
    token = { text: '', attrs: { completeListSize: size } };
  }
  return (w) => {
    w.open(verb).raw(body);
    if (token !== null) w.leaf('resumptionToken', token.text, token.attrs);
    w.close();
  };
}

/** The body of the answer to `verb` with `args`. @throws OaiProtocolError for a protocol error */
async function answer(ctx: OaiContext, verb: OaiVerb, args: ReadonlyMap<OaiArgument, string>): Promise<(w: XmlWriter) => void> {
  switch (verb) {
    case 'Identify': {
      const earliest = (await earliestChange(ctx.db)) ?? ctx.now;
      return (w) => writeIdentify(ctx, earliest, w);
    }
    case 'ListMetadataFormats': {
      const identifier = args.get('identifier');
      if (identifier !== undefined && (await itemOf(ctx, identifier)).deleted) fail('noMetadataFormats');
      return writeFormats;
    }
    case 'ListSets': {
      // The sets fit on one page: there is no token to resume.
      if (args.has('resumptionToken')) fail('badResumptionToken');
      const sets = (await materialSets(ctx.db)).filter((s) => !s.archived);
      return (w) => {
        w.open('ListSets');
        w.open('set').leaf('setSpec', MATERIAL_SET).leaf('setName', 'Material type').close();
        for (const s of sets) w.open('set').leaf('setSpec', s.spec).leaf('setName', s.name).close();
        w.close();
      };
    }
    case 'GetRecord': {
      const prefix = args.get('metadataPrefix')!;
      if (!isOaiPrefix(prefix)) fail('cannotDisseminateFormat');
      const item = await itemOf(ctx, args.get('identifier')!);
      const { render } = await renderOptions(ctx);
      const { xml: body } = await recordsXml(ctx.db, [item], prefix as OaiPrefix, render);
      return (w) => w.open('GetRecord').raw(body).close();
    }
    case 'ListIdentifiers':
    case 'ListRecords':
      return listPage(ctx, verb, args);
  }
}

/**
 * The answer to one OAI-PMH request (§10): `params` are its arguments as received (a name with every value given, the
 * query of a GET or the form of a POST). Always status 200 with an OAI-PMH document; a protocol error is in it.
 */
export async function handleOai(params: Readonly<Record<string, readonly string[]>>, ctx: OaiContext): Promise<OaiResult> {
  const envelope = { now: ctx.now, baseUrl: ctx.baseUrl };
  const verbs = Object.hasOwn(params, 'verb') ? (params['verb'] ?? []) : [];
  const verb = verbs.length === 1 ? verbs[0]! : '';
  if (!isVerb(verb)) return { status: 200, xml: oaiErrorDocument({ ...envelope, request: null }, 'badVerb') };

  let args: Map<OaiArgument, string>;
  try {
    args = checkArguments(verb, params);
  } catch (error) {
    if (error instanceof OaiProtocolError) return { status: 200, xml: oaiErrorDocument({ ...envelope, request: null }, error.code) };
    throw error;
  }
  const request: Record<string, string> = { verb };
  for (const name of OAI_ARGUMENTS) if (args.has(name)) request[name] = args.get(name)!;

  try {
    const body = await answer(ctx, verb, args);
    return { status: 200, xml: oaiDocument({ ...envelope, request }, body) };
  } catch (error) {
    if (error instanceof OaiProtocolError) return { status: 200, xml: oaiErrorDocument({ ...envelope, request }, error.code) };
    throw error;
  }
}
