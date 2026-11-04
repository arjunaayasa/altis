import type { ReactTable, RowData, TableFeatures } from '@tanstack/react-table';
import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useLocale, useT } from '@/i18n';

/**
 * The lists of the admin screens: a TanStack Table (v9, headless) drawn as a plain, scrollable `<table>` with a
 * screen-reader caption, a row for "nothing here", and a pager for the lists the server pages.
 */
export function DataTable<TFeatures extends TableFeatures, TData extends RowData>({
  table,
  caption,
  empty,
}: {
  // The selected state is not read here; any selector the screen chose will do.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: ReactTable<TFeatures, TData, any>;
  caption: string;
  empty: string;
}) {
  const rows = table.getRowModel().rows;
  const columns = table.getAllLeafColumns().length;
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted/50 text-left">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th key={header.id} scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-muted-foreground">
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns} className="px-3 py-6 text-center text-muted-foreground">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id} className="border-t align-top">
                {row.getAllCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2">
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** "Halaman 1 dari 3 · 60 …" with Sebelumnya/Berikutnya; `label` is the already translated text. */
export function Pager({ page, pages, label, onPage }: { page: number; pages: number; label: string; onPage(page: number): void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className="text-muted-foreground">{label}</p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {t('table.prev')}
        </Button>
        <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          {t('table.next')}
        </Button>
      </div>
    </div>
  );
}

/** Formats epoch milliseconds as a medium date and short time in the UI language. */
export function useDateTime(): (ms: number) => string {
  const locale = useLocale();
  return useCallback(
    (ms: number) => new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(ms),
    [locale],
  );
}
