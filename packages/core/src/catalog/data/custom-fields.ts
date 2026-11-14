import { upsert, type DB } from '@altis/db';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

// Custom fields of records and items (Phase 2 spec §3.7, §2.2 "Perubahan tabel Fase 1"): definitions in
// custom_field_defs (entity `records` | `items`), one JSON value per field and entity row in custom_values.
//
// - Bodies carry `custom: {<code>: value}`, validated by a strict Zod object built from the live definitions
//   (customValuesSchema). `code` is the definition's `code_display`, as the admin defined it.
// - A value is stored as its JSON text, which MySQL keeps in a TEXT column of 65 535 bytes: every value is capped on the
//   byte length of its JSON encoding as well (S19), since quotes, backslashes, newlines and control characters grow
//   when encoded.
// - CSV and SLiMS supply strings: coerceCustomValues turns them into the schema's types first (S19).
// - An archived definition's values stay stored but are never read back (readCustomValues) nor accepted (the schema).

const CUSTOM_VALUE_TYPES = Object.freeze(['text', 'longtext', 'number', 'date', 'select', 'multiselect', 'boolean', 'url'] as const);

/** The entities that have custom fields in Phase 2. */
export type CustomEntity = 'records' | 'items' | 'members';

/** The value types of a custom field. */
export type CustomFieldType = (typeof CUSTOM_VALUE_TYPES)[number];

/** One custom field definition, as the catalog uses it. */
export interface CustomFieldDef {
  id: string;
  /** The code values are keyed by (`code_display`). */
  code: string;
  type: CustomFieldType;
  labelId: string;
  labelEn: string | null;
  /** The options of a `select` or `multiselect` field. */
  options: { value: string; labelId: string; labelEn: string | null }[];
  required: boolean;
  sortOrder: number;
  /** Shown on the OPAC. */
  isPublic: boolean;
  /** Its text goes into the search text (public fields only in Phase 2, S20). */
  isSearchable: boolean;
  archived: boolean;
}

/** A text value: at most this many characters. */
export const CUSTOM_TEXT_MAX = 1000;
/** A long text value, and the JSON text of any value: at most this many UTF-8 bytes (MySQL TEXT is 65 535). */
export const CUSTOM_VALUE_MAX_BYTES = 60_000;
/** A URL value: at most this many characters. */
export const CUSTOM_URL_MAX = 2000;

const ID_BATCH = 500;

type Db = Kysely<DB> | Transaction<DB>;

function isCustomEntity(entity: unknown): entity is CustomEntity {
  // Komunitas K2: members have custom fields too (never public, never searchable: the masters API refuses both).
  return entity === 'records' || entity === 'items' || entity === 'members';
}

function isCustomFieldType(type: string): type is CustomFieldType {
  return (CUSTOM_VALUE_TYPES as readonly string[]).includes(type);
}

/** The stored options JSON (`[{value, label_id, label_en}]`, §3.7); [] when it is absent or unreadable. */
const storedOptions = z.array(
  z.looseObject({ value: z.string(), label_id: z.string().nullish(), label_en: z.string().nullish() }),
);

function parseOptions(json: string | null): CustomFieldDef['options'] {
  if (json === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const parsed = storedOptions.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.map((o) => ({ value: o.value, labelId: o.label_id ?? o.value, labelEn: o.label_en ?? null }));
}

/**
 * The custom field definitions of `entity`, ordered by `sort_order` then code: the live ones, or every one with
 * `o.includeArchived`. A definition of a type Phase 2 does not know is left out.
 */
export async function loadCustomDefs(db: Db, entity: CustomEntity, o: { includeArchived?: boolean } = {}): Promise<CustomFieldDef[]> {
  if (!isCustomEntity(entity)) throw new TypeError(`loadCustomDefs(): unknown entity ${JSON.stringify(entity)}`);
  let q = db
    .selectFrom('custom_field_defs')
    .select(['id', 'code_display', 'type', 'label', 'label_en', 'options', 'is_required', 'sort_order', 'is_public', 'is_searchable', 'archived_at'])
    .where('entity', '=', entity);
  if (o.includeArchived !== true) q = q.where('archived_at', 'is', null);
  const rows = await q.orderBy('sort_order').orderBy('code_key').execute();
  const defs: CustomFieldDef[] = [];
  for (const r of rows) {
    if (!isCustomFieldType(r.type)) continue;
    defs.push({
      id: r.id,
      code: r.code_display,
      type: r.type,
      labelId: r.label,
      labelEn: r.label_en,
      options: parseOptions(r.options),
      required: r.is_required === 1,
      sortOrder: r.sort_order,
      isPublic: r.is_public === 1,
      isSearchable: r.is_searchable === 1,
      archived: r.archived_at !== null,
    });
  }
  return defs;
}

/** The UTF-8 bytes of the JSON text a value is stored as. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/** A `too_big` issue (Zod's own shape) when `value`'s UTF-8 or JSON bytes pass {@link CUSTOM_VALUE_MAX_BYTES}. */
function capBytes(origin: 'string' | 'array') {
  return (ctx: { value: unknown; issues: unknown[] }) => {
    const text = typeof ctx.value === 'string' ? Buffer.byteLength(ctx.value, 'utf8') : 0;
    if (Math.max(text, jsonBytes(ctx.value)) > CUSTOM_VALUE_MAX_BYTES) {
      ctx.issues.push({ code: 'too_big', origin, maximum: CUSTOM_VALUE_MAX_BYTES, inclusive: true, input: ctx.value });
    }
  };
}

/** A calendar date `YYYY-MM-DD` (the Gregorian calendar, years 0001–9999). */
function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 0;
  return d <= days;
}

