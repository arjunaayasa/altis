import type { Permission } from '@altis/shared';
import { Link } from '@tanstack/react-router';
import { useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { useMe } from '@/lib/me';

/**
 * A line of links from a working screen to the reports that print or export its rows (the overdue list, the cash book,
 * the visits): each one only for a user who may open that report. The report page itself checks again.
 */
export function ReportLinks({ reports }: { reports: readonly { id: string; permission: Permission }[] }) {
  const t = useT();
  const me = useMe();
  const shown = reports.filter((r) => holds(me, r.permission));
  if (shown.length === 0) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm print:hidden" data-report-links="">
      <span className="text-muted-foreground">{t('reportLinks.label')}</span>
      {shown.map((r) => (
        <Link key={r.id} to={`/admin/reports/${encodeURIComponent(r.id)}`} className="text-primary underline-offset-4 hover:underline">
          {t(`report.${r.id}.title` as TKey)}
        </Link>
      ))}
    </p>
  );
}
