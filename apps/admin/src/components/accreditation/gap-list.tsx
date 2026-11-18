import type { ScoreView } from '@altis/shared/api/accreditation';
import { useId, type JSX } from 'react';
import { useT } from '@/i18n';
import { keyText, officialLabel, useFormats } from '@/screens/accreditation/data';

/** How many gaps the summary lists. */
export const GAPS_SHOWN = 10;

/**
 * The largest gaps of the estimate, largest first: each indicator by the decree's own number ("Pelayanan butir 7"),
 * the points of the final score it lacks to an a, and the action suggested for it.
 */
export function GapList({ gaps }: { gaps: ScoreView['gaps'] }): JSX.Element {
  const t = useT();
  const f = useFormats();
  const titleId = useId();
  const shown = gaps.slice(0, GAPS_SHOWN);
  return (
    <section aria-labelledby={titleId} className="grid gap-3">
      <h3 id={titleId} className="text-heading font-semibold">
        {t('accreditation.workspace.gaps.title')}
      </h3>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('accreditation.workspace.gaps.none')}</p>
      ) : (
        <ol className="grid border-t">
          {shown.map((g) => (
            <li key={g.code} className="grid gap-0.5 border-b py-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">{officialLabel(t, g.officialNo, g.component)}</span>
                <span className="text-muted-foreground tabular-nums">
                  {t('accreditation.workspace.gaps.points', { gap: f.decimal(roundGap(g.gap)) })}
                </span>
              </div>
              <span>{keyText(t, g.actionKey)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** A gap (four decimals) cut to two, as the score is shown. */
function roundGap(gap: string): string {
  const m = /^(\d+)(?:\.(\d{1,2}))?/.exec(gap);
  if (m === null) return gap;
  return `${m[1]}.${(m[2] ?? '').padEnd(2, '0')}`;
}
