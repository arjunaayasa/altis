import type { PeriodListResponse } from '@altis/shared/api/accreditation';
import type { BranchListResponse } from '@altis/shared/api/branches';
import type { LocationListResponse } from '@altis/shared/api/catalog/locations';
import type { MemberTypeListResponse } from '@altis/shared/api/members';
import type { StocktakeListResponse, StocktakeView } from '@altis/shared/api/stocktake';
import { useQuery } from '@tanstack/react-query';
import type { CollectionTypeView, LanguageView, MasterListResponse, MaterialTypeView } from '@altis/shared/api/catalog/masters';
import type { ReportCatalogEntry, ReportParamKind, ReportParamSpec } from '@altis/shared/api/reports';
import { useCallback, useId, useMemo, type FormEvent } from 'react';
import { CheckField, Field, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { SectionHead } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { fieldErrorKey, isMessageKey } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';

/**
 * The filters of a report's page (spec §4.15, §6.3): one control per parameter of the definition (`ReportParamSpec`),
 * of its kind, in the definition's order:
 *
 * - `dateRange`: two date inputs (from, to) in a group; `asOf`: a date (empty: today, the server's default);
 * - `year`, `int`: a whole number within the parameter's `min`/`max`;
 * - `period`, `branch`, `location`, `collectionType`, `materialType`, `language`: a select from the existing lists
 *   (`GET accreditation/periods` for a holder of `accreditation.workspace.read`, `GET branches`, and the catalogue's
 *   locations and masters for a holder of `catalog.records.read`), and `memberType` from `GET members/types` for a
 *   holder of `members.records.read`; a list the user may not read leaves the filter empty and says so. The locations
 *   follow the branch chosen in the same form;
 * - `status`: a select of its options, or a group of checkboxes when it takes several, labelled
 *   `<optionLabelPrefix><value>` (a vocabulary) or `report.option.<name>.<value>`;
 * - `bool`: a checkbox; `classPrefix`, `text` (and the kinds of later milestones): a text, one value per line when the
 *   parameter takes several.
 *
 * The form holds what was typed ({@link ParamValues}); {@link paramsOf} turns it into the definition's parameters as its
 * schema takes them (only what was filled in, numbers as numbers, the checked statuses in the definition's order) and
 * marks a required parameter left empty, a number out of range or a date range the wrong way round before anything is
 * sent. The server checks everything again; its field errors (`params.<name>`) land on the same fields
 * ({@link serverParamErrors}).
 */

/** The value of a `dateRange` parameter as the form holds it. */
export interface DateRangeValue {
  from: string;
  to: string;
}

/** A parameter's value as the form holds it: text as typed, a checkbox, the checked statuses, a date range. */
export type ParamValue = string | boolean | string[] | DateRangeValue;

export type ParamValues = Readonly<Record<string, ParamValue>>;

/** The message key of each field in error: by parameter name, or `<name>.from`/`<name>.to` for a date range. */
export type ParamErrors = Readonly<Record<string, string>>;

/** A choice of a select. */
export interface Choice {
  value: string;
  label: string;
}

/** The kinds whose control is a select of a list the server keeps. */
const LIST_KINDS = ['period', 'branch', 'location', 'collectionType', 'materialType', 'language', 'memberType', 'stocktake'] as const;

type ListKind = (typeof LIST_KINDS)[number];

const isListKind = (kind: ReportParamKind): kind is ListKind => (LIST_KINDS as readonly string[]).includes(kind);

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The most characters a text parameter takes here (the server's schema is the real bound). */
const TEXT_MAX = 200;

/** The value of `spec` with nothing filled in. */
export function emptyValue(spec: ReportParamSpec): ParamValue {
  if (spec.kind === 'dateRange') return { from: '', to: '' };
  if (spec.kind === 'bool') return false;
  if (spec.kind === 'status' && spec.multiple === true) return [];
  return '';
}

/** Every parameter of `entry` with nothing filled in. */
export function emptyValues(entry: ReportCatalogEntry): Record<string, ParamValue> {
  return Object.fromEntries(entry.params.map((p) => [p.name, emptyValue(p)]));
}

/** `value` as a date range, or empty bounds for anything else. */
function asRange(value: ParamValue | undefined): DateRangeValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { from: '', to: '' };
}

const asText = (value: ParamValue | undefined): string => (typeof value === 'string' ? value : '');

const asList = (value: ParamValue | undefined): string[] => (Array.isArray(value) ? value : []);

/** A whole number written as text (`'12'`), or the number itself, as the form's text. */
function numberText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^-?\d{1,9}$/.test(value)) return value;
  return null;
}

