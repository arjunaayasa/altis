import type { ReindexResponse } from '@altis/shared/api/catalog/search';
import type { DashboardResponse } from '@altis/shared/api/dashboard';
import type { DiagnosticsReport, DiagnosticsRunMode, DiagnosticsRuntime, DiagnosticsStocktake, RealtimeResponse } from '@altis/shared/api/diagnostics';
import { opCliLines, type OpView } from '@altis/shared/api/ops';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useDateTime } from '@/components/data-table';
import { CheckField, Notice } from '@/components/form-field';
import { JobProgress, type JobOutcome } from '@/components/job-progress';
import { ErrorState, LoadingState, PageHead } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { editionName, editionStatus } from '@/edition';
import { useT, type AdminKey, type TKey, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, OPS_PAGE_PATH, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { ME_KEY, useApiQuery, useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { DIALECT_NAMES } from '@/screens/backups/restore-dialog';
import { useBytes } from '@/screens/backups/upload';
import { BrowserTests } from './browser-tests';

/**
 * Diagnostik (spec §11, §13.3 "Diagnostik: §11; aktifkan SSE (.manage), konfirmasi 'jam sekarang benar'", §9.4
 * "pilihan di Diagnostik" (M46); routes `diagnostics.*`, `ops.current|drive|cancel`; 1c Task 32), `/admin/diagnostics`
 * for a holder of `system.diagnostics.read`:
 *
 * - **The report** (`GET diagnostics`): one block per section of {@link DiagnosticsReport} ({@link BLOCKS} is typed by
 *   its keys, so a section the server adds fails the build until it has its block): the release, runtime and runner,
 *   the job queue, the last backup, the edition, the database, the data folder, memory, the network and its proxy
 *   hops, WebAssembly, the HTTP methods and the chunk size, the audit chain, the clock, the exposure test and the disk;
 *   Phase 2 adds the catalogue's search index (with "Bangun ulang indeks") and OAI-PMH (plan Task 28). While a clock
 *   anomaly is set, the clock block also says that the date-based jobs are postponed ("Tugas berbasis tanggal ditunda:
 *   jam sistem melompat", the text the report housekeeping's job writes when it skips its age-based steps).
 * - **The exposure test** that failed is a red banner on top (§11 "banner merah bila gagal").
 * - **The suggested proxy hops** of the browser test, when they differ from the configured ones, with a link to
 *   Konfigurasi Sistem for whoever may open it (`system.config.manage`).
 * - For a holder of `system.diagnostics.manage`: the **SSE switch** (`PUT diagnostics/realtime`; 409
 *   REALTIME_PROBE_REQUIRED is explained: on Passenger/LiteSpeed the browser test must have received SSE within 24 h),
 *   **"Jam sekarang benar"** while a clock anomaly is active (`POST diagnostics/clock-confirm`, after a confirmation and
 *   through the reauth dialog), and **"Uji peramban"** (screens/diagnostics/browser-tests.tsx).
 * - **An op in `needs_attention`** (§9.4: no movement for 15 minutes, or a corrupt `op.json`), shown to whoever the
 *   dashboard raises `ops_attention` for (the holders of the op kind's permission, the ones `opsAuth` lets read
 *   `GET ops/current`; asking without it would be refused and audited as a denial): "Lanjutkan operasi"
 *   (`POST ops/drive {resume: true}`), "Batalkan operasi" before its point of no return (`POST ops/cancel`, after a
 *   confirmation and through the reauth dialog), a link to the operations page and the CLI lines for the server.
 */

/** The React Query key of the report. */
export const DIAGNOSTICS_KEY = ['diagnostics'] as const;
/** The React Query key of the current op (the shell makes `['ops']` stale on an `op.*` event). */
const OP_KEY = ['ops', 'current'] as const;

/** The runtimes by their product names (not translated). */
const RUNTIME_NAMES: Readonly<Record<DiagnosticsRuntime, string>> = Object.freeze({
  passenger: 'Passenger',
  litespeed: 'LiteSpeed',
  pm2: 'PM2',
  docker: 'Docker',
  service: 'Service',
  standalone: 'Standalone',
});

const RUN_MODES: readonly DiagnosticsRunMode[] = ['worker', 'cron_cli', 'cron_http', 'drive', 'piggyback'];

/** A duration in its largest whole unit (as the dashboard shows the queue's oldest job). */
function duration(t: Translate, ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t('dashboard.duration.seconds', { count: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('dashboard.duration.minutes', { count: m });
  const h = Math.floor(m / 60);
  if (h < 48) return t('dashboard.duration.hours', { count: h });
  return t('dashboard.duration.days', { count: Math.floor(h / 24) });
}

/** A label and its value, inside a block's `<dl>`. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-semibold break-words">{children}</dd>
    </div>
  );
}

/** A time as `<time>` in the UI language. */
function When({ ms }: { ms: number }) {
  const dateTime = useDateTime();
  return <time dateTime={new Date(ms).toISOString()}>{dateTime(ms)}</time>;
}

/** The link at the bottom of a block. */
function BlockLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="mt-auto w-fit text-sm font-semibold text-accent-text underline-offset-4 hover:underline">
      {children}
    </Link>
  );
}

type Outcome = { kind: 'success' | 'error'; text: string } | null;

// ---- the blocks --------------------------------------------------------------------------------------------------

interface BlockProps {
  report: DiagnosticsReport;
}

function ReleaseBlock({ report }: BlockProps) {
  const t = useT();
  const { release } = report;
  const versions = (list: readonly string[]): ReactNode =>
    list.length === 0 ? t('diagnostics.none') : <span className="font-mono">{list.join(', ')}</span>;
  return (
    <dl className="flex flex-col gap-2">
      <Row label={t('diagnostics.release.version')}>{release.version}</Row>
      <Row label={t('diagnostics.release.app_js')}>{release.appJsVersion ?? t('diagnostics.unknown')}</Row>
      <Row label={t('diagnostics.release.boot_protocol')}>{release.bootProtocol}</Row>
      <Row label={t('diagnostics.release.missing')}>{versions(release.missing)}</Row>
      <Row label={t('diagnostics.release.unadopted')}>{versions(release.unadopted)}</Row>
      {/* 1d Task 29: pending, pinned, the bundled release (§9.8), the keyset store (R65c) */}
      <Row label={t('diagnostics.release.pending')}>{versions(release.pending === null ? [] : [release.pending])}</Row>
      <Row label={t('diagnostics.release.pinned')}>{versions(release.pinned === null ? [] : [release.pinned])}</Row>
      <Row label={t('diagnostics.release.bundled')}>
        {release.bundled === null
          ? t('diagnostics.none')
          : t('diagnostics.release.bundled_value', {
              version: release.bundled.version,
              relation: t(`diagnostics.release.relation.${release.bundled.relation}`),
              note: t(`diagnostics.release.note.${release.bundled.note}`),
            })}
      </Row>
      <Row label={t('diagnostics.release.keyset')}>
        <span className={release.keyset.full ? 'font-semibold text-bad' : undefined}>
          {t(release.keyset.docs === 1 ? 'diagnostics.release.keyset_value_one' : 'diagnostics.release.keyset_value', { docs: release.keyset.docs, seq: release.keyset.maxSeq })}
          {release.keyset.full && ` ${t('diagnostics.release.keyset_full')}`}
        </span>
      </Row>
    </dl>
  );
}

/** The SSE switch (`system.diagnostics.manage`). */
function RealtimeSwitch({ transport }: { transport: 'sse' | 'polling' }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const save = async (sse: boolean | null): Promise<void> => {
    setBusy(true);
    setOutcome(null);
    try {
      const answer = await api<RealtimeResponse>('PUT', 'diagnostics/realtime', { sse });
      queryClient.setQueryData<DiagnosticsReport>(DIAGNOSTICS_KEY, (old) =>
        old === undefined ? old : { ...old, runtime: { ...old.runtime, transport: answer.transport } },
      );
      setOutcome({
        kind: 'success',
        text: t(sse === null ? 'diagnostics.sse.saved_auto' : sse ? 'diagnostics.sse.saved_on' : 'diagnostics.sse.saved_off'),
      });
      void queryClient.invalidateQueries({ queryKey: DIAGNOSTICS_KEY });
      // `auth/me`'s `client.realtime` tells the shell's realtime client which transport to use.
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    } catch (e) {
      const text = e instanceof ApiError && e.code === 'REALTIME_PROBE_REQUIRED' ? t('diagnostics.sse.probe_required') : problemText(t, e);
      setOutcome({ kind: 'error', text });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <CheckField
        asSwitch
        label={t('diagnostics.sse.label')}
        hint={t('diagnostics.sse.hint')}
        checked={transport === 'sse'}
        disabled={busy}
        onChange={(e) => void save(e.target.checked)}
      />
      <div>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void save(null)}>
          {t('diagnostics.sse.automatic')}
        </Button>
      </div>
      {outcome !== null && <Notice kind={outcome.kind}>{outcome.text}</Notice>}
    </div>
  );
}

function RuntimeBlock({ report }: BlockProps) {
  const t = useT();
  const me = useMe();
  const { runtime } = report;
  const runs = RUN_MODES.filter((mode) => runtime.runner.lastRuns[mode] !== undefined);
  return (
    <>
      <dl className="flex flex-col gap-2">
        <Row label={t('diagnostics.runtime.runtime')}>{RUNTIME_NAMES[runtime.runtime] ?? runtime.runtime}</Row>
        <Row label={t('diagnostics.runtime.transport')}>{t(`diagnostics.runtime.transport.${runtime.transport}`)}</Row>
        <Row label={t('diagnostics.runtime.runner')}>{t(`dashboard.scheduler.mode.${runtime.runner.mode}`)}</Row>
      </dl>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{t('diagnostics.runtime.last_runs')}</h3>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('diagnostics.never')}</p>
        ) : (
          <dl className="flex flex-col gap-1">
            {runs.map((mode) => (
              <Row key={mode} label={t(`dashboard.scheduler.run.${mode}`)}>
                <When ms={runtime.runner.lastRuns[mode]!} />
              </Row>
            ))}
          </dl>
        )}
      </div>
      {holds(me, 'system.diagnostics.manage') && <RealtimeSwitch transport={runtime.transport} />}
    </>
  );
}

