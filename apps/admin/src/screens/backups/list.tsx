import type { BackupCreateResponse, BackupItem, BackupListResponse } from '@altis/shared/api/backups';
import { useQueryClient } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useId, useMemo, useState } from 'react';
import { DataTable, useDateTime } from '@/components/data-table';
import { CheckField, Notice } from '@/components/form-field';
import { ErrorState, MoreMenu, MoreMenuItem, PageHead, SectionHead, SkeletonTable, Tag, type TagTone } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, OPS_PAGE_PATH, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { page } from '@/lib/page';
import { useRealtime } from '@/lib/realtime';
import { ProgressBar } from '@/screens/jobs/list';
import { PrepareDownloadDialog } from './prepare-dialog';
import { RestoreDialog } from './restore-dialog';
import { UploadPanel, useBytes } from './upload';

/**
 * Cadangan (spec §13.3 "Backup: Daftar, buat sekarang, siapkan unduhan (frasa sandi), unggah, restore", §9.9, §9.10;
 * routes `backups.*`; 1c Task 32), `/admin/backups` for a holder of `system.backup.read`:
 *
 * - **The list** (`GET backups`, newest first): when, the kind (with the "eksternal" badge of an uploaded archive and
 *   what it holds), the status, the size and the consistency (`snapshot`: made while ALTIS kept serving; `frozen`: ALTIS
 *   paused for it), and the next daily backup. It is read again when the realtime client hears `system.backup` (the
 *   shell makes `['backups']` stale); a running backup shows the progress its `backup.progress` events carry
 *   (`{backupId, progress}`, Task 20, S24).
 * - **Buat sekarang** (`system.backup.create`; `POST backups {includeFiles}`): the server chooses how (§9.9). A
 *   `snapshot` is a job whose progress the list shows; a `frozen` backup is an op under maintenance, so the page loads
 *   the operations page `/admin/_update` (with the `altis_ops` cookie the answer set), which drives it to its end.
 * - **Siapkan unduhan** (`system.backup.download`, a backup that is `ok`): screens/backups/prepare-dialog.tsx.
 * - **Unggah** (`system.backup.restore`): screens/backups/upload.tsx.
 * - **Pulihkan** (`system.backup.restore`, a backup that is `ok` or an uploaded archive): screens/backups/restore-dialog.tsx.
 *
 * The menus only hide: the server refuses whatever they hide.
 */

/** The React Query key of the list (the shell makes it stale on any `system.backup` event, lib/realtime.ts). */
export const BACKUPS_KEY = ['backups'] as const;

const STATUS_TONE: Readonly<Record<BackupItem['status'], TagTone>> = {
  running: 'neutral',
  ok: 'ok',
  failed: 'bad',
  deleted: 'neutral',
  uploaded: 'neutral',
};

/** The status of a backup as a tag: its word, in its colour. */
function BackupStatusBadge({ status }: { status: BackupItem['status'] }) {
  const t = useT();
  return <Tag tone={STATUS_TONE[status]}>{t(`backups.status.${status}`)}</Tag>;
}

const features = tableFeatures({});
const column = createColumnHelper<typeof features, BackupItem>();
const NO_ITEMS: BackupItem[] = [];

