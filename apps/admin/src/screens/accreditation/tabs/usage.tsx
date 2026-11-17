import type { UsageGridView } from '@altis/shared/api/accreditation';
import { useId, useState, type JSX } from 'react';
import { GroupMap } from '@/components/accreditation/usage/group-map';
import { UsageGrid } from '@/components/accreditation/usage/grid';
import { ImportWizard } from '@/components/accreditation/usage/import-wizard';
import { UnsavedChangesDialog, hasUnsavedChanges } from '@/components/accreditation/unsaved-changes';
import { accredKeys, accredPaths, useInstruments, usePeriod } from '@/components/accreditation/usage/queries';
import { useDateTime } from '@/components/data-table';
import { Notice, NoticeAlert, RefetchProblem } from '@/components/form-field';
import { LoadingState } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';

/**
 * The workspace tab Penggunaan Bulanan (spec §6, §10.7): the last SLiMS import with its cut-over date, the grid of
 * months × metrics with the source of every cell (manual entries edited in place while the period is open), the
 * metrics of the whole period, the mapping of the SLiMS member types and of the members SLiMS deleted, and "Impor dari
 * SLiMS", which takes the tab's place while it is open. Editing and importing need `accreditation.workspace.manage`; a
 * frozen period locks the manual entries (the mapping and the import are not the period's, so they stay open). The
 * import takes the grid's place, so while the grid holds unsaved cells "Impor dari SLiMS" asks first ("Perubahan belum
 * disimpan").
 */
export function UsageTab({ periodId }: { periodId: string }): JSX.Element {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const titleId = useId();
  const canManage = holds(me, 'accreditation.workspace.manage');
  const period = usePeriod(periodId);
  const instruments = useInstruments();
  const grid = useApiQuery<UsageGridView>({ queryKey: accredKeys.usage(periodId), path: accredPaths.usage(periodId) });
  const [importing, setImporting] = useState(false);
  // "Impor dari SLiMS" pressed while a form of the tab (the grid's cells) holds unsaved changes: the question is open.
  const [asking, setAsking] = useState(false);
  const openImport = (): void => (hasUnsavedChanges() ? setAsking(true) : setImporting(true));

  const config = instruments.data?.config;
  const configKnown = instruments.data !== undefined || instruments.isError;

  let body: JSX.Element;
  if (period.data === undefined || grid.data === undefined) {
    const error = period.error ?? grid.error;
    body =
      period.isError || grid.isError ? (
        <Notice kind="error">{problemText(t, error)}</Notice>
      ) : (
        <LoadingState />
      );
  } else if (importing) {
    const lastImport = grid.data.lastImport ?? period.data.lastUsageImport;
    body = (
      <ImportWizard
        periodId={periodId}
        defaultCutover={lastImport?.cutoverOn ?? config?.liveFrom ?? null}
        unknownDefault={config?.unknownMemberGroupDefault ?? null}
        onClose={() => setImporting(false)}
      />
    );
  } else {
    const frozen = period.data.status === 'frozen';
    const lastImport = grid.data.lastImport ?? period.data.lastUsageImport;
    body = (
      <div className="grid min-w-0 gap-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-0.5 text-sm">
            {lastImport === null ? (
              <p className="text-muted-foreground">{t('accreditation.usage.no_import')}</p>
            ) : (
              <>
                <p>{t('accreditation.usage.last_import', { date: dateTime(lastImport.finishedAt) })}</p>
                <p className="text-muted-foreground">
                  {lastImport.cutoverOn === null
                    ? t('accreditation.usage.last_import_no_cutover')
                    : t('accreditation.usage.last_import_cutover', { date: lastImport.cutoverOn })}
                </p>
              </>
            )}
          </div>
          {canManage && configKnown && (
            <Button type="button" variant="outline" onClick={openImport}>
              {t('accreditation.usage.import_open')}
            </Button>
          )}
        </div>
        {frozen && <NoticeAlert>{t('accreditation.usage.frozen')}</NoticeAlert>}
        {!canManage && <p className="text-sm text-muted-foreground">{t('accreditation.usage.read_only')}</p>}
        <RefetchProblem query={grid} />
        <UsageGrid periodId={periodId} grid={grid.data} span={{ from: period.data.startsOn, to: period.data.endsOn }} editable={canManage && !frozen} />
        {configKnown && <GroupMap editable={canManage} unknownDefault={config?.unknownMemberGroupDefault ?? null} periodId={periodId} />}
      </div>
    );
  }

  return (
    <section aria-labelledby={titleId} data-period-id={periodId} className="grid min-w-0 gap-4">
      <div className="grid max-w-[75ch] gap-1">
        <h2 id={titleId} className="text-base font-bold">
          {t('accreditation.usage.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('accreditation.usage.intro')}</p>
      </div>
      {body}
      <UnsavedChangesDialog open={asking} onLeave={() => setImporting(true)} onStay={() => setAsking(false)} />
    </section>
  );
}
