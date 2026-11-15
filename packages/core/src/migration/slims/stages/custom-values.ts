import {
  CUSTOM_TEXT_MAX,
  coerceCustomValues,
  customValuesSchema,
  loadCustomDefs,
  type CustomEntity,
  type CustomFieldDef,
  type CustomFieldType,
} from '../../../catalog/data/custom-fields.js';
import { cleanDate } from '../source/clean-text.js';
import { phpUnserialize } from '../source/php-unserialize.js';
import type { SlimsRow } from '../source/types.js';
import type { SlimsStageContext } from '../stage.js';
import { personalText } from './people-kit.js';
import { cachedForRun, cutChars, fitChars, fitText, intOf, keyOf, oneLine, quietText, scanAll, targetsOf, textOf, type BatchIo, type Ledger } from './stage-b-kit.js';

// The custom values of a SLiMS `item_custom` or `member_custom` row (one `cf_*` column per field, named by
// `mst_custom_field.dbfield`): each cell read as its field's type, then checked against the field definitions (S19): a
// value they refuse is reported and left out, the others are kept. SLiMS 9 table/column names (interoperability facts,
// no SLiMS code).
//
// A real run takes the definitions the run made (the legacy map of `mst_custom_field`: the masters stage's for items,
// the members stage's for members); a dry run, which made none, works them out of the source's `mst_custom_field` rows
// the way those stages make them.
//
// A member's values are personal data: their repairs are counted without their text (`***`) and a refused value is
// reported by its field code only, so the report never holds what a member's field says.

/** SLiMS custom field types → ALTIS (§11.4), as the definitions are made. */
const CUSTOM_TYPES: Readonly<Record<string, CustomFieldType>> = Object.freeze({
  text: 'text',
  longtext: 'longtext',
  numeric: 'number',
  dropdown: 'select',
  checklist: 'multiselect',
  choice: 'select',
  date: 'date',
});

const NAME_MAX = 191;

/** The strings of an unserialized list (a list of pairs, a list, an object of values). */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : typeof value === 'object' && value !== null ? Object.values(value) : [value];
}

/** The SLiMS table whose custom fields `entity` takes (`mst_custom_field.primary_table`). */
const PRIMARY: Readonly<Record<'items' | 'members', string>> = Object.freeze({ items: 'item', members: 'member' });

/**
 * The field definitions of `entity` a dry run uses (it made none): the source's `mst_custom_field` rows of its SLiMS
 * table, typed and with their options as the definitions are made (cached for the run).
 */
function sourceCustomDefs(c: SlimsStageContext, entity: 'items' | 'members'): Promise<CustomFieldDef[]> {
  return cachedForRun(c, `custom:defs:${entity}`, async () => {
    const defs: CustomFieldDef[] = [];
    await scanAll(c, 'mst_custom_field', (row) => {
      if (keyOf(row['primary_table']).toLowerCase() !== PRIMARY[entity]) return;
      const code = keyOf(row['dbfield']);
      if (code === '' || defs.some((d) => d.code === code)) return;
      const slimsType = keyOf(row['type']).toLowerCase();
      let type: CustomFieldType = Object.hasOwn(CUSTOM_TYPES, slimsType) ? CUSTOM_TYPES[slimsType]! : 'text';
      const options: CustomFieldDef['options'] = [];
      if (type === 'select' || type === 'multiselect') {
        const parsed = phpUnserialize(quietText(row['data']));
        const pairs: [string, string][] = [];
        if (parsed.ok) {
          for (const item of listOf(parsed.value)) {
            if (Array.isArray(item) && item[0] !== undefined && item[0] !== null) pairs.push([String(item[0]), String(item[1] ?? item[0])]);
            else if (typeof item === 'string' || typeof item === 'number') pairs.push([String(item), String(item)]);
          }
        } else {
          for (let i = 0; i < parsed.strings.length; i += 2) pairs.push([parsed.strings[i]!, parsed.strings[i + 1] ?? parsed.strings[i]!]);
        }
        for (const [v, label] of pairs) {
          const value = cutChars(oneLine(v), NAME_MAX);
          if (value !== '' && !options.some((o) => o.value === value)) options.push({ value, labelId: cutChars(oneLine(label), NAME_MAX) || value, labelEn: null });
        }
        if (options.length === 0) type = 'text';
      }
      defs.push({
        id: `~${code}`,
        code,
        type,
        labelId: code,
        labelEn: null,
        options,
        required: false,
        sortOrder: Math.max(0, intOf(row['field_id']) ?? 0),
        isPublic: false,
        isSearchable: false,
        archived: false,
      });
    });
    return defs;
  });
}

