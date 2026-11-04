import { THESAURUS_RECIPROCAL, THESAURUS_RELS, vocabKey, type SubjectType, type ThesaurusRel } from '@altis/shared';
import type { SubjectRelationsBody, SubjectView } from '@altis/shared/api/catalog/authorities';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useState } from 'react';
import { Badge, Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useT, type AdminKey } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { fieldErrorKey, problemText } from '@/lib/form-errors';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { useMe } from '@/lib/me';
import {
  authorityHref,
  authorityKey,
  authorityKindKey,
  authorityPath,
  orphansKey,
  relAbbr,
  subjectLabel,
  typeLabel,
  useAuthorityCandidates,
  type VersionChain,
} from './common';

/**
 * The thesaurus of a subject's page (Phase 2 Task 26; spec §3.5, §13; `PUT catalog/subjects/:id/relations`): the
 * subject's outgoing relations (USE/UF, BT/NT, RT, SA), edited as a list and saved as a whole with the subject's
 * version (the page's own writes chain through `versions`).
 *
 * - **Adding** takes a relation and a live subject found by its term (the subject itself is not offered; the same
 *   relation twice is refused before anything is sent; at most {@link MAX_RELATIONS}). **Removing** is per row.
 * - **The reciprocal preview** shows what the other subject will hold once saved, since the server writes (or removes)
 *   the reciprocal of every relation in the same transaction: adding `BT → X` previews "X NT ini" (new), removing a
 *   relation previews its reciprocal as removed.
 * - A refusal of one relation (`relations.<i>.subjectId`: `self`, `not_found`) lands on its row; any other refusal is
 *   a notice (CONFLICT_STALE with "Muat ulang data").
 * - BT/NT cycles are allowed and reported (`SubjectView.cycles`), with the terms along each cycle.
 *
 * The answer is `{id, version}` (S15): the subject is read again, and a list with no unsaved change follows it.
 */

/** The most relations one subject saves (`SubjectRelationsBody`). */
export const MAX_RELATIONS = 200;

/** One relation of the list, with what the page shows of the other subject. */
interface Relation {
  rel: ThesaurusRel;
  subjectId: string;
  term: string;
  type: SubjectType;
}

/** The subject at the other end of a relation. */
type Related = Omit<Relation, 'rel'>;

const keyOf = (r: Pick<Relation, 'rel' | 'subjectId'>): string => `${r.rel}:${r.subjectId}`;

function relationsOf(subject: SubjectView): Relation[] {
  return subject.relations.map(({ rel, subjectId, term, type }) => ({ rel, subjectId, term, type }));
}

/** The message of a refusal of one relation's subject. */
function relationErrorKey(code: string): AdminKey {
  if (code === 'self') return 'catalog.authorities.thesaurus.error.self';
  if (code === 'not_found') return 'catalog.authorities.thesaurus.error.not_found';
  return fieldErrorKey(code);
}

/** `relations.<i>.subjectId` (or `relations.<i>.rel`, `relations.<i>`) → `i`. */
function relationIndex(path: string): number | null {
  const m = /^relations\.(\d+)(?:\.|$)/.exec(path);
  return m === null ? null : Number(m[1]);
}

/** How many subjects of the cycles the page reads to name them (the cycles are rare and short). */
const CYCLE_LOOKUPS = 40;

/** The BT/NT cycles of `subject`, each as the terms along it (a subject the page does not know yet is read). */
function Cycles({ subject }: { subject: SubjectView }) {
  const t = useT();
  const me = useMe();
  const known = useMemo(() => new Map<string, string>([[subject.id, subject.term], ...subject.relations.map((r) => [r.subjectId, r.term] as const)]), [subject]);
  const unknown = useMemo(() => [...new Set(subject.cycles.flat())].filter((id) => !known.has(id)).slice(0, CYCLE_LOOKUPS), [subject.cycles, known]);
  const reads = useQueries({
    queries: unknown.map((id) => ({
      queryKey: authorityKey('subjects', id),
      queryFn: () => api<SubjectView>('GET', authorityPath('subjects', id)),
      enabled: me !== undefined,
    })),
  });
  const termOf = (id: string): string => known.get(id) ?? reads[unknown.indexOf(id)]?.data?.term ?? '…';
  if (subject.cycles.length === 0) return null;
  return (
    <div role="note" className="flex flex-col gap-1 rounded-md border border-warning-foreground/30 bg-warning px-3 py-2 text-sm text-warning-foreground">
      <p>{t('catalog.authorities.thesaurus.cycles')}</p>
      <ul className="list-inside list-disc">
        {subject.cycles.map((cycle) => (
          <li key={cycle.join('>')}>{cycle.map(termOf).join(' → ')}</li>
        ))}
      </ul>
    </div>
  );
}