/**
 * The values a page address gives (`?periodId=…&asOf=2025-06-30`, as the router parsed them): each one only when it
 * fits its parameter, so a link can open a report on a period or a date. Anything else in the address is ignored.
 */
export function valuesFromSearch(entry: ReportCatalogEntry, search: Readonly<Record<string, unknown>>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const spec of entry.params) {
    if (!hasOwn(search, spec.name)) continue;
    const raw = search[spec.name];
    switch (spec.kind) {
      case 'dateRange': {
        if (typeof raw !== 'object' || raw === null) break;
        const { from, to } = raw as { from?: unknown; to?: unknown };
        const range = { from: typeof from === 'string' && DATE.test(from) ? from : '', to: typeof to === 'string' && DATE.test(to) ? to : '' };
        if (range.from !== '' || range.to !== '') out[spec.name] = range;
        break;
      }
      case 'bool':
        if (raw === true || raw === 'true') out[spec.name] = true;
        break;
      case 'year':
      case 'int': {
        const text = numberText(raw);
        if (text !== null) out[spec.name] = text;
        break;
      }
      case 'status': {
        const options = spec.options ?? [];
        const wanted = Array.isArray(raw) ? raw : [raw];
        const known = options.filter((o) => wanted.includes(o));
        if (spec.multiple === true) {
          if (known.length > 0) out[spec.name] = known;
        } else if (typeof raw === 'string' && options.includes(raw)) out[spec.name] = raw;
        break;
      }
      case 'asOf':
        if (typeof raw === 'string' && DATE.test(raw)) out[spec.name] = raw;
        break;
      case 'text':
        if (spec.multiple === true && Array.isArray(raw)) out[spec.name] = raw.filter((v): v is string => typeof v === 'string').join('\n');
        else if (typeof raw === 'string' || typeof raw === 'number') out[spec.name] = String(raw);
        break;
      default:
        if (typeof raw === 'string' || typeof raw === 'number') out[spec.name] = String(raw);
    }
  }
  return out;
}

/**
 * The parameters of `entry` from the form's `values`, as the definition's schema takes them: only what was filled in
 * (a date range with the bounds given, a ticked checkbox as `true`, the checked statuses in the definition's order,
 * numbers as numbers, texts trimmed, one value per line when the parameter takes several), and the fields in error.
 */
export function paramsOf(entry: ReportCatalogEntry, values: ParamValues): { params: Record<string, unknown>; errors: Record<string, string> } {
  const params: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const required = (name: string): void => {
    errors[name] = 'form.error.required';
  };
  for (const spec of entry.params) {
    const value = values[spec.name];
    switch (spec.kind) {
      case 'dateRange': {
        const range = asRange(value);
        const from = range.from.trim();
        const to = range.to.trim();
        if (from === '' && to === '') {
          if (spec.required) required(`${spec.name}.from`);
          break;
        }
        if (from !== '' && to !== '' && from > to) errors[`${spec.name}.to`] = 'reports.params.range_order';
        params[spec.name] = { ...(from === '' ? {} : { from }), ...(to === '' ? {} : { to }) };
        break;
      }
      case 'bool':
        if (value === true) params[spec.name] = true;
        break;
      case 'year':
      case 'int': {
        const text = asText(value).trim();
        if (text === '') {
          if (spec.required) required(spec.name);
          break;
        }
        const n = Number(text);
        if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(n)) errors[spec.name] = 'reports.params.whole_number';
        else if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) errors[spec.name] = 'reports.params.out_of_range';
        else params[spec.name] = n;
        break;
      }
      case 'status':
        if (spec.multiple === true) {
          const checked = asList(value);
          const list = (spec.options ?? []).filter((o) => checked.includes(o));
          if (list.length > 0) params[spec.name] = list;
          else if (spec.required) required(spec.name);
          break;
        }
        if (asText(value) !== '') params[spec.name] = asText(value);
        else if (spec.required) required(spec.name);
        break;
      default: {
        if (spec.multiple === true) {
          const lines = asText(value)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l !== '');
          if (lines.length > 0) params[spec.name] = lines;
          else if (spec.required) required(spec.name);
          break;
        }
        const text = asText(value).trim();
        if (text !== '') params[spec.name] = text;
        else if (spec.required) required(spec.name);
      }
    }
  }
  return { params, errors };
}

