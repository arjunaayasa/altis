import { USAGE_CELL_GROUP_KEY, USAGE_PUT_MAX_CELLS, type UsageGridView, type UsagePutBody } from '@altis/shared/api/accreditation';
import type { UsageMetric } from '@altis/shared';
import { useQueryClient } from '@tanstack/react-query';
import { SaveIcon, Undo2Icon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Badge, Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type Translate } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { problemText } from '@/lib/form-errors';
import { cn } from '@/lib/utils';
import { useRetryKey } from '@/screens/catalog/exchange/summary-view';
import { accredKeys, accredPaths } from './queries';

/**
 * The monthly usage grid of a period (spec §10.7, the workspace's "Penggunaan Bulanan"): one group at a time (the
 * total, a population group, the guests, and the imported figures no group takes yet), a row per month and a column
 * per monthly metric, then one row of the metrics of the whole period. Every cell shows its value and its source
 * (`manual`, `slims`, none) as a badge, and a cut month says until when its SLiMS figures count.
 *
 * A user who may manage accreditation edits cells in place while the period is open: the changed cells (of every
 * group) are kept until "Simpan perubahan" (the page asks before it is left meanwhile), which sends them in writes of at
 * most {@link USAGE_PUT_MAX_CELLS} cells; an empty cell removes its manual entry. A value that is not a whole number of 0 or more is marked and nothing is
 * sent. The imported figures without a group are read-only (the mapping below the grid moves them).
 */

type GridCell = UsageGridView['cells'][number];

/** A cell's identity: `metric|month|groupKey` (month `''` for the whole period). */
const cellKey = (metric: UsageMetric, month: string | null, groupKey: string): string => `${metric}|${month ?? ''}|${groupKey}`;

/** The cell that `key` names. */
function parseKey(key: string): { metric: UsageMetric; month: string | null; groupKey: string } {
  const [metric, month, ...rest] = key.split('|');
  return { metric: metric as UsageMetric, month: month === '' || month === undefined ? null : month, groupKey: rest.join('|') };
}