export function ThesaurusEditor({
  subject,
  canEdit,
  versions,
  reload,
}: {
  subject: SubjectView;
  canEdit: boolean;
  versions: VersionChain;
  reload(): Promise<SubjectView | undefined>;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const headingId = useId();
  /** The relations as last read or saved, and the version they were read with. */
  const [saved, setSaved] = useState<{ relations: Relation[]; version: number }>(() => ({ relations: relationsOf(subject), version: subject.version }));
  const [rows, setRows] = useState<Relation[]>(saved.relations);
  const [rel, setRel] = useState<ThesaurusRel>('bt');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Related | null>(null);
  const [addError, setAddError] = useState<AdminKey | null>(null);
  /** The refusals of single relations, by relation key. */
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, AdminKey>>(new Map());
  const [problem, setProblem] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const savedKeys = useMemo(() => new Set(saved.relations.map(keyOf)), [saved.relations]);
  const rowKeys = useMemo(() => new Set(rows.map(keyOf)), [rows]);
  const removed = useMemo(() => saved.relations.filter((r) => !rowKeys.has(keyOf(r))), [saved.relations, rowKeys]);
  const dirty = removed.length > 0 || rows.length !== saved.relations.length || rows.some((r, i) => keyOf(r) !== keyOf(saved.relations[i]!));
  useDirtyGuard(dirty);

  // A newer read of the subject (after a save, a merge into it, a refetch) replaces a list with no unsaved change.
  useEffect(() => {
    if (dirty) return;
    const relations = relationsOf(subject);
    setSaved({ relations, version: subject.version });
    setRows(relations);
    // Only a newer read of the subject: the list's own edits do not reset it.
  }, [subject]);

  const candidates = useAuthorityCandidates('subjects', search, { enabled: canEdit });
  const offered = useMemo(() => {
    const live: Related[] = candidates.items
      .filter((v) => v.id !== subject.id && v.mergedInto === null && !v.archived)
      .map((v) => ({ subjectId: v.id, term: v.term, type: v.type }));
    return picked === null || live.some((v) => v.subjectId === picked.subjectId) ? live : [picked, ...live];
  }, [candidates.items, subject.id, picked]);
  const options: ComboboxOption[] = useMemo(() => offered.map((v) => ({ value: v.subjectId, label: subjectLabel(t, v.term, v.type) })), [offered, t]);

  const edited = (): void => {
    setDone(false);
    setProblem(null);
  };

  const add = (): void => {
    if (picked === null) return;
    const next: Relation = { ...picked, rel };
    if (rowKeys.has(keyOf(next))) {
      setAddError('catalog.authorities.thesaurus.duplicate');
      return;
    }
    if (rows.length >= MAX_RELATIONS) {
      setAddError('catalog.authorities.thesaurus.limit');
      return;
    }
    edited();
    setAddError(null);
    setRows([...rows, next]);
    setPicked(null);
    setSearch('');
  };

  const remove = (r: Relation): void => {
    edited();
    setAddError(null);
    setRows(rows.filter((x) => keyOf(x) !== keyOf(r)));
    setRowErrors((before) => {
      const next = new Map(before);
      next.delete(keyOf(r));
      return next;
    });
  };

  const discard = (): void => {
    edited();
    setAddError(null);
    setRowErrors(new Map());
    setRows(saved.relations);
  };

  const save = async (): Promise<void> => {
    edited();
    setAddError(null);
    setRowErrors(new Map());
    setBusy(true);
    const sent = versions.advance(saved.version);
    const body: SubjectRelationsBody = { relations: rows.map((r) => ({ rel: r.rel, subjectId: r.subjectId })), version: sent };
    try {
      const answer = await api<StoreResponse>('PUT', `${authorityPath('subjects', subject.id)}/relations`, body);
      versions.record(sent, answer.version);
      // The list is saved: the subject's next read replaces it (the server's terms and order).
      setSaved({ relations: rows, version: answer.version });
      setDone(true);
      // The subjects at the other end changed too (their reciprocals and versions), and a subject in the thesaurus is
      // no orphan.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: authorityKindKey('subjects') }),
        queryClient.invalidateQueries({ queryKey: orphansKey('subjects') }),
      ]);
    } catch (e) {
      const errors = e instanceof ApiError && e.code === 'VALIDATION_FAILED' ? (e.errors ?? []) : [];
      const onRows = new Map<string, AdminKey>();
      for (const error of errors) {
        const i = relationIndex(error.path);
        const row = i === null ? undefined : rows[i];
        if (row !== undefined && !onRows.has(keyOf(row))) onRows.set(keyOf(row), relationErrorKey(error.code));
      }
      setRowErrors(onRows);
      if (onRows.size === 0) setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  const reloadData = async (): Promise<void> => {
    const latest = await reload();
    if (latest === undefined) return;
    const relations = relationsOf(latest);
    setSaved({ relations, version: latest.version });
    setRows(relations);
    setRowErrors(new Map());
    setProblem(null);
  };

  const stale = problem instanceof ApiError && problem.code === 'CONFLICT_STALE';
  const reciprocal = (r: Relation): string => t('catalog.authorities.thesaurus.reciprocal', { term: r.term, rel: relAbbr(THESAURUS_RECIPROCAL[r.rel]) });

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base font-semibold">
        {t('catalog.authorities.thesaurus.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('catalog.authorities.thesaurus.description')}</p>
      <Cycles subject={subject} />
      {done && <Notice kind="success">{t('catalog.authorities.thesaurus.saved')}</Notice>}
      {problem !== null && (
        <Notice
          kind="error"
          action={
            stale ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void reloadData()}>
                {t('form.reload_data')}
              </Button>
            ) : undefined
          }
        >
          {problemText(t, problem)}
        </Notice>
      )}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('catalog.authorities.thesaurus.caption')}</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-muted-foreground">
                {t('catalog.authorities.thesaurus.col.rel')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap text-muted-foreground">
                {t('catalog.authorities.thesaurus.col.subject')}
              </th>
              {canEdit && (
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">{t('catalog.authorities.thesaurus.remove')}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={canEdit ? 3 : 2} className="px-3 py-6 text-center text-muted-foreground">
                  {t('catalog.authorities.thesaurus.empty')}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const error = rowErrors.get(keyOf(r));
                return (
                  <tr key={keyOf(r)} className="border-t align-top">
                    <td className="px-3 py-2 whitespace-nowrap">{t(vocabKey('thesaurus_rel', r.rel))}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap items-center gap-2">
                        <Link to={authorityHref('subjects', r.subjectId)} className="font-medium text-primary underline-offset-4 hover:underline">
                          {r.term}
                        </Link>
                        <span className="text-muted-foreground">{typeLabel(t, r.type)}</span>
                        {!savedKeys.has(keyOf(r)) && <Badge tone="neutral">{t('catalog.authorities.thesaurus.added')}</Badge>}
                      </span>
                      {error !== undefined && (
                        <p role="alert" className="mt-1 text-sm text-destructive">
                          {t(error)}
                        </p>
                      )}
                    </td>
                    {canEdit && (
                      <td className="px-3 py-2 text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          aria-label={t('catalog.authorities.thesaurus.remove_label', { rel: relAbbr(r.rel), term: r.term })}
                          onClick={() => remove(r)}
                        >
                          {t('catalog.authorities.thesaurus.remove')}
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="grid gap-4 rounded-lg border bg-card p-4 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] sm:items-end">
          <Field label={t('catalog.authorities.thesaurus.rel')}>
            {(c) => (
              <select
                {...c}
                className={SELECT_CLASS}
                value={rel}
                disabled={busy}
                onChange={(e) => {
                  setAddError(null);
                  setRel(e.target.value as ThesaurusRel);
                }}
              >
                {THESAURUS_RELS.map((value) => (
                  <option key={value} value={value}>
                    {t(vocabKey('thesaurus_rel', value))}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={t('catalog.authorities.thesaurus.subject')} error={addError ?? undefined}>
            {(c) => (
              <Combobox
                id={c.id}
                {...(c['aria-describedby'] === undefined ? {} : { 'aria-describedby': c['aria-describedby'] })}
                {...(c['aria-invalid'] === undefined ? {} : { 'aria-invalid': true })}
                options={options}
                value={picked?.subjectId ?? null}
                onValueChange={(id) => {
                  setAddError(null);
                  setPicked(offered.find((v) => v.subjectId === id) ?? null);
                }}
                placeholder={t('catalog.authorities.thesaurus.subject_placeholder')}
                searchPlaceholder={t('catalog.authorities.thesaurus.search_placeholder')}
                emptyText={
                  candidates.idle
                    ? t('catalog.authorities.pick.hint')
                    : candidates.error !== null
                      ? problemText(t, candidates.error)
                      : t('catalog.authorities.thesaurus.search_empty')
                }
                search={search}
                onSearchChange={setSearch}
                loading={candidates.loading}
                loadingText={t('catalog.authorities.pick.searching')}
                disabled={busy}
              />
            )}
          </Field>
          <Button type="button" variant="outline" disabled={picked === null || busy} onClick={add}>
            {t('catalog.authorities.thesaurus.add')}
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold">{t('catalog.authorities.thesaurus.preview')}</h3>
        <p className="text-xs text-muted-foreground">{t('catalog.authorities.thesaurus.preview_hint')}</p>
        {rows.length === 0 && removed.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('catalog.authorities.thesaurus.preview_empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {rows.map((r) => (
              <li key={keyOf(r)} className="flex flex-wrap items-center gap-2">
                <span>{reciprocal(r)}</span>
                {!savedKeys.has(keyOf(r)) && <Badge tone="neutral">{t('catalog.authorities.thesaurus.added')}</Badge>}
              </li>
            ))}
            {removed.map((r) => (
              <li key={keyOf(r)} className="flex flex-wrap items-center gap-2 text-muted-foreground">
                <span className="line-through">{reciprocal(r)}</span>
                <Badge tone="neutral">{t('catalog.authorities.thesaurus.removed')}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!dirty || busy} onClick={() => void save()}>
            {t(busy ? 'form.saving' : 'catalog.authorities.thesaurus.save')}
          </Button>
          {dirty && (
            <Button type="button" variant="outline" disabled={busy} onClick={discard}>
              {t('catalog.authorities.thesaurus.discard')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
