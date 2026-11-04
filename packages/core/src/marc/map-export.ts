// RecordData → MARC 21 (Phase 2 spec §5.1 mapping table, export direction; B3, S4, S5). The mapped fields are generated
// from the record's columns; the record's `marcExtra` is merged in tag order (a generated field comes before a kept
// one of the same tag, so a re-import maps the generated one again). Precedence (B3):
// - Leader: the marcExtra `LDR` when present, else generated; positions 00-04, 09 (`a`) and 12-16 recomputed.
// - 001 (the record id), 003 (the org code, when set) and 005 (`updatedAt`) are always generated; marcExtra's are
//   dropped. 008: marcExtra's when present (its language, 35-37, set from the record), else generated from
//   `createdAt`, the year and the language. 040 `$a orgCode` only when marcExtra holds no 040.
// - A tag MARC 21 marks non-repeatable (NON_REPEATABLE) is written once: the generated or mapped field wins. The name
//   main entries 100/110/111 count as one: a generated one wins over a kept one of another 1XX tag.
// - 856 for public attachments only, an http(s) URL re-checked here (S4) or `<baseUrl>/files/<id>` for a file; a
//   marcExtra 856 with any other URL is dropped. 852 only with `includeItems`.
// - Audience (S5): `staff` keeps marcExtra as stored; `public` drops 541, 561, 583, 590-599, 852, 876-878 and every
//   9XX of marcExtra (acquisition source and price, provenance, actions, local notes, holdings and items).
// Generated fields never carry acquisition data (item prices, suppliers, invoices, orders). Pure; no I/O.

import { RDA_CARRIER_TYPES, RDA_CONTENT_TYPES, RDA_MEDIA_TYPES, SUBJECT_EXPORT_TAG, type AgentType, type RelatorRole } from '@altis/shared';
import { isHttpUrl, URL_MAX } from '@altis/shared/api/catalog/common';
import type { MarcExtraField, RecordData } from '@altis/shared/api/catalog/record-data';
import { titleKey } from '../catalog/lib/title-key.js';
import { iso2709Leader } from './iso2709.js';
import { isControlTag, marcIndicator, marcLeader24, type MarcControlField, type MarcDataField, type MarcRecord } from './record.js';

/** Tags MARC 21 (bibliographic) marks non-repeatable, the leader included: written at most once. */
export const NON_REPEATABLE: ReadonlySet<string> = new Set([
  'LDR',
  '001',
  '003',
  '005',
  '008',
  '010',
  '018',
  '036',
  '038',
  '040',
  '042',
  '043',
  '044',
  '045',
  '066',
  '090',
  '100',
  '110',
  '111',
  '130',
  '240',
  '243',
  '245',
  '254',
  '256',
  '263',
  '306',
  '310',
  '357',
  '384',
  '507',
  '514',
  '841',
  '842',
  '844',
  '882',
]);

/** The name main entries: a record has one of them at most (100, 110 and 111 are each in NON_REPEATABLE too). */
const MAIN_ENTRY = /^1(00|10|11)$/;

/** marcExtra tags a public export leaves out (S5): acquisition, provenance, actions, local notes, holdings, items. */
const PUBLIC_DENIED = /^(541|561|583|59\d|852|87[6-8]|9\d\d)$/;

const RELATOR_TERM: Readonly<Record<RelatorRole, string>> = {
  aut: 'author',
  edt: 'editor',
  trl: 'translator',
  ill: 'illustrator',
  cmp: 'composer',
  drt: 'director',
  pro: 'producer',
  cre: 'creator',
  ctb: 'contributor',
};

const AGENT_TAG_OFFSET: Readonly<Record<AgentType, number>> = { person: 0, organization: 10, meeting: 11 };

/** The 6XX second indicator of a subject source (the inverse of the import's); another source is `7` + `$2`. */
const SOURCE_IND2: Readonly<Record<string, string>> = { lcsh: '0', lcshac: '1', mesh: '2', nal: '3', cash: '5', rvm: '6' };

const RDA_FIELDS = [
  { tag: '336', key: 'contentType', list: RDA_CONTENT_TYPES, source: 'rdacontent' },
  { tag: '337', key: 'mediaType', list: RDA_MEDIA_TYPES, source: 'rdamedia' },
  { tag: '338', key: 'carrierType', list: RDA_CARRIER_TYPES, source: 'rdacarrier' },
] as const;

/** A long line of text is written in fields of at most this many UTF-8 bytes (a field holds 9 999). */
const TEXT_FIELD_BYTES = 9000;

type Field = MarcControlField | MarcDataField;

const utf8 = new TextEncoder();

