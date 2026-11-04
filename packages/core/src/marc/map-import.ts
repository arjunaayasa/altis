// MARC 21 → RecordDraft (Phase 2 spec §5.1 mapping table, import direction; D2-13). Every field the table maps fills a
// draft field; every other field, the original leader (`LDR`), the 008 and the 040 go to `marcExtra` in tag order, so
// an export writes them back (lossless round trip, K5). The rules that make export → import a fixpoint (B3):
// - A field the export regenerates is consumed: the first usable instance is mapped and the others stay in marcExtra
//   (the export writes its own field first, so a re-import maps that one again). A tag MARC 21 marks non-repeatable
//   (NON_REPEATABLE) is kept once; a second 1XX becomes an added entry.
// - ISBD punctuation is dropped from mapped values (a trailing ` /`, ` :`, ` ;`, ` =`, `,` and a closing period
//   that is not part of an initial or an abbreviation); the export writes it back.
// - 245: `$a $n $p` make the title, `$b` the subtitle, `$c` the statement of responsibility. Its indicators (ind2 =
//   the nonfiling count passed to titleKey) and its other subfields ride in a marcExtra 245, which the export merges
//   into the 245 it generates.
// - Agents and subjects are ordered as the export writes them (main entry, then by tag), and a repeated one is
//   dropped (the database keeps one link per agent and role, and one per subject).
// - Values are fitted to the contract widths (RecordDraft); what is cut or dropped is named in `warnings`
//   (`value_cut:<field>`, `value_skipped:<field>`, `list_full:<list>`, `field_skipped:<tag>`, `title_missing`).
// Generated fields never carry acquisition data, so 020/024 `$c` (terms of availability, a price) is not kept.
// Pure; no I/O.

import { RDA_CARRIER_TYPES, RDA_CONTENT_TYPES, RDA_MEDIA_TYPES, RELATOR_ROLES, SUBJECT_EXPORT_TAG, type AgentType, type RelatorRole, type SubjectType } from '@altis/shared';
import { TEXT_MAX_BYTES, hasForbiddenControl, utf8Length } from '@altis/shared/api/catalog/common';
import { DRAFT_ITEMS_MAX, RECORD_LIST_MAX, type MarcExtraField, type RecordDraft } from '@altis/shared/api/catalog/record-data';
import { agentNameKey, subjectTermKey } from '../catalog/data/keys.js';
import { normalizeDoi, parseIsbn, parseIssn, splitIdentifierText } from '../catalog/lib/identifiers.js';
import { NON_REPEATABLE, nonfilingIndicator } from './map-export.js';
import { isControlField, marcIndicator, marcLeader24, type MarcControlField, type MarcDataField, type MarcRecord } from './record.js';

type Draft = RecordDraft;
type DraftIdentifier = Draft['identifiers'][number];
type DraftAgent = Draft['agents'][number];
type DraftSubject = Draft['subjects'][number];
type DraftItem = Draft['items'][number];
type DraftLink = Draft['links'][number];

/** The widths of the draft fields (RecordDraft, the column widths of §2.2). */
const W = { line: 191, short: 64, code: 32, barcode: 200, url: 2000, extraData: 9999 } as const;

// ---- text ----------------------------------------------------------------------------------------------------------