/** An `http:`/`https:` URL `new URL()` can parse. */
function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The schema of one value of `def` (never null: see customValuesSchema). */
function valueSchema(def: CustomFieldDef): z.ZodType {
  const options = new Set(def.options.map((o) => o.value));
  switch (def.type) {
    case 'text':
      return z.string().max(CUSTOM_TEXT_MAX).check(capBytes('string'));
    case 'longtext':
      return z.string().check(capBytes('string'));
    case 'number':
      return z.number();
    case 'date':
      return z.string().refine(isCalendarDate, { params: { code: 'invalid_date' } });
    case 'boolean':
      return z.boolean();
    case 'select':
      return z.string().refine((v) => options.has(v), { params: { code: 'invalid_option' } });
    case 'multiselect':
      return z
        .array(z.string())
        .refine((vs) => new Set(vs).size === vs.length && vs.every((v) => options.has(v)), { params: { code: 'invalid_option' } })
        .check(capBytes('array'));
    case 'url':
      return z.string().max(CUSTOM_URL_MAX).refine(isHttpUrl, { params: { code: 'invalid_url' } });
  }
}

/**
 * The strict schema of a body's `custom` object for `defs` (§3.7), keyed by the codes of the live definitions:
 *
 * - `text` ≤ 1000 characters; `longtext` ≤ 60 000 UTF-8 bytes; for both and `multiselect`, the JSON text ≤ 60 000
 *   bytes too (`too_big`, S19);
 * - `number` finite; `date` a calendar date `YYYY-MM-DD`; `boolean`; `select` one option value; `multiselect` distinct
 *   option values; `url` http/https, ≤ 2000;
 * - `null` clears a value; a required code must be present (and not null) in `create`, and cannot be cleared in
 *   `patch`; an unknown or archived code is refused (`unrecognized_keys`).
 *
 * Nested under `custom` in a body, its error paths read `custom.<code>`.
 */
export function customValuesSchema(defs: readonly CustomFieldDef[], mode: 'create' | 'patch'): z.ZodType<Record<string, unknown>> {
  // A code `__proto__` would not be validated by Zod (it builds objects by assignment): such a field is left out, so
  // the strict object refuses its key instead (the masters API refuses the code itself).
  const shape: Record<string, z.ZodType> = Object.fromEntries(
    defs
      .filter((def) => !def.archived && def.code !== '__proto__')
      .map((def) => {
        const value = valueSchema(def);
        if (def.required) return [def.code, mode === 'create' ? value : value.optional()];
        return [def.code, value.nullable().optional()];
      }),
  );
  return z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>;
}

const TRUE_WORDS = new Set(['1', 'true', 'ya']);
const FALSE_WORDS = new Set(['0', 'false', 'tidak']);
const DECIMAL = /^[+-]?\d+(?:[.,]\d+)?$/;

