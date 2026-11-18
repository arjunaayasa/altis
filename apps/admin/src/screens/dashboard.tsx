import type { BackupItem } from '@altis/shared/api/backups';
import type { EditionView } from '@altis/shared';
import type { DashboardResponse, DashboardRunMode } from '@altis/shared/api/dashboard';
import { Link } from '@tanstack/react-router';
import { useCallback, useId, type ReactNode } from 'react';
import { useDateTime } from '@/components/data-table';
import { ProblemAlert } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { editionName } from '@/edition';
import { useLocale, useT, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { isServerPage } from '@/lib/api';
import { useApiQuery, useMe } from '@/lib/me';
import { cn } from '@/lib/utils';

/**
 * Dasbor sistem (spec §13.3 "Versi/update, backup terakhir, antrean, penjadwal, peringatan"; route
 * `dashboard.get`), shown on Beranda (screens/home.tsx) to every staff member, as its last section, "Sistem". `GET dashboard` leaves out what the caller may not see, so the section shows one card per section the
 * answer carries:
 *
 * - the alerts are lines of Beranda's "Perlu perhatian" (screens/dashboard-attention.tsx), each with its message
 *   (`alert.<kind>`) and the page that explains or fixes it (`runner_stale` → Diagnostik; `ops_attention` → the
 *   operations page, a server page that is loaded, never routed);
 * - Versi (everyone's: the versions and the edition, "Edisi Komunitas"), Pembaruan (`version.update`, 1d Task 29: the
 *   last update check, linking to `/admin/updates`), Cadangan terakhir (with `system.backup.read`: the answer's
 *   `lastBackup` is null both without the permission and without a backup, so the permission decides the card),
 *   Antrean tugas (`queue`) and Penjadwal (`scheduler`).
 *
 * It is read again when an event arrives on `system.status` (every staff member's) or, for a backup reader,
 * `system.backup` (§10.7), except the many `*.progress` hints of a running job or backup: the shell reads those
 * channels for every screen and makes {@link DASHBOARD_KEY} stale (lib/realtime.ts `realtimeQueryKeys`). It is also
 * read every minute while the tab is visible, because a runner going quiet raises `runner_stale` without any event.
 * Those reads are background reads (`X-Altis-Background`): a dashboard left open does not keep the session alive.
 */

/** The React Query key of the dashboard (the shell makes it stale on events, lib/realtime.ts `realtimeQueryKeys`). */
export const DASHBOARD_KEY = ['dashboard'] as const;

/** How often an open dashboard reads itself again. */
const REFRESH_MS = 60_000;

const RUN_MODES: readonly DashboardRunMode[] = ['worker', 'cron_cli', 'cron_http', 'drive', 'piggyback'];

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** `bytes` in binary units (1 KB = 1024 B), one decimal at most, in the UI language. */
function useBytes(): (bytes: number) => string {
  const locale = useLocale();
  return useCallback(
    (bytes: number) => {
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
      }
      const n = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID', { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
      return `${n} ${UNITS[unit]}`;
    },
    [locale],
  );
}

/** A calendar date `YYYY-MM-DD` as a long date in the UI language. */
function useDay(): (day: string) => string {
  const locale = useLocale();
  return useCallback(
    (day: string) => {
      const date = new Date(`${day}T00:00:00`);
      return Number.isNaN(date.getTime()) ? day : new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'long' }).format(date);
    },
    [locale],
  );
}

