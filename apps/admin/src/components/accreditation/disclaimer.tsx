import type { JSX } from 'react';
import { useT } from '@/i18n';

/**
 * The sentence every screen that shows an estimated score carries: the estimate comes from ALTIS's data and the
 * librarian's answers, it is not an official grade, and only the national library's assessors grade.
 */
export function Disclaimer(): JSX.Element {
  const t = useT();
  return (
    <p data-disclaimer="" className="text-xs text-muted-foreground">
      {t('accred.disclaimer.estimate')}
    </p>
  );
}
