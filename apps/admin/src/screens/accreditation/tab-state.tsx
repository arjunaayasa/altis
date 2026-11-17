import type { InstrumentsResponse, InstrumentView, PeriodView } from '@altis/shared/api/accreditation';
import type { ReactNode } from 'react';
import { RefetchProblem } from '@/components/form-field';
import { Callout, ErrorState, LoadingState } from '@/components/layout';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { useMe } from '@/lib/me';
import { instrumentOf, useInstruments, usePeriod } from './data';

/** What a workspace tab works with once its period and the instruments came. */
export interface TabContext {
  period: PeriodView;
  instruments: InstrumentsResponse;
  /** The period's instrument; undefined when this build does not have it. */
  instrument: InstrumentView | undefined;
  /** The user holds `accreditation.workspace.manage`. */
  canManage: boolean;
  /** The period's own data may change: a manager, on an open period. */
  canEdit: boolean;
}

/**
 * The common start of the workspace tabs: the period (the frame already read it, so this is the cached copy) and the
 * instruments; while either loads a status line, a read that failed its message and a retry; then `children` with
 * both and what the user may change. A frozen period's data is read only, whoever looks at it.
 */
export function TabState({ periodId, children }: { periodId: string; children(ctx: TabContext): ReactNode }) {
  const me = useMe();
  const period = usePeriod(periodId);
  const instruments = useInstruments();
  if (period.data === undefined || instruments.data === undefined) {
    const failed = period.data === undefined && period.isError ? period : instruments.isError ? instruments : null;
    if (failed !== null) return <ErrorState error={failed.error} onRetry={() => void failed.refetch()} retrying={failed.isFetching} />;
    return <LoadingState />;
  }
  const canManage = holds(me, 'accreditation.workspace.manage');
  return (
    <>
      <RefetchProblem query={period} />
      {children({
        period: period.data,
        instruments: instruments.data,
        instrument: instrumentOf(instruments.data, period.data.instrumentId),
        canManage,
        canEdit: canManage && period.data.status === 'open',
      })}
    </>
  );
}

/** Why a period's data is read only here, if it is: frozen, or the user may not change it. */
export function ReadOnlyNote({ ctx }: { ctx: TabContext }) {
  const t = useT();
  if (ctx.canEdit) return null;
  return (
    <Callout role="status" title={t(ctx.period.status === 'frozen' ? 'accreditation.workspace.form.frozen' : 'accreditation.workspace.form.read_only')} />
  );
}
