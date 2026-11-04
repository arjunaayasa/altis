import type { MarcJsonDataField, MarcJsonRecord } from '@altis/shared/api/catalog/exchange';
import { DownloadIcon } from 'lucide-react';
import { ProblemAlert } from '@/components/form-field';
import { useT } from '@/i18n';
import { useApiQuery } from '@/lib/me';

/**
 * The MARC tab of the record editor (Phase 2 spec §13 "tab MARC (baca saja + unduh)"; plan Task 24, M9): the record
 * as `GET catalog/records/:id/marc?format=json` gives it (one `MarcJsonRecord`, the staff audience), as a read-only
 * table of the leader and the fields (tag, indicators, `$a value $b value`), with plain download links of the ISO 2709
 * and MARCXML forms (the browser sends the session cookie; a GET needs no CSRF token). Loaded when the tab opens.
 */

/** One row of the table: a tag, its indicators (data fields), and its content. */
interface MarcRow {
  tag: string;
  indicators: string | null;
  content: string;
}

/** The subfields of a data field as written in cataloguing: `$a value $b value`. */
function subfieldText(field: MarcJsonDataField): string {
  return field.subfields.flatMap((sf) => Object.entries(sf).map(([code, value]) => `$${code} ${value}`)).join(' ');
}

/** The fields of `record` as rows, in their order. */
function rowsOf(record: MarcJsonRecord): MarcRow[] {
  return record.fields.flatMap((field) =>
    Object.entries(field).map(([tag, value]): MarcRow =>
      typeof value === 'string' ? { tag, indicators: null, content: value } : { tag, indicators: `${value.ind1}${value.ind2}`, content: subfieldText(value) },
    ),
  );
}

/** An indicator as shown: a blank one as `#` (the MARC 21 documentation's convention). */
const showIndicators = (s: string): string => s.replace(/ /g, '#');

export function MarcTab({ recordId }: { recordId: string }) {
  const t = useT();
  const marc = useApiQuery<MarcJsonRecord>({
    queryKey: ['catalog', 'records', 'marc', recordId],
    path: `catalog/records/${encodeURIComponent(recordId)}/marc?format=json`,
    refetchOnWindowFocus: false,
  });
  const base = `/api/v1/catalog/records/${encodeURIComponent(recordId)}/marc`;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t('catalog.records.marc.hint')}</p>
      <div className="flex flex-wrap gap-2">
        <a href={`${base}?format=mrc`} download className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
          <DownloadIcon className="size-4" aria-hidden="true" />
          {t('catalog.records.marc.download_mrc')}
        </a>
        <a href={`${base}?format=xml`} download className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
          <DownloadIcon className="size-4" aria-hidden="true" />
          {t('catalog.records.marc.download_xml')}
        </a>
      </div>
      {marc.data === undefined ? (
        marc.isError ? (
          <ProblemAlert error={marc.error} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full font-mono text-xs">
            <caption className="sr-only">{t('catalog.records.marc.caption')}</caption>
            <thead className="bg-muted/50 text-left font-sans text-sm">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                  {t('catalog.records.marc.tag')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                  {t('catalog.records.marc.indicators')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                  {t('catalog.records.marc.data')}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t align-top">
                <th scope="row" className="px-3 py-1.5 text-left font-medium" title={t('catalog.records.marc.leader')}>
                  LDR
                </th>
                <td className="px-3 py-1.5" />
                <td className="px-3 py-1.5 whitespace-pre-wrap">{marc.data.leader}</td>
              </tr>
              {rowsOf(marc.data).map((row, i) => (
                <tr key={`${row.tag}-${i}`} className="border-t align-top">
                  <th scope="row" className="px-3 py-1.5 text-left font-medium">
                    {row.tag}
                  </th>
                  <td className="px-3 py-1.5 whitespace-pre">{row.indicators === null ? '' : showIndicators(row.indicators)}</td>
                  <td className="px-3 py-1.5 break-words whitespace-pre-wrap">{row.content}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
