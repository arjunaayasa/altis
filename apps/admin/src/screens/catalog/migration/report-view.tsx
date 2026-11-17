import { ACCRED_GROUPS, isUlid } from '@altis/shared';
import { MIGRATION_DRY_LIST_KEYS, MIGRATION_MATCH_KEYS, type MigrationSummary } from '@altis/shared/api/catalog/migration';
import type { RunView } from '@altis/shared/api/catalog/runs';
import { Link } from '@tanstack/react-router';
import { useId, type ReactNode } from 'react';
import { z } from 'zod';
import { Badge, Notice, NoticeAlert } from '@/components/form-field';
import { TABLE } from '@/components/layout';
import { buttonVariants } from '@/components/ui/button';
import { useLocale, useT, type Translate } from '@/i18n';
import { isMessageKey } from '@/lib/form-errors';
import { cn } from '@/lib/utils';
import { DryListsReport, MatchesReport } from './people';

/**
 * The report of a SLiMS migration run (Phase 2 spec §11.6; plan Task 30; summary of Task 23): what `catalog_runs.summary`
 * holds, shown as the dry run's or the migration's report.
 *
 * - **Reconciliation** per SLiMS table: `source = migrated + merged + skipped + archived`; a table read with a
 *   difference left over is drawn in red with its difference and "Tidak terjelaskan"; a table this edition does not
 *   read never fails and says why by its `unreadKind`: a table of a later module ("Tidak dibaca: modul
 *   Anggota/Sirkulasi", with the hint that the separate aggregate import reads some of its columns without migrating
 *   them), a derived table ("Tidak dibaca: tabel turunan"), or no reason (a plugin table, or a summary stored by an
 *   earlier release: "Tidak dibaca (belum didukung)").
 * - A re-sync dry run counts the SLiMS records and copies that are new, changed or gone (`catalogChanges`).
 * - The rows of the ALTIS target tables before and after (M13), the character-set sample of the first 1 000 rows
 *   (M13), the text repairs per column and their samples (cut to 120 characters, M6), the random check sample with a
 *   link to each record, the missing files and the non-standard barcodes, and the warnings.
 * - "Unduh laporan lengkap (CSV)" streams `GET catalog/runs/:id/report` (staff only, S18), whose rows are whole.
 *
 * The summary is read through a tolerant check: a field that is missing or of another shape shows as empty, so a run
 * cut short (or written by another release) still shows what it has. Every value is text in React, never HTML.
 */

const count = z.number().finite().catch(0);

const ReportSummary = z.object({
  version: z.enum(['9', '8', 'unknown']).nullable().catch(null),
  stage: z.string().max(64).nullable().catch(null),
  reconciliation: z
    .object({
      ok: z.boolean(),
      tables: z.array(
        z.object({
          table: z.string(),
          source: count,
          migrated: count,
          merged: count,
          skipped: count,
          archived: count,
          unread: z.boolean().catch(false),
          diff: count,
          // ---- Komunitas K1 (catalogue re-sync) ----
          unreadKind: z.enum(['phase3', 'derived']).optional().catch(undefined),
        }),
      ),
    })
    .nullable()
    .catch(null),
  samples: z.array(z.object({ column: z.string(), fix: z.string(), before: z.string(), after: z.string().nullable() })).catch([]),
  charset: z
    .array(
      z.object({
        column: z.string(),
        rows: count,
        ascii: count,
        utf8: count,
        cp1252: count,
        mojibake: count,
        samples: z.array(z.string()).catch([]),
      }),
    )
    .catch([]),
  targets: z.array(z.object({ table: z.string(), before: count, after: count })).catch([]),
  checks: z.array(z.object({ legacyId: z.string(), recordId: z.string(), title: z.string(), matches: z.boolean() })).catch([]),
  missingFiles: count,
  nonstandardBarcodes: count,
  warnings: z.array(z.string()).catch([]),
  // ---- Komunitas K1 (catalogue re-sync) ----
  catalogChanges: z.number().int().nonnegative().optional().catch(undefined),
  // ---- Komunitas (SLiMS members and circulation) ----
  memberNoCollisions: z.number().int().nonnegative().optional().catch(undefined),
  matches: z
    .array(z.object({ key: z.enum(MIGRATION_MATCH_KEYS), scope: z.string(), source: count, altis: count, explained: count, ok: z.boolean() }))
    .optional()
    .catch(undefined),
  dryLists: z
    .array(z.object({ key: z.enum(MIGRATION_DRY_LIST_KEYS), count, samples: z.array(z.string()).max(20).catch([]) }))
    .optional()
    .catch(undefined),
  // The SLiMS member types the run saw: their names label the member rows of "Cocokkan dengan SLiMS".
  memberTypes: z
    .array(z.object({ id: z.string(), name: z.string(), members: count, group: z.enum(ACCRED_GROUPS) }))
    .optional()
    .catch(undefined),
});

