import { CLEARANCE_PURPOSES, type ClearancePurpose, type ErrorCode } from '@altis/shared';
import {
  CLEARANCE_PAPERS,
  type ClearanceCheckResponse,
  type ClearanceIssueBody,
  type ClearanceListResponse,
  type ClearancePaper,
  type ClearanceView,
} from '@altis/shared/api/circulation';
import type { MemberListItem, MemberSearchResponse } from '@altis/shared/api/members';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Field, Notice, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { DenseTable, ErrorState, FilterField, FilterRow, InlinePanel, PageHead, Section, SkeletonTable, StatusText, Tag, type DenseColumn } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api, csrfToken, setCsrfToken } from '@/lib/api';
import { buildSync } from '@/lib/build-sync';
import { useMe } from '@/lib/me';
import { todayLocal, useCalendarDate } from '@/screens/circulation/common';

/**
 * Surat Bebas Pustaka (`/admin/anggota/bebas-pustaka`): numbered clearance letters for members who leave (graduation,
 * a move). Members are picked one by one (number or name) or a whole class at once (at most 200); "Periksa" shows who
 * may get a letter now (no open loan, no unpaid balance, no hold waiting on the hold shelf) and why the others may not;
 * "Cetak surat" issues the next numbers of the year to those who pass and opens the PDF (the refused ones are listed on
 * its last page). Below, the letters issued: print one again (same number) or void it (its number is never reused; the
 * reason is asked in a panel above the list).
 *
 * Everything needs `members.records.manage`. The letter's paper and signature come from Pengaturan › Anggota.
 */

const LETTERS_KEY = ['members', 'clearances'] as const;
const MAX = 200;

/** The PDF of `POST members/clearances`, read as bytes; a refusal (any answer that is not a PDF) as its ApiError. */
async function issuePdf(body: ClearanceIssueBody): Promise<{ blob: Blob; issued: number; refused: number }> {
  const token = csrfToken();
  const res = await fetch('/api/v1/members/clearances', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/pdf, application/problem+json', 'Content-Type': 'application/json', ...(token === null ? {} : { 'X-CSRF-Token': token }) },
    body: JSON.stringify(body),
  });
  const build = res.headers.get('X-Altis-Build');
  if (build !== null) buildSync.observe(build);
  const rotated = res.headers.get('X-CSRF-Token');
  if (rotated !== null && rotated !== '') setCsrfToken(rotated);
  if (res.ok && /^application\/pdf\b/i.test(res.headers.get('Content-Type') ?? '')) {
    return { blob: await res.blob(), issued: Number(res.headers.get('X-Altis-Clearance-Issued') ?? '0'), refused: Number(res.headers.get('X-Altis-Clearance-Refused') ?? '0') };
  }
  const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string; errors?: { path: string; code: string }[]; reason?: string };
  throw new ApiError(res.status, (problem.code ?? 'INTERNAL') as ErrorCode, {
    ...(problem.detail === undefined ? {} : { detail: problem.detail }),
    ...(problem.errors === undefined ? {} : { errors: problem.errors }),
    ...(problem.reason === undefined ? {} : { reason: problem.reason }),
    problemJson: problem.code !== undefined,
  });
}

/** Opens `url` in a new tab when the browser can. */
function openTab(url: string): void {
  try {
    window.open(url, '_blank', 'noopener');
  } catch {
    // The link on the page still opens it.
  }
}