/** One line of text: control characters become spaces, whitespace is collapsed, the ends trimmed. */
function line(s: string): string {
  return s.replace(/\p{Cc}+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/**
 * `s` without the characters of `set` and the blanks it ends with. A loop from the end: a regex `[…]+$` retries a long
 * run of them from each of its starts (quadratic: an hour for one 1 MiB MARCXML subfield or SRU answer value).
 */
function trimEndOf(s: string, set: ReadonlySet<string>): string {
  let end = s.length;
  while (end > 0) {
    const ch = s[end - 1]!;
    if (!set.has(ch) && ch.trim() !== '') break;
    end--;
  }
  return s.slice(0, end);
}

const ISBD_END: ReadonlySet<string> = new Set(['/', ':', ';', '=', ',']);
const RELATOR_END: ReadonlySet<string> = new Set(['.', ',', ';', ':']);

/** Drops trailing ISBD separators (` /`, ` :`, ` ;`, ` =`, `,`) and whitespace. */
function trimIsbd(s: string): string {
  return trimEndOf(s, ISBD_END);
}

/**
 * Drops a closing period that is punctuation, not part of the last word: kept after an initial or a short
 * abbreviation (`R.`, `Jr.`, `S.Pd.`) and after an ellipsis, dropped after a word of 3+ letters or digits or a number.
 */
function dropFinalPeriod(s: string): string {
  if (!s.endsWith('.') || s.endsWith('..')) return s;
  const word = s.slice(s.lastIndexOf(' ') + 1, -1);
  if (word.includes('.')) return s;
  const alnum = word.replace(/[^\p{L}\p{N}]/gu, '');
  if (/^\p{N}+$/u.test(alnum) || alnum.length >= 3) return s.slice(0, -1);
  return s;
}

/** A mapped one-line value: one line, ISBD separators dropped, and (`period`) a closing period dropped. */
function clean(s: string, period: boolean): string {
  const t = trimIsbd(line(s));
  return period ? trimIsbd(dropFinalPeriod(t)) : t;
}

/** Multi-line text (notes, summary): each line cleaned, empty lines dropped. */
function lines(s: string): string[] {
  return s
    .split(/\r\n|\r|\n/)
    .map(line)
    .filter((l) => l !== '');
}

/** The values of `codes` in field order. */
function values(f: MarcDataField, codes: string): string[] {
  return f.subfields.filter(([c]) => c.length === 1 && codes.includes(c)).map(([, v]) => v);
}

function first(f: MarcDataField, code: string): string | undefined {
  return f.subfields.find(([c]) => c === code)?.[1];
}

/** A value in parentheses without them (`(pbk.)` → `pbk.`). */
function unparen(s: string): string {
  const t = line(s);
  return t.startsWith('(') && t.endsWith(')') ? t.slice(1, -1).trim() : t;
}

/** What every value of a marcExtra entry may not hold: C0 controls but TAB/LF/CR, and DEL. */
function extraSafe(s: string): string {
  if (!hasForbiddenControl(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) continue;
    out += s[i];
  }
  return out;
}

// ---- the mapping ---------------------------------------------------------------------------------------------------

/** The MARC relator terms (English and Indonesian) of the roles ALTIS keeps (§2.2). */
const RELATOR_TERMS: Readonly<Record<string, RelatorRole>> = {
  author: 'aut',
  writer: 'aut',
  pengarang: 'aut',
  penulis: 'aut',
  editor: 'edt',
  editors: 'edt',
  ed: 'edt',
  eds: 'edt',
  penyunting: 'edt',
  translator: 'trl',
  tr: 'trl',
  trans: 'trl',
  penerjemah: 'trl',
  penterjemah: 'trl',
  'alih bahasa': 'trl',
  illustrator: 'ill',
  ill: 'ill',
  illus: 'ill',
  ilustrator: 'ill',
  composer: 'cmp',
  komposer: 'cmp',
  director: 'drt',
  sutradara: 'drt',
  producer: 'pro',
  produser: 'pro',
  creator: 'cre',
  pencipta: 'cre',
  contributor: 'ctb',
  kontributor: 'ctb',
};

/** A `$4` code, a relator URI or an `$e` term → the role, or null when ALTIS has no such role. */
function relator(v: string): RelatorRole | null {
  const t = trimEndOf(line(v).toLowerCase(), RELATOR_END);
  const uri = /\/relators\/([a-z]{3})$/.exec(t);
  const code = uri ? uri[1]! : t;
  if ((RELATOR_ROLES as readonly string[]).includes(code)) return code as RelatorRole;
  return Object.hasOwn(RELATOR_TERMS, t) ? RELATOR_TERMS[t]! : null;
}

/** The subject source of a 6XX second indicator (MARC 21), `7` taking `$2`. */
const SUBJECT_SOURCES: Readonly<Record<string, string>> = { '0': 'lcsh', '1': 'lcshac', '2': 'mesh', '3': 'nal', '5': 'cash', '6': 'rvm' };

const SUBJECT_TYPE_BY_TAG: Readonly<Record<string, SubjectType>> = {
  '600': 'name',
  '610': 'name',
  '611': 'name',
  '648': 'temporal',
  '650': 'topic',
  '651': 'geographic',
  '655': 'genre',
  '656': 'occupation',
};

const AGENT_TYPE_BY_TAG: Readonly<Record<string, AgentType>> = {
  '100': 'person',
  '110': 'organization',
  '111': 'meeting',
  '700': 'person',
  '710': 'organization',
  '711': 'meeting',
};

/** The export tag of each agent type, for the order agents are written in. */
const AGENT_TAG: Readonly<Record<AgentType, number>> = { person: 700, organization: 710, meeting: 711 };

/** The export tag of each identifier type (the control identifier comes first and is never written). */
const IDENTIFIER_TAG: Readonly<Record<DraftIdentifier['type'], number>> = { control: 0, isbn: 20, issn: 22, doi: 24, other: 24 };

const RDA_LISTS = {
  '336': { field: 'contentType', list: RDA_CONTENT_TYPES },
  '337': { field: 'mediaType', list: RDA_MEDIA_TYPES },
  '338': { field: 'carrierType', list: RDA_CARRIER_TYPES },
} as const;

/** The subfields of a 6XX that subdivide it (form, general, chronological, geographic). */
const SUBDIVISIONS = 'vxyz';
/** Subfields that never belong to a name or a term: links, sources, relators ($e, or $j in a meeting name, X11). */
const notText = (tag: string) => (tag === '611' ? '0123456789j' : '0123456789e');

class DraftBuilder {
  readonly warnings: string[] = [];
  private readonly warned = new Set<string>();

  warn(w: string): void {
    if (!this.warned.has(w)) {
      this.warned.add(w);
      this.warnings.push(w);
    }
  }

  /** `s` cut to `max` code points (a warning names `field`), without a trailing blank. */
  fit(s: string, max: number, field: string): string {
    if (s.length <= max) return s;
    const points = Array.from(s);
    if (points.length <= max) return s;
    this.warn(`value_cut:${field}`);
    return points.slice(0, max).join('').trimEnd();
  }

  /** Multi-line text cut to the TEXT width (60 000 UTF-8 bytes) at a code point boundary. */
  fitText(s: string, field: string): string {
    if (utf8Length(s) <= TEXT_MAX_BYTES) return s;
    this.warn(`value_cut:${field}`);
    let bytes = 0;
    let out = '';
    for (const ch of s) {
      bytes += utf8Length(ch);
      if (bytes > TEXT_MAX_BYTES) break;
      out += ch;
    }
    return out.trimEnd();
  }
}

/** A marcExtra entry of `f`, or null (with a warning) when it cannot be stored. */
function extraOf(f: MarcControlField | MarcDataField, b: DraftBuilder, subfields?: [string, string][]): MarcExtraField | null {
  if (!/^\d{3}$/.test(f.tag)) {
    b.warn(`field_skipped:${f.tag}`);
    return null;
  }
  const data = isControlField(f) ? extraSafe(f.value) : JSON.stringify((subfields ?? f.subfields).map(([c, v]) => [c, extraSafe(v)]));
  if (data.length > W.extraData) {
    b.warn(`field_skipped:${f.tag}`);
    return null;
  }
  return isControlField(f) ? { tag: f.tag, ind1: ' ', ind2: ' ', data } : { tag: f.tag, ind1: marcIndicator(f.ind1), ind2: marcIndicator(f.ind2), data };
}

/**
 * The draft of one MARC record (spec §5.1). `materialTypeCodeFor` maps leader/06 and /07 to a material type code (null:
 * the default type). `warnings` lists what had to be cut or dropped to fit the draft's contract.
 */
export function marcToDraft(rec: MarcRecord, o: { materialTypeCodeFor(leader06: string, leader07: string): string | null }): { draft: RecordDraft; warnings: string[] } {
  const b = new DraftBuilder();
  const leader = marcLeader24(rec.leader);
  const extra: { at: number; field: MarcExtraField }[] = [{ at: -1, field: { tag: 'LDR', ind1: ' ', ind2: ' ', data: leader } }];
  const keep = (at: number, f: MarcControlField | MarcDataField, subfields?: [string, string][]) => {
    const e = extraOf(f, b, subfields);
    if (e) extra.push({ at, field: e });
  };

  const control = new Map<string, string>();
  const used = new Set<number>();
  const fields = rec.fields;
  const dataFields: { at: number; f: MarcDataField }[] = [];
  const seenNonRepeatable = new Set<string>();

  // Control fields and the non-repeatable tags: 001/003 → the control identifier, 005 dropped, the rest kept.
  fields.forEach((f, at) => {
    if (NON_REPEATABLE.has(f.tag) && !/^1(00|10|11)$/.test(f.tag)) {
      if (seenNonRepeatable.has(f.tag)) {
        b.warn(`field_skipped:${f.tag}`);
        used.add(at);
        return;
      }
      seenNonRepeatable.add(f.tag);
    }
    if (isControlField(f)) {
      used.add(at);
      if (f.tag === '001' || f.tag === '003' || f.tag === '005') control.set(f.tag, line(f.value));
      else keep(at, f);
    } else dataFields.push({ at, f });
  });

  /** The first data field of `tag` (passing `ok`) that is not used yet, marked used. */
  const take = (tag: string, ok: (f: MarcDataField) => boolean = () => true): MarcDataField | undefined => {
    const hit = dataFields.find(({ at, f }) => f.tag === tag && !used.has(at) && ok(f));
    if (!hit) return undefined;
    used.add(hit.at);
    return hit.f;
  };
  const all = (tags: readonly string[]) => dataFields.filter(({ at, f }) => tags.includes(f.tag) && !used.has(at));

  const draft: Draft = {
    materialTypeCode: o.materialTypeCodeFor(leader[6]!, leader[7]!),
    title: '',
    publisher: null,
    identifiers: [],
    agents: [],
    subjects: [],
    links: [],
    items: [],
    marcExtra: [],
  };
  const set = <K extends keyof Draft>(key: K, value: Draft[K] | '' | undefined) => {
    if (value !== undefined && value !== '') draft[key] = value as Draft[K];
  };

  // ---- 245 -------------------------------------------------------------------------------------------------------
  const t245 = take('245');
  if (t245) {
    set('title', b.fitText(clean(values(t245, 'anp').join(' '), true), 'title'));
    set('subtitle', b.fitText(clean(values(t245, 'b').join(' '), true), 'subtitle'));
    set('responsibility', b.fitText(clean(values(t245, 'c').join(' '), true), 'responsibility'));
    const residual = t245.subfields.filter(([c]) => c.length === 1 && !'abcnp'.includes(c)).map(([c, v]) => [c, trimIsbd(line(v))] as [string, string]);
    // Links ($6, $8) first: the export writes them there.
    residual.sort((x, y) => Number(!'68'.includes(x[0])) - Number(!'68'.includes(y[0])));
    const at = dataFields.find((d) => d.f === t245)!.at;
    keep(at, { ...t245, ind2: nonfilingIndicator(marcIndicator(t245.ind2), draft.title) }, residual);
  }
  if (draft.title === '') b.warn('title_missing');

  // ---- identifiers -----------------------------------------------------------------------------------------------
  const ids: DraftIdentifier[] = [];
  const f001 = control.get('001');
  if (f001) {
    const f003 = control.get('003');
    const value = f003 ? `${f003}:${f001}` : f001;
    if (value.length <= W.short) ids.push({ type: 'control', value });
    else b.warn('value_skipped:identifiers.control');
  }
  const addId = (type: DraftIdentifier['type'], value: string, qualifier: string | null | undefined) => {
    const v = line(value);
    if (v === '') return;
    if (v.length > W.short) return b.warn('value_skipped:identifiers');
    const q = qualifier ? b.fit(line(qualifier), W.short, 'identifiers.qualifier') : '';
    ids.push(q ? { type, value: v, qualifier: q } : { type, value: v });
  };
  for (const { at, f } of all(['020', '022'])) {
    used.add(at);
    const q = values(f, 'q').map(unparen).filter((s) => s !== '');
    for (const a of values(f, 'a')) {
      for (const part of splitIdentifierText(a)) addId(part.type, part.value, [part.qualifier, ...q].filter((s) => s).join('; '));
    }
    const residual = f.subfields.filter(([c]) => c.length === 1 && !'aqc'.includes(c));
    if (residual.length > 0) keep(at, f, residual);
  }
  for (const { at, f } of all(['024'])) {
    used.add(at);
    const doi = f.ind1 === '7' && values(f, '2').some((s) => line(s).toLowerCase() === 'doi');
    const other = f.ind1 === '8';
    if ((!doi && !other) || values(f, 'a').some((a) => line(a).length > W.short)) {
      keep(at, f);
      continue;
    }
    const q = values(f, 'q').map(unparen).filter((s) => s !== '');
    for (const a of values(f, 'a')) addId(doi ? 'doi' : 'other', a, doi ? null : q.join('; '));
    const residual = f.subfields.filter(([c]) => c.length === 1 && !(doi ? 'a2c' : 'aqc').includes(c));
    if (residual.length > 0) keep(at, f, residual);
  }
  const idKey = (i: DraftIdentifier) => {
    const key = i.type === 'isbn' ? parseIsbn(i.value)?.key : i.type === 'issn' ? parseIssn(i.value)?.key : i.type === 'doi' ? normalizeDoi(i.value) : null;
    return `${i.type}|${key ?? i.value.toUpperCase()}`;
  };
  draft.identifiers = cap(dedupe(stableSort(ids, (i) => IDENTIFIER_TAG[i.type]), idKey), RECORD_LIST_MAX.identifiers, 'identifiers', b);

  // ---- classification, call number, language ---------------------------------------------------------------------
  const f082 = take('082', (f) => values(f, 'a').length > 0);
  if (f082) set('classification', b.fit(line(first(f082, 'a') ?? ''), W.short, 'classification'));
  const callOf = (f: MarcDataField | undefined, codes: string) => (f ? line(values(f, codes).join(' ')) : '');
  let call = callOf(take('090'), 'ab');
  if (call === '') call = callOf(take('050', (f) => values(f, 'a').length > 0), 'ab');
  if (call === '') {
    const holding = dataFields.find(({ f }) => f.tag === '852' && values(f, 'h').length > 0 && values(f, 'p').length === 0);
    if (holding) call = callOf(holding.f, 'hi');
  }
  set('callNumber', b.fit(call, W.short, 'callNumber'));
  const f008 = rec.fields.find((f): f is MarcControlField => f.tag === '008' && isControlField(f))?.value ?? '';
  const lang008 = f008.slice(35, 38);
  let language = /^[a-z]{3}$/.test(lang008) ? lang008 : '';
  if (language === '') {
    const f041 = dataFields.find(({ f }) => f.tag === '041' && values(f, 'a').length > 0);
    const code = f041 ? line(first(f041.f, 'a') ?? '').toLowerCase().slice(0, 3) : '';
    if (/^[a-z]{3}$/.test(code)) language = code;
  }
  set('languageCode', language);

  // ---- 250, 255/256, 260/264, 300, 336-338, series, notes ---------------------------------------------------------
  const f250 = take('250', (f) => values(f, 'ab').length > 0);
  if (f250) set('edition', b.fit(clean(values(f250, 'ab').join(' '), true), W.line, 'edition'));
  const detail = take('255', (f) => values(f, 'a').length > 0) ?? take('256', (f) => values(f, 'a').length > 0);
  if (detail) set('materialDetail', b.fit(clean(values(detail, 'a').join(' '), false), W.line, 'materialDetail'));
  const pub = take('264', (f) => f.ind2 === '1') ?? take('260');
  if (pub) {
    const place = b.fit(clean(first(pub, 'a') ?? '', true), W.line, 'publicationPlace');
    const name = b.fit(clean(first(pub, 'b') ?? '', true), W.line, 'publisher');
    set('publicationPlace', place);
    if (name !== '') draft.publisher = place !== '' ? { name, place } : { name };
    set('publicationDateText', b.fit(clean(first(pub, 'c') ?? '', true), W.short, 'publicationDateText'));
  }
  const year = /(?<!\d)\d{4}(?!\d)/.exec(draft.publicationDateText ?? '')?.[0] ?? (/^\d{4}$/.test(f008.slice(7, 11)) ? f008.slice(7, 11) : undefined);
  set('publicationYear', year);
  if (draft.publicationDateText === undefined && year !== undefined) draft.publicationDateText = year;
  const f300 = take('300', (f) => values(f, 'abce').length > 0);
  if (f300) set('physicalDesc', b.fit(clean(values(f300, 'abce').join(' '), false), W.line, 'physicalDesc'));
  for (const [tag, { field, list }] of Object.entries(RDA_LISTS)) {
    const codeOf = (f: MarcDataField): string | undefined => {
      const code = line(first(f, 'b') ?? '').toLowerCase();
      if (/^[a-z]{1,8}$/.test(code)) return code;
      const term = line(first(f, 'a') ?? '').toLowerCase();
      return (list as readonly { code: string; term: string }[]).find((e) => e.term === term)?.code;
    };
    const f = take(tag, (x) => codeOf(x) !== undefined);
    if (f) set(field, codeOf(f));
  }
  const seriesOf = (f: MarcDataField) => {
    const a = clean(values(f, 'a').join(' '), false);
    const v = clean(values(f, 'v').join(' '), false);
    return a === '' ? '' : v === '' ? a : `${a} ; ${v}`;
  };
  const series = take('490', (f) => seriesOf(f) !== '') ?? take('440', (f) => seriesOf(f) !== '') ?? take('830', (f) => seriesOf(f) !== '');
  if (series) set('series', b.fit(seriesOf(series), W.line, 'series'));
  const text = (tag: string, codes: string, field: 'notes' | 'summary') => {
    const out: string[] = [];
    for (const { at, f } of all([tag])) {
      if (values(f, codes).length === 0) continue; // nothing to map (a $5 or $3 alone): kept in marcExtra
      used.add(at);
      out.push(...lines(values(f, codes).join(' ')));
    }
    set(field, b.fitText(out.join('\n'), field));
  };
  text('500', 'a', 'notes');
  text('520', 'ab', 'summary');

  // ---- agents ----------------------------------------------------------------------------------------------------
  const agents: DraftAgent[] = [];
  for (const { at, f } of all(['100', '110', '111', '700', '710', '711'])) {
    const main = f.tag.startsWith('1');
    if (!main && values(f, 't').length > 0) continue; // a name-title entry is a work, not a contributor
    const type = AGENT_TYPE_BY_TAG[f.tag]!;
    const nameCodes = type === 'person' ? 'abcq' : type === 'organization' ? 'ab' : 'acdenq';
    const name = b.fit(clean(values(f, nameCodes).join(' '), true), W.line, 'agents.name');
    if (name === '') continue; // no name to map: kept in marcExtra
    used.add(at);
    const dates = type === 'person' ? b.fit(clean(values(f, 'd').join(' '), true), W.short, 'agents.dates') : '';
    // The relator term is $e, except in a meeting name (X11), where $e is a subordinate unit and the term is $j.
    const marked = [...values(f, '4'), ...values(f, type === 'meeting' ? 'j' : 'e')];
    const role = marked.map(relator).find((r) => r !== null) ?? (marked.length > 0 ? 'ctb' : 'aut');
    const isMain = main && !agents.some((x) => x.isMain);
    agents.push(dates ? { type, name, dates, role, isMain } : { type, name, role, isMain });
  }
  const agentOrder = (a: DraftAgent) => (a.isMain ? 0 : AGENT_TAG[a.type]);
  draft.agents = cap(
    dedupe(stableSort(agents, agentOrder), (a) => `${a.type}|${agentNameKey(a.name, a.dates)}|${a.role}`),
    RECORD_LIST_MAX.agents,
    'agents',
    b,
  );

  // ---- subjects --------------------------------------------------------------------------------------------------
  const subjects: Omit<DraftSubject, 'isPrimary'>[] = [];
  for (const { at, f } of all(Object.keys(SUBJECT_TYPE_BY_TAG))) {
    const type = SUBJECT_TYPE_BY_TAG[f.tag]!;
    const main = clean(f.subfields.filter(([c]) => c.length === 1 && !SUBDIVISIONS.includes(c) && !notText(f.tag).includes(c)).map(([, v]) => v).join(' '), true);
    const parts = [main, ...values(f, SUBDIVISIONS).map((v) => clean(v, true))].filter((p) => p !== '');
    if (parts.length === 0) continue; // no term to map: kept in marcExtra
    used.add(at);
    const term = b.fit(parts.join(' -- '), W.line, 'subjects.term');
    const source = f.ind2 === '7' ? b.fit(line(first(f, '2') ?? ''), W.short, 'subjects.authoritySource') : Object.hasOwn(SUBJECT_SOURCES, f.ind2) ? SUBJECT_SOURCES[f.ind2] : undefined;
    subjects.push(source ? { type, term, authoritySource: source } : { type, term });
  }
  const tagOf = (s: { type: SubjectType }) => Number(SUBJECT_EXPORT_TAG[s.type]);
  draft.subjects = cap(
    dedupe(stableSort(subjects, tagOf), (s) => `${s.type}|${subjectTermKey(s.term)}`),
    RECORD_LIST_MAX.subjects,
    'subjects',
    b,
  ).map((s, i) => ({ ...s, isPrimary: i === 0 }));

  // ---- items (852, 952) and links (856) --------------------------------------------------------------------------
  const items: DraftItem[] = [];
  const code = (v: string | undefined, field: string): string | undefined => {
    const c = line(v ?? '');
    if (c === '') return undefined;
    if (c.length <= W.code && /^[\x20-\x7E]+$/.test(c)) return c;
    b.warn(`value_skipped:${field}`);
    return undefined;
  };
  for (const { at, f } of all(['852', '952'])) {
    const barcode = line(first(f, 'p') ?? '');
    if (barcode === '') continue; // a holdings statement: kept in marcExtra
    used.add(at);
    if (barcode.length > W.barcode) {
      b.warn('value_skipped:items.barcode');
      continue;
    }
    const k = f.tag === '852' ? { branch: 'b', location: 'c', call: 'hi', type: '' } : { branch: 'a', location: 'c', call: 'o', type: 'y' };
    const item: DraftItem = { barcode };
    const branchCode = code(first(f, k.branch), 'items.branchCode');
    const locationCode = code(first(f, k.location), 'items.locationCode');
    const callNumber = b.fit(line(values(f, k.call).join(' ')), W.short, 'items.callNumber');
    const collectionTypeCode = k.type ? code(first(f, k.type), 'items.collectionTypeCode') : undefined;
    if (branchCode) item.branchCode = branchCode;
    if (locationCode) item.locationCode = locationCode;
    if (callNumber) item.callNumber = callNumber;
    if (collectionTypeCode) item.collectionTypeCode = collectionTypeCode;
    items.push(item);
  }
  draft.items = cap(items, DRAFT_ITEMS_MAX, 'items', b);
  const links: DraftLink[] = [];
  for (const { at, f } of all(['856'])) {
    const urls = values(f, 'u').map((u) => u.trim()).filter((u) => u !== '');
    if (urls.length === 0) continue;
    used.add(at);
    const title = b.fit(line(first(f, 'y') ?? ''), W.line, 'links.title');
    for (const url of urls) {
      if (url.length > W.url) b.warn('value_skipped:links.url');
      else links.push(title ? { url, title } : { url });
    }
  }
  draft.links = cap(links, RECORD_LIST_MAX.links, 'links', b);

  // ---- everything else -------------------------------------------------------------------------------------------
  for (const { at, f } of dataFields) if (!used.has(at)) keep(at, f);
  const ordered = stableSort(
    extra.sort((x, y) => x.at - y.at),
    (e) => (e.field.tag === 'LDR' ? -1 : Number(e.field.tag)),
  ).map((e) => e.field);
  draft.marcExtra = cap(ordered, RECORD_LIST_MAX.marcExtra, 'marcExtra', b);
  return { draft, warnings: b.warnings };
}

/** `list` sorted by `key`, ties kept in their order. */
function stableSort<T>(list: readonly T[], key: (x: T) => number): T[] {
  return list
    .map((x, i) => ({ x, i, k: key(x) }))
    .sort((p, q) => p.k - q.k || p.i - q.i)
    .map((e) => e.x);
}

/** `list` without the later entries whose key repeats an earlier one. */
function dedupe<T>(list: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The first `max` entries of `list` (a warning names `name` when some are left out). */
function cap<T>(list: T[], max: number, name: string, b: DraftBuilder): T[] {
  if (list.length <= max) return list;
  b.warn(`list_full:${name}`);
  return list.slice(0, max);
}
