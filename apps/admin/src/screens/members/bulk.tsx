import type { BranchListResponse } from '@altis/shared/api/branches';
import { MemberBulkBody, type MemberBulkResponse } from '@altis/shared/api/member-ops';
import type { MemberListItem } from '@altis/shared/api/members';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Field, Notice, ProblemAlert, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useApiQuery } from '@/lib/me';
import { useMemberTypes, useTypeName } from '@/screens/circulation/common';
import { refreshMembers } from './common';
import { addToCardQueue } from './tools';

/**
 * The bulk bar of the member list: what the selected members get (`POST members/bulk`), as an inline panel under the
 * selection (no dialog, except the archive question, which the panel asks in words): extend the membership, change the
 * type, class or home branch, suspend or reactivate, archive or restore; and the class promotion, which works on whole
 * classes ("VII-A => VIII-A", one pair per line) rather than on the selection. The answer says how many changed and
 * which members were refused, with the reason. "Tambah ke antrean kartu" queues the selection for Cetak Kartu.
 */

type Panel = 'extend' | 'set' | 'suspend' | 'reactivate' | 'archive' | 'restore' | 'promote';

/** "VII-A => VIII-A" lines as class pairs; the 1-based number of the first line that cannot be read, else null. */
export function parseClassPairs(text: string): { pairs: { from: string; to: string | null }[]; bad: number | null } {
  const pairs: { from: string; to: string | null }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    const m = /^(.+?)\s*(?:=>|->|→)\s*(.*)$/.exec(line);
    if (m === null || m[1]!.trim() === '') return { pairs, bad: i + 1 };
    const to = m[2]!.trim();
    pairs.push({ from: m[1]!.trim(), to: to === '' ? null : to });
  }
  return { pairs, bad: null };
}

