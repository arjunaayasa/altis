import { vocabKey } from '@altis/shared';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { RecordDetail } from '@altis/shared/api/catalog/records';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRightIcon, ExternalLinkIcon, MergeIcon, XIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useDateTime } from '@/components/data-table';
import { Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useLocale, useT, type Translate } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';

/**
 * Duplikat, the comparison of one group (Phase 2 spec §3.3, §13; plan Task 29): every record of the group is read
 * (`GET catalog/records/:id`, the editor's query), two of its live records are shown side by side (the rows that differ
 * are marked), and "Gabungkan" merges the one into the other through `POST catalog/records/:id/merge {sourceId,
 * version}` after a confirmation (the merge moves items, attachments, identifiers, authorities and relations, archives
 * the source and redirects its OPAC address; it cannot be undone).
 *
 * - Only live records are offered: an archived record, or one merged into another (by the server's `mergedInto`, or by
 *   a merge made on this page, {@link CompareProps.merged}), is named with the reason and never sent.
 * - `version` is the kept record's, as last read; a 409 `CONFLICT_STALE` (someone changed it) stays in the dialog, and
 *   the records are read again after every merge.
 */

/** The editor's query key of a record (records/edit.tsx), so both screens share what they read. */
const detailKey = (id: string) => ['catalog', 'records', 'detail', id] as const;

export interface CompareProps {
  /** The group's number in the list (1-based), for the heading. */
  n: number;
  recordIds: readonly string[];
  /** Records merged on this page: source id → target id (the server's answer may come later than the next read). */
  merged: Readonly<Record<string, string>>;
  onMerged(sourceId: string, targetId: string): void;
  onClose(): void;
}

/** One row of the comparison: a label and each side's value, with a text form to compare. */
interface Row {
  key: string;
  label: string;
  show(r: RecordDetail): ReactNode;
  text(r: RecordDetail): string;
}

const identifierText = (t: Translate, i: RecordDetail['identifiers'][number]): string =>
  i.type === 'isbn' || i.type === 'issn' || i.type === 'doi' ? `${i.type.toUpperCase()} ${i.value}` : `${t(vocabKey('identifier_type', i.type))}: ${i.value}`;

const publisherText = (r: RecordDetail): string => (r.publisher === null ? '' : r.publisher.place === undefined ? r.publisher.name : `${r.publisher.name} (${r.publisher.place})`);

/** A list cell: each value on its own line. */
function Lines({ values }: { values: string[] }) {
  if (values.length === 0) return null;
  return (
    <ul className="grid gap-0.5">
      {values.map((v, i) => (
        <li key={i}>{v}</li>
      ))}
    </ul>
  );
}

function useRows(): Row[] {
  const t = useT();
  const locale = useLocale();
  const dateTime = useDateTime();
  const text = (pick: (r: RecordDetail) => string | undefined | null) => (r: RecordDetail) => pick(r) ?? '';
  const plain = (key: string, label: string, pick: (r: RecordDetail) => string | undefined | null): Row => ({ key, label, show: text(pick), text: text(pick) });
  const list = (key: string, label: string, pick: (r: RecordDetail) => string[]): Row => ({
    key,
    label,
    show: (r) => <Lines values={pick(r)} />,
    text: (r) => pick(r).join('\n'),
  });
  return [
    plain('title', t('catalog.duplicates.compare.field.title'), (r) => r.title),
    plain('subtitle', t('vocab.field.subtitle'), (r) => r.subtitle),
    plain('responsibility', t('vocab.field.responsibility'), (r) => r.responsibility),
    plain('material_type', t('catalog.duplicates.compare.field.material_type'), (r) => (locale === 'en' ? r.materialType.nameEn : r.materialType.nameId)),
    plain('edition', t('vocab.field.edition'), (r) => r.edition),
    plain('publisher', t('vocab.field.publisher'), publisherText),
    plain('publication_year', t('vocab.field.publication_year'), (r) => r.publicationYear),
    list('identifiers', t('vocab.field.identifiers'), (r) => r.identifiers.map((i) => identifierText(t, i))),
    list('agents', t('vocab.field.agents'), (r) => r.agents.map((a) => `${a.name} (${t(vocabKey('relator', a.role))})`)),
    list('subjects', t('vocab.field.subjects'), (r) => r.subjects.map((s) => s.term)),
    plain('series', t('vocab.field.series'), (r) => r.series),
    plain('physical_desc', t('vocab.field.physical_desc'), (r) => r.physicalDesc),
    plain('classification', t('vocab.field.classification'), (r) => r.classification),
    plain('call_number', t('vocab.field.call_number'), (r) => r.callNumber),
    plain('language', t('vocab.field.language'), (r) => (r.language === null ? '' : locale === 'en' ? r.language.nameEn : r.language.nameId)),
    plain('items', t('catalog.duplicates.compare.field.items'), (r) =>
      t('catalog.duplicates.compare.items', { total: String(r.itemCounts.total), available: String(r.itemCounts.available) }),
    ),
    plain('attachments', t('catalog.duplicates.compare.field.attachments'), (r) => String(r.attachments.length)),
    plain('updated', t('catalog.duplicates.compare.field.updated'), (r) => dateTime(r.updatedAt)),
  ];
}