/**
 * The field errors of the server's VALIDATION_FAILED for `entry`'s parameters (`params.<name>`, `params.<name>.to`,
 * `params.<name>.0`), each on its field; null when the problem names none of them (another problem, or `params`
 * itself: the preview's `export_only`).
 */
export function serverParamErrors(entry: ReportCatalogEntry, e: unknown): Record<string, string> | null {
  if (!(e instanceof ApiError) || e.code !== 'VALIDATION_FAILED') return null;
  const out: Record<string, string> = {};
  for (const { path, code } of e.errors ?? []) {
    const [head, name, sub] = path.split('.');
    if (head !== 'params' || name === undefined) continue;
    const spec = entry.params.find((p) => p.name === name);
    if (spec === undefined) continue;
    let key: string = name;
    let message: string = fieldErrorKey(code);
    if (spec.kind === 'dateRange') {
      key = sub === 'to' ? `${name}.to` : `${name}.from`;
      if (sub === 'to' && code === 'invalid') message = 'reports.params.range_order';
    } else if ((spec.kind === 'year' || spec.kind === 'int') && (code === 'too_small' || code === 'too_big')) {
      message = 'reports.params.out_of_range';
    }
    if (!hasOwn(out, key)) out[key] = message;
  }
  return Object.keys(out).length === 0 ? null : out;
}

// ---- the option lists ----------------------------------------------------------------------------------------------

/** A list of choices: loading, unavailable to this user (or failed), or its choices. */
export type ChoiceList = { state: 'loading' } | { state: 'unavailable' } | { state: 'ready'; choices: readonly Choice[] };

/** A location choice also knows its branch, so the form can list only the chosen branch's. */
interface LocationChoice extends Choice {
  branchId: string;
}

/** The option lists of a definition's select parameters (only the lists it uses are read). */
export interface ParamOptions {
  lists: Readonly<Record<ListKind, ChoiceList>>;
  locations: readonly LocationChoice[] | null;
}

/** A level of the location tree, as the start of a choice's label (no-break spaces). */
const INDENT = '\u00a0\u00a0\u00a0';

const LOADING: ChoiceList = { state: 'loading' };
const UNAVAILABLE: ChoiceList = { state: 'unavailable' };

/**
 * Reads the lists the select parameters of `entry` need, each once and only when the user may read it, and gives them
 * as choices (archived entries say so: a report may ask about the past).
 */
