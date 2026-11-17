import type { MarcJsonDataField, MarcJsonRecord } from '@altis/shared/api/catalog/exchange';
import { ErrorState, LoadingState, TABLE } from '@/components/layout';
import { buttonVariants } from '@/components/ui/button';
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
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[75ch] text-sm text-muted-foreground">{t('catalog.records.marc.hint')}</p>
        <div className="flex flex-wrap gap-2">
          <a href={`${base}?format=mrc`} download className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('catalog.records.marc.download_mrc')}
          </a>
          <a href={`${base}?format=xml`} download className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('catalog.records.marc.download_xml')}
          </a>
        </div>
      </div>
      {marc.data === undefined ? (
        marc.isError ? (
          <ErrorState error={marc.error} onRetry={() => void marc.refetch()} retrying={marc.isFetching} />
        ) : (
          <LoadingState />
        )
      ) : (
        <div className={TABLE.wrap}>
          {/* The MARC data keeps a fixed-width face: the leader's and the indicators' positions are read by column. */}
          <table className={TABLE.table}>
            <caption className="sr-only">{t('catalog.records.marc.caption')}</caption>
            <thead>
              <tr>
                <th scope="col" className={`${TABLE.th} w-px`}>
                  {t('catalog.records.marc.tag')}
                </th>
                <th scope="col" className={`${TABLE.th} w-px`}>
                  {t('catalog.records.marc.indicators')}
                </th>
                <th scope="col" className={TABLE.th}>
                  {t('catalog.records.marc.data')}
                </th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs">
              <tr>
                <th scope="row" className={`${TABLE.td} text-left font-semibold`} title={t('catalog.records.marc.leader')}>
                  LDR
                </th>
                <td className={TABLE.td} />
                <td className={`${TABLE.td} whitespace-pre-wrap`}>{marc.data.leader}</td>
              </tr>
              {rowsOf(marc.data).map((row, i) => (
                <tr key={`${row.tag}-${i}`}>
                  <th scope="row" className={`${TABLE.td} text-left font-semibold`}>
                    {row.tag}
                  </th>
                  <td className={`${TABLE.td} whitespace-pre`}>{row.indicators === null ? '' : showIndicators(row.indicators)}</td>
                  <td className={`${TABLE.td} break-words whitespace-pre-wrap`}>{row.content}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
