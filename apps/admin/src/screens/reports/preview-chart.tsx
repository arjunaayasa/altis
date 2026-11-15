import type { ReportCatalogEntry, ReportCell, ReportColumnType, ReportColumnView } from '@altis/shared/api/reports';
import { BarChart, type ChartBar } from '@/components/bar-chart';
import { useLocale, useT, type TKey } from '@/i18n';
import { isMessageKey } from '@/lib/form-errors';
import { useCellFormat } from './cell-format';

/**
 * The compact chart above a report's preview (`entry.chart`, spec of the definition): drawn from the rows the preview
 * already holds, in the output's language as the table under it, which stays the record (a date labels its bar as the
 * table says it, "2 Mar 2026", not 2026-03-02). `rows` draws a bar per row
 * (its label column's cell, its value column's number); `totals` a bar per listed column of the totals row. A chart
 * whose columns the answer lacks (a definition's columns may depend on its parameters), or with nothing to draw, is not
 * shown.
 */

const labelOf = (t: ReturnType<typeof useT>, c: ReportColumnView): string => (isMessageKey(c.labelKey) ? t(c.labelKey as TKey) : c.key);

const numberOf = (cell: ReportCell | undefined): number => (typeof cell === 'number' && Number.isFinite(cell) ? cell : 0);

/** The bars and the title of `chart` over a preview's columns and rows, or null when it cannot be drawn. */
export function chartBars(
  t: ReturnType<typeof useT>,
  chart: NonNullable<ReportCatalogEntry['chart']>,
  columns: readonly ReportColumnView[],
  rows: readonly (readonly ReportCell[])[],
  totals: readonly ReportCell[] | null,
  format: (type: ReportColumnType, cell: ReportCell) => string = (_type, cell) => String(cell),
): { title: string; bars: ChartBar[] } | null {
  const at = (key: string): number => columns.findIndex((c) => c.key === key);
  if (chart.kind === 'rows') {
    const l = at(chart.label);
    const v = at(chart.value);
    if (l < 0 || v < 0 || rows.length === 0) return null;
    return {
      title: t('reports.chart.rows', { value: labelOf(t, columns[v]!), label: labelOf(t, columns[l]!) }),
      bars: rows.map((r) => ({ label: r[l] === null || r[l] === undefined ? '—' : columns[l]!.type === 'date' ? format('date', r[l]) : String(r[l]), value: numberOf(r[v]) })),
    };
  }
  if (totals === null) return null;
  const listed = chart.columns.map(at).filter((k) => k >= 0);
  if (listed.length === 0) return null;
  return {
    title: t('reports.chart.totals', { total: String(totals[0] ?? '') }),
    bars: listed.map((k) => ({ label: labelOf(t, columns[k]!), value: numberOf(totals[k]) })),
  };
}

/** The chart of a preview, or nothing. */
export function PreviewChart({
  entry,
  columns,
  rows,
  totals,
}: {
  entry: ReportCatalogEntry;
  columns: readonly ReportColumnView[];
  rows: readonly (readonly ReportCell[])[];
  totals: readonly ReportCell[] | null;
}) {
  const t = useT();
  const locale = useLocale();
  const format = useCellFormat();
  if (entry.chart === undefined || entry.chart === null) return null;
  const drawn = chartBars(t, entry.chart, columns, rows, totals, format);
  if (drawn === null || drawn.bars.length === 0) return null;
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID', { maximumFractionDigits: 2 });
  const max = Math.max(0, ...drawn.bars.map((b) => b.value));
  const maxBars = 40;
  const description = [
    t('reports.chart.desc', { count: number.format(drawn.bars.length), max: number.format(max) }),
    ...(drawn.bars.length > maxBars ? [t('reports.chart.partial', { shown: number.format(maxBars), count: number.format(drawn.bars.length) })] : []),
  ].join(' ');
  return <BarChart title={drawn.title} description={description} bars={drawn.bars} format={(v) => number.format(v)} maxBars={maxBars} />;
}
