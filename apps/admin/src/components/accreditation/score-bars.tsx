import type { ScoreView } from '@altis/shared/api/accreditation';
import { useId, type JSX } from 'react';
import { useT } from '@/i18n';
import { componentLabel, useFormats } from '@/screens/accreditation/data';

/**
 * One bar per component of the estimate: the points its answered indicators reached out of their maximum (unanswered
 * ones count 1, as for the lower bound), with the component's weight. Each bar is a meter named after its component.
 */
export function ScoreBars({ score }: { score: ScoreView }): JSX.Element {
  const t = useT();
  const f = useFormats();
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3">
      <h3 id={titleId} className="font-semibold">
        {t('accreditation.workspace.bars.title')}
      </h3>
      <ul className="grid gap-3">
        {score.perComponent.map((c) => {
          const label = componentLabel(t, c.code);
          const pct = c.max > 0 ? Math.max(0, Math.min(100, (c.sum / c.max) * 100)) : 0;
          return (
            <li key={c.code} className="grid gap-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span>{label}</span>
                <span className="text-muted-foreground tabular-nums">
                  {t('accreditation.workspace.bars.value', { sum: f.number(c.sum), max: f.number(c.max), weight: f.number(c.weight) })}
                </span>
              </div>
              <div
                role="meter"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={c.max}
                aria-valuenow={c.sum}
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