/** The field definitions of `entity` and, per `cf_*` column of the custom table, the one that takes it. */
export async function slimsCustomDefs(
  c: SlimsStageContext,
  io: BatchIo,
  entity: 'items' | 'members',
  columns: readonly string[],
): Promise<{ defs: CustomFieldDef[]; byColumn: Map<string, CustomFieldDef> }> {
  const byColumn = new Map<string, CustomFieldDef>();
  if (io.trx !== null) {
    const mapped = await targetsOf(c, io.db, 'mst_custom_field', columns);
    const defs = await loadCustomDefs(io.db, entity satisfies CustomEntity);
    const byId = new Map(defs.map((d) => [d.id, d]));
    for (const column of columns) {
      const def = byId.get(mapped.get(column) ?? '');
      if (def !== undefined) byColumn.set(column, def);
    }
    return { defs, byColumn };
  }
  const defs = await sourceCustomDefs(c, entity);
  for (const column of columns) {
    const def = defs.find((d) => d.code === column);
    if (def !== undefined) byColumn.set(column, def);
  }
  return { defs, byColumn };
}

/** Multi-line text: C0 controls but tab, line feed and carriage return removed, DEL too; trimmed. */
function multiLine(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) continue;
    out += ch;
  }
  return out.trim();
}

/** A list as coerceCustomValues reads a multiselect: joined with `|`, a literal `|` as `\|`. */
function pipes(list: readonly string[]): string {
  return list.map((s) => s.replace(/\|/g, '\\|')).join('|');
}

/**
 * The custom values of one row `key` of the custom table `table`, checked against `defs` (S19); refused values reported
 * and left out. With `o.personal` (a member's) no value text reaches the report or the samples.
 */
export function slimsCustomValues(
  log: Ledger,
  table: string,
  key: string,
  row: SlimsRow,
  defs: readonly CustomFieldDef[],
  byColumn: ReadonlyMap<string, CustomFieldDef>,
  o: { personal?: boolean } = {},
): Record<string, unknown> {
  const personal = o.personal === true;
  const shown = (s: string): string => (personal ? '***' : s);
  const refused = (code: string, given: string): string => (personal ? code : `${code}=${cutChars(given, 60)}`);
  const raw: [string, string][] = [];
  for (const [column, def] of byColumn) {
    const cell = personal ? personalText(log, table, column, row[column]) : textOf(log, table, column, row[column]);
    if (cell === null) continue;
    let s = def.type === 'longtext' ? multiLine(cell) : oneLine(cell);
    if (s === '') continue;
    if (def.type === 'multiselect') {
      const parsed = phpUnserialize(s);
      const list = parsed.ok ? listOf(parsed.value).filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : parsed.strings;
      if (!parsed.ok) {
        log.fixed(`${table}.${column}`, ['php'], shown(s), shown(JSON.stringify(list)));
        log.report(table, key, 'php_broken', `${column}: ${list.length} teks terbaca / strings recovered`);
      }
      s = pipes(list.map((x) => oneLine(x)).filter((x) => x !== ''));
    } else if (def.type === 'date') {
      const date = cleanDate(s);
      if (date === null) {
        log.fixed(`${table}.${column}`, ['date'], shown(s), '');
        log.report(table, key, 'date_invalid', personal ? column : `${column}=${cutChars(s, 40)}`);
        continue;
      }
      s = date.slice(0, 10);
    } else if (def.type === 'text') {
      s = fitChars(log, table, key, column, s, CUSTOM_TEXT_MAX) ?? '';
    } else if (def.type === 'longtext') {
      s = fitText(log, table, key, column, s) ?? '';
    }
    if (s !== '') raw.push([def.code, s]);
  }
  const given = Object.fromEntries(raw);
  const coerced = coerceCustomValues(defs, given);
  for (const e of coerced.errors) {
    const code = e.path.replace(/^custom\./, '');
    log.report(table, key, 'custom_value_invalid', refused(code, given[code] ?? ''));
  }
  // The definitions' schema (S19): a value it refuses is reported and left out; the others are kept.
  const schema = customValuesSchema(defs, 'patch');
  let values: Record<string, unknown> = coerced.values;
  for (let round = 0; round < 8 && Object.keys(values).length > 0; round += 1) {
    const parsed = schema.safeParse(values);
    if (parsed.success) return parsed.data;
    const bad = new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? '')));
    if (bad.has('')) return {};
    for (const code of bad) {
      log.report(table, key, 'custom_value_invalid', refused(code, given[code] ?? ''));
      values = Object.fromEntries(Object.entries(values).filter(([k]) => k !== code));
    }
  }
  return values;
}