function QueueBlock({ report }: BlockProps) {
  const t = useT();
  const me = useMe();
  const { queue } = report;
  return (
    <>
      <dl className="flex flex-col gap-2">
        <Row label={t('dashboard.queue.queued')}>{queue.queued}</Row>
        <Row label={t('dashboard.queue.running')}>{queue.running}</Row>
        <Row label={t('dashboard.queue.dead')}>{queue.dead}</Row>
        <Row label={t('diagnostics.queue.oldest')}>{queue.oldestQueuedMs === null ? t('diagnostics.none') : duration(t, queue.oldestQueuedMs)}</Row>
      </dl>
      {holds(me, 'system.jobs.read') && <BlockLink to="/admin/jobs">{t('diagnostics.queue.open')}</BlockLink>}
    </>
  );
}

function BackupBlock({ report }: BlockProps) {
  const t = useT();
  const me = useMe();
  const bytes = useBytes();
  const last = report.backup.last;
  return (
    <>
      {last === null ? (
        <p className="text-sm text-muted-foreground">{t('diagnostics.backup.none')}</p>
      ) : (
        <dl className="flex flex-col gap-2">
          <Row label={t('backups.col.created')}>
            <When ms={last.createdAt} />
          </Row>
          <Row label={t('backups.col.kind')}>{t(`backups.kind.${last.kind}`)}</Row>
          <Row label={t('backups.col.status')}>{t(`backups.status.${last.status}`)}</Row>
          <Row label={t('backups.col.size')}>{last.size === null ? t('backups.size_none') : bytes(last.size)}</Row>
          <Row label={t('backups.col.consistency')}>{t(`backups.consistency.${last.consistency}`)}</Row>
        </dl>
      )}
      {holds(me, 'system.backup.read') && <BlockLink to="/admin/backups">{t('diagnostics.backup.open')}</BlockLink>}
    </>
  );
}

