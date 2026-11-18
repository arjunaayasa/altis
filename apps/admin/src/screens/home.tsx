import { Link } from '@tanstack/react-router';
import { ScanBarcodeIcon, UserPlusIcon } from 'lucide-react';
import { useMemo } from 'react';
import { paletteShortcut } from '@/components/shell/app-shell';
import { PageHeader } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useLocale, useT } from '@/i18n';
import { holds } from '@/lib/access';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { SystemHealth } from '@/screens/dashboard';
import { Attention, useAttentionItems, useAttentionSources } from '@/screens/dashboard-attention';
import { DeskActivity } from '@/screens/dashboard-activity';
// ---- Komunitas (member, visit and circulation reports) ----
import { TodayStrip, useDeskToday, useLibraryToday } from '@/screens/dashboard-today';
import { UsageBlocks } from '@/screens/dashboard-usage';

/**
 * Beranda: the first screen after signing in. Its header (the way to a new member and to the desk on the right) with today's date, today's opening hours (as the public home
 * page shows them; none set: nothing), the desk's branch when the user serves at more than one, and a welcome; then,
 * each only for a user who may read it:
 *
 * 1. the strip of today's figures (screens/dashboard-today.tsx);
 * 2. the desk's activity per hour today beside "Perlu perhatian" (dashboard-activity.tsx, dashboard-attention.tsx);
 * 3. the loans by subject, the most borrowed titles (dashboard-usage.tsx) and "Kesehatan sistem" (dashboard.tsx), in
 *    one row of equal columns.
 *
 * The library's yearly figures are on the reports page (dashboard-library.tsx, shown by screens/reports/catalog.tsx);
 * a reader of one of them gets a line under the last row that says so, with the link. Every figure of the system is
 * on Tentang (the health card's "Detail").
 *
 * A row falls back to fewer columns when one of its blocks is not there, and to one column below 1060 px. A user who sees
 * none of the library blocks gets the hint that the command palette finds pages and commands.
 */

/** A calendar date `YYYY-MM-DD` as a long date with its weekday, in the UI language. */
function useLongDate(): (day: string) => string {
  const locale = useLocale();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    return (day: string) => {
      const at = Date.parse(`${day}T12:00:00Z`);
      return Number.isNaN(at) ? day : format.format(at);
    };
  }, [locale]);
}

/** Today in the browser's calendar, `YYYY-MM-DD` (until the server has said what today is). */
function browserToday(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Beranda (see the top of this file). */
export function HomeScreen() {
  const t = useT();
  const me = useMe();
  const longDate = useLongDate();
  const name = me?.authenticated === true ? me.user.name : '';
  const { desk, query: deskQuery } = useDeskToday();
  const library = useLibraryToday();
  const attention = useAttentionItems();
  const attentionSources = useAttentionSources();

  const deskBranch = desk.branches?.find((b) => b.id === desk.branchId);
  const today = library.data?.today ?? deskQuery.data?.on ?? browserToday();
  // ---- Komunitas (staff screens' data): today's opening hours, as the public home page has them ----
  const open = library.data?.openToday ?? null;
  const hours = open === null ? [] : open.closed ? [t('dashboard.home.closed_today')] : open.times.length > 0 ? [t('dashboard.home.open_today', { hours: open.times.join(', ') })] : [];
  const lead = [longDate(today), ...hours, ...(deskBranch !== undefined && (desk.branches?.length ?? 0) > 1 ? [t('dashboard.today.branch', { name: deskBranch.name })] : [])];
  const addsMembers = holds(me, 'members.records.manage');
  const readsFigures = holds(me, 'catalog.records.read') || holds(me, 'members.records.read') || holds(me, 'visits.records.read') || holds(me, 'circulation.records.read');
  const hasActivity = desk.branchId !== null;
  const hasAttention = attention.length > 0 || attentionSources.reads;
  const seesLibrary =
    desk.branchId !== null || holds(me, 'members.records.read') || holds(me, 'circulation.records.read') || holds(me, 'reports.statistics.read') || hasAttention;

  return (
    <div className="grid gap-4" data-home="">
      <PageHeader
        title={t('nav.home')}
        description={
          <>
            {lead.join(' · ')} · <span>{t('home.welcome', { name })}</span>
          </>
        }
        actions={
          addsMembers || desk.branchId !== null ? (
            <>
              {addsMembers && (
                <Button asChild variant="outline">
                  <Link to="/admin/anggota/baru">
                    <UserPlusIcon aria-hidden="true" />
                    {t('members.add')}
                  </Link>
                </Button>
              )}
              {desk.branchId !== null && (
                <Button asChild>
                  <Link to="/admin/layanan">
                    <ScanBarcodeIcon aria-hidden="true" />
                    {t('dashboard.home.open_desk')}
                  </Link>
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      {!seesLibrary && <p className="text-muted-foreground">{t('home.intro', { shortcut: paletteShortcut() })}</p>}
      <TodayStrip />
      {(hasActivity || hasAttention) && (
        <div className={cn('grid gap-4', hasActivity && hasAttention && 'min-[1060px]:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]')}>
          <DeskActivity />
          <Attention items={attention} sources={attentionSources} />
        </div>
      )}
      <div className="grid gap-4 min-[1060px]:auto-cols-fr min-[1060px]:grid-flow-col">
        <UsageBlocks />
        <SystemHealth />
      </div>
      {readsFigures && (
        <p className="text-meta text-muted-foreground" data-figures-moved="">
          {t('dashboard.home.figures_moved')}{' '}
          <Link to="/admin/reports" className="font-semibold text-accent-text underline-offset-4 hover:underline">
            {t('dashboard.library.reports')}
          </Link>
        </p>
      )}
    </div>
  );
}
