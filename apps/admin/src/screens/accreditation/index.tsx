import { vocabKey } from '@altis/shared';
import type { InstrumentView, PeriodView } from '@altis/shared/api/accreditation';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type { ComponentType, JSX } from 'react';
import { PeriodPicker } from '@/components/accreditation/period-picker';
import { StatusLine } from '@/components/accreditation/status-line';
import { UnsavedChangesDialog } from '@/components/accreditation/unsaved-changes';
import { EmptyState, ErrorState, LoadingState, PageHead, Tag } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger, WRAPPING_TABS } from '@/components/ui/tabs';
import { useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError } from '@/lib/api';
import { useUnsavedNavigationQuestion } from '@/lib/dirty-navigation';
import { useMe } from '@/lib/me';
import { useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';
import { accreditationEventKeys, instrumentOf, useFormats, useInstruments, usePeriod, usePeriods } from './data';
import { ACCREDITATION_TABS, isAccreditationTab, validateAccreditationSearch, type AccreditationTab } from './search';
import { HistoryTab } from './tabs/history';
import { IndicatorsTab } from './tabs/indicators';
import { PopulationTab } from './tabs/population';
import { PrintTab } from './tabs/print';
import { ProfileTab } from './tabs/profile';
import { RegistersTab } from './tabs/registers';
import { SnpTab } from './tabs/snp';
import { SummaryTab } from './tabs/summary';
import { UsageTab } from './tabs/usage';

/**
 * Akreditasi (spec §6 "Akreditasi", §10.2, §10.4, §10.12): `/admin/accreditation` opens the latest period,
 * `/admin/accreditation/$periodId?tab=` one period on one of its tabs.
 *
 * - The period picker (every live period, newest first; a frozen one marked) and, for a manager, "Periode baru".
 * - The period's instrument with its decree and source status (a copy not yet compared with the official gazette says
 *   so), its kind and span, and its status.
 * - The status line (status-line.tsx): the last catalogue sync from SLiMS with the way to the migration wizard in sync
 *   mode, when the results were computed, the stale mark, "Hitung ulang" with its job, and the reminder that catalogue
 *   edits are not tracked.
 * - The tabs, kept in the `tab` search param: Ringkasan, Indikator, Profil, Populasi & Sarana, Register, Penggunaan
 *   Bulanan, Kepatuhan SNP, Cetak, Riwayat.
 *
 * The screen listens on the `accreditation` channel: new results of a period read every period query again.
 *
 * A tab shows only while it is open, so another tab, another period or a link out of the workspace unmounts what it
 * holds. While one of its forms has unsaved changes (Profil, Populasi & Sarana, the usage grid, an open register
 * panel), such a navigation first asks "Perubahan belum disimpan" (lib/dirty-navigation.ts).
 */

const BASE = '/admin/accreditation';

/** The tab components, by the tab that shows them. */
const TAB_SCREENS: Readonly<Record<AccreditationTab, ComponentType<{ periodId: string }>>> = {
  ringkasan: SummaryTab,
  indikator: IndicatorsTab,
  profil: ProfileTab,
  populasi: PopulationTab,
  register: RegistersTab,
  penggunaan: UsageTab,
  snp: SnpTab,
  cetak: PrintTab,
  riwayat: HistoryTab,
};

const TAB_LABELS: Readonly<Record<AccreditationTab, TKey>> = {
  ringkasan: 'accreditation.tab.ringkasan',
  indikator: 'accreditation.tab.indikator',
  profil: 'accreditation.tab.profil',
  populasi: 'accreditation.tab.populasi',
  register: 'accreditation.tab.register',
  penggunaan: 'accreditation.tab.penggunaan',
  snp: 'accreditation.tab.snp',
  cetak: 'accreditation.tab.cetak',
  riwayat: 'accreditation.tab.riwayat',
};

export function AccreditationScreen(): JSX.Element {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { periodId: given } = useParams({ strict: false }) as { periodId?: string };
  const search = validateAccreditationSearch(useSearch({ strict: false }));
  const tab: AccreditationTab = search.tab ?? 'ringkasan';
  const canManage = holds(me, 'accreditation.workspace.manage');
  const periods = usePeriods();
  const instruments = useInstruments();
  const list = periods.data?.periods;
  const periodId = given ?? list?.[0]?.id ?? '';
  const period = usePeriod(periodId);
  const unsaved = useUnsavedNavigationQuestion();
  const unsavedDialog = <UnsavedChangesDialog open={unsaved !== null} onLeave={() => unsaved?.leave()} onStay={() => unsaved?.stay()} />;

  // New results of a period: every period query is read again.
  useRealtime(holds(me, 'accreditation.workspace.read') ? ['accreditation'] : [], (e) => {
    for (const queryKey of accreditationEventKeys(e)) void queryClient.invalidateQueries({ queryKey });
  });

  const open = (id: string, next: AccreditationTab | undefined): void => {
    void navigate({ to: `${BASE}/${encodeURIComponent(id)}`, search: next === undefined ? {} : { tab: next } });
  };

  const header = (
    <>
      <PageHead
        title={t('accreditation.title')}
        intro={t('accreditation.description')}
        actions={
          canManage && (list?.length ?? 0) > 0 ? (
            <Button asChild variant="outline">
              <Link to={`${BASE}/new`}>{t('accreditation.new_period')}</Link>
            </Button>
          ) : undefined
        }
      />
      {list !== undefined && list.length > 0 && <PeriodPicker periods={list} value={periodId} onChange={(id) => open(id, search.tab)} />}
    </>
  );

  if (list === undefined) {
    return (
      <div className="grid gap-6">
        {header}
        {periods.isError ? <ErrorState error={periods.error} onRetry={() => void periods.refetch()} retrying={periods.isFetching} /> : <LoadingState />}
        {unsavedDialog}
      </div>
    );
  }

  if (list.length === 0 && given === undefined) {
    return (
      <div className="grid gap-6">
        {header}
        <EmptyState
          title={t('accreditation.empty.title')}
          actions={
            canManage ? (
              <Button asChild>
                <Link to={`${BASE}/new`}>{t('accreditation.new_period')}</Link>
              </Button>
            ) : undefined
          }>
          <p>{t(canManage ? 'accreditation.empty.text' : 'accreditation.empty.read_only')}</p>
        </EmptyState>
        {unsavedDialog}
      </div>
    );
  }

  const p = period.data;
  let body: JSX.Element;
  if (p === undefined) {
    const missing = period.error instanceof ApiError && period.error.code === 'NOT_FOUND';
    body = missing ? (
      <EmptyState title={t('accreditation.not_found')} />
    ) : period.isError ? (
      <ErrorState error={period.error} onRetry={() => void period.refetch()} retrying={period.isFetching} />
    ) : (
      <LoadingState />
    );
  } else {
    body = (
      <>
        <PeriodHeader period={p} instrument={instrumentOf(instruments.data, p.instrumentId)} />
        <StatusLine period={p} />
        {/* Manual activation: a tab opens on a click or Enter/Space, not when it merely gets the focus (an arrow key,
            or the focus coming back to it when "Perubahan belum disimpan" is answered with Batal). */}
        <Tabs value={tab} activationMode="manual" onValueChange={(value) => isAccreditationTab(value) && value !== tab && open(p.id, value)}>
          <TabsList aria-label={t('accreditation.tabs')} className={WRAPPING_TABS.list}>
            {ACCREDITATION_TABS.map((k) => (
              <TabsTrigger key={k} value={k} className={cn('flex-none', WRAPPING_TABS.trigger)}>
                {t(TAB_LABELS[k])}
              </TabsTrigger>
            ))}
          </TabsList>
          {ACCREDITATION_TABS.map((k) => {
            const Screen = TAB_SCREENS[k];
            return (
              <TabsContent key={k} value={k} className="pt-4">
                {k === tab && <Screen periodId={p.id} />}
              </TabsContent>
            );
          })}
        </Tabs>
      </>
    );
  }

  return (
    <div className="grid gap-6">
      {header}
      {body}
      {unsavedDialog}
    </div>
  );
}

/** The period's instrument (decree, source status, whether it is scored), its kind and span, and its status. */
function PeriodHeader({ period, instrument }: { period: PeriodView; instrument: InstrumentView | undefined }) {
  const t = useT();
  const f = useFormats();
  return (
    <div className="grid gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-bold">{period.name}</h2>
        <Tag tone={period.status === 'frozen' ? 'warn' : 'neutral'}>{t(vocabKey('period_status', period.status))}</Tag>
      </div>
      {instrument === undefined ? (
        <p>{t('accreditation.instrument.unknown', { id: period.instrumentId })}</p>
      ) : (
        <p className="flex flex-wrap items-center gap-2">
          <span>{t('accreditation.instrument.line', { decree: instrument.decree, date: f.day(instrument.effectiveFrom) })}</span>
          {instrument.sourceStatus === 'P-copy' && <Tag>{t('accred.source.copy')}</Tag>}
          {instrument.sourceStatus === 'U' && <Tag>{t('accreditation.source.unverified')}</Tag>}
          {!instrument.scored && <Tag>{t('accreditation.instrument.unscored')}</Tag>}
        </p>
      )}
      <p className="text-muted-foreground">
        {t('accreditation.period.span', { kind: t(vocabKey('period_kind', period.kind)), from: f.day(period.startsOn), to: f.day(period.endsOn) })}
      </p>
    </div>
  );
}