/** The edition (ruling R9: `edition`, from the edition service): its name and status. */
function EditionBlock({ report }: BlockProps) {
  const t = useT();
  return (
    <dl className="flex flex-col gap-2">
      <Row label={t('diagnostics.edition.name')}>{editionName(t, report.edition.edition)}</Row>
      <Row label={t('diagnostics.edition.status')}>{editionStatus(t, report.edition)}</Row>
    </dl>
  );
}

function DatabaseBlock({ report }: BlockProps) {
  const t = useT();
  const { database } = report;
  const limit = (n: number): ReactNode => (n > 0 ? n : t('diagnostics.database.no_limit'));
  return (
    <dl className="flex flex-col gap-2">
      <Row label={t('diagnostics.database.engine')}>{DIALECT_NAMES[database.dialect] ?? database.dialect}</Row>
      <Row label={t('diagnostics.database.version')}>
        <span className="font-mono text-xs">{database.version}</span>
      </Row>
      <Row label={t('diagnostics.database.full_text')}>{t(database.fullText ? 'form.yes' : 'form.no')}</Row>
      <Row label={t('diagnostics.database.max_connections')}>{limit(database.limits.maxConnections)}</Row>
      <Row label={t('diagnostics.database.max_user_connections')}>{limit(database.limits.maxUserConnections)}</Row>
      <Row label={t('diagnostics.database.pool')}>{database.poolSize}</Row>
    </dl>
  );
}

function DataDirBlock({ report }: BlockProps) {
  const t = useT();
  const bytes = useBytes();
  const { dataDir } = report;
  if (dataDir === null) return <p className="text-sm text-muted-foreground">{t('diagnostics.data_dir.none')}</p>;
  return (
    <>
      <dl className="flex flex-col gap-2">
        <Row label={t('diagnostics.data_dir.bytes')}>{bytes(dataDir.bytes)}</Row>
        <Row label={t('diagnostics.data_dir.files')}>{dataDir.files}</Row>
        <Row label={t('diagnostics.data_dir.measured')}>
          <When ms={dataDir.measuredAt} />
        </Row>
      </dl>
      {dataDir.truncated && <p className="text-sm text-muted-foreground">{t('diagnostics.data_dir.truncated')}</p>}
    </>
  );
}

function MemoryBlock({ report }: BlockProps) {
  const t = useT();
  const bytes = useBytes();
  const { memory } = report;
  return (
    <dl className="flex flex-col gap-2">
      <Row label={t('diagnostics.memory.rss')}>{bytes(memory.rssBytes)}</Row>
      <Row label={t('diagnostics.memory.heap')}>{bytes(memory.heapUsedBytes)}</Row>
      <Row label={t('diagnostics.memory.total')}>{bytes(memory.totalBytes)}</Row>
      <Row label={t('diagnostics.memory.free')}>{bytes(memory.freeBytes)}</Row>
    </dl>
  );
}

