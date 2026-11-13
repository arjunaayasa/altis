import type { DB } from '@altis/db';
import { MESSAGES, isCalendarDate, t, type Locale, type MessageKey } from '@altis/shared';
import type { ReportParamSpec } from '@altis/shared/api/reports';
import type { Kysely } from 'kysely';
import type { ReportCtx, ReportDefinition } from '../types.js';

// The filters of a run in words (spec §4.15: the PDF header names them): one "Label: value" line per parameter that is
// set, in the order the definition lists them, in the run's language. Ids are written as the names of what they point
// to (branch, location, collection type, material type, language, accreditation period; an id that names nothing any
// more is written as it is), dates as words ("2 Januari 2026"), the options of a `status` parameter by their labels.
// A `bool` parameter that is true is its label alone; false, like an absent or empty value, is not a filter. Only the
// definition's own values (the stored `def`) are described: the paper of a PDF is no filter.

/** The locale tag of a run's language for numbers and dates. */
export function localeTag(locale: Locale): string {
  return locale === 'id' ? 'id-ID' : 'en-GB';
}

/** A calendar date `YYYY-MM-DD` in words in `locale` ("2 Januari 2026", "2 January 2026"); other text as it is. */
export function dateInWords(locale: Locale, date: string): string {
  if (typeof date !== 'string' || !isCalendarDate(date)) return String(date);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at = new Date(0);
  at.setUTCFullYear(y, m - 1, d);
  return new Intl.DateTimeFormat(localeTag(locale), { dateStyle: 'long', timeZone: 'UTC' }).format(at);
}

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** The text of `key` in `locale`, or null when the catalog has no such message. */
function messageOr(locale: Locale, key: string): string | null {
  return hasOwn(MESSAGES[locale], key) || hasOwn(MESSAGES.id, key) ? t(locale, key as MessageKey) : null;
}

type NamedKind = 'branch' | 'location' | 'collectionType' | 'materialType' | 'language' | 'period';

/** The name of the row `id` of a parameter of kind `kind`, in `locale`; null when there is no such row. */
async function nameOf(db: Kysely<DB>, kind: NamedKind, id: string, locale: Locale): Promise<string | null> {
  switch (kind) {
    case 'branch':
      return (await db.selectFrom('branches').select('name').where('id', '=', id).executeTakeFirst())?.name ?? null;
    case 'location':
      return (await db.selectFrom('locations').select('name').where('id', '=', id).executeTakeFirst())?.name ?? null;
    case 'period':
      return (await db.selectFrom('accred_periods').select('name').where('id', '=', id).executeTakeFirst())?.name ?? null;
    case 'collectionType':
    case 'materialType':
    case 'language': {
      const table = kind === 'collectionType' ? 'collection_types' : kind === 'materialType' ? 'material_types' : 'languages';
      const row = await db.selectFrom(table).select(['name_id', 'name_en']).where('id', '=', id).executeTakeFirst();
      return row === undefined ? null : locale === 'id' ? row.name_id : row.name_en;
    }
  }
}

const NAMED_KINDS: ReadonlySet<string> = new Set<NamedKind>(['branch', 'location', 'collectionType', 'materialType', 'language', 'period']);

/** The values of a parameter: an array's items, else the value itself; absent, null and empty strings left out. */
function valuesOf(value: unknown): unknown[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => v !== undefined && v !== null && v !== '');
}

/** A value as text (an object as its JSON). */
function plain(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/** The words of one value of `spec`, or null when it says nothing (a false flag, an empty range). */
async function valueText(spec: ReportParamSpec, value: unknown, ctx: Pick<ReportCtx, 'db' | 'locale'>): Promise<string | null> {
  const { locale } = ctx;
  switch (spec.kind) {
    case 'dateRange': {
      if (typeof value !== 'object' || value === null) return plain(value);
      const { from, to } = value as { from?: unknown; to?: unknown };
      const a = typeof from === 'string' && from !== '' ? dateInWords(locale, from) : null;
      const b = typeof to === 'string' && to !== '' ? dateInWords(locale, to) : null;
      if (a === null && b === null) return null;
      return a !== null && b !== null ? `${a} – ${b}` : a !== null ? `${a} –` : `– ${b}`;
    }
    case 'asOf':
      return typeof value === 'string' ? dateInWords(locale, value) : plain(value);
    case 'status': {
      const option = plain(value);
      const key = spec.optionLabelPrefix === undefined ? `report.option.${spec.name}.${option}` : `${spec.optionLabelPrefix}${option}`;
      return messageOr(locale, key) ?? option;
    }
    default:
      if (NAMED_KINDS.has(spec.kind) && typeof value === 'string') return (await nameOf(ctx.db, spec.kind as NamedKind, value, locale)) ?? value;
      return plain(value);
  }
}

/**
 * The run's filters in words: one "Label: value" line per parameter of `def` that `params` (the stored `def`) sets,
 * in the language of `ctx` (see the top of this file).
 */
export async function describeParams(def: ReportDefinition, params: Record<string, unknown>, ctx: Pick<ReportCtx, 'db' | 'locale'>): Promise<string[]> {
  const lines: string[] = [];
  for (const spec of def.params) {
    if (!hasOwn(params, spec.name)) continue;
    const value = params[spec.name];
    const label = t(ctx.locale, spec.labelKey as MessageKey);
    if (spec.kind === 'bool') {
      if (value === true) lines.push(label);
      continue;
    }
    const texts: string[] = [];
    for (const v of valuesOf(value)) {
      const text = await valueText(spec, v, ctx);
      if (text !== null) texts.push(text);
    }
    if (texts.length > 0) lines.push(`${label}: ${texts.join(', ')}`);
  }
  return lines;
}