export function useParamOptions(entry: ReportCatalogEntry): ParamOptions {
  const t = useT();
  const me = useMe();
  const locale = useLocale();
  const kinds = new Set(entry.params.map((p) => p.kind));
  const uses = (kind: ListKind): boolean => kinds.has(kind);
  const catalog = holds(me, 'catalog.records.read');
  const accreditation = holds(me, 'accreditation.workspace.read');

  const periods = useApiQuery<PeriodListResponse>({
    queryKey: ['reports', 'options', 'periods'],
    path: 'accreditation/periods',
    enabled: uses('period') && accreditation,
    staleTime: 60_000,
  });
  const branches = useApiQuery<BranchListResponse>({
    queryKey: ['reports', 'options', 'branches'],
    path: 'branches?includeArchived=true',
    enabled: uses('branch'),
    staleTime: 60_000,
  });
  const locations = useApiQuery<LocationListResponse>({
    queryKey: ['reports', 'options', 'locations'],
    path: 'catalog/locations?includeArchived=true',
    enabled: uses('location') && catalog,
    staleTime: 60_000,
  });
  const collectionTypes = useApiQuery<MasterListResponse<CollectionTypeView>>({
    queryKey: ['reports', 'options', 'collection-types'],
    path: 'catalog/collection-types?includeArchived=true',
    enabled: uses('collectionType') && catalog,
    staleTime: 60_000,
  });
  const materialTypes = useApiQuery<MasterListResponse<MaterialTypeView>>({
    queryKey: ['reports', 'options', 'material-types'],
    path: 'catalog/material-types?includeArchived=true',
    enabled: uses('materialType') && catalog,
    staleTime: 60_000,
  });
  const languages = useApiQuery<MasterListResponse<LanguageView>>({
    queryKey: ['reports', 'options', 'languages'],
    path: 'catalog/languages?includeArchived=true',
    enabled: uses('language') && catalog,
    staleTime: 60_000,
  });

  // ---- Komunitas (member, visit and circulation reports) ----
  const memberTypes = useApiQuery<MemberTypeListResponse>({
    queryKey: ['reports', 'options', 'member-types'],
    path: 'members/types?includeArchived=true',
    enabled: uses('memberType') && holds(me, 'members.records.read'),
    staleTime: 60_000,
  });

  // ---- Komunitas K4 (stocktake) ----
  // The sessions of every branch the user may see (a report on one session).
  const stocktakeReadable = me !== undefined && me.authenticated && (holds(me, 'stocktake.scan.use') || Object.values(me.branchPermissions).some((p) => p.includes('stocktake.scan.use')));
  const stocktakes = useQuery<StocktakeView[]>({
    queryKey: ['reports', 'options', 'stocktakes'],
    queryFn: async () => {
      const list = await api<BranchListResponse>('GET', 'branches?includeArchived=true');
      const out: StocktakeView[] = [];
      for (const b of list.items) {
        const r = await api<StocktakeListResponse>('GET', `branches/${b.id}/stocktakes`).catch(() => null);
        if (r !== null) out.push(...r.items);
      }
      return out.sort((a, b) => b.startedAt - a.startedAt);
    },
    enabled: uses('stocktake') && stocktakeReadable,
    staleTime: 60_000,
  });

  const wanted = {
    stocktake: uses('stocktake') && stocktakeReadable,
    period: uses('period') && accreditation,
    branch: uses('branch'),
    location: uses('location') && catalog,
    collectionType: uses('collectionType') && catalog,
    materialType: uses('materialType') && catalog,
    language: uses('language') && catalog,
    memberType: uses('memberType') && holds(me, 'members.records.read'),
  };
  const state = (q: { data: unknown; isError: boolean }, readable: boolean): 'loading' | 'unavailable' | 'ready' =>
    !readable || q.isError ? 'unavailable' : q.data === undefined ? 'loading' : 'ready';
  const periodState = state(periods, wanted.period);
  const branchState = state(branches, wanted.branch);
  const locationState = state(locations, wanted.location);
  const collectionTypeState = state(collectionTypes, wanted.collectionType);
  const materialTypeState = state(materialTypes, wanted.materialType);
  const languageState = state(languages, wanted.language);
  const memberTypeState = state(memberTypes, wanted.memberType);
  const stocktakeState = state(stocktakes, wanted.stocktake);

  return useMemo((): ParamOptions => {
    const states: Record<ListKind, 'loading' | 'unavailable' | 'ready'> = {
      period: periodState,
      branch: branchState,
      location: locationState,
      collectionType: collectionTypeState,
      materialType: materialTypeState,
      language: languageState,
      memberType: memberTypeState,
      stocktake: stocktakeState,
    };
    const name = (n: { nameId: string; nameEn: string }): string => (locale === 'en' ? n.nameEn : n.nameId);
    const archived = (label: string, isArchived: boolean): string => (isArchived ? t('reports.params.archived_option', { name: label }) : label);
    const listOf = (kind: ListKind, choices: () => Choice[]): ChoiceList =>
      states[kind] === 'ready' ? { state: 'ready', choices: choices() } : states[kind] === 'loading' ? LOADING : UNAVAILABLE;

    let locationChoices: LocationChoice[] | null = null;
    const items = locations.data?.items;
    if (locationState === 'ready' && items !== undefined) {
      const parentOf = new Map(items.map((l) => [l.id, l.parentId]));
      const depth = (id: string): number => {
        let d = 0;
        for (let p = parentOf.get(id) ?? null; p !== null && d < 8; p = parentOf.get(p) ?? null) d += 1;
        return d;
      };
      locationChoices = items.map((l) => ({
        value: l.id,
        branchId: l.branchId,
        label: `${INDENT.repeat(depth(l.id))}${archived(`${l.name} (${l.code})`, l.archived)}`,
      }));
    }
    const lists: Record<ListKind, ChoiceList> = {
      period: listOf('period', () =>
        (periods.data?.periods ?? []).map((p) => ({ value: p.id, label: t('reports.params.period_option', { name: p.name, from: p.startsOn, to: p.endsOn }) })),
      ),
      branch: listOf('branch', () => (branches.data?.items ?? []).map((b) => ({ value: b.id, label: archived(`${b.name} (${b.code})`, b.archivedAt !== null) }))),
      location: listOf('location', () => locationChoices ?? []),
      collectionType: listOf('collectionType', () =>
        (collectionTypes.data?.items ?? []).map((m) => ({ value: m.id, label: archived(`${name(m)} (${m.code})`, m.archived) })),
      ),
      materialType: listOf('materialType', () =>
        (materialTypes.data?.items ?? []).map((m) => ({ value: m.id, label: archived(`${name(m)} (${m.code})`, m.archived) })),
      ),
      language: listOf('language', () => (languages.data?.items ?? []).map((m) => ({ value: m.id, label: archived(`${name(m)} (${m.code})`, m.archived) }))),
      memberType: listOf('memberType', () =>
        (memberTypes.data?.items ?? []).map((m) => ({
          value: m.id,
          label: archived(`${locale === 'en' ? (m.nameEn ?? m.nameId) : m.nameId} (${m.code})`, m.archived),
        })),
      ),
      stocktake: listOf('stocktake', () =>
        (stocktakes.data ?? []).map((st) => ({ value: st.id, label: `${st.name} (${st.branch.code}, ${new Date(st.startedAt).toISOString().slice(0, 10)})` })),
      ),
    };
    return { lists, locations: locationChoices };
  }, [
    periodState,
    branchState,
    locationState,
    collectionTypeState,
    materialTypeState,
    languageState,
    memberTypeState,
    stocktakeState,
    stocktakes.data,
    periods.data,
    branches.data,
    locations.data,
    collectionTypes.data,
    materialTypes.data,
    languages.data,
    memberTypes.data,
    t,
    locale,
  ]);
}