function NetworkBlock({ report }: BlockProps) {
  const t = useT();
  const me = useMe();
  const { network } = report;
  const differs = network.suggestedHops !== null && network.suggestedHops !== network.hops;
  return (
    <>
      <dl className="flex flex-col gap-2">
        <Row label={t('diagnostics.network.ip_trust')}>{t(`diagnostics.network.ip_trust.${network.ipTrust}`)}</Row>
        <Row label={t('diagnostics.network.hops')}>{network.hops}</Row>
        <Row label={t('diagnostics.network.suggested')}>{network.suggestedHops ?? t('diagnostics.http.untested')}</Row>
      </dl>
      {differs && (
        <div className="grid gap-1 rounded-md border border-warn-line bg-warn-bg px-3.5 py-3 text-sm">
          <p>{t(network.suggestedHops === 1 ? 'diagnostics.network.suggest_change_one' : 'diagnostics.network.suggest_change', { hops: network.suggestedHops! })}</p>
          {holds(me, 'system.config.manage') ? (
            <Link to="/admin/system" className="w-fit font-semibold text-accent-text underline underline-offset-4">
              {t('diagnostics.network.open_config')}
            </Link>
          ) : (
            <p>{t('diagnostics.network.ask_admin')}</p>
          )}
        </div>
      )}
    </>
  );
}

function WasmBlock({ report }: BlockProps) {
  const t = useT();
  const { wasm } = report;
  return (
    <>
      <dl className="flex flex-col gap-2">
        <Row label={t('diagnostics.wasm.status')}>{t(wasm.ok ? 'diagnostics.wasm.ok' : 'diagnostics.wasm.failed')}</Row>
      </dl>
      {wasm.hint !== null && <p className="text-sm text-muted-foreground">{wasm.hint}</p>}
    </>
  );
}

function HttpBlock({ report }: BlockProps) {
  const t = useT();
  const bytes = useBytes();
  const { http } = report;
  const method = (ok: boolean): string => t(ok ? 'diagnostics.http.allowed' : 'diagnostics.http.blocked');
  return (
    <dl className="flex flex-col gap-2">
      {http.methods === null ? (
        <Row label={t('diagnostics.http.methods')}>{t('diagnostics.http.untested')}</Row>
      ) : (
        <>
          <Row label="PUT">{method(http.methods.put)}</Row>
          <Row label="PATCH">{method(http.methods.patch)}</Row>
          <Row label="DELETE">{method(http.methods.delete)}</Row>
        </>
      )}
      <Row label={t('diagnostics.http.override')}>{t(http.methodOverride ? 'diagnostics.http.override_on' : 'diagnostics.http.override_off')}</Row>
      <Row label={t('diagnostics.http.chunk')}>{http.chunkBytes === null ? t('diagnostics.http.untested') : bytes(http.chunkBytes)}</Row>
      <Row label={t('diagnostics.http.probed')}>{http.probedAt === null ? t('diagnostics.never') : <When ms={http.probedAt} />}</Row>
    </dl>
  );
}

function AuditBlock({ report }: BlockProps) {
  const t = useT();
  const me = useMe();
  const chain = report.audit.chain;
  return (
    <>
      {chain === null ? (
        <p className="text-sm text-muted-foreground">{t('diagnostics.audit.none')}</p>
      ) : (
        <dl className="flex flex-col gap-2">
          <Row label={t('diagnostics.audit.status')}>
            {chain.ok ? (
              t('diagnostics.audit.ok')
            ) : (
              <span className="font-semibold text-bad">{t('diagnostics.audit.broken', { seq: chain.brokenAt ?? '?' })}</span>
            )}
          </Row>
          <Row label={t('diagnostics.audit.head')}>{chain.head}</Row>
          <Row label={t('diagnostics.audit.checked')}>
            <When ms={chain.checkedAt} />
          </Row>
        </dl>
      )}
      {holds(me, 'system.audit.read') && <BlockLink to="/admin/audit">{t('diagnostics.audit.open')}</BlockLink>}
    </>
  );
}