/** "Buat sekarang": with or without the uploaded files. */
function CreateBackup() {
  const t = useT();
  const queryClient = useQueryClient();
  const titleId = useId();
  const [includeFiles, setIncludeFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const create = async (): Promise<void> => {
    setBusy(true);
    setOutcome(null);
    try {
      const started = await api<BackupCreateResponse>('POST', 'backups', { includeFiles });
      if (started.consistency === 'frozen') {
        // An op under maintenance: the operations page follows it (and drives it where no runner is always on).
        page.assign(OPS_PAGE_PATH);
        return;
      }
      setOutcome({ kind: 'success', text: t('backups.create.started') });
      void queryClient.invalidateQueries({ queryKey: BACKUPS_KEY });
    } catch (e) {
      // A 503 MAINTENANCE already took the page where it belongs (lib/api.ts); any other refusal is shown.
      if (!(e instanceof ApiError && e.code === 'MAINTENANCE')) setOutcome({ kind: 'error', text: problemText(t, e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={titleId} className="grid min-w-0 content-start gap-3">
      <h2 id={titleId} className="text-heading font-semibold">
        {t('backups.create.title')}
      </h2>
      <CheckField
        label={t('backups.create.include_files')}
        hint={t('backups.create.include_files_hint')}
        checked={includeFiles}
        disabled={busy}
        onChange={(e) => setIncludeFiles(e.target.checked)}
      />
      <div>
        <Button disabled={busy} onClick={() => void create()}>
          {t('backups.create.submit')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('backups.create.hint')}</p>
      {outcome !== null && <Notice kind={outcome.kind}>{outcome.text}</Notice>}
    </section>
  );
}

/** `/admin/backups`. */
export function BackupsScreen() {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const bytes = useBytes();
  const queryClient = useQueryClient();
  const listId = useId();
  const list = useApiQuery<BackupListResponse>({ queryKey: BACKUPS_KEY, path: 'backups' });
  const items = list.data?.items ?? NO_ITEMS;

  const mayCreate = holds(me, 'system.backup.create');
  const mayDownload = holds(me, 'system.backup.download');
  const mayRestore = holds(me, 'system.backup.restore');

  // The progress of running backups, from their `backup.progress` events (the shell already reads `system.backup`
  // for a holder of `system.backup.read`; a channel the caller may not read would refuse the whole poll, §10.7).
  const [progress, setProgress] = useState<Readonly<Record<string, number>>>({});
  useRealtime(holds(me, 'system.backup.read') ? ['system.backup'] : [], (e) => {
    if (e.type !== 'backup.progress') return;
    const { backupId, progress: value } = e.payload;
    if (typeof backupId !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) return;
    setProgress((current) => ({ ...current, [backupId]: Math.max(0, Math.min(100, value)) }));
  });

  // The dialogs keep their backup between openings (it is shown while one closes); each opening starts afresh.
  const [preparing, setPreparing] = useState<{ backup: BackupItem; open: boolean } | null>(null);
  const [restoring, setRestoring] = useState<{ backup: BackupItem; open: boolean } | null>(null);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('createdAt', {
          header: t('backups.col.created'),
          cell: (info) => (
            <time dateTime={new Date(info.getValue()).toISOString()} className="whitespace-nowrap">
              {dateTime(info.getValue())}
            </time>
          ),
        }),
        column.accessor('kind', {
          header: t('backups.col.kind'),
          cell: (info) => {
            const item = info.row.original;
            return (
              <span className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span>{t(`backups.kind.${item.kind}`)}</span>
                  {item.external && (
                    <Tag tone="warn" title={t('backups.external_hint')}>
                      {t('backups.external')}
                    </Tag>
                  )}
                </span>
                {item.status === 'ok' && (
                  <span className="text-xs text-muted-foreground">{t(item.includesFiles ? 'backups.content.files' : 'backups.content.db')}</span>
                )}
              </span>
            );
          },
        }),
        column.accessor('status', {
          header: t('backups.col.status'),
          cell: (info) => {
            const item = info.row.original;
            const value = progress[item.id];
            return (
              <span className="flex min-w-32 flex-col gap-1">
                <BackupStatusBadge status={item.status} />
                {item.status === 'running' && value !== undefined && (
                  <span className="flex items-center gap-2">
                    <ProgressBar value={value} label={t('backups.progress')} />
                    <span className="text-xs tabular-nums">{Math.round(value)} %</span>
                  </span>
                )}
              </span>
            );
          },
        }),
        column.accessor('size', {
          header: t('backups.col.size'),
          cell: (info) => <span className="whitespace-nowrap tabular-nums">{info.getValue() === null ? t('backups.size_none') : bytes(info.getValue()!)}</span>,
        }),
        column.accessor('consistency', {
          header: t('backups.col.consistency'),
          cell: (info) => t(`backups.consistency.${info.getValue()}`),
        }),
        column.display({
          id: 'actions',
          header: () => <span className="sr-only">{t('table.actions')}</span>,
          cell: (info) => {
            const item = info.row.original;
            const when = dateTime(item.createdAt);
            const prepare = mayDownload && item.status === 'ok';
            const restore = mayRestore && (item.status === 'ok' || item.status === 'uploaded');
            if (!prepare && !restore) return null;
            return (
              <MoreMenu small label={t('backups.more_named', { time: when })}>
                {prepare && (
                  <MoreMenuItem aria-label={t('backups.action.prepare_label', { time: when })} onSelect={() => setPreparing({ backup: item, open: true })}>
                    {t('backups.action.prepare')}
                  </MoreMenuItem>
                )}
                {restore && (
                  <MoreMenuItem danger aria-label={t('backups.action.restore_label', { time: when })} onSelect={() => setRestoring({ backup: item, open: true })}>
                    {t('backups.action.restore')}
                  </MoreMenuItem>
                )}
              </MoreMenu>
            );
          },
        }),
      ]),
    [t, dateTime, bytes, progress, mayDownload, mayRestore],
  );

  const table = useTable({ features, columns, data: items, getRowId: (item) => item.id });

  const next = list.data?.nextScheduledAt;

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <PageHead title={t('nav.backups')} intro={t('backups.description')} />
        {next !== undefined && (
          <p className="text-meta text-muted-foreground">{next === null ? t('backups.next_off') : t('backups.next', { time: dateTime(next) })}</p>
        )}
      </div>

      {(mayCreate || mayRestore) && (
        <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
          {mayCreate && <CreateBackup />}
          {mayRestore && <UploadPanel onUploaded={() => void queryClient.invalidateQueries({ queryKey: BACKUPS_KEY })} />}
        </div>
      )}

      <section aria-labelledby={listId} className="grid gap-3">
        <SectionHead id={listId} title={t('backups.list.title')} />
        {list.isError && list.data === undefined ? (
          <ErrorState title={t('backups.load_failed')} error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : list.data === undefined ? (
          <SkeletonTable label={t('shell.loading')} columns={6} rows={3} />
        ) : (
          <DataTable table={table} caption={t('backups.caption')} empty={t('backups.empty')} />
        )}
      </section>

      <PrepareDownloadDialog
        backup={preparing?.backup ?? null}
        open={preparing?.open === true}
        onClose={() => setPreparing((current) => (current === null ? null : { ...current, open: false }))}
      />
      <RestoreDialog
        backup={restoring?.backup ?? null}
        open={restoring?.open === true}
        onClose={() => setRestoring((current) => (current === null ? null : { ...current, open: false }))}
      />
    </div>
  );
}