/** The label of option `value` of a `status` parameter: its vocabulary's, its report's, or the value itself. */
export function optionLabel(t: Translate, spec: ReportParamSpec, value: string): string {
  const key = spec.optionLabelPrefix !== undefined ? `${spec.optionLabelPrefix}${value}` : `report.option.${spec.name}.${value}`;
  return isMessageKey(key) ? t(key) : value;
}

/** The label of a parameter (`report.param.<name>`), or its name when this build has no text for it. */
export function paramLabel(t: Translate, spec: ReportParamSpec): string {
  return isMessageKey(spec.labelKey) ? t(spec.labelKey as TKey) : spec.name;
}

/** The choices of a select parameter: its list (the locations of the chosen branch only), or its options. */
function choicesOf(t: Translate, spec: ReportParamSpec, options: ParamOptions, branchId: string): ChoiceList {
  if (spec.kind === 'status') return { state: 'ready', choices: (spec.options ?? []).map((o) => ({ value: o, label: optionLabel(t, spec, o) })) };
  if (!isListKind(spec.kind)) return UNAVAILABLE;
  if (spec.kind === 'location' && branchId !== '' && options.locations !== null) {
    return { state: 'ready', choices: options.locations.filter((l) => l.branchId === branchId) };
  }
  return options.lists[spec.kind];
}

/**
 * Says the parameters `params` (as sent, or as a run stored them) in words: `Label: value; …`, the values by their
 * labels (a branch by its name, a status by its vocabulary), `Tanpa filter` when there is none.
 */
