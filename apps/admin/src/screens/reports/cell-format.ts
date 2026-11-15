import type { ReportCell, ReportColumnType } from '@altis/shared/api/reports';
import { useMemo } from 'react';
import { useLocale } from '@/i18n';

// The text of a report cell on screen, shared by the preview's table and its chart, so that both say a value alike.

/** Formats a cell by its column's type in the current language (the output's, under the section's provider). */
export function useCellFormat(): (type: ReportColumnType, cell: ReportCell) => string {
  const locale = useLocale();
  return useMemo(() => {
    const tag = locale === 'en' ? 'en-GB' : 'id-ID';
    const integer = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 });
    const money = new Intl.NumberFormat(tag, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const percent = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 });
    const date = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeZone: 'UTC' });
    return (type, cell) => {
      if (cell === null) return '';
      if (typeof cell === 'number' && Number.isFinite(cell)) {
        if (type === 'int') return integer.format(cell);
        if (type === 'money') return money.format(cell);
        if (type === 'percent') return percent.format(cell / 100);
        return String(cell);
      }
      if (type === 'date' && typeof cell === 'string') {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cell);
        if (m !== null) return date.format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      }
      return String(cell);
    };
  }, [locale]);
}
