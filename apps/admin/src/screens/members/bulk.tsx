import type { BranchListResponse } from '@altis/shared/api/branches';
import { MemberBulkBody, type MemberBulkResponse } from '@altis/shared/api/member-ops';
import type { MemberListItem } from '@altis/shared/api/members';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Field, Notice, ProblemAlert, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Callout, InlinePanel, SelectionBar } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useApiQuery } from '@/lib/me';
import { useMemberTypes, useTypeName } from '@/screens/circulation/common';
import { refreshMembers } from './common';
import { addToCardQueue } from './tools';

/**
 * The bulk bar of the member list: a tinted bar over the table naming how many are selected, with one button per bulk
 * action; each opens its inline panel under the bar (no dialog; archiving asks its question in words in the panel).
 * What the selected members get goes to `POST members/bulk`: extend the membership, change the
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

  const ACTIONS = ['extend', 'set', 'suspend', 'reactivate', 'archive', 'restore'] as const;
  const panelFields =
    panel === null ? null : (
      <InlinePanel
        key={panel}
        title={panel === 'promote' ? t('members.tools.bulk.promote') : t('members.tools.bulk.panel_title', { action: t(`members.tools.bulk.${panel}`), count })}
        onSubmit={(e) => void submit(e)}
        onCancel={() => setPanel(null)}>
        <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
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
              <Field id={`${ids}-type`} label={t('members.tools.bulk.type')} hint={t('members.tools.bulk.type_hint')}>
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
              {(c) => <textarea {...c} rows={2} className={TEXTAREA_CLASS} maxLength={191} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          )}
          {panel === 'reactivate' && <p className="text-sm sm:col-span-2">{t('members.reactivate.body')}</p>}
          {panel === 'archive' && <p className="text-sm sm:col-span-2">{t('members.tools.bulk.archive_confirm', { count })}</p>}
          {panel === 'restore' && <p className="text-sm sm:col-span-2">{t('members.tools.bulk.restore_note')}</p>}
          {panel === 'promote' && (
            <Field label={t('members.tools.bulk.promote_pairs')} hint={t('members.tools.bulk.promote_hint')} className="sm:col-span-2">
              {(c) => <textarea {...c} className={TEXTAREA_CLASS} rows={5} value={pairs} onChange={(e) => setPairs(e.target.value)} />}
            </Field>
          )}
        </div>
        {error !== null && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
        <ProblemAlert error={problem} />
        {result !== null && (
          <Callout tone={result.refused.length > 0 ? 'warn' : 'ok'} role="status" title={t('members.tools.bulk.done', { done: result.done })}>
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
          </Callout>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy} variant={panel === 'archive' ? 'destructive' : 'default'}>
            {panel === 'promote' ? t('members.tools.bulk.promote') : t('members.tools.bulk.apply', { count })}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setPanel(null)}>
            {t('members.tools.bulk.cancel')}
          </Button>
        </div>
      </InlinePanel>
    );

  if (count === 0) {
    // Nothing selected: only the class promotion, which works on whole classes.
    return (
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {queued !== null && <Notice kind="success">{t('members.tools.added_to_queue', { count: queued })}</Notice>}
          {canManage && (
            <Button size="sm" variant="outline" aria-pressed={panel === 'promote'} onClick={() => (panel === 'promote' ? setPanel(null) : open('promote'))}>
              {t('members.tools.bulk.promote')}…
            </Button>
          )}
        </div>
        {panelFields}
      </div>
    );
  }

  return (
    <SelectionBar
      count={count}
      label={t('members.tools.selected', { count })}
      actions={canManage ? [...ACTIONS, 'promote' as const].map((p) => ({ id: p, label: t(`members.tools.bulk.${p}`) })) : []}
      open={panel}
      onOpenChange={(id) => (id === null ? setPanel(null) : open(id as Panel))}
      extra={
        <Button type="button" size="sm" variant="ghost" onClick={queue}>
          {t('members.tools.to_card_queue')}
        </Button>
      }
      onClear={() => {
        setPanel(null);
        onClear();
      }}
      clearLabel={t('members.tools.clear_selection')}>
      {queued !== null && <Notice kind="success">{t('members.tools.added_to_queue', { count: queued })}</Notice>}
      {panelFields}
    </SelectionBar>
  );
}