/** What the report shows of a run's summary (MigrationSummary without the per-table counters, which reconcile). */
export type ReportData = Omit<MigrationSummary, 'tables' | 'unread' | 'fixes'> & { fixes: { column: string; fix: string; count: number }[] };

/** The text repairs `{column: {fix: n}}` as rows, read entry by entry (the column names come from SLiMS). */
function fixRows(raw: unknown): ReportData['fixes'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const rows: ReportData['fixes'] = [];
  for (const [column, fixes] of Object.entries(raw)) {
    if (typeof fixes !== 'object' || fixes === null || Array.isArray(fixes)) continue;
    for (const [fix, n] of Object.entries(fixes as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n)) rows.push({ column, fix, count: n });
    }
  }
  return rows;
}

/** The report data of a run's summary, or null when it has none (a run that has not started). */
export function readReport(summary: Record<string, unknown> | null): ReportData | null {
  if (summary === null) return null;
  const parsed = ReportSummary.safeParse(summary);
  if (!parsed.success) return null;
  return { ...parsed.data, fixes: fixRows(summary['fixes']) };
}

/** The text of a code with a message under `prefix`, else the code itself (a code of a newer release). */
function codeText(t: Translate, prefix: string, code: string): string {
  const key = `${prefix}${code}`;
  return isMessageKey(key) ? t(key) : code;
}

/** The label of a migration stage (§11.3), or its name. */
export function stageText(t: Translate, stage: string): string {
  return codeText(t, 'catalog.migration.stage.', stage);
}

/** A table of the report: an `h3` and a scrollable table named by it. */
function ReportTable({ title, hint, head, children }: { title: string; hint?: string; head: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <div className="grid gap-2">
      <h3 id={id} className="text-sm font-bold">
        {title}
      </h3>
      {hint !== undefined && <p className="max-w-[75ch] text-sm text-muted-foreground">{hint}</p>}
      <div className={TABLE.wrap}>
        <table aria-labelledby={id} className={TABLE.table}>
          <thead>
            <tr>{head}</tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, numeric = false }: { children: ReactNode; numeric?: boolean }) {
  return (
    <th scope="col" className={cn(TABLE.th, numeric && 'text-right')}>
      {children}
    </th>
  );
}

function RowHead({ children }: { children: ReactNode }) {
  return (
    <th scope="row" className={cn(TABLE.td, 'text-left font-normal break-all')}>
      {children}
    </th>
  );
}

function Td({ children, numeric = false, className }: { children: ReactNode; numeric?: boolean; className?: string }) {
  return <td className={cn(TABLE.td, numeric && 'text-right', className)}>{children}</td>;
}

/** Why a table is not read, by its `unreadKind` (none: the earlier label). */
function UnreadLabel({ kind }: { kind: 'phase3' | 'derived' | undefined }) {
  const t = useT();
  if (kind === 'phase3') {
    return (
      <span className="inline-flex flex-col items-end gap-1">
        <Badge>{t('catalog.migration.report.unread_phase3')}</Badge>
        <span className="text-xs text-muted-foreground">{t('catalog.migration.report.unread_phase3_hint')}</span>
      </span>
    );
  }
  return <Badge>{t(kind === 'derived' ? 'catalog.migration.report.unread_derived' : 'catalog.migration.report.unread')}</Badge>;
}

/**
 * `unclosed`: the run ended outside its slices (its job cancelled while queued, or dead) and nothing closed it yet: its
 * counts of the ALTIS tables are still its first stage's, so they are not shown as its result.
 */