export function useDescribeParams(entry: ReportCatalogEntry, options: ParamOptions): (params: Readonly<Record<string, unknown>> | null) => string {
  const t = useT();
  const locale = useLocale();
  return useCallback(
    (params) => {
      const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
      const parts: string[] = [];
      for (const spec of entry.params) {
        if (params === null || !hasOwn(params, spec.name)) continue;
        const raw = params[spec.name];
        let text: string | null = null;
        if (spec.kind === 'dateRange' && typeof raw === 'object' && raw !== null) {
          const { from, to } = raw as { from?: unknown; to?: unknown };
          const f = typeof from === 'string' ? from : '';
          const u = typeof to === 'string' ? to : '';
          if (f !== '' && u !== '') text = t('reports.params.range', { from: f, to: u });
          else if (f !== '') text = t('reports.params.range_from', { from: f });
          else if (u !== '') text = t('reports.params.range_to', { to: u });
        } else if (spec.kind === 'bool') {
          text = raw === true ? t('reports.params.yes') : null;
        } else if (spec.kind === 'status') {
          const list = Array.isArray(raw) ? raw : [raw];
          text = list.filter((v): v is string => typeof v === 'string').map((v) => optionLabel(t, spec, v)).join(', ') || null;
        } else if (isListKind(spec.kind) && typeof raw === 'string') {
          const list = spec.kind === 'location' && options.locations !== null ? { state: 'ready' as const, choices: options.locations } : options.lists[spec.kind];
          const found = list.state === 'ready' ? list.choices.find((c) => c.value === raw) : undefined;
          text = found === undefined ? raw : found.label.trim();
        } else if (spec.kind === 'int' && typeof raw === 'number') {
          text = number.format(raw);
        } else if (Array.isArray(raw)) {
          text = raw.map(String).join(', ') || null;
        } else if (typeof raw === 'string' || typeof raw === 'number') {
          text = String(raw);
        }
        if (text !== null && text !== '') parts.push(`${paramLabel(t, spec)}: ${text}`);
      }
      return parts.length === 0 ? t('reports.params.summary_none') : parts.join('; ');
    },
    [entry, options, t, locale],
  );
}

// ---- the form ------------------------------------------------------------------------------------------------------

export interface ParamFormProps {
  entry: ReportCatalogEntry;
  values: ParamValues;
  errors: ParamErrors;
  options: ParamOptions;
  /** A control changed: the parameter's new value. */
  onChange(name: string, value: ParamValue): void;
  /** "Terapkan". */
  onApply(): void;
  /** "Kosongkan": every parameter back to empty. */
  onReset(): void;
  // ---- Komunitas K5 (reports) ----
  /** The form feeds a preview ("Terapkan"); false for a document, which is only exported (default true). */
  previews?: boolean;
}

/** The filter form (see the top of this file). */
export function ParamForm({ entry, values, errors, options, onChange, onApply, onReset, previews = true }: ParamFormProps) {
  const t = useT();
  const headingId = useId();
  const branchSpec = entry.params.find((p) => p.kind === 'branch');
  const branchId = branchSpec === undefined ? '' : asText(values[branchSpec.name]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (previews) onApply();
  };

  return (
    <form noValidate aria-label={t('reports.params.title')} className="grid gap-3" onSubmit={submit}>
      <SectionHead id={headingId} title={t('reports.params.title')} />
      {entry.params.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('reports.params.none')}</p>
      ) : (
        <div className="grid max-w-5xl items-start gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          {entry.params.map((spec) => (
            <ParamControl
              key={spec.name}
              spec={spec}
              value={values[spec.name] ?? emptyValue(spec)}
              errors={errors}
              choices={choicesOf(t, spec, options, spec.kind === 'location' ? branchId : '')}
              onChange={(value) => onChange(spec.name, value)}
            />
          ))}
        </div>
      )}
      {(previews || entry.params.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {previews && <Button type="submit">{t('reports.params.apply')}</Button>}
          {entry.params.length > 0 && (
            <Button type="button" variant="outline" onClick={onReset}>
              {t('reports.params.reset')}
            </Button>
          )}
        </div>
      )}
    </form>
  );
}

/** The hint of a number: its range. */
function rangeHint(t: Translate, spec: ReportParamSpec): string | undefined {
  return spec.min !== undefined && spec.max !== undefined ? t('reports.params.range_hint', { min: spec.min, max: spec.max }) : undefined;
}