/** `id` when it is one of `live`, else the first of `live` that is not `other`. */
function pick(id: string, live: RecordDetail[], other: string): string {
  if (live.some((r) => r.id === id)) return id;
  return (live.find((r) => r.id !== other) ?? live[0])?.id ?? '';
}

/** The comparison of one group (see the top of this file). */
export function Compare({ n, recordIds, merged, onMerged, onClose }: CompareProps) {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const headingId = useId();
  const rows = useRows();
  const reads = useQueries({
    queries: recordIds.map((id) => ({
      queryKey: detailKey(id),
      queryFn: () => api<RecordDetail>('GET', `catalog/records/${encodeURIComponent(id)}`),
      enabled: me !== undefined,
      retry: false,
    })),
  });
  const [chosen, setChosen] = useState<{ target: string; source: string }>({ target: '', source: '' });
  const [pending, setPending] = useState<{ target: RecordDetail; source: RecordDetail } | null>(null);
  const [done, setDone] = useState<{ source: string; target: string } | null>(null);

  const settled = reads.every((q) => q.data !== undefined || q.isError);
  const loaded = reads.map((q) => q.data).filter((r): r is RecordDetail => r !== undefined);
  const isMerged = (r: RecordDetail): boolean => r.mergedInto !== null || Object.prototype.hasOwnProperty.call(merged, r.id);
  const live = loaded.filter((r) => !r.archived && !isMerged(r));
  const target = pick(chosen.target, live, chosen.source);
  const source = pick(chosen.source, live, target);
  const left = live.find((r) => r.id === target);
  const right = live.find((r) => r.id === source);
  const option = (r: RecordDetail): string => (r.publicationYear === undefined ? r.title : `${r.title} (${r.publicationYear})`);

  const merge = async (pair: { target: RecordDetail; source: RecordDetail }): Promise<void> => {
    const kept = await api<StoreResponse>('POST', `catalog/records/${encodeURIComponent(pair.target.id)}/merge`, {
      sourceId: pair.source.id,
      version: pair.target.version,
    });
    // The next merge into the same record sends its new version even before the read below has come back.
    queryClient.setQueryData<RecordDetail>(detailKey(kept.id), (old) => (old === undefined ? old : { ...old, version: kept.version }));
    onMerged(pair.source.id, pair.target.id);
    setDone({ source: pair.source.title, target: pair.target.title });
    // Both records changed (the kept one's version, items and identifiers; the other is archived): read them again.
    void queryClient.invalidateQueries({ queryKey: ['catalog', 'records'] });
  };

  return (
    <section aria-labelledby={headingId} className="grid gap-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-semibold">
          {t('catalog.duplicates.compare.title', { n: String(n) })}
        </h2>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          <XIcon aria-hidden="true" />
          {t('catalog.duplicates.compare.close')}
        </Button>
      </div>
      {done !== null && <Notice kind="success">{t('catalog.duplicates.merge.done', done)}</Notice>}
      {!settled ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('shell.loading')}
        </p>
      ) : (
        <>
          {reads.map((q, i) =>
            q.isError ? (
              <Notice key={recordIds[i]} kind="error">
                {t('catalog.duplicates.compare.unreadable', { id: recordIds[i]! })}
                {q.error instanceof ApiError && q.error.code !== 'NOT_FOUND' ? ` ${problemText(t, q.error)}` : ''}
              </Notice>
            ) : null,
          )}
          {loaded
            .filter((r) => r.archived || isMerged(r))
            .map((r) => (
              <p key={r.id} className="text-sm text-muted-foreground">
                {isMerged(r) ? t('catalog.duplicates.compare.merged', { title: r.title }) : t('catalog.duplicates.compare.archived', { title: r.title })}
              </p>
            ))}
          {live.length < 2 && (
            <p className="text-sm font-medium">{t(live.length === 1 ? 'catalog.duplicates.compare.one_left' : 'catalog.duplicates.compare.none_left')}</p>
          )}
          {live.length >= 2 && target === source && <p className="text-sm text-muted-foreground">{t('catalog.duplicates.compare.same')}</p>}
          {live.length >= 2 && (
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
              <Field label={t('catalog.duplicates.compare.target')}>
                {(c) => (
                  <select {...c} className={SELECT_CLASS} value={target} onChange={(e) => setChosen({ target: e.target.value, source })}>
                    {live.map((r) => (
                      <option key={r.id} value={r.id}>
                        {option(r)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Button type="button" variant="outline" onClick={() => setChosen({ target: source, source: target })}>
                <ArrowLeftRightIcon aria-hidden="true" />
                {t('catalog.duplicates.compare.swap')}
              </Button>
              <Field label={t('catalog.duplicates.compare.source')}>
                {(c) => (
                  <select {...c} className={SELECT_CLASS} value={source} onChange={(e) => setChosen({ target, source: e.target.value })}>
                    {live.map((r) => (
                      <option key={r.id} value={r.id}>
                        {option(r)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
          )}
          {left !== undefined && right !== undefined && left.id !== right.id && (
            <>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <caption className="sr-only">{t('catalog.duplicates.compare.caption')}</caption>
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                        {t('catalog.duplicates.compare.field')}
                      </th>
                      {[left, right].map((r, i) => (
                        <th key={r.id} scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                          <span className="flex flex-wrap items-center gap-2">
                            {t(i === 0 ? 'catalog.duplicates.compare.kept' : 'catalog.duplicates.compare.merged_in')}
                            <a
                              href={`/admin/catalog/records/${encodeURIComponent(r.id)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={t('catalog.duplicates.compare.open', { title: r.title })}
                              className="inline-flex text-primary"
                            >
                              <ExternalLinkIcon className="size-4" aria-hidden="true" />
                            </a>
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const a = row.text(left);
                      const b = row.text(right);
                      if (a === '' && b === '') return null;
                      const differs = a !== b;
                      return (
                        <tr key={row.key} data-differs={differs ? 'true' : 'false'} className={differs ? 'border-t bg-warning/40 align-top' : 'border-t align-top'}>
                          <th scope="row" className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                            {row.label}
                            {differs && <span className="sr-only"> ({t('catalog.duplicates.compare.differs')})</span>}
                          </th>
                          <td className="px-3 py-2">{row.show(left)}</td>
                          <td className="px-3 py-2">{row.show(right)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-sm text-muted-foreground">{t('catalog.duplicates.merge_hint')}</p>
              <div>
                <Button type="button" variant="destructive" onClick={() => setPending({ target: left, source: right })}>
                  <MergeIcon aria-hidden="true" />
                  {t('catalog.duplicates.merge')}
                </Button>
              </div>
            </>
          )}
        </>
      )}
      <ConfirmDialog
        open={pending !== null}
        title={t('catalog.duplicates.merge.title')}
        description={pending === null ? '' : t('catalog.duplicates.merge.body', { source: pending.source.title, target: pending.target.title })}
        confirmLabel={t('catalog.duplicates.merge')}
        destructive
        onConfirm={() => (pending === null ? Promise.resolve() : merge(pending))}
        onClose={() => setPending(null)}
      />
    </section>
  );
}