export function ReportView({ run, unclosed = false }: { run: RunView; unclosed?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale === 'en' ? 'en' : 'id');
  const n = (value: number): string => number.format(value);
  const titleId = useId();
  const report = readReport(run.summary);
  const failing = report?.reconciliation?.tables.filter((r) => !r.unread && r.diff !== 0) ?? [];

  return (
    <section aria-labelledby={titleId} className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={titleId} className="text-base font-bold">
          {t(run.dryRun ? 'catalog.migration.report.title_dry' : 'catalog.migration.report.title_real')}
        </h2>
        {run.reportFileId !== null && (
          <a
            href={`/api/v1/catalog/runs/${encodeURIComponent(run.id)}/report`}
            download
            className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('catalog.migration.report.download')}
          </a>
        )}
      </div>
      {run.status === 'failed' && <Notice kind="error">{t('catalog.migration.run.failed')}</Notice>}
      {run.status === 'cancelled' && <NoticeAlert>{t('catalog.migration.run.cancelled')}</NoticeAlert>}
      {report !== null && (
        <>
          <p className="text-sm">
            {t('catalog.migration.report.version', {
              version: report.version === null || report.version === 'unknown' ? t('catalog.migration.report.version_unknown') : report.version,
            })}
          </p>
          {report.warnings.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-bold">{t('catalog.migration.report.warnings')}</h3>
              <ul className="list-disc pl-5 text-sm">
                {report.warnings.map((w) => (
                  <li key={w}>{codeText(t, 'catalog.migration.warning.', w)}</li>
                ))}
              </ul>
            </div>
          )}

          <MatchesReport matches={report.matches} collisions={report.memberNoCollisions} memberTypes={report.memberTypes} />
          <DryListsReport lists={report.dryLists} />
          {report.reconciliation === null ? (
            <NoticeAlert>{t('catalog.migration.report.reconcile_none')}</NoticeAlert>
          ) : (
            <>
              {failing.length === 0 ? (
                <NoticeAlert tone="success">{t('catalog.migration.report.reconcile_ok')}</NoticeAlert>
              ) : (
                <Notice kind="error">{t('catalog.migration.report.reconcile_failed', { count: n(failing.length) })}</Notice>
              )}
              <ReportTable
                title={t('catalog.migration.report.reconcile')}
                hint={t('catalog.migration.report.reconcile_hint')}
                head={
                  <>
                    <Th>{t('catalog.migration.report.col_table')}</Th>
                    <Th numeric>{t('catalog.migration.report.col_source')}</Th>
                    <Th numeric>{t('catalog.migration.report.col_migrated')}</Th>
                    <Th numeric>{t('catalog.migration.report.col_merged')}</Th>
                    <Th numeric>{t('catalog.migration.report.col_skipped')}</Th>
                    <Th numeric>{t('catalog.migration.report.col_archived')}</Th>
                    <Th numeric>{t('catalog.migration.report.col_diff')}</Th>
                  </>
                }
              >
                {report.reconciliation.tables.map((r) => {
                  const fails = !r.unread && r.diff !== 0;
                  return (
                    <tr key={r.table} className={fails ? 'bg-bad-bg' : undefined} data-reconcile={fails ? 'failed' : r.unread ? 'unread' : 'ok'}>
                      <RowHead>{r.table}</RowHead>
                      <Td numeric>{n(r.source)}</Td>
                      <Td numeric>{r.unread ? t('catalog.migration.report.none') : n(r.migrated)}</Td>
                      <Td numeric>{r.unread ? t('catalog.migration.report.none') : n(r.merged)}</Td>
                      <Td numeric>{r.unread ? t('catalog.migration.report.none') : n(r.skipped)}</Td>
                      <Td numeric>{r.unread ? t('catalog.migration.report.none') : n(r.archived)}</Td>
                      <Td numeric>
                        {r.unread ? (
                          <UnreadLabel kind={r.unreadKind} />
                        ) : fails ? (
                          <span className="inline-flex flex-wrap items-center justify-end gap-2">
                            <span className="font-semibold text-bad">{n(r.diff)}</span>
                            <Badge tone="danger">{t('catalog.migration.report.diff_failed')}</Badge>
                          </span>
                        ) : (
                          n(r.diff)
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </ReportTable>
            </>
          )}

          <ul className="flex flex-col gap-1 text-sm">
            <li>{t('catalog.migration.report.missing_files', { count: n(report.missingFiles) })}</li>
            <li>{t('catalog.migration.report.nonstandard_barcodes', { count: n(report.nonstandardBarcodes) })}</li>
            {report.catalogChanges !== undefined && <li>{t('catalog.migration.report.catalog_changes', { count: n(report.catalogChanges) })}</li>}
          </ul>

          {report.targets.length > 0 && unclosed && !run.dryRun && (
            <section className="flex flex-col gap-1">
              <h3 className="text-sm font-bold">{t('catalog.migration.report.targets')}</h3>
              <p className="text-sm text-muted-foreground">{t('catalog.migration.report.targets_unclosed')}</p>
            </section>
          )}
          {report.targets.length > 0 && !(unclosed && !run.dryRun) && (
            <ReportTable
              title={t('catalog.migration.report.targets')}
              {...(run.dryRun ? { hint: t('catalog.migration.report.targets_dry') } : {})}
              head={
                <>
                  <Th>{t('catalog.migration.report.col_target')}</Th>
                  <Th numeric>{t('catalog.migration.report.col_before')}</Th>
                  <Th numeric>{t('catalog.migration.report.col_after')}</Th>
                  <Th numeric>{t('catalog.migration.report.col_added')}</Th>
                </>
              }
            >
              {report.targets.map((r) => (
                <tr key={r.table}>
                  <RowHead>{r.table}</RowHead>
                  <Td numeric>{n(r.before)}</Td>
                  <Td numeric>{n(r.after)}</Td>
                  <Td numeric>{n(r.after - r.before)}</Td>
                </tr>
              ))}
            </ReportTable>
          )}

          {report.charset.length > 0 && (
            <ReportTable
              title={t('catalog.migration.report.charset')}
              hint={t('catalog.migration.report.charset_hint')}
              head={
                <>
                  <Th>{t('catalog.migration.report.col_column')}</Th>
                  <Th numeric>{t('catalog.migration.report.col_rows')}</Th>
                  <Th numeric>{t('catalog.migration.report.col_ascii')}</Th>
                  <Th numeric>{t('catalog.migration.report.col_utf8')}</Th>
                  <Th numeric>{t('catalog.migration.report.col_cp1252')}</Th>
                  <Th numeric>{t('catalog.migration.report.col_mojibake')}</Th>
                  <Th>{t('catalog.migration.report.col_examples')}</Th>
                </>
              }
            >
              {report.charset.map((c) => (
                <tr key={c.column}>
                  <RowHead>{c.column}</RowHead>
                  <Td numeric>{n(c.rows)}</Td>
                  <Td numeric>{n(c.ascii)}</Td>
                  <Td numeric>{n(c.utf8)}</Td>
                  <Td numeric className={c.cp1252 > 0 ? 'font-semibold text-warn' : undefined}>
                    {n(c.cp1252)}
                  </Td>
                  <Td numeric className={c.mojibake > 0 ? 'font-semibold text-warn' : undefined}>
                    {n(c.mojibake)}
                  </Td>
                  <Td>
                    {c.samples.length === 0 ? (
                      t('catalog.migration.report.none')
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {c.samples.map((s, i) => (
                          <li key={i} className="text-meta break-all">
                            {s}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Td>
                </tr>
              ))}
            </ReportTable>
          )}

          {report.fixes.length > 0 && (
            <ReportTable
              title={t('catalog.migration.report.fixes')}
              head={
                <>
                  <Th>{t('catalog.migration.report.col_column')}</Th>
                  <Th>{t('catalog.migration.report.col_fix')}</Th>
                  <Th numeric>{t('catalog.migration.report.col_count')}</Th>
                </>
              }
            >
              {report.fixes.map((f, i) => (
                <tr key={i}>
                  <RowHead>{f.column}</RowHead>
                  <Td>{codeText(t, 'catalog.migration.fix.', f.fix)}</Td>
                  <Td numeric>{n(f.count)}</Td>
                </tr>
              ))}
            </ReportTable>
          )}

          {report.samples.length > 0 && (
            <ReportTable
              title={t('catalog.migration.report.samples')}
              head={
                <>
                  <Th>{t('catalog.migration.report.col_column')}</Th>
                  <Th>{t('catalog.migration.report.col_fix')}</Th>
                  <Th>{t('catalog.migration.report.col_sample_before')}</Th>
                  <Th>{t('catalog.migration.report.col_sample_after')}</Th>
                </>
              }
            >
              {report.samples.map((s, i) => (
                <tr key={i}>
                  <RowHead>{s.column}</RowHead>
                  <Td>{codeText(t, 'catalog.migration.fix.', s.fix)}</Td>
                  <Td className="text-meta break-all">{s.before}</Td>
                  <Td className="text-meta break-all">{s.after ?? t('catalog.migration.report.none')}</Td>
                </tr>
              ))}
            </ReportTable>
          )}

          {report.checks.length > 0 && (
            <ReportTable
              title={t('catalog.migration.report.checks')}
              hint={t('catalog.migration.report.checks_hint')}
              head={
                <>
                  <Th>{t('catalog.migration.report.col_legacy')}</Th>
                  <Th>{t('catalog.migration.report.col_title')}</Th>
                  <Th>{t('catalog.migration.report.col_match')}</Th>
                  <Th>{t('catalog.migration.col_actions')}</Th>
                </>
              }
            >
              {report.checks.map((c, i) => (
                <tr key={i}>
                  <RowHead>{c.legacyId}</RowHead>
                  <Td className="break-words">{c.title}</Td>
                  <Td>
                    <Badge tone={c.matches ? 'neutral' : 'warning'}>
                      {t(c.matches ? 'catalog.migration.report.match_yes' : 'catalog.migration.report.match_no')}
                    </Badge>
                  </Td>
                  <Td>
                    {isUlid(c.recordId) && (
                      <Link
                        to="/admin/catalog/records/$recordId"
                        params={{ recordId: c.recordId }}
                        className="font-semibold text-accent-text underline-offset-4 hover:underline">
                        {t('catalog.migration.report.open_record')}
                      </Link>
                    )}
                  </Td>
                </tr>
              ))}
            </ReportTable>
          )}
        </>
      )}
    </section>
  );
}
