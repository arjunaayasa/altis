import { LOCALES, NOTICE_KINDS, NOTICE_STATUSES, type Locale, type NoticeKind, type NoticeStatus } from '@altis/shared';
import type {
  NoticeListItem,
  NoticeListResponse,
  NoticePreviewResponse,
  NoticeSendResponse,
  NoticeStatusResponse,
  NoticeTestResponse,
} from '@altis/shared/api/notices';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type FormEvent } from 'react';
import { Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { useDateTime } from '@/components/data-table';
import { Callout, DenseTable, ErrorState, FilterField, FilterRow, LAYER, PageHead, Section, SkeletonTable, StatStrip, Tag, type DenseColumn, type TagTone } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { holds, holdsAt } from '@/lib/access';
import { api } from '@/lib/api';
import { useApiQuery, useMe } from '@/lib/me';
import { SettingsLoader } from '@/screens/settings/library';
import { NoticeTemplatesForm } from '@/screens/settings/notices';
import { newTransactionKey } from './common';

/**
 * Pengingat E-mail (`/admin/layanan/pengingat`, `circulation.records.read`): whether the library can send mail (SMTP),
 * the last daily preparation and sending, the notices of the last 7 days by status; the log of notices (newest first,
 * by status, kind and day; a member opens on their page); and, for those who read the settings, the preview of each
 * mail with sample data, a test send to an address they type (to manage them), and the library's own wording of each
 * mail (`email.template.*`, group `email`; the reminder settings themselves are in Pengaturan › Sirkulasi).
 *
 * {@link SendRemindersButton} is the reminder button of Terlambat & Jatuh Tempo: it queues an overdue reminder for the
 * members of the given loans, one request per branch (the desk permission is per branch), at most 200 members each.
 */

interface Filters {
  status: string;
  kind: string;
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { status: '', kind: '', from: '', to: '' };

const STATUS_TONE: Record<NoticeStatus, TagTone> = {
  queued: 'neutral',
  sending: 'neutral',
  sent: 'ok',
  failed: 'bad',
  skipped: 'warn',
};

function listPath(f: Filters, cursor: string | null): string {
  const q = new URLSearchParams({ limit: '50' });
  if (f.status !== '') q.set('status', f.status);
  if (f.kind !== '') q.set('kind', f.kind);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.from)) q.set('from', f.from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.to)) q.set('to', f.to);
  if (cursor !== null) q.set('cursor', cursor);
  return `circulation/notices?${q.toString()}`;
}

function StatusPanel() {
  const t = useT();
  const at = useDateTime();
  const status = useApiQuery<NoticeStatusResponse>({ queryKey: ['circulation', 'notices', 'status'], path: 'circulation/notices/status' });
  if (status.data === undefined) return null;
  const s = status.data;
  const week =
    NOTICE_STATUSES.filter((x) => s.lastWeek[x] > 0)
      .map((x) => `${t(`vocab.notice_status.${x}`)} ${s.lastWeek[x]}`)
      .join(' · ') || '0';
  return (
    <Section title={t('notices.status.title')}>
      <Callout tone={s.smtpConfigured ? 'ok' : 'bad'} role={s.smtpConfigured ? 'status' : 'alert'} title={t(s.smtpConfigured ? 'notices.status.smtp_ok' : 'notices.status.smtp_missing')} />
      <StatStrip
        label={t('notices.status.title')}
        items={[
          { key: 'build', label: t('notices.status.last_build'), value: <span className="text-sm">{s.lastBuildAt === null ? t('notices.status.never') : at(s.lastBuildAt)}</span> },
          { key: 'send', label: t('notices.status.last_send'), value: <span className="text-sm">{s.lastSendAt === null ? t('notices.status.never') : at(s.lastSendAt)}</span> },
          { key: 'waiting', label: t('notices.status.waiting'), value: s.waiting },
          { key: 'week', label: t('notices.status.week'), value: <span className="text-sm">{week}</span> },
        ]}
      />
    </Section>
  );
}

