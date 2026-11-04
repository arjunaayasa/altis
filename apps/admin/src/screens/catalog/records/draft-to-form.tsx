import {
  RECORD_FIELD_NAMES,
  normalizeKey,
  type AgentType,
  type FieldState,
  type IdentifierType,
  type RecordFieldName,
  type RelationType,
  type RelatorRole,
  type SubjectType,
} from '@altis/shared';
import type { CustomFieldView, LanguageView, MaterialTypeTemplate, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { LinkInput, MarcExtraField, RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { AgentRefInput, PublisherRefInput, RecordCreateBody, RecordDetail, RecordPatchBody, SubjectRefInput } from '@altis/shared/api/catalog/records';

/**
 * The record editor's form model (Phase 2 spec §3.1, §3.8, §6.2, §6.3; plan Task 24): the values the form holds, how
 * they are made from a copied draft ({@link draftToFormValues}) or a stored record ({@link detailToFormValues}), and
 * how they become the strict create and patch bodies of Task 4's contract.
 *
 * - The form names its fields as the bodies name their keys (`subtitle`, `publicationYear`, `agents.0.ref`), so a
 *   server field error lands on its field. Two exceptions are mapped by {@link bodyPathToFormPath}: the identifiers
 *   (empty rows are not sent, so body and form indexes differ) and the custom fields (a code may hold a `.`, which a
 *   form path cannot: the form keeps them as `customValues.<i>`).
 * - Texts are strings (`''` for none); a body leaves an empty one out on create and sends `null` on a patch.
 * - A new authority stays a reference by name (`{type, name}`, `{name}`; decision P2-10): the server finds or creates
 *   it when the record is saved, so the editor needs no authority permission.
 * - A field the material type's template hides is never sent (§3.8: the server refuses a value there).
 * - A copied draft keeps its `marcExtra` and `links` (S4: posted as `RecordCreateBody.links` on create) and its
 *   `source` (`sru:<id>`, `isbn:arsya`).
 */

/** An agent of the form: an existing one (`id`), or a new one to be found or created by its type, name and dates. */
export interface AgentChoice {
  id: string | null;
  type: AgentType;
  name: string;
  dates: string;
  authoritySource: string;
}

/** A subject of the form: an existing one (`id`), or a new one by type and term. */
export interface SubjectChoice {
  id: string | null;
  type: SubjectType;
  term: string;
  classification: string;
  authoritySource: string;
}

/** The publisher of the form: an existing one (`id`), or a new one by name. */
export interface PublisherChoice {
  id: string | null;
  name: string;
  place: string;
}

export interface IdentifierRow {
  type: IdentifierType;
  value: string;
  qualifier: string;
}

export interface AgentRow {
  ref: AgentChoice;
  role: RelatorRole;
  isMain: boolean;
}

export interface SubjectRow {
  ref: SubjectChoice;
  isPrimary: boolean;
}

/** A relation stored on this record; `title` is shown only. */
export interface RelationRow {
  relatedId: string;
  type: RelationType;
  title: string;
}

/** A custom field's value in the form: text (a number, a date, `true`/`false` as text too), or the options picked. */
export type CustomFormValue = string | string[];

export interface CustomRow {
  code: string;
  value: CustomFormValue;
}

/** What the record editor's form holds. */
export interface RecordFormValues {
  materialTypeId: string;
  title: string;
  subtitle: string;
  responsibility: string;
  edition: string;
  materialDetail: string;
  publisher: PublisherChoice | null;
  publicationPlace: string;
  publicationYear: string;
  publicationDateText: string;
  physicalDesc: string;
  series: string;
  classification: string;
  callNumber: string;
  languageId: string;
  contentType: string;
  mediaType: string;
  carrierType: string;
  summary: string;
  notes: string;
  opacVisible: boolean;
  promoted: boolean;
  identifiers: IdentifierRow[];
  agents: AgentRow[];
  subjects: SubjectRow[];
  relations: RelationRow[];
  customValues: CustomRow[];
  /** Where the values came from (`sru:<id>`, `isbn:arsya`); null for a record typed by hand. */
  source: string | null;
  /** The MARC fields a copied draft carried that ALTIS does not map (kept for export). */
  marcExtra: MarcExtraField[];
  /** A copied draft's links: stored as public URL attachments on create (S4). */
  links: LinkInput[];
}

/** The masters a draft's codes are looked up in. */
export interface DraftMasters {
  materialTypes: readonly MaterialTypeView[];
  languages: readonly LanguageView[];
  /** `catalog.defaultMaterialTypeId`: a draft whose type is unknown gets it. */
  defaultMaterialTypeId: string | null;
}

/** What the bodies need besides the values: the template of the chosen type and the custom fields. */
export interface BodyContext {
  template: MaterialTypeTemplate;
  customFields: readonly CustomFieldView[];
}

// ---- the template (§3.8) -----------------------------------------------------------------------------------------

/** The body keys a template governs (the server's `TemplateKey`). */
export type TemplateKey =
  | 'subtitle'
  | 'responsibility'
  | 'edition'
  | 'materialDetail'
  | 'publisher'
  | 'publicationPlace'
  | 'publicationYear'
  | 'publicationDateText'
  | 'physicalDesc'
  | 'series'
  | 'classification'
  | 'callNumber'
  | 'languageId'
  | 'contentType'
  | 'mediaType'
  | 'carrierType'
  | 'summary'
  | 'notes'
  | 'identifiers'
  | 'agents'
  | 'subjects';

/**
 * For each template field, the body keys it stands for and those a `required` one needs (as the server reads them:
 * `publication_year` covers the date as written too, `rda` the three RDA codes).
 */
export const TEMPLATE_FIELD_KEYS: Readonly<Record<RecordFieldName, { keys: readonly TemplateKey[]; required: readonly TemplateKey[] }>> = Object.freeze({
  subtitle: { keys: ['subtitle'], required: ['subtitle'] },
  responsibility: { keys: ['responsibility'], required: ['responsibility'] },
  edition: { keys: ['edition'], required: ['edition'] },
  material_detail: { keys: ['materialDetail'], required: ['materialDetail'] },
  publisher: { keys: ['publisher'], required: ['publisher'] },
  publication_place: { keys: ['publicationPlace'], required: ['publicationPlace'] },
  publication_year: { keys: ['publicationYear', 'publicationDateText'], required: ['publicationYear'] },
  physical_desc: { keys: ['physicalDesc'], required: ['physicalDesc'] },
  series: { keys: ['series'], required: ['series'] },
  classification: { keys: ['classification'], required: ['classification'] },
  call_number: { keys: ['callNumber'], required: ['callNumber'] },
  language: { keys: ['languageId'], required: ['languageId'] },
  rda: { keys: ['contentType', 'mediaType', 'carrierType'], required: ['contentType', 'mediaType', 'carrierType'] },
  summary: { keys: ['summary'], required: ['summary'] },
  notes: { keys: ['notes'], required: ['notes'] },
  identifiers: { keys: ['identifiers'], required: ['identifiers'] },
  agents: { keys: ['agents'], required: ['agents'] },
  subjects: { keys: ['subjects'], required: ['subjects'] },
});

/** How `template` shows `field` (`optional` when it does not name it). */
export function fieldState(template: MaterialTypeTemplate, field: RecordFieldName): FieldState {
  return Object.hasOwn(template.fields, field) ? (template.fields[field] ?? 'optional') : 'optional';
}

/** The body keys `template` hides. */
function hiddenKeys(template: MaterialTypeTemplate): Set<TemplateKey> {
  const hidden = new Set<TemplateKey>();
  for (const field of RECORD_FIELD_NAMES) if (fieldState(template, field) === 'hidden') for (const key of TEMPLATE_FIELD_KEYS[field].keys) hidden.add(key);
  return hidden;
}

/** The custom fields `template` shows, live ones only, in their order (`sortOrder`, then code). */
export function shownCustomFields(template: MaterialTypeTemplate, defs: readonly CustomFieldView[]): CustomFieldView[] {
  const codes = new Set(template.customFields);
  return defs
    .filter((d) => d.entity === 'records' && !d.archived && codes.has(d.code))
    .sort((a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

// ---- making the values -------------------------------------------------------------------------------------------

/** One empty ISBN row: the editor's ISBN field (the scanner fills it, §6.3). */
export const EMPTY_ISBN: Readonly<IdentifierRow> = Object.freeze({ type: 'isbn', value: '', qualifier: '' });

/** Every value empty, for `materialType` (its RDA defaults, its template's default language). */
export function emptyFormValues(materialType: MaterialTypeView | undefined): RecordFormValues {
  return {
    materialTypeId: materialType?.id ?? '',
    title: '',
    subtitle: '',
    responsibility: '',
    edition: '',
    materialDetail: '',
    publisher: null,
    publicationPlace: '',
    publicationYear: '',
    publicationDateText: '',
    physicalDesc: '',
    series: '',
    classification: '',
    callNumber: '',
    languageId: materialType?.template.defaults.languageId ?? '',
    contentType: materialType?.contentType ?? '',
    mediaType: materialType?.mediaType ?? '',
    carrierType: materialType?.carrierType ?? '',
    summary: '',
    notes: '',
    opacVisible: true,
    promoted: false,
    identifiers: [{ ...EMPTY_ISBN }],
    agents: [],
    subjects: [],
    relations: [],
    customValues: [],
    source: null,
    marcExtra: [],
    links: [],
  };
}

/** A stored custom value as the form holds it (a list stays a list; a number or a boolean becomes its text). */
export function customFormValue(value: unknown): CustomFormValue {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** The empty value of a custom field of `def`'s type. */
export function emptyCustomValue(def: CustomFieldView): CustomFormValue {
  return def.type === 'multiselect' ? [] : '';
}

/**
 * `values` with a row for each custom field `template` shows (empty when there is none yet), so that every shown
 * field has its place in the form from the start (a field the server names lands on it).
 */
export function withCustomRows(values: RecordFormValues, template: MaterialTypeTemplate, defs: readonly CustomFieldView[]): RecordFormValues {
  const have = new Set(values.customValues.map((r) => r.code));
  const missing = shownCustomFields(template, defs).filter((d) => !have.has(d.code));
  if (missing.length === 0) return values;
  return { ...values, customValues: [...values.customValues, ...missing.map((d) => ({ code: d.code, value: emptyCustomValue(d) }))] };
}

const keyOf = (s: string): string => normalizeKey(s);

/**
 * A copied draft (SRU, ISBN lookup) as form values: the material type and the language by code (an unknown type
 * becomes the default one, an unknown language none), the RDA codes of the draft or else the type's, the new
 * authorities as references by name, the identifiers, `marcExtra`, the links, and `source`. Items stay with the
 * dialog ("tambah eksemplar sekarang" opens the items tab after the save).
 */
export function draftToFormValues(draft: RecordDraft, masters: DraftMasters, source?: string): RecordFormValues {
  const code = draft.materialTypeCode;
  const byCode = code === null ? undefined : masters.materialTypes.find((t) => !t.archived && keyOf(t.code) === keyOf(code));
  const type =
    byCode ?? masters.materialTypes.find((t) => !t.archived && t.id === masters.defaultMaterialTypeId) ?? masters.materialTypes.find((t) => !t.archived);
  const language = draft.languageCode === undefined ? undefined : masters.languages.find((l) => !l.archived && keyOf(l.code) === keyOf(draft.languageCode as string));
  const base = emptyFormValues(type);
  const identifiers = draft.identifiers.map((i) => ({ type: i.type, value: i.value, qualifier: i.qualifier ?? '' }));
  return {
    ...base,
    title: draft.title,
    subtitle: draft.subtitle ?? '',
    responsibility: draft.responsibility ?? '',
    edition: draft.edition ?? '',
    materialDetail: draft.materialDetail ?? '',
    publisher: draft.publisher === null ? null : { id: null, name: draft.publisher.name, place: draft.publisher.place ?? '' },
    publicationPlace: draft.publicationPlace ?? '',
    publicationYear: draft.publicationYear ?? '',
    publicationDateText: draft.publicationDateText ?? '',
    physicalDesc: draft.physicalDesc ?? '',
    series: draft.series ?? '',
    classification: draft.classification ?? '',
    callNumber: draft.callNumber ?? '',
    languageId: language?.id ?? (draft.languageCode === undefined ? base.languageId : ''),
    contentType: draft.contentType ?? base.contentType,
    mediaType: draft.mediaType ?? base.mediaType,
    carrierType: draft.carrierType ?? base.carrierType,
    summary: draft.summary ?? '',
    notes: draft.notes ?? '',
    identifiers: identifiers.length === 0 ? [{ ...EMPTY_ISBN }] : identifiers,
    agents: draft.agents.map((a) => ({
      ref: { id: null, type: a.type, name: a.name, dates: a.dates ?? '', authoritySource: a.authoritySource ?? '' },
      role: a.role,
      isMain: a.isMain,
    })),
    subjects: draft.subjects.map((s) => ({
      ref: { id: null, type: s.type, term: s.term, classification: s.classification ?? '', authoritySource: s.authoritySource ?? '' },
      isPrimary: s.isPrimary,
    })),
    customValues: Object.entries(draft.custom ?? {}).map(([c, value]) => ({ code: c, value: customFormValue(value) })),
    source: source ?? null,
    marcExtra: [...draft.marcExtra],
    links: [...draft.links],
  };
}

/** A stored record as form values (the relations this record stores; the identifiers, or one empty ISBN row). */
export function detailToFormValues(d: RecordDetail): RecordFormValues {
  const identifiers = d.identifiers.map((i) => ({ type: i.type, value: i.value, qualifier: i.qualifier ?? '' }));
  return {
    materialTypeId: d.materialTypeId,
    title: d.title,
    subtitle: d.subtitle ?? '',
    responsibility: d.responsibility ?? '',
    edition: d.edition ?? '',
    materialDetail: d.materialDetail ?? '',
    publisher: d.publisher === null ? null : { id: d.publisher.id, name: d.publisher.name, place: d.publisher.place ?? '' },
    publicationPlace: d.publicationPlace ?? '',
    publicationYear: d.publicationYear ?? '',
    publicationDateText: d.publicationDateText ?? '',
    physicalDesc: d.physicalDesc ?? '',
    series: d.series ?? '',
    classification: d.classification ?? '',
    callNumber: d.callNumber ?? '',
    languageId: d.languageId ?? '',
    contentType: d.contentType ?? '',
    mediaType: d.mediaType ?? '',
    carrierType: d.carrierType ?? '',
    summary: d.summary ?? '',
    notes: d.notes ?? '',
    opacVisible: d.opacVisible,
    promoted: d.promoted,
    identifiers: identifiers.length === 0 ? [{ ...EMPTY_ISBN }] : identifiers,
    agents: d.agents.map((a) => ({
      ref: { id: a.id, type: a.type, name: a.name, dates: a.dates ?? '', authoritySource: a.authoritySource ?? '' },
      role: a.role,
      isMain: a.isMain,
    })),
    subjects: d.subjects.map((s) => ({
      ref: { id: s.id, type: s.type, term: s.term, classification: s.classification ?? '', authoritySource: s.authoritySource ?? '' },
      isPrimary: s.isPrimary,
    })),
    relations: d.relations.filter((r) => r.direction === 'out').map((r) => ({ relatedId: r.recordId, type: r.type, title: r.title })),
    customValues: Object.entries(d.custom).map(([code, value]) => ({ code, value: customFormValue(value) })),
    source: d.source,
    marcExtra: d.marcExtra,
    links: [],
  };
}

// ---- making the bodies -------------------------------------------------------------------------------------------

/** A single-line text: trimmed, null when empty. */
const line = (s: string): string | null => {
  const t = s.trim();
  return t === '' ? null : t;
};

/** A free text (summary, notes): kept as written, null when blank. */
const free = (s: string): string | null => (s.trim() === '' ? null : s);

/** An identifier row is sent when it holds a value. */
const filled = (row: IdentifierRow): boolean => row.value.trim() !== '';

export function agentRef(a: AgentChoice): AgentRefInput {
  if (a.id !== null) return { id: a.id };
  const ref: AgentRefInput = { type: a.type, name: a.name.trim() };
  const dates = line(a.dates);
  const authoritySource = line(a.authoritySource);
  if (dates !== null) ref.dates = dates;
  if (authoritySource !== null) ref.authoritySource = authoritySource;
  return ref;
}

export function subjectRef(s: SubjectChoice): SubjectRefInput {
  if (s.id !== null) return { id: s.id };
  const ref: SubjectRefInput = { type: s.type, term: s.term.trim() };
  const classification = line(s.classification);
  const authoritySource = line(s.authoritySource);
  if (classification !== null) ref.classification = classification;
  if (authoritySource !== null) ref.authoritySource = authoritySource;
  return ref;
}

export function publisherRef(p: PublisherChoice): PublisherRefInput {
  if (p.id !== null) return { id: p.id };
  const ref: PublisherRefInput = { name: p.name.trim() };
  const place = line(p.place);
  if (place !== null) ref.place = place;
  return ref;
}

/** The identifier rows that are sent, as the body holds them. */
function identifierInputs(rows: readonly IdentifierRow[]): NonNullable<RecordCreateBody['identifiers']> {
  return rows.filter(filled).map((r) => {
    const qualifier = line(r.qualifier);
    return qualifier === null ? { type: r.type, value: r.value.trim() } : { type: r.type, value: r.value.trim(), qualifier };
  });
}

/** Every key a body may carry, from the values: texts null when empty, lists as sent (empty rows left out). */
interface BodyFields {
  materialTypeId: string;
  title: string;
  subtitle: string | null;
  responsibility: string | null;
  edition: string | null;
  materialDetail: string | null;
  publisher: PublisherRefInput | null;
  publicationPlace: string | null;
  publicationYear: string | null;
  publicationDateText: string | null;
  physicalDesc: string | null;
  series: string | null;
  classification: string | null;
  callNumber: string | null;
  languageId: string | null;
  contentType: string | null;
  mediaType: string | null;
  carrierType: string | null;
  summary: string | null;
  notes: string | null;
  identifiers: NonNullable<RecordCreateBody['identifiers']>;
  agents: NonNullable<RecordCreateBody['agents']>;
  subjects: NonNullable<RecordCreateBody['subjects']>;
  relations: NonNullable<RecordCreateBody['relations']>;
  opacVisible: boolean;
  promoted: boolean;
}

/** The keys of {@link BodyFields} the template governs, then the others a patch compares. */
const TEMPLATE_KEYS: readonly TemplateKey[] = [
  'subtitle',
  'responsibility',
  'edition',
  'materialDetail',
  'publisher',
  'publicationPlace',
  'publicationYear',
  'publicationDateText',
  'physicalDesc',
  'series',
  'classification',
  'callNumber',
  'languageId',
  'contentType',
  'mediaType',
  'carrierType',
  'summary',
  'notes',
  'identifiers',
  'agents',
  'subjects',
];

function bodyFields(v: RecordFormValues): BodyFields {
  return {
    materialTypeId: v.materialTypeId,
    title: v.title.trim(),
    subtitle: line(v.subtitle),
    responsibility: line(v.responsibility),
    edition: line(v.edition),
    materialDetail: line(v.materialDetail),
    publisher: v.publisher === null ? null : publisherRef(v.publisher),
    publicationPlace: line(v.publicationPlace),
    publicationYear: line(v.publicationYear),
    publicationDateText: line(v.publicationDateText),
    physicalDesc: line(v.physicalDesc),
    series: line(v.series),
    classification: line(v.classification),
    callNumber: line(v.callNumber),
    languageId: v.languageId === '' ? null : v.languageId,
    contentType: v.contentType === '' ? null : v.contentType,
    mediaType: v.mediaType === '' ? null : v.mediaType,
    carrierType: v.carrierType === '' ? null : v.carrierType,
    summary: free(v.summary),
    notes: free(v.notes),
    identifiers: identifierInputs(v.identifiers),
    agents: v.agents.map((a) => ({ ref: agentRef(a.ref), role: a.role, isMain: a.isMain })),
    subjects: v.subjects.map((s) => ({ ref: subjectRef(s.ref), isPrimary: s.isPrimary })),
    relations: v.relations.map((r) => ({ relatedId: r.relatedId, type: r.type })),
    opacVisible: v.opacVisible,
    promoted: v.promoted,
  };
}

/** Whether a body value counts as given (the server's `hasTemplateValue`). */
const present = (value: unknown): boolean => value !== null && value !== undefined && (!Array.isArray(value) || value.length > 0);

/** A custom value as a body sends it (null: none), by the field's type (the item forms use it too). */
export function customBodyValue(def: CustomFieldView, value: CustomFormValue | undefined): unknown {
  if (Array.isArray(value)) return def.type === 'multiselect' && value.length > 0 ? [...value] : null;
  const text = value ?? '';
  if (text.trim() === '') return null;
  switch (def.type) {
    case 'longtext':
      return text;
    case 'number': {
      const n = Number(text.trim());
      // Not a number (a copied text): sent as it is, so the server names the field.
      return Number.isFinite(n) ? n : text.trim();
    }
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : null;
    case 'multiselect':
      return [text];
    default:
      return text.trim();
  }
}

/** The custom values of the shown fields, by code (null: none). */
function customBodyValues(rows: readonly CustomRow[], ctx: BodyContext): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const def of shownCustomFields(ctx.template, ctx.customFields)) out.set(def.code, customBodyValue(def, rows.find((r) => r.code === def.code)?.value));
  return out;
}

/** The record's `RecordCreateBody`: the values given, minus the fields the template hides. */
export function formToCreateBody(v: RecordFormValues, ctx: BodyContext): RecordCreateBody {
  const f = bodyFields(v);
  const hidden = hiddenKeys(ctx.template);
  const body: Record<string, unknown> = { materialTypeId: f.materialTypeId, title: f.title };
  for (const key of TEMPLATE_KEYS) if (!hidden.has(key) && present(f[key])) body[key] = f[key];
  if (f.relations.length > 0) body['relations'] = f.relations;
  body['opacVisible'] = f.opacVisible;
  body['promoted'] = f.promoted;
  const custom: Record<string, unknown> = {};
  for (const [code, value] of customBodyValues(v.customValues, ctx)) if (value !== null) custom[code] = value;
  if (Object.keys(custom).length > 0) body['custom'] = custom;
  if (v.source !== null && v.source !== 'manual') body['source'] = v.source;
  if (v.marcExtra.length > 0) body['marcExtra'] = v.marcExtra;
  if (v.links.length > 0) body['links'] = v.links;
  return body as RecordCreateBody;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The `RecordPatchBody` from `before` (the record as loaded) to `v`: `version` and only the keys that changed (an
 * emptied text or list is `null`/`[]`, a custom value cleared is `null`); never a key the template hides.
 */
export function formToPatchBody(v: RecordFormValues, before: RecordFormValues, version: number, ctx: BodyContext): RecordPatchBody {
  const after = bodyFields(v);
  const prev = bodyFields(before);
  const hidden = hiddenKeys(ctx.template);
  const body: Record<string, unknown> = { version };
  if (after.materialTypeId !== prev.materialTypeId) body['materialTypeId'] = after.materialTypeId;
  if (after.title !== prev.title) body['title'] = after.title;
  for (const key of TEMPLATE_KEYS) if (!hidden.has(key) && !same(after[key], prev[key])) body[key] = after[key];
  for (const key of ['relations', 'opacVisible', 'promoted'] as const) if (!same(after[key], prev[key])) body[key] = after[key];
  const now = customBodyValues(v.customValues, ctx);
  const was = customBodyValues(before.customValues, ctx);
  const custom: Record<string, unknown> = {};
  for (const [code, value] of now) if (!same(value, was.get(code))) custom[code] = value;
  if (Object.keys(custom).length > 0) body['custom'] = custom;
  return body as RecordPatchBody;
}

/** A field error: the `.`-joined path and the check (D10). */
export interface FormFieldError {
  path: string;
  code: string;
}

/**
 * The template's `required` checks on the values as they will be stored (§3.8, the server's own): one `required`
 * per empty key of a required field, in the template's field order. A required custom field the template shows is
 * `custom.<code>`.
 */
export function templateRequiredErrors(v: RecordFormValues, ctx: BodyContext): FormFieldError[] {
  const f = bodyFields(v);
  const errors: FormFieldError[] = [];
  for (const field of RECORD_FIELD_NAMES) {
    if (fieldState(ctx.template, field) !== 'required') continue;
    for (const key of TEMPLATE_FIELD_KEYS[field].required) if (!present(f[key])) errors.push({ path: key, code: 'required' });
  }
  for (const [code, value] of customBodyValues(v.customValues, ctx)) {
    const def = ctx.customFields.find((d) => d.code === code);
    if (def?.required === true && value === null) errors.push({ path: `custom.${code}`, code: 'required' });
  }
  return errors;
}

/**
 * The form field a body's error path names (the server's `{path}`): an identifier by its row (empty rows are not
 * sent), a custom value by its `customValues` row; any other path is the form's own. Null for a custom code the
 * form has no row for.
 */
export function bodyPathToFormPath(path: string, v: RecordFormValues): string | null {
  const identifier = /^identifiers\.(\d+)(\..*)?$/.exec(path);
  if (identifier !== null) {
    const sent = v.identifiers.flatMap((row, i) => (filled(row) ? [i] : []));
    const row = sent[Number(identifier[1])];
    return row === undefined ? 'identifiers' : `identifiers.${row}${identifier[2] ?? ''}`;
  }
  if (path.startsWith('custom.')) {
    const code = path.slice('custom.'.length);
    const row = v.customValues.findIndex((r) => r.code === code);
    return row < 0 ? null : `customValues.${row}.value`;
  }
  return path;
}