export function BulkBar({ selected, onClear, canManage }: { selected: MemberListItem[]; onClear(): void; canManage: boolean }) {
  const t = useT();
  const ids = useId();
  const queryClient = useQueryClient();
  const types = useMemberTypes();
  const typeName = useTypeName();
  const branches = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: false }], path: 'branches', staleTime: 60_000 });
  const [panel, setPanel] = useState<Panel | null>(null);
  const [from, setFrom] = useState<'expiry' | 'today'>('expiry');
  const [days, setDays] = useState('');
  const [typeId, setTypeId] = useState('');
  const [className, setClassName] = useState('');
  const [branchId, setBranchId] = useState('');
  const [note, setNote] = useState('');
  const [pairs, setPairs] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MemberBulkResponse | null>(null);
  const [queued, setQueued] = useState<number | null>(null);

  const count = selected.length;
  const memberName = new Map(selected.map((m) => [m.id, `${m.memberNo} ${m.name}`]));

  const open = (p: Panel): void => {
    setPanel(p);
    setProblem(null);
    setError(null);
    setResult(null);
    setQueued(null);
  };

  const bodyOf = (): unknown => {
    const ids = selected.map((m) => m.id);
    switch (panel) {
      case 'extend':
        return { action: 'extend', ids, from, ...(days.trim() === '' ? {} : { days: Number(days.trim()) }) };
      case 'set':
        return {
          action: 'set',
          ids,
          set: {
            ...(typeId === '' ? {} : { memberTypeId: typeId }),
            ...(className.trim() === '' ? {} : { className: className.trim() }),
            ...(branchId === '' ? {} : { homeBranchId: branchId }),
          },
        };
      case 'suspend':
        return { action: 'set', ids, set: { status: 'suspended', statusNote: note.trim() } };
      case 'reactivate':
        return { action: 'set', ids, set: { status: 'active' } };
      case 'archive':
      case 'restore':
        return { action: panel, ids };
      case 'promote': {
        const parsed = parseClassPairs(pairs);
        if (parsed.bad !== null) {
          setError(t('members.tools.bulk.promote_invalid', { line: parsed.bad }));
          return null;
        }
        return { action: 'promote', classMap: parsed.pairs };
      }
      default:
        return null;
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setProblem(null);
    setError(null);
    const body = bodyOf();
    if (body === null) return;
    const parsed = MemberBulkBody.safeParse(body);
    if (!parsed.success) {
      setError(t('visits.settings.invalid'));
      return;
    }
    setBusy(true);
    try {
      const r = await api<MemberBulkResponse>('POST', 'members/bulk', parsed.data);
      setResult(r);
      await refreshMembers(queryClient);
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  const queue = (): void => {
    setQueued(addToCardQueue(selected.map((m) => ({ id: m.id, memberNo: m.memberNo, name: m.name }))));
  };

  return (
    <section aria-label={t('members.tools.selected', { count })} className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {count > 0 && (
          <p className="mr-2 text-sm font-medium" role="status">
            {t('members.tools.selected', { count })}
          </p>
        )}
        {count > 0 && (
          <Button size="sm" variant="outline" onClick={queue}>
            {t('members.tools.to_card_queue')}
          </Button>
        )}
        {canManage &&
          count > 0 &&
          (['extend', 'set', 'suspend', 'reactivate', 'archive', 'restore'] as const).map((p) => (
            <Button key={p} size="sm" variant={panel === p ? 'default' : 'outline'} onClick={() => open(p)}>
              {t(`members.tools.bulk.${p}`)}
            </Button>
          ))}
        {canManage && (
          <Button size="sm" variant={panel === 'promote' ? 'default' : 'outline'} onClick={() => open('promote')}>
            {t('members.tools.bulk.promote')}
          </Button>
        )}
        {count > 0 && (
          <Button size="sm" variant="ghost" onClick={onClear}>
            {t('members.tools.clear_selection')}
          </Button>
        )}
      </div>
      {queued !== null && <Notice kind="success">{t('members.tools.added_to_queue', { count: queued })}</Notice>}
      {panel !== null && (
        <form noValidate onSubmit={(e) => void submit(e)} className="grid gap-3 rounded-md border bg-card p-3 sm:grid-cols-2">
          {panel === 'extend' && (
            <>
              <Field id={`${ids}-from`} label={t('members.tools.bulk.from')}>
                <select id={`${ids}-from`} className={SELECT_CLASS} value={from} onChange={(e) => setFrom(e.target.value as 'expiry' | 'today')}>
                  <option value="expiry">{t('members.tools.bulk.from_expiry')}</option>
                  <option value="today">{t('members.tools.bulk.from_today')}</option>
                </select>
              </Field>
              <Field label={t('members.tools.bulk.days')}>{(c) => <Input {...c} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />}</Field>
            </>
          )}
          {panel === 'set' && (
            <>
              <Field id={`${ids}-type`} label={t('members.tools.bulk.type')}>
                <select id={`${ids}-type`} className={SELECT_CLASS} value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                  <option value="">{t('members.tools.bulk.keep')}</option>
                  {(types.data?.items ?? []).map((type) => (
                    <option key={type.id} value={type.id}>
                      {typeName(type)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('members.tools.bulk.class')} hint={t('members.tools.bulk.class_hint')}>
                {(c) => <Input {...c} maxLength={64} value={className} onChange={(e) => setClassName(e.target.value)} />}
              </Field>
              <Field id={`${ids}-branch`} label={t('members.tools.bulk.branch')}>
                <select id={`${ids}-branch`} className={SELECT_CLASS} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  <option value="">{t('members.tools.bulk.keep')}</option>
                  {(branches.data?.items ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          {panel === 'suspend' && (
            <Field label={t('members.tools.bulk.note')} className="sm:col-span-2">
              {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={191} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          )}
          {panel === 'archive' && <p className="text-sm sm:col-span-2">{t('members.tools.bulk.archive_confirm', { count })}</p>}
          {panel === 'promote' && (
            <Field label={t('members.tools.bulk.promote_pairs')} hint={t('members.tools.bulk.promote_hint')} className="sm:col-span-2">
              {(c) => <textarea {...c} className={TEXTAREA_CLASS} rows={5} value={pairs} onChange={(e) => setPairs(e.target.value)} />}
            </Field>
          )}
          {error !== null && (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {error}
            </p>
          )}
          <div className="sm:col-span-2">
            <ProblemAlert error={problem} />
          </div>
          {result !== null && (
            <div className="grid gap-1 text-sm sm:col-span-2" role="status">
              <p>{t('members.tools.bulk.done', { done: result.done })}</p>
              {result.refused.length > 0 && (
                <>
                  <p>{t('members.tools.bulk.refused', { count: result.refused.length })}</p>
                  <ul className="list-disc pl-5">
                    {result.refused.map((r) => (
                      <li key={r.id}>
                        {memberName.get(r.id) ?? r.id}: {t(`vocab.member_bulk_refusal.${r.reason}`)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy} variant={panel === 'archive' ? 'destructive' : 'default'}>
              {panel === 'promote' ? t('members.tools.bulk.promote') : t('members.tools.bulk.apply', { count })}
            </Button>
            <Button type="button" variant="outline" onClick={() => setPanel(null)}>
              {t('members.tools.bulk.cancel')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