/** `s` split on `|`, where `\|` is a literal pipe; empty parts dropped. */
function splitPipes(s: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (c === '|') {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts.filter((p) => p !== '');
}

/**
 * The strings a CSV row or a SLiMS column supplies, turned into the types of {@link customValuesSchema} (S19):
 * `number` from a decimal with `.` or `,`; `boolean` from `0/1/true/false/ya/tidak` (any case); `date` from
 * `YYYY-MM-DD`; `multiselect` split on `|` (`\|` for a literal pipe); an empty string is `null`. A value that does not
 * convert is left out and reported as `{path: 'custom.<code>', code: 'invalid'}`. A code no live definition has is
 * passed through as it is, for the strict schema to refuse.
 */
export function coerceCustomValues(
  defs: readonly CustomFieldDef[],
  raw: Record<string, string>,
): { values: Record<string, unknown>; errors: { path: string; code: 'invalid' }[] } {
  const byCode = new Map(defs.filter((d) => !d.archived).map((d) => [d.code, d]));
  // Collected as entries, then Object.fromEntries: a CSV header `custom.__proto__` stays a key, never a prototype.
  const entries: [string, unknown][] = [];
  const errors: { path: string; code: 'invalid' }[] = [];
  for (const [code, s] of Object.entries(raw)) {
    const def = byCode.get(code);
    if (def === undefined) {
      entries.push([code, s]);
      continue;
    }
    if (s === '') {
      entries.push([code, null]);
      continue;
    }
    const t = s.trim();
    switch (def.type) {
      case 'number':
        if (DECIMAL.test(t)) entries.push([code, Number(t.replace(',', '.'))]);
        else errors.push({ path: `custom.${code}`, code: 'invalid' });
        break;
      case 'boolean': {
        const word = t.toLowerCase();
        if (TRUE_WORDS.has(word)) entries.push([code, true]);
        else if (FALSE_WORDS.has(word)) entries.push([code, false]);
        else errors.push({ path: `custom.${code}`, code: 'invalid' });
        break;
      }
      case 'date':
        if (isCalendarDate(t)) entries.push([code, t]);
        else errors.push({ path: `custom.${code}`, code: 'invalid' });
        break;
      case 'multiselect':
        entries.push([code, splitPipes(s)]);
        break;
      default:
        entries.push([code, s]);
    }
  }
  return { values: Object.fromEntries(entries), errors };
}

/**
 * Writes the custom values of one row of `entity` (`values` already validated by customValuesSchema): each value is
 * upserted as its JSON text (`updated_at` = `o.now`, `updated_by` = `o.actor`), a `null` deletes the field's row.
 * Codes not in `values` are left as they are. Await it before the next statement on `trx`.
 *
 * @throws TypeError for an unknown entity, a code `defs` does not define, or a value whose JSON text is over 60 000
 *   bytes (nothing of that call is written past the value before it)
 */
export async function writeCustomValues(
  trx: Transaction<DB>,
  entity: CustomEntity,
  entityId: string,
  values: Record<string, unknown>,
  defs: readonly CustomFieldDef[],
  o: { now: number; actor: string | null },
): Promise<void> {
  if (!isCustomEntity(entity)) throw new TypeError(`writeCustomValues(): unknown entity ${JSON.stringify(entity)}`);
  const byCode = new Map(defs.map((d) => [d.code, d]));
  for (const code of Object.keys(values)) {
    if (!byCode.has(code)) throw new TypeError(`writeCustomValues(): ${JSON.stringify(code)} is not a custom field of ${entity}`);
  }
  for (const [code, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const def = byCode.get(code) as CustomFieldDef;
    const key = { field_id: def.id, entity_id: entityId };
    if (value === null) {
      await trx.deleteFrom('custom_values').where('field_id', '=', def.id).where('entity_id', '=', entityId).execute();
      continue;
    }
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json, 'utf8') > CUSTOM_VALUE_MAX_BYTES) {
      throw new TypeError(`writeCustomValues(): the value of ${code} is not JSON of at most ${CUSTOM_VALUE_MAX_BYTES} bytes`);
    }
    const row = { value: json, updated_at: o.now, updated_by: o.actor };
    await upsert(trx, 'custom_values', key, row, row);
  }
}

/**
 * The custom values of the rows `ids` of `entity`, keyed by row id (every id present, `{}` when it has none), each a
 * map from code to value. Values of archived definitions are left out; a value whose JSON cannot be read is skipped.
 */
export async function readCustomValues(db: Db, entity: CustomEntity, ids: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
  if (!isCustomEntity(entity)) throw new TypeError(`readCustomValues(): unknown entity ${JSON.stringify(entity)}`);
  // Entries per row, made into objects at the end (Object.fromEntries: a code `__proto__` stays a key).
  const collected = new Map<string, [string, unknown][]>();
  const unique = [...new Set(ids)];
  for (const id of unique) collected.set(id, []);
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const rows = await db
      .selectFrom('custom_values as v')
      .innerJoin('custom_field_defs as d', 'd.id', 'v.field_id')
      .select(['v.entity_id', 'v.value', 'd.code_display'])
      .where('d.entity', '=', entity)
      .where('d.archived_at', 'is', null)
      .where('v.entity_id', 'in', unique.slice(i, i + ID_BATCH))
      .execute();
    for (const r of rows) {
      let value: unknown;
      try {
        value = JSON.parse(r.value);
      } catch {
        continue;
      }
      collected.get(r.entity_id)?.push([r.code_display, value]);
    }
  }
  return new Map([...collected].map(([id, entries]) => [id, Object.fromEntries(entries)]));
}