function ClockBlock({ report }: BlockProps) {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  // Kept here, outside the anomaly's part: the notice stays once the report reads without the anomaly.
  const [outcome, setOutcome] = useState<Outcome>(null);
  const { anomaly } = report.clock;

  const confirm = async (): Promise<void> => {
    await api('POST', 'diagnostics/clock-confirm');
    setOutcome({ kind: 'success', text: t('diagnostics.clock.confirmed') });
    void queryClient.invalidateQueries({ queryKey: DIAGNOSTICS_KEY });
    // The clock banner of `auth/me` and the dashboard's alert end with it.
    void queryClient.invalidateQueries({ queryKey: ME_KEY });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  return (
    <>
      {anomaly === null ? (
        <p className="text-sm">{t('diagnostics.clock.ok')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-bad">{t('diagnostics.clock.anomaly', { time: dateTime(anomaly.detectedAt) })}</p>
          <p className="text-sm text-muted-foreground">{t('diagnostics.clock.max_seen', { time: dateTime(anomaly.maxSeen) })}</p>
          {/* Komunitas K1: the scheduled steps that count days (the report housekeeping's) wait for the clock too. */}
          <p className="text-sm">{t('jobs.message.reports.housekeeping.date_jobs_postponed')}</p>
          {holds(me, 'system.diagnostics.manage') && (
            <div>
              <Button variant="outline" onClick={() => setConfirming(true)}>
                {t('diagnostics.clock.confirm')}
              </Button>
            </div>
          )}
        </div>
      )}
      {outcome !== null && <Notice kind={outcome.kind}>{outcome.text}</Notice>}
      <ConfirmDialog
        open={confirming}
        title={t('diagnostics.clock.confirm_title')}
        description={t('diagnostics.clock.confirm_description')}
        confirmLabel={t('diagnostics.clock.confirm')}
        onConfirm={confirm}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

function ExposureBlock({ report }: BlockProps) {
  const t = useT();
  const { exposure } = report;
  if (exposure === null) return <p className="text-sm text-muted-foreground">{t('diagnostics.exposure.none')}</p>;
  return (
    <>
      <p className={cn('text-sm', !exposure.ok && 'font-semibold text-bad')}>{t(exposure.ok ? 'diagnostics.exposure.ok' : 'diagnostics.exposure.failed')}</p>
      <dl className="flex flex-col gap-2">
        {!exposure.ok && exposure.url !== null && (
          <Row label={t('diagnostics.exposure.url')}>
            <span className="font-mono text-xs break-all">{exposure.url}</span>
          </Row>
        )}
        <Row label={t('diagnostics.exposure.checked')}>
          <When ms={exposure.checkedAt} />
        </Row>
      </dl>
    </>
  );
}

function DiskBlock({ report }: BlockProps) {
  const t = useT();
  const dateTime = useDateTime();
  const { lowAt } = report.disk;
  return lowAt === null ? (
    <p className="text-sm">{t('diagnostics.disk.ok')}</p>
  ) : (
    <p className="text-sm font-semibold text-bad">{t('diagnostics.disk.low', { time: dateTime(lowAt) })}</p>
  );
}

// ---- Phase 2 (catalog): Task 3 (B2), completed by Task 28: the search index and OAI blocks ----------------------
// Both read "tidak tersedia" while the report has them as null (before the search provider filled them). The search
// index block (spec §4.8) shows its status, the documents of live records against the live records, the last build,
// and for a holder of `system.diagnostics.manage` "Bangun ulang indeks" (`POST catalog/search/reindex`, after a
// confirmation; it queues the one full rebuild, or joins the one already queued) followed by the job's progress. A
// rebuild already queued or running (the report's `jobId`) shows its progress instead of the button. `building` with
// no rebuild running stays until the daily catalogue upkeep or a new rebuild starts one (a cancelled rebuild leaves it
// so, Task 15), and the block says so. The OAI-PMH block (spec §10) warns, as the dashboard does, while OAI-PMH is on
// without an admin e-mail (it then answers 503), with a link to the OPAC settings. Copy: i18n/catalog/settings.ts.

const SEARCH_STATUS: Readonly<Record<NonNullable<DiagnosticsReport['search']>['status'], AdminKey>> = {
  ready: 'diagnostics.search.status.ready',
  building: 'diagnostics.search.status.building',
  missing: 'diagnostics.search.status.missing',
};

function Unavailable() {
  const t = useT();
  return <p className="text-sm text-muted-foreground">{t('diagnostics.unavailable')}</p>;
}

/** A warning inside a block (the colours of the suggested-hops notice). */
function BlockWarning({ children }: { children: ReactNode }) {
  return <div className="grid gap-1 rounded-md border border-warn-line bg-warn-bg px-3.5 py-3 text-sm">{children}</div>;
}

function SearchBlock({ report }: BlockProps) {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const { search } = report;
  /** The rebuild this page started (the report names it only once it is read again). */
  const [started, setStarted] = useState<string | null>(null);
  /** The rebuild whose end this page has seen: the report may still name it until it is read again. */
  const [ended, setEnded] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  if (search === null) return <Unavailable />;

  const following = started ?? search.jobId;
  const active = following !== null && following !== ended;
  const canRebuild = holds(me, 'system.diagnostics.manage');
  // `GET jobs/:id` answers its creator, a holder of `system.jobs.read`, and a holder of the rebuild's own permission
  // `system.diagnostics.manage` (an interactive job's handler permission, whom drive accepts: C26/E22b, so that this page
  // drives the rebuild the boot queued where no worker runs); 404 for anyone else: a rebuild someone else started is
  // only named for the others.
  const canFollow = started !== null || holds(me, 'system.jobs.read') || canRebuild;

  const rebuild = async (): Promise<void> => {
    const { jobId } = await api<ReindexResponse>('POST', 'catalog/search/reindex');
    setOutcome(null);
    setEnded(null);
    setStarted(jobId);
    void queryClient.invalidateQueries({ queryKey: DIAGNOSTICS_KEY });
  };

  const done = (jobId: string, status: JobOutcome): void => {
    setEnded(jobId);
    setStarted(null);
    setOutcome(
      status === 'succeeded'
        ? { kind: 'success', text: t('catalog.settings.search_health.rebuilt') }
        : { kind: 'error', text: t('catalog.settings.search_health.rebuild_ended') },
    );
    void queryClient.invalidateQueries({ queryKey: DIAGNOSTICS_KEY });
    // The dashboard's `search_index_mismatch` follows the index.
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  return (
    <>
      <dl className="flex flex-col gap-2">
        <Row label={t('diagnostics.search.status')}>{t(SEARCH_STATUS[search.status])}</Row>
        <Row label={t('diagnostics.search.documents')}>{t('diagnostics.search.counts', { docs: search.docs, records: search.records })}</Row>
        {search.builtAt !== null && (
          <Row label={t('diagnostics.search.built')}>
            <When ms={search.builtAt} />
          </Row>
        )}
      </dl>
      {search.status === 'ready' && search.docs !== search.records && (
        <BlockWarning>
          <p>{t('alert.search_index_mismatch')}</p>
        </BlockWarning>
      )}
      {!active && search.status === 'building' && <p className="text-sm text-muted-foreground">{t('catalog.settings.search_health.stalled')}</p>}
      {!active && search.status === 'missing' && <p className="text-sm text-muted-foreground">{t('catalog.settings.search_health.missing')}</p>}
      {active ? (
        canFollow ? (
          <JobProgress jobId={following} onDone={(status) => done(following, status)} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('catalog.settings.search_health.running')}
          </p>
        )
      ) : (
        canRebuild && (
          <div>
            <Button variant="outline" onClick={() => setConfirming(true)}>
              {t('catalog.settings.search_health.rebuild')}
            </Button>
          </div>
        )
      )}
      {outcome !== null && <Notice kind={outcome.kind}>{outcome.text}</Notice>}
      <ConfirmDialog
        open={confirming}
        title={t('catalog.settings.search_health.rebuild_title')}
        description={t('catalog.settings.search_health.rebuild_description')}
        confirmLabel={t('catalog.settings.search_health.rebuild')}
        onConfirm={rebuild}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

function OaiBlock({ report }: BlockProps) {
  const t = useT();
  const me = useMe();
  const { oai } = report;
  if (oai === null) return <Unavailable />;
  return (
    <>
      <dl className="flex flex-col gap-2">
        <Row label={t('diagnostics.oai.state')}>{t(oai.enabled ? 'diagnostics.oai.enabled' : 'diagnostics.oai.disabled')}</Row>
        <Row label={t('diagnostics.oai.admin_email')}>
          {t(oai.adminEmailSet ? 'diagnostics.oai.admin_email_set' : 'diagnostics.oai.admin_email_missing')}
        </Row>
      </dl>
      {oai.enabled && !oai.adminEmailSet && (
        <BlockWarning>
          <p>{t('alert.oai_misconfigured')}</p>
          {holds(me, 'system.settings.read') && (
            <Link to="/admin/settings/opac" className="w-fit font-semibold text-accent-text underline underline-offset-4">
              {t('catalog.settings.oai_status.open_settings')}
            </Link>
          )}
        </BlockWarning>
      )}
    </>
  );
}

// ---- Komunitas K1 (edition lane) ----------------------------------------------------------------------------------

/** The migrations of another lane the database records (0 on a database only this edition migrated). */
function EditionLaneBlock({ report }: BlockProps) {
  const t = useT();
  return <p className="text-sm">{t('diagnostics.edition_lane.applied', { count: report.editionLane.applied })}</p>;
}

// ---- Komunitas K4 (stocktake) ------------------------------------------------------------------------------------

const STUCK_TEXT: Readonly<Record<NonNullable<DiagnosticsStocktake['stuck']>, AdminKey>> = {
  no_job: 'stocktake.ui.diag.stuck.no_job',
  job_ended: 'stocktake.ui.diag.stuck.job_ended',
  stalled: 'stocktake.ui.diag.stuck.stalled',
};

/** The stocktake sessions under way, each with its preparation or finish job, and a warning for one that is stuck. */
function StocktakeBlock({ report }: BlockProps) {
  const t = useT();
  const me = useMe();
  const dateTime = useDateTime();
  if (report.stocktakes.length === 0) return <p className="text-sm text-muted-foreground">{t('stocktake.ui.diag.none')}</p>;
  return (
    <>
      {report.stocktakes.map((s) => (
        <div key={s.id} data-stocktake={s.id} className="flex flex-col gap-2">
          <dl className="flex flex-col gap-2">
            <Row label={t('stocktake.ui.diag.session', { name: s.name, branch: s.branch.code })}>{t(`vocab.stocktake_status.${s.status}`)}</Row>
            <Row label={t('stocktake.ui.col.started')}>
              <When ms={s.startedAt} />
            </Row>
            <Row label={t('stocktake.ui.diag.job')}>
              {s.job === null
                ? t('stocktake.ui.diag.no_job')
                : t('stocktake.ui.diag.job_value', { status: t(`jobs.status.${s.job.status}` as AdminKey), progress: s.job.progress, time: dateTime(s.job.updatedAt) })}
            </Row>
          </dl>
          <p className="text-sm">{t('stocktake.ui.diag.counts', { found: s.counts.found, total: s.counts.total, pending: s.counts.pending })}</p>
          {s.pendingUploads > 0 && <p className="text-sm text-muted-foreground">{t('stocktake.ui.diag.uploads', { count: s.pendingUploads })}</p>}
          {s.stuck !== null && (
            <BlockWarning>
              <p>{t(STUCK_TEXT[s.stuck], { status: t(`vocab.stocktake_status.${s.status}`) })}</p>
            </BlockWarning>
          )}
          {holds(me, 'system.jobs.read') && s.job !== null && (
            <Link to="/admin/jobs/$jobId" params={{ jobId: s.job.id }} className="w-fit text-sm font-semibold text-accent-text underline-offset-4 hover:underline">
              {t('diagnostics.queue.open')}
            </Link>
          )}
        </div>
      ))}
    </>
  );
}

/** One block per section of the report, in this order; typed by the report's keys (a new section needs its block). */
const BLOCKS: { readonly [K in keyof DiagnosticsReport]: { title: TKey; Body(props: BlockProps): ReactNode } } = {
  release: { title: 'diagnostics.release.title', Body: ReleaseBlock },
  runtime: { title: 'diagnostics.runtime.title', Body: RuntimeBlock },
  queue: { title: 'diagnostics.queue.title', Body: QueueBlock },
  backup: { title: 'diagnostics.backup.title', Body: BackupBlock },
  edition: { title: 'diagnostics.edition.title', Body: EditionBlock },
  database: { title: 'diagnostics.database.title', Body: DatabaseBlock },
  dataDir: { title: 'diagnostics.data_dir.title', Body: DataDirBlock },
  memory: { title: 'diagnostics.memory.title', Body: MemoryBlock },
  network: { title: 'diagnostics.network.title', Body: NetworkBlock },
  wasm: { title: 'diagnostics.wasm.title', Body: WasmBlock },
  http: { title: 'diagnostics.http.title', Body: HttpBlock },
  audit: { title: 'diagnostics.audit.title', Body: AuditBlock },
  clock: { title: 'diagnostics.clock.title', Body: ClockBlock },
  exposure: { title: 'diagnostics.exposure.title', Body: ExposureBlock },
  disk: { title: 'diagnostics.disk.title', Body: DiskBlock },
  // ---- Phase 2 (catalog): Task 3 (B2) ----
  search: { title: 'diagnostics.search.title', Body: SearchBlock },
  oai: { title: 'diagnostics.oai.title', Body: OaiBlock },
  // ---- Komunitas K1 (edition lane) ----
  editionLane: { title: 'diagnostics.edition_lane.title', Body: EditionLaneBlock },
  // ---- Komunitas K4 (stocktake) ----
  stocktakes: { title: 'stocktake.ui.diag.title', Body: StocktakeBlock },
};

const BLOCK_ORDER = Object.keys(BLOCKS) as (keyof DiagnosticsReport)[];

function Block({ name, report }: { name: keyof DiagnosticsReport; report: DiagnosticsReport }) {
  const t = useT();
  const id = useId();
  const { title, Body } = BLOCKS[name];
  return (
    <section data-diagnostics-block={name} aria-labelledby={id} className="grid min-w-0 content-start gap-3 border-t pt-4">
      <h2 id={id} className="text-base font-bold">
        {t(title)}
      </h2>
      <Body report={report} />
    </section>
  );
}

/** The red banner of a failed exposure test (§11). */
function ExposureBanner({ url }: { url: string | null }) {
  const t = useT();
  const id = useId();
  return (
    <div role="alert" aria-labelledby={id} className="grid gap-1 rounded-md border border-bad-line bg-bad-bg px-3.5 py-3 text-sm">
      <p id={id} className="font-bold text-bad">
        {t('diagnostics.exposure.banner')}
      </p>
      <p>{t('alert.exposure_failed')}</p>
      {url !== null && <p className="font-mono text-xs break-all">{url}</p>}
    </div>
  );
}

// ---- an op that needs attention ----------------------------------------------------------------------------------

/** The current op, or null without one (404 OPS_NONE). */
async function readOp(): Promise<OpView | null> {
  try {
    return await api<OpView>('GET', 'ops/current', undefined, { background: true });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** An op in `needs_attention`: Lanjutkan, Batalkan, the operations page and the CLI lines (§9.4, M46). */
function OpAttention() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const titleId = useId();
  const dashboard = useApiQuery<DashboardResponse>({ queryKey: ['dashboard'], path: 'dashboard', staleTime: 30_000, request: { background: true } });
  const flagged = dashboard.data?.alerts.some((a) => a.kind === 'ops_attention') === true;
  const current = useQuery({ queryKey: OP_KEY, queryFn: readOp, enabled: me !== undefined && flagged });
  const op = current.data ?? null;
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  if (op === null || (!op.needsAttention && outcome === null)) return null;

  const after = (next: OpView, text: AdminKey): void => {
    queryClient.setQueryData<OpView | null>(OP_KEY, next);
    setOutcome({ kind: 'success', text: t(text) });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const resume = async (): Promise<void> => {
    setBusy(true);
    setOutcome(null);
    try {
      after(await api<OpView>('POST', 'ops/drive', { resume: true }), 'diagnostics.op.resumed');
    } catch (e) {
      setOutcome({ kind: 'error', text: problemText(t, e) });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (): Promise<void> => {
    after(await api<OpView>('POST', 'ops/cancel'), 'diagnostics.op.cancelled');
  };

  const kind = op.kind === null ? t('diagnostics.unknown') : t(`ops.kind.${op.kind}`);
  const cancellable = op.needsAttention && !op.terminal && !op.pointOfNoReturn;

  return (
    <section aria-labelledby={titleId} className="grid gap-3 rounded-md border border-bad-line bg-bad-bg px-3.5 py-3">
      <h2 id={titleId} className="text-base font-bold text-bad">
        {t('diagnostics.op.title')}
      </h2>
      <p className="text-sm">{t('diagnostics.op.body', { kind })}</p>
      <dl className="flex flex-col gap-2">
        <Row label={t('ops.page.state')}>{t(`ops.state.${op.state}` as TKey)}</Row>
        <Row label={t('ops.page.progress')}>{Math.round(op.progress)} %</Row>
        {op.error !== null && (
          <Row label={t('ops.page.error')}>
            <span className="flex flex-col">
              <span>{t(`error.${op.error.code}` as TKey)}</span>
              {op.error.detail !== undefined && <span className="font-mono text-xs break-all text-muted-foreground">{op.error.detail}</span>}
            </span>
          </Row>
        )}
      </dl>
      {op.needsAttention && (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={() => void resume()}>
            {t('ops.page.resume')}
          </Button>
          {cancellable && (
            <Button variant="outline" className="bg-background" disabled={busy} onClick={() => setCancelling(true)}>
              {t('ops.page.cancel')}
            </Button>
          )}
        </div>
      )}
      <a href={OPS_PAGE_PATH} className="w-fit text-sm font-semibold text-accent-text underline-offset-4 hover:underline">
        {t('diagnostics.op.open_page')}
      </a>
      {outcome !== null && <Notice kind={outcome.kind}>{outcome.text}</Notice>}
      <div className="flex flex-col gap-1 text-sm">
        <p>{t('ops.page.cli_steps')}</p>
        <pre className="overflow-x-auto rounded border bg-background p-2 text-xs">
          {/* Final review (OPS-ATTN-EXIT): ops:resume or ops:cancel, as on the operations page. */}
          <code>{opCliLines(op).join('\n')}</code>
        </pre>
        <p className="text-muted-foreground">{t('ops.page.cli_hint')}</p>
      </div>
      <ConfirmDialog
        open={cancelling}
        title={t('diagnostics.op.cancel_title')}
        description={t('ops.page.cancel_confirm')}
        confirmLabel={t('ops.page.cancel')}
        destructive
        onConfirm={cancel}
        onClose={() => setCancelling(false)}
      />
    </section>
  );
}

// ---- the screen --------------------------------------------------------------------------------------------------

/** `/admin/diagnostics`. */
export function DiagnosticsScreen() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  // A refusal is the answer; only a lost connection is worth asking again.
  const query = useApiQuery<DiagnosticsReport>({ queryKey: DIAGNOSTICS_KEY, path: 'diagnostics', retry: (count, e) => !(e instanceof ApiError) && count < 2 });
  const report = query.data;

  return (
    <div className="grid gap-6">
      <PageHead
        title={t('nav.diagnostics')}
        intro={t('diagnostics.description')}
        actions={
          <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
            {t('diagnostics.refresh')}
          </Button>
        }
      />

      {report?.exposure?.ok === false && <ExposureBanner url={report.exposure.url} />}
      <OpAttention />

      {report === undefined ? (
        query.isError ? (
          <ErrorState title={t('diagnostics.load_failed')} error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          <div className="grid gap-x-8 gap-y-6 md:grid-cols-2 xl:grid-cols-3">
            {BLOCK_ORDER.map((name) => (
              <Block key={name} name={name} report={report} />
            ))}
          </div>
          {holds(me, 'system.diagnostics.manage') && <BrowserTests onSaved={() => void queryClient.invalidateQueries({ queryKey: DIAGNOSTICS_KEY })} />}
        </>
      )}
    </div>
  );
}