export function ClearancesScreen() {
  const t = useT();
  const me = useMe();
  const day = useCalendarDate();
  const ids = useId();
  const queryClient = useQueryClient();
  const canManage = holds(me, 'members.records.manage');

  const [picked, setPicked] = useState<MemberListItem[]>([]);
  const [q, setQ] = useState('');
  const [className, setClassName] = useState('');
  const [found, setFound] = useState<MemberListItem[] | null>(null);
  const [check, setCheck] = useState<ClearanceCheckResponse | null>(null);
  const [purpose, setPurpose] = useState<ClearancePurpose>('graduation');
  const [issuedOn, setIssuedOn] = useState(todayLocal());
  const [paper, setPaper] = useState<ClearancePaper | ''>('');
  const [problem, setProblem] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState<ClearanceView | null>(null);
  const [reason, setReason] = useState('');
  const [voidProblem, setVoidProblem] = useState<unknown>(null);

  const letters = useInfiniteQuery({
    queryKey: [...LETTERS_KEY],
    queryFn: ({ pageParam }) => api<ClearanceListResponse>('GET', `members/clearances?limit=50${pageParam === null ? '' : `&cursor=${encodeURIComponent(pageParam)}`}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: me !== undefined && canManage,
  });

  const add = (rows: readonly MemberListItem[]): void => {
    setCheck(null);
    setPicked((list) => {
      const have = new Set(list.map((m) => m.id));
      return [...list, ...rows.filter((m) => !have.has(m.id))].slice(0, MAX);
    });
  };

  const search = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setProblem(null);
    const body = { ...(q.trim() === '' ? {} : { q: q.trim() }), ...(className.trim() === '' ? {} : { className: className.trim() }), limit: MAX };
    if (q.trim() === '' && className.trim() === '') return;
    try {
      const res = await api<MemberSearchResponse>('POST', 'members/search', body);
      setFound(res.items.filter((m) => m.status !== 'archived' && m.status !== 'anonymized'));
    } catch (error) {
      setProblem(error);
    }
  };

  const runCheck = async (): Promise<void> => {
    setProblem(null);
    setNotice(null);
    try {
      setCheck(await api<ClearanceCheckResponse>('POST', 'members/clearances/check', { memberIds: picked.map((m) => m.id) }));
    } catch (error) {
      setProblem(error);
    }
  };

  const issue = async (): Promise<void> => {
    setProblem(null);
    setNotice(null);
    setBusy(true);
    try {
      const body: ClearanceIssueBody = { memberIds: picked.map((m) => m.id), purpose, issuedOn, ...(paper === '' ? {} : { paper }) };
      const pdf = await issuePdf(body);
      const url = URL.createObjectURL(pdf.blob);
      if (pdfUrl !== null) URL.revokeObjectURL(pdfUrl);
      setPdfUrl(url);
      openTab(url);
      setNotice(t('members.clearance.issued', { issued: pdf.issued, refused: pdf.refused }));
      setCheck(null);
      setPicked([]);
      await queryClient.invalidateQueries({ queryKey: LETTERS_KEY });
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  };

  const voidLetter = async (letter: ClearanceView): Promise<void> => {
    await api<{ id: string }>('POST', `members/${encodeURIComponent(letter.memberId)}/clearances/${encodeURIComponent(letter.id)}/void`, { reason: reason.trim() });
    setNotice(t('members.clearance.voided', { number: letter.number }));
    setReason('');
    await queryClient.invalidateQueries({ queryKey: LETTERS_KEY });
  };

  const refusalsOf = (id: string): string | null => {
    const row = check?.items.find((r) => r.memberId === id);
    if (row === undefined) return null;
    return row.refusals.length === 0 ? '' : row.refusals.map((r) => t(`vocab.clearance_refusal.${r}`)).join('; ');
  };
  const passing = check?.items.filter((r) => r.refusals.length === 0).length ?? 0;
  const rows = letters.data?.pages.flatMap((p) => p.items) ?? [];

  if (!canManage) return <Notice kind="error">{t('members.clearance.no_permission')}</Notice>;

  const closeVoid = (): void => {
    setVoiding(null);
    setReason('');
    setVoidProblem(null);
  };

  const pickedColumns: DenseColumn<MemberListItem>[] = [
    {
      id: 'member',
      header: t('members.clearance.col.member'),
      cell: (m) => (
        <>
          <span className="font-semibold tracking-wide">{m.memberNo}</span> · {m.name}
        </>
      ),
    },
    { id: 'class', header: t('members.clearance.col.class'), cell: (m) => m.className ?? '—' },
    {
      id: 'check',
      header: t('members.clearance.col.check'),
      cell: (m) => {
        const why = refusalsOf(m.id);
        return why === null ? <span className="text-muted-foreground">—</span> : why === '' ? <Tag tone="ok">{t('members.clearance.passes')}</Tag> : <StatusText tone="bad">{why}</StatusText>;
      },
    },
    {
      id: 'actions',
      header: <span className="sr-only">{t('table.actions')}</span>,
      className: 'w-px py-1.5 text-right whitespace-nowrap',
      cell: (m) => (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t('members.clearance.remove_named', { name: m.name })}
          onClick={() => {
            setPicked((list) => list.filter((x) => x.id !== m.id));
            setCheck(null);
          }}>
          {t('members.clearance.remove')}
        </Button>
      ),
    },
  ];

  const letterColumns: DenseColumn<ClearanceView>[] = [
    {
      id: 'number',
      header: t('members.clearance.col.number'),
      cell: (l) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="tracking-wide whitespace-nowrap">{l.number}</span>
          {l.voided && <Tag tone="warn">{t('members.clearance.void_badge')}</Tag>}
        </span>
      ),
    },
    { id: 'member', header: t('members.clearance.col.member'), cell: (l) => (l.name === null ? t('members.clearance.anonymous') : `${l.memberNo ?? ''} · ${l.name}`) },
    { id: 'issued', header: t('members.clearance.col.issued'), className: 'whitespace-nowrap', cell: (l) => day(l.issuedOn) },
    { id: 'purpose', header: t('members.clearance.col.purpose'), cell: (l) => t(`vocab.clearance_purpose.${l.purpose}`) },
    {
      id: 'actions',
      header: <span className="sr-only">{t('table.actions')}</span>,
      className: 'w-px py-1.5 text-right whitespace-nowrap',
      cell: (l) => (
        <>
          <Button asChild size="sm" variant="ghost">
            <a href={`/api/v1/members/${encodeURIComponent(l.memberId)}/clearances/${encodeURIComponent(l.id)}/pdf`} target="_blank" rel="noopener" aria-label={t('members.clearance.reprint_named', { number: l.number })}>
              {t('members.clearance.reprint')}
            </a>
          </Button>
          {!l.voided && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('members.clearance.void_named', { number: l.number })}
              aria-expanded={voiding?.id === l.id}
              onClick={() => {
                setReason('');
                setVoidProblem(null);
                setVoiding(l);
              }}>
              {t('members.clearance.void')}
            </Button>
          )}
        </>
      ),
    },
  ];

  return (
    <div className="grid max-w-5xl gap-6">
      <PageHead title={t('nav.members.clearances')} intro={t('members.clearance.intro')} />
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {pdfUrl !== null && (
        <p className="text-sm">
          <a href={pdfUrl} target="_blank" rel="noopener" className="font-semibold text-accent-text underline-offset-4 hover:underline">
            {t('members.clearance.open_pdf')}
          </a>
        </p>
      )}
      <ProblemAlert error={problem} />

      <FilterRow
        label={t('members.clearance.search')}
        onSubmit={(e) => void search(e)}
        actions={
          <Button type="submit" variant="outline">
            {t('members.clearance.find')}
          </Button>
        }>
        <FilterField id={`${ids}-q`} wide label={t('members.clearance.search')}>
          <Input id={`${ids}-q`} value={q} maxLength={191} autoComplete="off" onChange={(e) => setQ(e.target.value)} />
        </FilterField>
        <FilterField id={`${ids}-class`} label={t('members.clearance.class')}>
          <Input id={`${ids}-class`} value={className} maxLength={64} autoComplete="off" onChange={(e) => setClassName(e.target.value)} />
        </FilterField>
      </FilterRow>

      {found !== null && (
        <section aria-label={t('members.clearance.found')} className="grid gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-meta text-muted-foreground">{t('members.clearance.found_count', { count: found.length })}</p>
            <Button type="button" size="sm" variant="outline" disabled={found.length === 0} onClick={() => add(found)}>
              {t('members.clearance.add_all')}
            </Button>
          </div>
          {found.length > 0 && (
            <ul className="grid max-h-64 overflow-y-auto rounded-lg border">
              {found.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-sm last:border-b-0">
                  <span className="min-w-0">
                    <span className="font-semibold tracking-wide">{m.memberNo}</span> · {m.name}
                    {m.className !== null && <span className="text-muted-foreground"> · {m.className}</span>}
                  </span>
                  <Button type="button" size="sm" variant="ghost" aria-label={t('members.clearance.add_named', { name: m.name })} onClick={() => add([m])}>
                    {t('members.clearance.add')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <Section
        title={t('members.clearance.picked', { count: picked.length, max: MAX })}
        aside={
          <>
            <Button type="button" size="sm" variant="outline" disabled={picked.length === 0} onClick={() => void runCheck()}>
              {t('members.clearance.check')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={picked.length === 0}
              onClick={() => {
                setPicked([]);
                setCheck(null);
              }}>
              {t('members.clearance.clear')}
            </Button>
          </>
        }>
        <DenseTable caption={t('members.clearance.picked_caption')} columns={pickedColumns} rows={picked} rowKey={(m) => m.id} empty={t('members.clearance.none_picked')} />
        {check !== null && <p className="text-sm font-semibold">{t('members.clearance.check_summary', { pass: passing, refused: check.items.length - passing })}</p>}
        <div className="grid gap-x-5 gap-y-4 sm:grid-cols-3">
          <Field id={`${ids}-purpose`} label={t('members.clearance.purpose')}>
            <select id={`${ids}-purpose`} className={SELECT_CLASS} value={purpose} onChange={(e) => setPurpose(e.target.value as ClearancePurpose)}>
              {CLEARANCE_PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {t(`vocab.clearance_purpose.${p}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('members.clearance.issued_on')}>
            {(c) => <Input {...c} type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />}
          </Field>
          <Field id={`${ids}-paper`} label={t('members.clearance.paper')}>
            <select id={`${ids}-paper`} className={SELECT_CLASS} value={paper} onChange={(e) => setPaper(e.target.value as ClearancePaper | '')}>
              <option value="">{t('members.clearance.paper_profile')}</option>
              {CLEARANCE_PAPERS.map((p) => (
                <option key={p} value={p}>
                  {t(`members.clearance.paper_${p}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy || picked.length === 0} onClick={() => void issue()}>
            {t('members.clearance.issue')}
          </Button>
        </div>
      </Section>

      <Section title={t('members.clearance.letters')}>
        {voiding !== null && (
          <InlinePanel
            key={voiding.id}
            title={t('members.clearance.confirm_void', { number: voiding.number })}
            onCancel={closeVoid}
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim() === '') return;
              setVoidProblem(null);
              voidLetter(voiding).then(
                () => setVoiding(null),
                (error: unknown) => setVoidProblem(error),
              );
            }}>
            <p className="-mt-1.5 max-w-[75ch] text-sm text-muted-foreground">{t('members.clearance.confirm_void_body')}</p>
            <Field id={`${ids}-reason`} label={t('members.clearance.void_reason')} className="max-w-md">
              <Input id={`${ids}-reason`} value={reason} maxLength={191} autoComplete="off" onChange={(e) => setReason(e.target.value)} />
            </Field>
            <ProblemAlert error={voidProblem} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant="destructive" disabled={reason.trim() === ''}>
                {t('members.clearance.void')}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={closeVoid}>
                {t('form.cancel')}
              </Button>
            </div>
          </InlinePanel>
        )}
        {letters.isError && letters.data === undefined ? (
          <ErrorState error={letters.error} onRetry={() => void letters.refetch()} retrying={letters.isFetching} />
        ) : letters.data === undefined ? (
          <SkeletonTable label={t('shell.loading')} columns={5} rows={3} />
        ) : (
          <DenseTable
            caption={t('members.clearance.letters')}
            columns={letterColumns}
            rows={rows}
            rowKey={(l) => l.id}
            rowClassName={(l) => (voiding?.id === l.id ? 'bg-accent-soft' : undefined)}
            empty={t('members.clearance.no_letters')}
          />
        )}
        {letters.hasNextPage && (
          <Button type="button" variant="outline" size="sm" className="w-fit" disabled={letters.isFetchingNextPage} onClick={() => void letters.fetchNextPage()}>
            {t('circulation.load_more')}
          </Button>
        )}
      </Section>
    </div>
  );
}
