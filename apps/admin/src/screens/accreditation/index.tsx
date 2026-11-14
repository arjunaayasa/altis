import { vocabKey } from '@altis/shared';
import type { InstrumentView, PeriodView } from '@altis/shared/api/accreditation';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import type { ComponentType, JSX } from 'react';
import { PeriodPicker } from '@/components/accreditation/period-picker';
import { StatusLine } from '@/components/accreditation/status-line';
import { UnsavedChangesDialog } from '@/components/accreditation/unsaved-changes';
import { Badge, ProblemAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError } from '@/lib/api';
import { useUnsavedNavigationQuestion } from '@/lib/dirty-navigation';
import { useMe } from '@/lib/me';
import { useRealtime } from '@/lib/realtime';
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
 * dialog), such a navigation first asks "Perubahan belum disimpan" (lib/dirty-navigation.ts).
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
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('accreditation.title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('accreditation.description')}</p>
        </div>
        {canManage && (list?.length ?? 0) > 0 && (
          <Button asChild variant="outline">
            <Link to={`${BASE}/new`}>
              <PlusIcon aria-hidden="true" />
              {t('accreditation.new_period')}
            </Link>
          </Button>
        )}
      </div>
      {list !== undefined && list.length > 0 && <PeriodPicker periods={list} value={periodId} onChange={(id) => open(id, search.tab)} />}
    </header>
  );

  if (list === undefined) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        {periods.isError ? (
          <ProblemAlert error={periods.error}>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void periods.refetch()}>
              {t('table.retry')}
            </Button>
          </ProblemAlert>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )}
        {unsavedDialog}
      </div>
    );
  }

  if (list.length === 0 && given === undefined) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div className="flex max-w-xl flex-col items-start gap-3 rounded-lg border bg-card p-6 text-card-foreground">
          <h2 className="text-lg font-semibold">{t('accreditation.empty.title')}</h2>
          <p className="text-sm text-muted-foreground">{t(canManage ? 'accreditation.empty.text' : 'accreditation.empty.read_only')}</p>
          {canManage && (
            <Button asChild>
              <Link to={`${BASE}/new`}>
                <PlusIcon aria-hidden="true" />
                {t('accreditation.new_period')}
              </Link>
            </Button>
          )}
        </div>
        {unsavedDialog}
      </div>
    );
  }

  const p = period.data;
  let body: JSX.Element;
  if (p === undefined) {
    const missing = period.error instanceof ApiError && period.error.code === 'NOT_FOUND';
    body = missing ? (
      <p className="text-sm">{t('accreditation.not_found')}</p>
    ) : period.isError ? (
      <ProblemAlert error={period.error} />
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        {t('shell.loading')}
      </p>
    );
  } else {
    body = (
      <>
        <PeriodHeader period={p} instrument={instrumentOf(instruments.data, p.instrumentId)} />
        <StatusLine period={p} />
        {/* Manual activation: a tab opens on a click or Enter/Space, not when it merely gets the focus (an arrow key,
            or the focus coming back to it when "Perubahan belum disimpan" is answered with Batal). */}
        <Tabs value={tab} activationMode="manual" onValueChange={(value) => isAccreditationTab(value) && value !== tab && open(p.id, value)}>
          <TabsList aria-label={t('accreditation.tabs')} className="h-auto flex-wrap justify-start">
            {ACCREDITATION_TABS.map((k) => (
              <TabsTrigger key={k} value={k} className="flex-none">
                {t(TAB_LABELS[k])}
              </TabsTrigger>
            ))}
          </TabsList>
          {ACCREDITATION_TABS.map((k) => {
            const Screen = TAB_SCREENS[k];
            return (
              <TabsContent key={k} value={k} className="pt-2">
                {k === tab && <Screen periodId={p.id} />}
              </TabsContent>
            );
          })}
        </Tabs>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
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
    <div className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">{period.name}</h2>
        <Badge tone={period.status === 'frozen' ? 'warning' : 'neutral'}>{t(vocabKey('period_status', period.status))}</Badge>
      </div>
      {instrument === undefined ? (
        <p>{t('accreditation.instrument.unknown', { id: period.instrumentId })}</p>
      ) : (
        <p className="flex flex-wrap items-center gap-2">
          <span>{t('accreditation.instrument.line', { decree: instrument.decree, date: f.day(instrument.effectiveFrom) })}</span>
          {instrument.sourceStatus === 'P-copy' && <Badge>{t('accred.source.copy')}</Badge>}
          {instrument.sourceStatus === 'U' && <Badge>{t('accreditation.source.unverified')}</Badge>}
          {!instrument.scored && <Badge>{t('accreditation.instrument.unscored')}</Badge>}
        </p>
      )}
      <p className="text-muted-foreground">
        {t('accreditation.period.span', { kind: t(vocabKey('period_kind', period.kind)), from: f.day(period.startsOn), to: f.day(period.endsOn) })}
      </p>
    </div>
  );
}
