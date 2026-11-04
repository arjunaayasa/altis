import { XmlWriter } from '@altis/core';
import { absoluteUrl } from '../urls.js';

// The OAI-PMH 2.0 protocol layer (Phase 2 spec §10; Task 35): the response envelope, the error codes, datestamps and
// setSpecs. Every document is written with Task 5's XmlWriter, which escapes all text and drops the characters XML 1.0
// forbids, so a value from the catalogue or the request can never break the XML a harvester reads.
//
// The envelope (OAI-PMH 2.0 §3.2): the XML declaration, `<OAI-PMH>` in the protocol's namespace with its schema
// location, `<responseDate>`, `<request>` (the base URL, with the request's arguments as attributes, except after a
// badVerb or badArgument, where the protocol wants none), then the verb's element or the error(s). A protocol error is
// an HTTP 200 answer like any other.

export const OAI_PMH_NS = 'http://www.openarchives.org/OAI/2.0/';
const OAI_PMH_XSD = 'http://www.openarchives.org/OAI/2.0/OAI-PMH.xsd';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';

/** The six verbs. */
export const OAI_VERBS = Object.freeze(['Identify', 'ListMetadataFormats', 'ListSets', 'GetRecord', 'ListIdentifiers', 'ListRecords'] as const);
export type OaiVerb = (typeof OAI_VERBS)[number];

/** The verbs that page, and the formats ALTIS disseminates. */
export type OaiListVerb = 'ListRecords' | 'ListIdentifiers';
export type OaiPrefix = 'oai_dc' | 'marc21';

/** The metadata formats (§10): Dublin Core and MARCXML (MARC21slim). */
export const OAI_FORMATS: readonly { prefix: OaiPrefix; schema: string; namespace: string }[] = Object.freeze([
  { prefix: 'oai_dc', schema: 'http://www.openarchives.org/OAI/2.0/oai_dc.xsd', namespace: 'http://www.openarchives.org/OAI/2.0/oai_dc/' },
  { prefix: 'marc21', schema: 'http://www.loc.gov/standards/marcxml/schema/MARC21slim.xsd', namespace: 'http://www.loc.gov/MARC21/slim' },
]);

export function isOaiPrefix(value: string): value is OaiPrefix {
  return OAI_FORMATS.some((f) => f.prefix === value);
}

/** The protocol's error codes; `noSetHierarchy` is not one of them: the repository has sets. */
export type OaiErrorCode =
  | 'badArgument'
  | 'badResumptionToken'
  | 'badVerb'
  | 'cannotDisseminateFormat'
  | 'idDoesNotExist'
  | 'noRecordsMatch'
  | 'noMetadataFormats';

/** The text of each error (English: the protocol's working language). */
export const OAI_ERROR_TEXT: Readonly<Record<OaiErrorCode, string>> = Object.freeze({
  badArgument: 'An argument is illegal, missing, repeated or malformed for this verb.',
  badResumptionToken: 'The resumption token is invalid or has expired; start the list again.',
  badVerb: 'The verb argument is missing, repeated or not an OAI-PMH verb.',
  cannotDisseminateFormat: 'This metadata format is not available; see ListMetadataFormats.',
  idDoesNotExist: 'No item of this repository has this identifier.',
  noRecordsMatch: 'No record matches these arguments.',
  noMetadataFormats: 'The item was deleted: no metadata format is available for it.',
});

/** The arguments a request may carry besides `verb`, in the order the `request` element echoes them. */
export const OAI_ARGUMENTS = Object.freeze(['identifier', 'metadataPrefix', 'from', 'until', 'set', 'resumptionToken'] as const);
export type OaiArgument = (typeof OAI_ARGUMENTS)[number];

/** `ms` as an OAI datestamp: `YYYY-MM-DDThh:mm:ssZ` in UTC, cut to the second (the repository's granularity). */
export function oaiDatestamp(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SECOND_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * A `from` or `until` argument: a day (`YYYY-MM-DD`) or a second (`YYYY-MM-DDThh:mm:ssZ`) in UTC, as its first
 * millisecond, with its granularity; null for anything else (an impossible date included).
 */
export function parseOaiDate(value: string): { ms: number; granularity: 'day' | 'second' } | null {
  const m = SECOND_RE.exec(value) ?? DAY_RE.exec(value);
  if (m === null) return null;
  const [y, mo, d, hh = 0, mi = 0, ss = 0] = m.slice(1).map(Number) as [number, number, number, number?, number?, number?];
  if (mo < 1 || mo > 12 || d < 1 || hh > 23 || mi > 59 || ss > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(hh, mi, ss, 0);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return { ms: date.getTime(), granularity: m.length > 4 ? 'second' : 'day' };
}

/** A setSpec as OAI-PMH spells it: unreserved URI characters, `:` between the levels. */
const SET_SPEC = /^[A-Za-z0-9\-_.!~*'()]+(?::[A-Za-z0-9\-_.!~*'()]+)*$/;

export function isOaiSetSpec(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && SET_SPEC.test(value);
}

/** The top set: every record has a material type. */
export const MATERIAL_SET = 'material';

/** Characters a material set keeps as they are; `~` is the escape, so it is escaped itself. */
const SET_KEEP = /^[a-z0-9\-_.!*'()]$/;

/**
 * The set of a material type (§10): `material:` + its code in lower case. A character a setSpec cannot hold (a
 * space, `/`, `:`, …; material codes are printable ASCII) is written as `~` + its UTF-8 bytes in hex, so that
 * different codes never share a set.
 */
export function materialSetSpec(codeKey: string): string {
  let out = '';
  for (const ch of codeKey.toLowerCase()) {
    if (SET_KEEP.test(ch)) out += ch;
    else for (const byte of Buffer.from(ch, 'utf8')) out += `~${byte.toString(16).padStart(2, '0')}`;
  }
  return `${MATERIAL_SET}:${out}`;
}

/** What every document needs: the response time, the base URL, and the arguments to echo (null: none). */
export interface OaiEnvelope {
  now: number;
  baseUrl: string;
  /** `verb` and the other arguments as received; null after a badVerb or badArgument. */
  request: Readonly<Record<string, string>> | null;
}

/** An OAI-PMH document: the envelope around what `write` adds (the verb's element or the errors). */
export function oaiDocument(o: OaiEnvelope, write: (w: XmlWriter) => void): string {
  const w = new XmlWriter();
  w.raw('<?xml version="1.0" encoding="UTF-8"?>\n');
  w.open('OAI-PMH', { xmlns: OAI_PMH_NS, 'xmlns:xsi': XSI_NS, 'xsi:schemaLocation': `${OAI_PMH_NS} ${OAI_PMH_XSD}` });
  w.leaf('responseDate', oaiDatestamp(o.now));
  w.leaf('request', absoluteUrl(o.baseUrl, '/oai'), o.request ?? undefined);
  write(w);
  w.close();
  return `${w.toString()}\n`;
}

/** The document of one protocol error; `request` is dropped for badVerb and badArgument (OAI-PMH 2.0 §3.6). */
export function oaiErrorDocument(o: OaiEnvelope, code: OaiErrorCode): string {
  const request = code === 'badVerb' || code === 'badArgument' ? null : o.request;
  return oaiDocument({ ...o, request }, (w) => w.leaf('error', OAI_ERROR_TEXT[code], { code }));
}
