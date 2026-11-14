import type { EvidenceComponent, EvidenceListResponse } from '@altis/shared/api/accreditation';
import { useId } from 'react';
import { useLocale, useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { useBytes } from '@/screens/backups/upload';
import { componentLabel } from './run-card';

/**
 * The running size of the evidence of each component (spec §10.9): the files of the period's evidence counted per
 * component of the evidence ZIP (`GET accreditation/evidence` `componentBytes`), against the upload limit per component
 * (`accreditation.evidence.componentLimitMb`, binary megabytes as the server counts them). A component over the limit
 * says so; SiPAPI refuses a component file that large.
 */

/** The components in the order of the evidence ZIP. */
export const EVIDENCE_COMPONENTS: readonly EvidenceComponent[] = Object.freeze(['K', 'SP', 'L', 'T', 'F', 'G', 'profil']);

const MB = 1024 * 1024;

export function ComponentSizes({ bytes, limitMb }: { bytes: EvidenceListResponse['componentBytes']; limitMb: number }) {
  const t = useT();
  const locale = useLocale();
  const size = useBytes();
  const captionId = useId();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  const limit = number.format(limitMb);
  const limitBytes = limitMb * MB;
  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto rounded-md border">
        <table aria-labelledby={captionId} className="w-full text-sm">
          <caption id={captionId} className="px-3 pt-2 text-left font-medium">
            {t('accreditation.print.sizes.title')}
          </caption>
          <thead className="text-left">
            <tr>
              <td colSpan={3} className="px-3 pb-2 text-xs text-muted-foreground">
                {t('accreditation.print.sizes.intro', { limit })}
              </td>
            </tr>
            <tr className="bg-muted/50">
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('accreditation.print.sizes.col_component')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('accreditation.print.sizes.col_size')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('accreditation.print.sizes.col_state')}
              </th>
            </tr>
          </thead>
          <tbody>
            {EVIDENCE_COMPONENTS.map((code) => {
              const n = bytes[code] ?? 0;
              const over = n > limitBytes;
              const pct = limitBytes <= 0 ? 100 : Math.min(100, (n / limitBytes) * 100);
              return (
                <tr key={code} data-component={code} className="border-t align-top">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    {componentLabel(t, code)}
                  </th>
                  <td className="px-3 py-2">
                    <div className="grid min-w-40 gap-1">
                      <span className="tabular-nums">{t('accreditation.print.sizes.size_of', { size: size(n), limit })}</span>
                      <div aria-hidden="true" className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div className={cn('h-full rounded-full', over ? 'bg-destructive' : 'bg-primary')} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {over ? (
                      <span data-over-limit className="text-destructive">
                        {t('accreditation.print.sizes.over', { limit })}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t('accreditation.print.sizes.within')}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