/** The control of one parameter, of its kind. */
function ParamControl({
  spec,
  value,
  errors,
  choices,
  onChange,
}: {
  spec: ReportParamSpec;
  value: ParamValue;
  errors: ParamErrors;
  choices: ChoiceList;
  onChange(value: ParamValue): void;
}) {
  const t = useT();
  const label = paramLabel(t, spec);
  const error = errors[spec.name];

  if (spec.kind === 'dateRange') {
    const range = asRange(value);
    return (
      <fieldset data-param={spec.name} className="grid min-w-0 gap-x-5 gap-y-4 sm:col-span-2 sm:grid-cols-2">
        <legend className="mb-1.5 text-meta leading-snug font-semibold">{label}</legend>
        <Field label={t('reports.params.from')} error={errors[`${spec.name}.from`]}>
          {(c) => <Input {...c} type="date" value={range.from} onChange={(e) => onChange({ ...range, from: e.target.value })} />}
        </Field>
        <Field label={t('reports.params.to')} error={errors[`${spec.name}.to`]}>
          {(c) => <Input {...c} type="date" value={range.to} onChange={(e) => onChange({ ...range, to: e.target.value })} />}
        </Field>
      </fieldset>
    );
  }

  if (spec.kind === 'bool') {
    return (
      <div data-param={spec.name} className="pt-7">
        <CheckField label={label} checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      </div>
    );
  }

  if (spec.kind === 'status' && spec.multiple === true) {
    const checked = asList(value);
    const list = choices.state === 'ready' ? choices.choices : [];
    const toggle = (option: string, on: boolean): void => {
      const next = on ? [...checked, option] : checked.filter((v) => v !== option);
      onChange((spec.options ?? []).filter((o) => next.includes(o)));
    };
    return (
      <fieldset data-param={spec.name} className="grid min-w-0 gap-2 sm:col-span-full" aria-invalid={error === undefined ? undefined : true}>
        <legend className="mb-1.5 text-meta leading-snug font-semibold">{label}</legend>
        <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
          {list.map((c) => (
            <CheckField key={c.value} label={c.label} checked={checked.includes(c.value)} onChange={(e) => toggle(c.value, e.target.checked)} />
          ))}
        </div>
        {error !== undefined && <p className="text-meta font-semibold text-bad">{isMessageKey(error) ? t(error) : t('form.error.invalid')}</p>}
        <p className="text-xs text-muted-foreground">{t('reports.params.multi_hint')}</p>
      </fieldset>
    );
  }

  if (spec.kind === 'status' || isListKind(spec.kind)) {
    const list = choices.state === 'ready' ? choices.choices : [];
    const empty = spec.required ? t('reports.params.choose') : spec.kind === 'status' ? t('reports.params.default') : t('reports.params.all');
    return (
      <div data-param={spec.name}>
        <Field label={label} error={error} hint={choices.state === 'unavailable' ? t('reports.params.options_unavailable') : undefined}>
          {(c) => (
            <select
              {...c}
              className={SELECT_CLASS}
              value={asText(value)}
              disabled={choices.state === 'unavailable'}
              aria-busy={choices.state === 'loading' ? true : undefined}
              onChange={(e) => onChange(e.target.value)}
            >
              <option value="">{empty}</option>
              {list.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
    );
  }

  if (spec.kind === 'asOf') {
    return (
      <div data-param={spec.name}>
        <Field label={label} error={error} hint={t('reports.params.as_of_hint')}>
          {(c) => <Input {...c} type="date" value={asText(value)} onChange={(e) => onChange(e.target.value)} />}
        </Field>
      </div>
    );
  }

  if (spec.kind === 'year' || spec.kind === 'int') {
    return (
      <div data-param={spec.name}>
        <Field label={label} error={error} hint={rangeHint(t, spec)}>
          {(c) => (
            <Input
              {...c}
              type="number"
              inputMode="numeric"
              step={1}
              {...(spec.min === undefined ? {} : { min: spec.min })}
              {...(spec.max === undefined ? {} : { max: spec.max })}
              value={asText(value)}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </Field>
      </div>
    );
  }

  if (spec.multiple === true) {
    return (
      <div data-param={spec.name}>
        <Field label={label} error={error} hint={t('reports.params.lines_hint')}>
          {(c) => <textarea {...c} rows={3} className={TEXTAREA_CLASS} value={asText(value)} onChange={(e) => onChange(e.target.value)} />}
        </Field>
      </div>
    );
  }

  return (
    <div data-param={spec.name}>
      <Field label={label} error={error} hint={spec.kind === 'classPrefix' ? t('reports.params.class_prefix_hint') : undefined}>
        {(c) => (
          <Input
            {...c}
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={spec.kind === 'classPrefix' ? 16 : TEXT_MAX}
            value={asText(value)}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </Field>
    </div>
  );
}