/** The value typed into a cell: null (empty: remove the manual entry), a whole number, or undefined (not one). */
function parseValue(text: string): number | null | undefined {
  const s = text.trim();
  if (s === '') return null;
  if (!/^\d{1,16}$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The label of a group of the grid. */
export function usageGroupLabel(t: Translate, group: UsageGridView['groups'][number]): string {
  if (group.key === '') return t('accreditation.usage.group.total');
  if (group.key === 'guest') return t('accreditation.usage.group.guest');
  if (group.key === 'unmapped') return t('accreditation.usage.group.unmapped');
  if (group.accredGroup !== null && group.accredGroup !== 'guest') return t(`vocab.accred_group.${group.accredGroup}`);
  return group.label ?? group.key;
}

/** `YYYY-MM` as the UI language writes a month ("Januari 2026"). */
export function useMonthLabel(): (month: string) => string {
  const locale = useLocale();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return (month: string) => {
      const m = /^(\d{4})-(\d{2})$/.exec(month);
      return m === null ? month : format.format(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    };
  }, [locale]);
}

const SOURCE_TONE = { manual: 'info', slims: 'neutral', none: 'neutral' } as const;

type SaveState =
  | { kind: 'idle' }
  | { kind: 'invalid' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; error: unknown; partial: boolean };

export interface UsageGridProps {
  periodId: string;
  grid: UsageGridView;
  /** The period's first and last day (the cells of the whole period cover them). */
  span: { from: string; to: string };
  /** The user may manage accreditation and the period is open. */
  editable: boolean;
}

export function UsageGrid({ periodId, grid, span, editable }: UsageGridProps) {
  const t = useT();
  const locale = useLocale();
  const monthLabel = useMonthLabel();
  const queryClient = useQueryClient();
  const retryKey = useRetryKey('accreditation-usage');
  const ids = { monthly: useId(), span: useId() };
  const number = useMemo(() => new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID'), [locale]);

  const [groupKey, setGroupKey] = useState('');
  /** The changed cells, in the order they were first changed: key → the text typed. */
  const [edits, setEdits] = useState<ReadonlyMap<string, string>>(new Map());
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [state, setState] = useState<SaveState>({ kind: 'idle' });

  // Unsaved cells keep the page from being reloaded under the user's hands.
  useDirtyGuard(edits.size > 0);

  const cells = useMemo(() => new Map(grid.cells.map((c) => [cellKey(c.metric, c.month, c.groupKey), c] as const)), [grid.cells]);
  const monthly = useMemo(() => grid.metrics.filter((m) => grid.cells.some((c) => c.metric === m && c.month !== null)), [grid]);
  const spanMetrics = useMemo(() => grid.metrics.filter((m) => grid.cells.some((c) => c.metric === m && c.month === null)), [grid]);
  const group = grid.groups.find((g) => g.key === groupKey) ?? grid.groups[0];
  const groupLabel = group === undefined ? '' : usageGroupLabel(t, group);
  const groupEditable = editable && group !== undefined && USAGE_CELL_GROUP_KEY.test(group.key);
  const saving = state.kind === 'saving';

  const shownText = (key: string, cell: GridCell | undefined): string => edits.get(key) ?? (cell?.value === null || cell?.value === undefined ? '' : String(cell.value));

  const change = (key: string, text: string): void => {
    const cell = cells.get(key);
    const original = cell?.value === null || cell?.value === undefined ? '' : String(cell.value);
    setEdits((current) => {
      const next = new Map(current);
      if (text === original) next.delete(key);
      else next.set(key, text);
      return next;
    });
    setInvalid((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    if (state.kind !== 'saving') setState({ kind: 'idle' });
  };

  const discard = (): void => {
    setEdits(new Map());
    setInvalid(new Set());
    setState({ kind: 'idle' });
  };

  const save = async (): Promise<void> => {
    if (saving || edits.size === 0) return;
    const bad = new Set<string>();
    const pending: { key: string; cell: UsagePutBody['cells'][number] }[] = [];
    for (const [key, text] of edits) {
      const value = parseValue(text);
      if (value === undefined) bad.add(key);
      else pending.push({ key, cell: { ...parseKey(key), value } });
    }
    setInvalid(bad);
    if (bad.size > 0) {
      setState({ kind: 'invalid' });
      return;
    }
    setState({ kind: 'saving' });
    let sent = 0;
    /** The cells written: they leave the changed cells once the grid has been read again (no old value flashes). */
    const written = new Set<string>();
    let outcome: SaveState = { kind: 'saved' };
    try {
      while (sent < pending.length) {
        const chunk = pending.slice(sent, sent + USAGE_PUT_MAX_CELLS);
        const body: UsagePutBody = { cells: chunk.map((p) => p.cell) };
        try {
          await api('PUT', accredPaths.usage(periodId), body, { idempotencyKey: retryKey.key(body) });
        } catch (e) {
          // The cells a refusal names are marked; the others of that write stay changed.
          if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') {
            const named = new Set<string>();
            for (const fe of e.errors ?? []) {
              const m = /^cells\.(\d+)(?:\.|$)/.exec(fe.path);
              const at = m === null ? undefined : chunk[Number(m[1])];
              if (at !== undefined) named.add(at.key);
            }
            setInvalid(named);
          }
          throw e;
        }
        retryKey.clear();
        for (const p of chunk) written.add(p.key);
        sent += chunk.length;
      }
    } catch (e) {
      outcome = { kind: 'error', error: e, partial: sent > 0 };
    }
    if (written.size > 0) {
      void queryClient.invalidateQueries({ queryKey: accredKeys.period(periodId) });
      void queryClient.invalidateQueries({ queryKey: accredKeys.results(periodId) });
      await queryClient.invalidateQueries({ queryKey: accredKeys.usage(periodId) });
      setEdits((current) => new Map([...current].filter(([key]) => !written.has(key))));
    }
    setState(outcome);
  };

  const cell = (metric: UsageMetric, month: string | null, rowLabel: string) => {
    const key = cellKey(metric, month, groupKey);
    const c = cells.get(key);
    const source = c?.source ?? 'none';
    const isInvalid = invalid.has(key);
    const dirty = edits.has(key);
    return (
      <td key={key} data-usage-cell={key} className="px-2 py-1.5 align-top">
        <div className="grid min-w-24 justify-items-end gap-1">
          <Input
            value={shownText(key, c)}
            inputMode="numeric"
            autoComplete="off"
            aria-label={t('accreditation.usage.cell', { metric: t(`vocab.usage_metric.${metric}`), month: rowLabel, group: groupLabel })}
            aria-invalid={isInvalid ? true : undefined}
            disabled={!groupEditable || saving}
            onChange={(e) => change(key, e.target.value)}
            className={cn('h-8 w-24 text-right tabular-nums', dirty && 'border-primary bg-primary/5')}
          />
          <Badge tone={SOURCE_TONE[source]} className={source === 'none' ? 'opacity-70' : undefined}>
            {t(`report.source.${source}`)}
          </Badge>
          {month !== null && c?.spanTo !== null && c?.spanTo !== undefined && (
            <span className="text-xs text-muted-foreground">{t('accreditation.usage.until', { date: c.spanTo })}</span>
          )}
        </div>
      </td>
    );
  };

  const metricHeader = (metric: UsageMetric) => (
    <th key={metric} scope="col" className="px-2 py-2 text-right align-bottom text-xs font-medium text-muted-foreground">
      {t(`vocab.usage_metric.${metric}`)}
    </th>
  );

  const errorText = (): string | null => {
    if (state.kind === 'invalid') return t('accreditation.usage.invalid');
    if (state.kind !== 'error') return null;
    const base = state.error instanceof ApiError && state.error.code === 'VALIDATION_FAILED' && invalid.size > 0 ? t('accreditation.usage.invalid') : problemText(t, state.error);
    return state.partial ? `${t('accreditation.usage.save_partial')} ${base}` : base;
  };
  const error = errorText();

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label={t('accreditation.usage.group')} className="w-full max-w-xs">
          {(c) => (
            <select {...c} className={SELECT_CLASS} value={groupKey} onChange={(e) => setGroupKey(e.target.value)}>
              {grid.groups.map((g) => (
                <option key={g.key} value={g.key}>
                  {usageGroupLabel(t, g)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            {edits.size > 0 && <span className="text-sm text-muted-foreground">{t('accreditation.usage.changes', { count: number.format(edits.size) })}</span>}
            <Button type="button" variant="outline" disabled={edits.size === 0 || saving} onClick={discard}>
              <Undo2Icon aria-hidden="true" />
              {t('accreditation.usage.discard')}
            </Button>
            <Button type="button" disabled={edits.size === 0 || saving} onClick={() => void save()}>
              <SaveIcon aria-hidden="true" />
              {saving ? t('accreditation.usage.saving') : t('accreditation.usage.save')}
            </Button>
          </div>
        )}
      </div>
      {group?.key === 'unmapped' && <p className="text-sm text-muted-foreground">{t('accreditation.usage.group.unmapped_hint')}</p>}
      {editable && groupEditable && <p className="text-xs text-muted-foreground">{t('accreditation.usage.empty_hint')}</p>}
      {error !== null && <Notice kind="error">{error}</Notice>}
      {state.kind === 'saved' && <Notice kind="success">{t('accreditation.usage.saved')}</Notice>}

      <div className="overflow-x-auto rounded-md border">
        <table aria-labelledby={ids.monthly} className="w-full text-sm">
          <caption id={ids.monthly} className="px-3 py-2 text-left font-medium">
            {t('accreditation.usage.monthly_caption', { group: groupLabel })}
          </caption>
          <thead className="bg-muted/50">
            <tr>
              <th scope="col" className="px-3 py-2 text-left align-bottom text-xs font-medium text-muted-foreground">
                {t('accreditation.usage.month')}
              </th>
              {monthly.map(metricHeader)}
            </tr>
          </thead>
          <tbody>
            {grid.months.map((month) => {
              const label = monthLabel(month);
              return (
                <tr key={month} className="border-t">
                  <th scope="row" className="px-3 py-1.5 text-left align-top font-normal whitespace-nowrap">
                    {label}
                  </th>
                  {monthly.map((metric) => cell(metric, month, label))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {spanMetrics.length > 0 && (
        <div className="grid gap-2">
          <p className="text-xs text-muted-foreground">{t('accreditation.usage.span_hint', { from: span.from, to: span.to })}</p>
          <div className="overflow-x-auto rounded-md border">
            <table aria-labelledby={ids.span} className="w-full text-sm">
              <caption id={ids.span} className="px-3 py-2 text-left font-medium">
                {t('accreditation.usage.span_caption', { group: groupLabel })}
              </caption>
              <thead className="bg-muted/50">
                <tr>
                  <td />
                  {spanMetrics.map(metricHeader)}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t">
                  <th scope="row" className="px-3 py-1.5 text-left align-top font-normal whitespace-nowrap">
                    {t('accreditation.usage.span_row')}
                  </th>
                  {spanMetrics.map((metric) => cell(metric, null, t('accreditation.usage.span_row')))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
