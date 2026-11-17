import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { paletteShortcut } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { useLocale, useT } from '@/i18n';
import { holds } from '@/lib/access';
import { useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { Dashboard } from '@/screens/dashboard';
import { Attention, useAttentionItems } from '@/screens/dashboard-attention';
import { DeskActivity } from '@/screens/dashboard-activity';
// ---- Komunitas K5 (reports) ----
import { LibraryStatistics } from '@/screens/dashboard-library';
// ---- Komunitas (member, visit and circulation reports) ----
import { TodayStrip, useDeskToday, useLibraryToday } from '@/screens/dashboard-today';
import { UsageBlocks } from '@/screens/dashboard-usage';

/**
 * Beranda: the first screen after signing in. Its title with today's date, the desk's branch when the user serves at
 * more than one, and a welcome; then, each only for a user who may read it:
 *
 * 1. the strip of today's figures (screens/dashboard-today.tsx);
 * 2. the desk's activity per hour today beside "Perlu perhatian" (dashboard-activity.tsx, dashboard-attention.tsx);
 * 3. the loans by subject beside the most borrowed titles (dashboard-usage.tsx);
 * 4. the library's statistics (dashboard-library.tsx) and the system section (dashboard.tsx).
 *
 * A two-column row falls back to one column when one of its blocks is not there, and below 1024 px. A user who sees
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

  const deskBranch = desk.branches?.find((b) => b.id === desk.branchId);
  const today = library.data?.today ?? deskQuery.data?.on ?? browserToday();
  const lead = [longDate(today), ...(deskBranch !== undefined && (desk.branches?.length ?? 0) > 1 ? [t('dashboard.today.branch', { name: deskBranch.name })] : [])];
  const hasActivity = desk.branchId !== null;
  const hasAttention = attention.length > 0;
  const seesLibrary =
    desk.branchId !== null || holds(me, 'members.records.read') || holds(me, 'circulation.records.read') || holds(me, 'reports.statistics.read') || hasAttention;

  return (
    <div className="flex flex-col gap-6" data-home="">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl leading-snug font-bold">{t('nav.home')}</h1>
          <p className="text-muted-foreground">
            {lead.join(' · ')} · <span>{t('home.welcome', { name })}</span>
          </p>
          {!seesLibrary && <p className="text-muted-foreground">{t('home.intro', { shortcut: paletteShortcut() })}</p>}
        </div>
        {desk.branchId !== null && (
          <Button asChild>
            <Link to="/admin/layanan">{t('dashboard.home.open_desk')}</Link>
          </Button>
        )}
      </div>
      <TodayStrip />
      {(hasActivity || hasAttention) && (
        <div className={cn('grid gap-8', hasActivity && hasAttention && 'lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]')}>
          <DeskActivity />
          <Attention items={attention} />
        </div>
      )}
      <UsageBlocks />
      <LibraryStatistics />
      <Dashboard />
    </div>
  );
}