/** A duration in its largest whole unit (seconds below a minute, ..., days from 48 hours). */
function duration(t: Translate, ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t('dashboard.duration.seconds', { count: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('dashboard.duration.minutes', { count: m });
  const h = Math.floor(m / 60);
  if (h < 48) return t('dashboard.duration.hours', { count: h });
  return t('dashboard.duration.days', { count: Math.floor(h / 24) });
}

/** A link to an admin page: the operations page is loaded (a server page), any other one routed. */
export function PageLink({ to, search, children, className }: { to: string; search?: Record<string, string | number | boolean>; children: ReactNode; className?: string }) {
  if (isServerPage(to)) {
    return (
      <a href={to} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link to={to} search={search} className={className}>
      {children}
    </Link>
  );
}

/** The system dashboard, read as Beranda reads it (shared by its sections: the same query). */
export function useSystemDashboard() {
  return useApiQuery<DashboardResponse>({
    queryKey: DASHBOARD_KEY,
    path: 'dashboard',
    request: { background: true },
    refetchInterval: REFRESH_MS,
  });
}

/** A dashboard card: a titled region. */
function Card({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('flex flex-col gap-3 rounded-lg border bg-background p-4', className)}>
      <h3 id={id} className="text-heading font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** A label and its value, inside a card's `<dl>`. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

/** The link at the bottom of a card. */
function CardLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <PageLink to={to} className="mt-auto self-start text-sm font-semibold text-accent-text underline-offset-4 hover:underline">
      {children}
    </PageLink>
  );
}

function VersionCard({ version, edition }: { version: DashboardResponse['version']; edition: EditionView }) {
  const t = useT();
  return (
    <Card title={t('dashboard.version.title')}>
      <dl className="flex flex-col gap-2">
        <Row label={t('dashboard.version.edition')}>{editionName(t, edition.edition)}</Row>
        <Row label={t('dashboard.version.current')}>{version.current}</Row>
        <Row label={t('dashboard.version.app_js')}>{version.appJs ?? t('dashboard.version.unknown')}</Row>
        <Row label={t('dashboard.version.boot_protocol')}>{version.bootProtocol}</Row>
      </dl>
    </Card>
  );
}

/**
 * Pembaruan (1d Task 29, moved here from Task 30 by preflight S13; `system.update.read`): the release the last check
 * found (and whether it is a stepping stone), when it checked, whether this edition covers it (`entitled`; always in
 * the community edition), a pin, image mode, and the way to the Pembaruan page, where the update is applied.
 */
function UpdateCard({ update }: { update: NonNullable<DashboardResponse['version']['update']> }) {
  const t = useT();
  const day = useDay();
  const dateTime = useDateTime();
  const { available } = update;
  return (
    <Card title={t('dashboard.update.title')}>
      <dl className="flex flex-col gap-2">
        <Row label={t('dashboard.update.available')}>
          {available === null ? t('dashboard.update.none') : <span className="font-mono">{available.version}</span>}
        </Row>
        {available !== null && <Row label={t('dashboard.update.released')}>{day(available.releasedAt)}</Row>}
        <Row label={t('dashboard.update.checked')}>{update.checkedAt === null ? t('dashboard.update.never') : dateTime(update.checkedAt)}</Row>
        {update.pinned !== null && (
          <Row label={t('dashboard.update.pinned')}>
            <span className="font-mono">{update.pinned}</span>
          </Row>
        )}
      </dl>
      {available?.steppingStone === true && <p className="text-sm text-muted-foreground">{t('update.precheck.stepping_stone')}</p>}
      {!update.entitled && (
        <p className="text-sm text-bad">{t(available === null ? 'dashboard.update.ended' : 'dashboard.update.not_entitled')}</p>
      )}
      {!update.oneClick && <p className="text-sm text-muted-foreground">{t('dashboard.update.image')}</p>}
      <CardLink to="/admin/updates">{t('dashboard.update.open')}</CardLink>
    </Card>
  );
}

function BackupCard({ backup, nextAt }: { backup: BackupItem | null; nextAt: number | null }) {
  const t = useT();
  const dateTime = useDateTime();
  const bytes = useBytes();
  return (
    <Card title={t('dashboard.backup.title')}>
      {backup === null ? (
        <p className="text-sm text-muted-foreground">{t('dashboard.backup.none')}</p>
      ) : (
        <dl className="flex flex-col gap-2">
          <Row label={t('dashboard.backup.status')}>
            <span className={backup.status === 'failed' ? 'text-bad' : undefined}>{t(`dashboard.backup.status.${backup.status}`)}</span>
          </Row>
          <Row label={t('dashboard.backup.kind')}>{t(`dashboard.backup.kind.${backup.kind}`)}</Row>
          <Row label={t('dashboard.backup.created')}>{dateTime(backup.createdAt)}</Row>
          {backup.size !== null && <Row label={t('dashboard.backup.size')}>{bytes(backup.size)}</Row>}
        </dl>
      )}
      <dl className="flex flex-col gap-2">
        <Row label={t('dashboard.backup.next')}>{nextAt === null ? t('dashboard.backup.next_off') : dateTime(nextAt)}</Row>
      </dl>
      <CardLink to="/admin/backups">{t('dashboard.backup.open')}</CardLink>
    </Card>
  );
}

function QueueCard({ queue }: { queue: NonNullable<DashboardResponse['queue']> }) {
  const t = useT();
  const stat = (label: string, value: number, tone?: string) => (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('text-2xl font-semibold tabular-nums', tone)}>{value}</dd>
    </div>
  );
  return (
    <Card title={t('dashboard.queue.title')}>
      <dl className="grid grid-cols-3 gap-2">
        {stat(t('dashboard.queue.queued'), queue.queued)}
        {stat(t('dashboard.queue.running'), queue.running)}
        {stat(t('dashboard.queue.dead'), queue.dead, queue.dead > 0 ? 'text-bad' : undefined)}
      </dl>
      {queue.oldestQueuedMs !== null && (
        <p className="text-sm text-muted-foreground">{t('dashboard.queue.oldest', { duration: duration(t, queue.oldestQueuedMs) })}</p>
      )}
      <CardLink to="/admin/jobs">{t('dashboard.queue.open')}</CardLink>
    </Card>
  );
}

function SchedulerCard({ scheduler }: { scheduler: NonNullable<DashboardResponse['scheduler']> }) {
  const t = useT();
  const dateTime = useDateTime();
  const runs = RUN_MODES.flatMap((mode) => {
    const at = scheduler.runner.lastRuns[mode];
    return at === undefined ? [] : [{ mode, at }];
  });
  const enabled = scheduler.schedules.filter((s) => s.enabled).length;
  return (
    <Card title={t('dashboard.scheduler.title')}>
      <dl className="flex flex-col gap-2">
        <Row label={t('dashboard.scheduler.mode')}>{t(`dashboard.scheduler.mode.${scheduler.runner.mode}`)}</Row>
        <div className="flex flex-col gap-1">
          <dt className="text-sm text-muted-foreground">{t('dashboard.scheduler.last_runs')}</dt>
          {runs.length === 0 ? (
            <dd className="text-sm font-medium">{t('dashboard.scheduler.never')}</dd>
          ) : (
            runs.map(({ mode, at }) => (
              <dd key={mode} className="flex flex-wrap justify-between gap-x-4 text-sm">
                <span>{t(`dashboard.scheduler.run.${mode}`)}</span>
                <time dateTime={new Date(at).toISOString()} className="font-medium">
                  {dateTime(at)}
                </time>
              </dd>
            ))
          )}
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">{t('dashboard.scheduler.schedules', { enabled, total: scheduler.schedules.length })}</p>
      <CardLink to="/admin/jobs/schedules">{t('dashboard.scheduler.open')}</CardLink>
    </Card>
  );
}

/** The system dashboard (Beranda's last section, "Sistem"). */
export function Dashboard() {
  const t = useT();
  const me = useMe();
  const headingId = useId();
  const query = useSystemDashboard();
  const readsBackups = holds(me, 'system.backup.read');

  const data = query.data;
  let body: ReactNode;
  if (data === undefined) {
    body = query.isError ? (
      <ProblemAlert error={query.error}>
        <p>{t('dashboard.load_failed')}</p>
        <Button variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}>
          {t('table.retry')}
        </Button>
      </ProblemAlert>
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        {t('shell.loading')}
      </p>
    );
  } else {
    body = (
      <div aria-label={t('dashboard.label')} role="group" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <VersionCard version={data.version} edition={data.edition} />
        {data.version.update !== null && <UpdateCard update={data.version.update} />}
        {readsBackups && <BackupCard backup={data.lastBackup} nextAt={data.nextBackupAt} />}
        {data.queue !== null && <QueueCard queue={data.queue} />}
        {data.scheduler !== null && <SchedulerCard scheduler={data.scheduler} />}
      </div>
    );
  }
  return (
    <section aria-labelledby={headingId} className="mt-2 flex flex-col gap-3" data-system-dashboard="">
      <h2 id={headingId} className="text-heading font-semibold">
        {t('dashboard.home.system.title')}
      </h2>
      {body}
    </section>
  );
}