function NoticeLog() {
  const t = useT();
  const me = useMe();
  const at = useDateTime();
  const ids = useId();
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const filtered = filters.status !== '' || filters.kind !== '' || filters.from !== '' || filters.to !== '';
  const canOpenMember = holds(me, 'members.records.read');
  const list = useInfiniteQuery({
    queryKey: ['circulation', 'notices', 'list', filters],
    queryFn: ({ pageParam }) => api<NoticeListResponse>('GET', listPath(filters, pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    enabled: me !== undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const apply = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setFilters(draft);
  };

  const columns: DenseColumn<NoticeListItem>[] = [
    { id: 'created', header: t('notices.col.created'), className: 'whitespace-nowrap', cell: (r) => at(r.createdAt) },
    {
      id: 'member',
      header: t('notices.col.member'),
      cell: (r) =>
        r.member === null ? (
          <span className="text-muted-foreground">{t('notices.member_gone')}</span>
        ) : (
          <div>
            {canOpenMember ? (
              <Link to={`/admin/anggota/${encodeURIComponent(r.member.id)}`} className="font-semibold text-accent-text underline-offset-4 hover:underline">
                {r.member.name}
              </Link>
            ) : (
              <span className="font-semibold">{r.member.name}</span>
            )}
            <p className="text-meta tracking-wide text-muted-foreground">{r.member.memberNo}</p>
          </div>
        ),
    },
    {
      id: 'kind',
      header: t('notices.col.kind'),
      cell: (r) => (
        <div>
          <p>{t(`vocab.notice_kind.${r.kind}`)}</p>
          <p className="text-meta text-muted-foreground">
            {r.kind !== 'hold_ready' && t('notices.loans', { count: r.loanCount })}
            {r.manual && ` · ${t('notices.manual')}`}
          </p>
        </div>
      ),
    },
    {
      id: 'status',
      header: t('notices.col.status'),
      cell: (r) => (
        <div className="grid gap-1">
          <Tag tone={STATUS_TONE[r.status]}>{t(`vocab.notice_status.${r.status}`)}</Tag>
          {r.reason !== null && <span className="text-meta text-muted-foreground">{t(`vocab.notice_reason.${r.reason}`)}</span>}
          {r.status === 'failed' && <span className="text-meta text-muted-foreground">{t('notices.attempts', { count: r.attempts })}</span>}
        </div>
      ),
    },
    { id: 'sent', header: t('notices.col.sent'), className: 'whitespace-nowrap', cell: (r) => (r.sentAt === null ? '—' : at(r.sentAt)) },
  ];

  const clear = (): void => {
    setDraft(NO_FILTERS);
    setFilters(NO_FILTERS);
  };

  return (
    <Section title={t('notices.log.title')}>
      <FilterRow
        label={t('notices.log.title')}
        onSubmit={apply}
        actions={
          <>
            <Button type="submit" variant="outline">
              {t('notices.filter.apply')}
            </Button>
            {filtered && (
              <Button type="button" variant="link" onClick={clear}>
                {t('notices.filter.clear')}
              </Button>
            )}
          </>
        }>
        <FilterField id={`${ids}-status`} label={t('notices.filter.status')}>
          <select id={`${ids}-status`} className={SELECT_CLASS} value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
            <option value="">{t('notices.filter.all')}</option>
            {NOTICE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`vocab.notice_status.${s}`)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField id={`${ids}-kind`} label={t('notices.filter.kind')}>
          <select id={`${ids}-kind`} className={SELECT_CLASS} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
            <option value="">{t('notices.filter.all')}</option>
            {NOTICE_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`vocab.notice_kind.${k}`)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label={t('notices.filter.from')}>{(c) => <Input {...c} type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />}</FilterField>
        <FilterField label={t('notices.filter.to')}>{(c) => <Input {...c} type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />}</FilterField>
      </FilterRow>
      {list.isError && list.data === undefined ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : list.data === undefined ? (
        <SkeletonTable label={t('shell.loading')} columns={5} rows={4} />
      ) : (
        <>
          <DenseTable
            caption={t('notices.log.caption')}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            empty={
              filtered ? (
                <span className="flex flex-wrap items-center gap-2">
                  {t('notices.log.empty_filtered')}
                  <Button type="button" variant="link" className="h-auto p-0" onClick={clear}>
                    {t('notices.filter.clear')}
                  </Button>
                </span>
              ) : (
                t('notices.log.empty')
              )
            }
          />
          {list.hasNextPage && (
            <Button variant="outline" className="w-fit" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {t('notices.load_more')}
            </Button>
          )}
        </>
      )}
    </Section>
  );
}

function PreviewAndTest() {
  const t = useT();
  const me = useMe();
  const ids = useId();
  const [kind, setKind] = useState<NoticeKind>('overdue');
  const [locale, setLocale] = useState<Locale>('id');
  const [to, setTo] = useState('');
  const [preview, setPreview] = useState<NoticePreviewResponse | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const canManage = holds(me, 'system.settings.manage');
  if (!holds(me, 'system.settings.read')) return null;

  const run = async (send: boolean): Promise<void> => {
    setProblem(null);
    setSentTo(null);
    setBusy(true);
    try {
      if (send) {
        await api<NoticeTestResponse>('POST', 'circulation/notices/test', { kind, locale, to: to.trim() });
        setSentTo(to.trim());
      } else {
        setPreview(await api<NoticePreviewResponse>('POST', 'circulation/notices/preview', { kind, locale }));
      }
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t('notices.test.title')}>
      <p className="-mt-1 max-w-[75ch] text-sm text-muted-foreground">{t('notices.test.intro')}</p>
      <form
        noValidate
        aria-label={t('notices.test.title')}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(false);
        }}>
        <FilterField id={`${ids}-kind`} label={t('notices.test.kind')}>
          <select id={`${ids}-kind`} className={SELECT_CLASS} value={kind} onChange={(e) => setKind(e.target.value as NoticeKind)}>
            {NOTICE_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`vocab.notice_kind.${k}`)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField id={`${ids}-locale`} label={t('notices.test.locale')}>
          <select id={`${ids}-locale`} className={SELECT_CLASS} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {t(`palette.language.${l}`)}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField wide label={t('notices.test.to')} hint={canManage ? undefined : t('notices.test.no_permission')}>
          {(c) => <Input {...c} type="email" autoComplete="email" maxLength={191} value={to} disabled={!canManage} onChange={(e) => setTo(e.target.value)} />}
        </FilterField>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="outline" disabled={busy}>
            {t('notices.test.preview')}
          </Button>
          <Button type="button" variant="outline" disabled={busy || !canManage || to.trim() === ''} onClick={() => void run(true)}>
            {t('notices.test.send')}
          </Button>
        </div>
      </form>
      {sentTo !== null && <Notice kind="success">{t('notices.test.sent', { to: sentTo })}</Notice>}
      {problem !== null && <ProblemAlert error={problem} />}
      {preview !== null && (
        <div className={`grid max-w-[75ch] gap-2 rounded-lg border p-4 ${LAYER}`}>
          <p className="text-sm">
            <span className="text-muted-foreground">{t('notices.test.subject')}: </span>
            <span className="font-semibold">{preview.subject}</span>
          </p>
          <pre className="font-sans text-sm whitespace-pre-wrap">{preview.text}</pre>
        </div>
      )}
    </Section>
  );
}

/** `/admin/layanan/pengingat`. */
export function NoticesScreen() {
  const t = useT();
  return (
    <div className="grid gap-6">
      <PageHead title={t('nav.circulation.notices')} intro={t('notices.intro')} />
      <StatusPanel />
      <NoticeLog />
      <PreviewAndTest />
      <Templates />
    </div>
  );
}

/** The library's own wording of the three mails, for those who read the settings. */
function Templates() {
  const me = useMe();
  if (!holds(me, 'system.settings.read')) return null;
  return <SettingsLoader group="email">{(view, canManage) => <NoticeTemplatesForm initial={view} canManage={canManage} />}</SettingsLoader>;
}

/** A loan of the overdue list, as the reminder button needs it. */
export interface ReminderLoan {
  branchId: string;
  memberId: string | null;
}

/** At most this many members per request (the API's limit). */
const SEND_CHUNK = 200;

/**
 * Queues an overdue reminder for the members of `loans` at each branch where the user serves (one request per branch
 * and 200 members), then says what was queued. Nothing shows for a user who serves nowhere among them.
 */
export function SendRemindersButton({ loans, label }: { loans: readonly ReminderLoan[]; label: 'notices.send.overdue' | 'notices.send.overdue_all' }) {
  const t = useT();
  const me = useMe();
  const [result, setResult] = useState<NoticeSendResponse | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const byBranch = new Map<string, Set<string>>();
  for (const l of loans) {
    if (l.memberId === null || !holdsAt(me, 'circulation.desk.use', l.branchId)) continue;
    const set = byBranch.get(l.branchId) ?? new Set<string>();
    set.add(l.memberId);
    byBranch.set(l.branchId, set);
  }
  if (byBranch.size === 0) return null;

  const send = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    setResult(null);
    const total: NoticeSendResponse = { kind: 'overdue', queued: 0, existing: 0, nothing: 0, refused: [] };
    try {
      for (const [branchId, members] of byBranch) {
        const list = [...members];
        for (let k = 0; k < list.length; k += SEND_CHUNK) {
          const r = await api<NoticeSendResponse>(
            'POST',
            `branches/${encodeURIComponent(branchId)}/circulation/notices`,
            { memberIds: list.slice(k, k + SEND_CHUNK), kind: 'overdue' },
            { idempotencyKey: newTransactionKey('notice') },
          );
          total.queued += r.queued;
          total.existing += r.existing;
          total.nothing += r.nothing;
          total.refused.push(...r.refused);
        }
      }
      setResult(total);
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-1">
      <Button type="button" size="sm" variant="outline" className="w-fit" disabled={busy} onClick={() => void send()}>
        {t(label)}
      </Button>
      {result !== null && (
        <p role="status" className="text-meta text-muted-foreground">
          {t('notices.send.result', { queued: result.queued, existing: result.existing, nothing: result.nothing })}
          {result.refused.length > 0 && ` ${t('notices.send.result_refused', { count: result.refused.length })}`}
        </p>
      )}
      {problem !== null && <ProblemAlert error={problem} />}
    </div>
  );
}
