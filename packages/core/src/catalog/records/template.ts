import { RECORD_FIELD_NAMES, type FieldState, type RecordFieldName } from '@altis/shared';
import { EMPTY_TEMPLATE, MaterialTypeTemplate } from '@altis/shared/api/catalog/masters';
import type { FieldWarning } from '@altis/shared/api/catalog/common';

// The material type's template (Phase 2 spec §3.8), enforced by the server as well as the form (§3.1): a field the
// template marks `required` must hold a value, one it marks `hidden` must not be given one. `title` is always
// required (the body schema's), and a field the template does not name is `optional`.
//
// - The template names fields (`RecordFieldName`); the bodies name their keys. Each field stands for one or more body
//   keys (TEMPLATE_KEYS): `publication_year` for the year and the date as written, `rda` for the three RDA codes. A
//   required field needs its `required` keys; a hidden one refuses a value in any of its keys.
// - Error paths are the body keys (`subtitle`, `materialDetail`, `contentType`), so the editor maps them onto its
//   fields; the errors come in the template's fixed field order.
// - A create is checked as a whole. A patch: `required` against the record as it will be (stored values plus the
//   patch), `hidden` against the values the patch sends only, so that hiding a field later never blocks editing
//   the other fields of an older record.

/** The body keys a template governs. */
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

/** For each field: the body keys it stands for, and those a `required` field needs a value in. */
const TEMPLATE_KEYS: Readonly<Record<RecordFieldName, { keys: readonly TemplateKey[]; required: readonly TemplateKey[] }>> = Object.freeze({
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

/** Which keys hold a value (a non-blank text, an object, a non-empty list). */
export type TemplatePresence = Partial<Record<TemplateKey, boolean>>;

/** Whether `v` is a value for the template: not undefined or null, not a blank text, not an empty list. */
export function hasTemplateValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** The presence of every template key in `source` (a body or a patch). */
export function presenceOf(source: Partial<Record<TemplateKey, unknown>>): TemplatePresence {
  const out: TemplatePresence = {};
  for (const { keys } of Object.values(TEMPLATE_KEYS)) for (const key of keys) out[key] = hasTemplateValue(source[key]);
  return out;
}

/**
 * The stored template of a material type: `material_types.template` parsed with the strict §3.8 schema; the empty
 * template (every field optional, no custom field shown) when it cannot be read.
 */
export function parseTemplate(json: string | null): MaterialTypeTemplate {
  if (json === null) return EMPTY_TEMPLATE;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return EMPTY_TEMPLATE;
  }
  const parsed = MaterialTypeTemplate.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_TEMPLATE;
}

/** The state of `field` in `template` (`optional` when it does not name it). */
function stateOf(template: MaterialTypeTemplate, field: RecordFieldName): FieldState {
  return Object.hasOwn(template.fields, field) ? (template.fields[field] ?? 'optional') : 'optional';
}

/**
 * The template's field errors, in its field order: `{path: <key>, code: 'required'}` for each required key without
 * a value in `result` (the record as it will be stored), `{path: <key>, code: 'hidden'}` for each key of a hidden
 * field that `sent` gives a value.
 */
export function templateErrors(template: MaterialTypeTemplate, result: TemplatePresence, sent: TemplatePresence): FieldWarning[] {
  const errors: FieldWarning[] = [];
  for (const field of RECORD_FIELD_NAMES) {
    const state = stateOf(template, field);
    const spec = TEMPLATE_KEYS[field];
    if (state === 'required') {
      for (const key of spec.required) if (result[key] !== true) errors.push({ path: key, code: 'required' });
    } else if (state === 'hidden') {
      for (const key of spec.keys) if (sent[key] === true) errors.push({ path: key, code: 'hidden' });
    }
  }
  return errors;
}
