import type { ReportColumnView } from '@altis/shared/api/reports';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '@/i18n';
import { ReportTable, keepsOnOneLine } from '@/screens/reports/preview-table';

// A wide report table scrolls sideways in its frame: a value written as one word (a month such as 2026-01, a code)
// never breaks inside its cell, while a text of several words keeps a readable width and wraps.

const COLUMNS: ReportColumnView[] = [
  { key: 'month', labelKey: 'report.column.month', type: 'text' },
  { key: 'note', labelKey: 'report.column.source', type: 'text' },
  { key: 'loans', labelKey: 'report.column.loans', type: 'int' },
];

describe('the cells of a report table', () => {
  it('keeps a one-word value on one line, an empty one too, and lets words wrap', () => {
    expect(keepsOnOneLine('2026-01')).toBe(true);
    expect(keepsOnOneLine('978-602-1234-56-7')).toBe(true);
    expect(keepsOnOneLine('')).toBe(true);
    expect(keepsOnOneLine('Tidak ada data')).toBe(false);
    expect(keepsOnOneLine('x'.repeat(40))).toBe(false);
  });

  it('draws a month cell without a break and a sentence cell with a minimum width', () => {
    render(
      <I18nProvider locale="id">
        <ReportTable columns={COLUMNS} rows={[['2026-01', 'Belum ada data penggunaan', 12]]} totals={null} caption="Uji" />
      </I18nProvider>,
    );
    const [month, note, loans] = within(screen.getByRole('table', { name: 'Uji' })).getAllByRole('cell');
    expect(month!.className).toContain('whitespace-nowrap');
    expect(note!.className).not.toContain('whitespace-nowrap');
    expect(note!.className).toContain('min-w-40');
    expect(loans!.className).toContain('whitespace-nowrap');
    expect(loans!.className).toContain('text-right');
  });
});