/**
 * The 245 second indicator to keep: a nonfiling count only when it ends the title on a word boundary (a space or an
 * apostrophe) and titleKey applies it; anything else becomes `0`. Internal: the import uses it too.
 */
export function nonfilingIndicator(ind2: string, title: string): string {
  if (!/^[1-9]$/.test(ind2)) return ind2;
  const n = Number(ind2);
  const before = title.charAt(n - 1);
  const boundary = before === ' ' || before === "'" || before === '\u{2019}' || before === '\u{02BC}';
  return boundary && title.length > n && titleKey(title, null, n) !== titleKey(title) ? ind2 : '0';
}

/** `s` ending with a full stop (or `?`/`!`), as ISBD closes an area. */
function period(s: string): string {
  return s === '' || /[.?!]$/.test(s) ? s : `${s}.`;
}

/** `s` followed by a comma before the next element, unless it already ends in punctuation that does the job. */
function comma(s: string): string {
  return /[.,?!-]$/.test(s) ? s : `${s},`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `text` in pieces of at most TEXT_FIELD_BYTES UTF-8 bytes, cut at a space when there is one. */
function textPieces(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (utf8.encode(rest).length > TEXT_FIELD_BYTES) {
    let cut = 0;
    let bytes = 0;
    for (const ch of rest) {
      const n = utf8.encode(ch).length;
      if (bytes + n > TEXT_FIELD_BYTES) break;
      bytes += n;
      cut += ch.length;
    }
    const space = rest.lastIndexOf(' ', cut);
    const at = space > cut / 2 ? space : cut;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest !== '') out.push(rest);
  return out;
}

/** A marcExtra entry as a field, or null when it cannot be (a bad tag, or data that is not the subfield JSON). */
function extraField(e: MarcExtraField): Field | null {
  if (!/^\d{3}$/.test(e.tag)) return null;
  if (isControlTag(e.tag)) return { tag: e.tag, value: e.data };
  let parsed: unknown;
  try {
    parsed = JSON.parse(e.data);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const subfields: [string, string][] = [];
  for (const sf of parsed as unknown[]) {
    if (!Array.isArray(sf) || sf.length !== 2 || typeof sf[0] !== 'string' || typeof sf[1] !== 'string') return null;
    subfields.push([sf[0], sf[1]]);
  }
  return { tag: e.tag, ind1: marcIndicator(e.ind1), ind2: marcIndicator(e.ind2), subfields };
}

/** An 856 that would link anywhere but http(s) (S4). */
function unsafeLink(f: Field): boolean {
  return f.tag === '856' && 'subfields' in f && f.subfields.some(([c, v]) => c === 'u' && !(isHttpUrl(v.trim()) && v.trim().length <= URL_MAX));
}

/** The 008 generated for a record without one: date entered, date type and year, language. */
function generated008(createdAt: number, year: string | undefined, language: string | undefined): string {
  const c = new Date(createdAt);
  const entered = pad(c.getUTCFullYear() % 100) + pad(c.getUTCMonth() + 1) + pad(c.getUTCDate());
  const date = year && /^\d{4}$/.test(year) ? `s${year}` : 'nuuuu';
  return `${entered}${date}    xx ${'|'.repeat(17)}${language ?? '|||'} d`;
}

/**
 * The MARC record of a stored record (spec §5.1). `audience` decides what of marcExtra is written (S5), `orgCode` is
 * `catalog.marcOrgCode` (null: no 003 and no generated 040, P2-32), `baseUrl` is `config.baseUrl` for the files of
 * public attachments, `includeItems` adds an 852 per item.
 */
export function recordToMarc(d: RecordData, o: { audience: 'public' | 'staff'; orgCode: string | null; baseUrl: string; includeItems: boolean }): MarcRecord {
  const orgCode = o.orgCode !== null && o.orgCode.trim() !== '' ? o.orgCode.trim() : null;
  const language = d.language?.code ?? d.languageCode;
  const lang3 = language && /^[a-z]{3}$/.test(language) ? language : undefined;

  // ---- marcExtra ---------------------------------------------------------------------------------------------------
  let ldr: string | null = null;
  let f008: string | null = null;
  let carrier: MarcDataField | null = null;
  const extra: Field[] = [];
  for (const e of d.marcExtra) {
    if (e.tag === 'LDR') {
      ldr ??= e.data;
      continue;
    }
    const f = extraField(e);
    if (f === null || f.tag === '001' || f.tag === '003' || f.tag === '005') continue;
    if (f.tag === '008') {
      if ('value' in f) f008 ??= f.value;
      continue;
    }
    if (f.tag === '245') {
      if ('subfields' in f) carrier ??= f;
      continue;
    }
    if (o.audience === 'public' && PUBLIC_DENIED.test(f.tag)) continue;
    if (unsafeLink(f)) continue;
    extra.push(f);
  }
  const has = (tag: string) => extra.some((f) => f.tag === tag);

  // ---- generated fields --------------------------------------------------------------------------------------------
  const gen: Field[] = [];
  const data = (tag: string, ind: string, subfields: [string, string | undefined | null][]) => {
    const kept = subfields.filter((s): s is [string, string] => typeof s[1] === 'string' && s[1] !== '');
    if (kept.length > 0) gen.push({ tag, ind1: ind[0] ?? ' ', ind2: ind[1] ?? ' ', subfields: kept });
  };

  gen.push({ tag: '001', value: d.id });
  if (orgCode) gen.push({ tag: '003', value: orgCode });
  const u = new Date(d.updatedAt);
  gen.push({
    tag: '005',
    value: `${u.getUTCFullYear()}${pad(u.getUTCMonth() + 1)}${pad(u.getUTCDate())}${pad(u.getUTCHours())}${pad(u.getUTCMinutes())}${pad(u.getUTCSeconds())}.${Math.floor(u.getUTCMilliseconds() / 100)}`,
  });
  let value008 = f008 ?? generated008(d.createdAt, d.publicationYear, lang3);
  if (f008 !== null && lang3 && value008.length >= 38) value008 = value008.slice(0, 35) + lang3 + value008.slice(38);
  gen.push({ tag: '008', value: value008 });

  // Identifiers: ISBN 020, ISSN 022, DOI 024 7_, others 024 8_; the control identifier is the 001/003 of the source.
  for (const id of d.identifiers) {
    if (id.type === 'isbn') data('020', '  ', [['a', id.value], ['q', id.qualifier]]);
    else if (id.type === 'issn') data('022', '  ', [['a', id.qualifier ? `${id.value} (${id.qualifier})` : id.value]]);
    else if (id.type === 'doi') data('024', '7 ', [['a', id.value], ['2', 'doi']]);
    else if (id.type === 'other') data('024', '8 ', [['a', id.value], ['q', id.qualifier]]);
  }
  if (orgCode && !has('040')) data('040', '  ', [['a', orgCode]]);
  data('082', '04', [['a', d.classification]]);
  data('090', '  ', [['a', d.callNumber]]);

  // Agents: the main one in 1XX, the others in 7XX, `$e` the relator term and `$4` its code.
  const main = d.agents.findIndex((a) => a.isMain);
  d.agents.forEach((a, i) => {
    const tag = String((i === main ? 100 : 700) + AGENT_TAG_OFFSET[a.type]);
    const ind1 = a.type === 'person' ? (a.name.includes(',') ? '1' : '0') : '2';
    const subfields: [string, string][] = [['a', comma(a.name)]];
    if (a.dates) subfields.push(['d', comma(a.dates)]);
    // A meeting name (X11) has its relator term in $j: its $e is a subordinate unit.
    subfields.push([a.type === 'meeting' ? 'j' : 'e', RELATOR_TERM[a.role]], ['4', a.role]);
    gen.push({ tag, ind1, ind2: ' ', subfields });
  });

  // 245 with ISBD punctuation; the marcExtra 245 gives the indicators and the subfields ALTIS does not map.
  const residual = carrier?.subfields.filter(([c]) => c.length === 1 && !'abcnp'.includes(c)) ?? [];
  const lead = residual.filter(([c]) => c === '6' || c === '8');
  const body: { code: string; value: string; mapped: boolean }[] = [{ code: 'a', value: d.title, mapped: true }];
  for (const [code, value] of residual) if (code !== '6' && code !== '8') body.push({ code, value, mapped: false });
  if (d.subtitle) body.push({ code: 'b', value: d.subtitle, mapped: true });
  if (d.responsibility) body.push({ code: 'c', value: d.responsibility, mapped: true });
  const ib = body.findIndex((e) => e.code === 'b');
  const ic = body.findIndex((e) => e.code === 'c');
  if (ib > 0) body[ib - 1]!.value += ' :';
  if (ic > 0) body[ic - 1]!.value += ' /';
  const last = body.at(-1)!;
  if (last.mapped) last.value = period(last.value);
  gen.push({
    tag: '245',
    ind1: carrier?.ind1 ?? (main >= 0 ? '1' : '0'),
    ind2: carrier ? nonfilingIndicator(carrier.ind2, d.title) : '0',
    subfields: [...lead, ...body.map((e) => [e.code, e.value] as [string, string])],
  });

  data('250', '  ', [['a', d.edition ? period(d.edition) : null]]);
  // 255 (cartographic) or 256 (other); 256 is non-repeatable, so a kept 255/256 moves the material detail to 255.
  const detailTag = /^[ef]$/.test(d.materialType.marcType) || has('255') || has('256') ? '255' : '256';
  data(detailTag, '  ', [['a', d.materialDetail]]);
  const date = d.publicationDateText ?? d.publicationYear;
  const publisher = d.publisher?.name;
  const place = d.publicationPlace;
  data('264', ' 1', [
    ['a', place ? `${place}${publisher ? ' :' : date ? ',' : ''}` : null],
    ['b', publisher ? `${publisher}${date ? ',' : ''}` : null],
    ['c', date],
  ]);
  data('300', '  ', [['a', d.physicalDesc]]);
  for (const r of RDA_FIELDS) {
    const code = d[r.key];
    if (!code) continue;
    const term = (r.list as readonly { code: string; term: string }[]).find((e) => e.code === code)?.term;
    data(r.tag, '  ', [['a', term], ['b', code], ['2', r.source]]);
  }
  if (d.series) {
    const cut = d.series.lastIndexOf(' ; ');
    if (cut > 0) data('490', '0 ', [['a', `${d.series.slice(0, cut)} ;`], ['v', d.series.slice(cut + 3)]]);
    else data('490', '0 ', [['a', d.series]]);
  }
  for (const [tag, text] of [
    ['500', d.notes],
    ['520', d.summary],
  ] as const) {
    for (const l of (text ?? '').split(/\r\n|\r|\n/)) for (const piece of textPieces(l.trim())) data(tag, '  ', [['a', piece]]);
  }

  // Subjects: by type (§2.5), ind2/$2 from the authority source, subdivisions (` -- `) as $x.
  for (const s of d.subjects) {
    const tag = SUBJECT_EXPORT_TAG[s.type];
    const parts = s.term
      .split(' -- ')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    if (parts.length === 0) continue;
    const source = s.authoritySource ?? undefined;
    const ind2 = source ? (Object.hasOwn(SOURCE_IND2, source) ? SOURCE_IND2[source]! : '7') : '4';
    const subfields: [string, string][] = [['a', parts[0]!], ...parts.slice(1).map((p) => ['x', p] as [string, string])];
    if (ind2 === '7') subfields.push(['2', source!]);
    gen.push({ tag, ind1: tag === '600' ? (parts[0]!.includes(',') ? '1' : '0') : ' ', ind2, subfields });
  }

  if (o.includeItems) {
    for (const item of d.items) {
      data('852', '  ', [
        ['b', item.branchCode],
        ['c', item.locationCode],
        ['h', item.callNumber],
        ['p', item.barcode],
      ]);
    }
  }

  const files = `${o.baseUrl.replace(/\/+$/, '')}/files/`;
  for (const a of d.attachments) {
    if (a.access !== 'public') continue;
    const url = a.kind === 'file' ? (a.fileId ? files + encodeURIComponent(a.fileId) : null) : (a.url?.trim() ?? null);
    if (url === null || !isHttpUrl(url) || url.length > URL_MAX) continue;
    data('856', '40', [['u', url], ['y', a.title && a.title !== url ? a.title : null]]);
  }

  // ---- merge, in tag order, the generated field first; a non-repeatable tag once ----------------------------------
  const merged = [...gen.map((f, i) => ({ f, i, src: 0 })), ...extra.map((f, i) => ({ f, i, src: 1 }))]
    .sort((x, y) => (x.f.tag < y.f.tag ? -1 : x.f.tag > y.f.tag ? 1 : x.src - y.src || x.i - y.i))
    .map((e) => e.f);
  // A record has one name main entry (100, 110 or 111): the generated one, else the first kept one in tag order.
  const mainTag = gen.find((f) => MAIN_ENTRY.test(f.tag))?.tag ?? merged.find((f) => MAIN_ENTRY.test(f.tag))?.tag;
  const seen = new Set<string>();
  const fields = merged.filter((f) => {
    if (MAIN_ENTRY.test(f.tag) && f.tag !== mainTag) return false;
    if (!NON_REPEATABLE.has(f.tag)) return true;
    if (seen.has(f.tag)) return false;
    seen.add(f.tag);
    return true;
  });

  const marcType = /^[\x21-\x7E]$/.test(d.materialType.marcType) ? d.materialType.marcType : 'a';
  const marcLevel = /^[\x21-\x7E]$/.test(d.materialType.marcLevel) ? d.materialType.marcLevel : 'm';
  const base = ldr !== null ? marcLeader24(ldr) : `00000n${marcType}${marcLevel} a2200000 i 4500`;
  return { leader: iso2709Leader({ leader: base, fields }), fields };
}
