import { RECORD_BULK_MAX, type RecordBulkBody, type RecordBulkResponse, type RecordListItem } from '@altis/shared/api/catalog/records';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { InlinePanel } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT, type TKey } from '@/i18n';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { ACCRED_FIELDS } from './editor-sections';

/**
 * "Ubah data akreditasi" of Bibliografi: set the accreditation fields of the selected records at once
 * (`POST catalog/records/bulk {ids, set}`, at most {@link RECORD_BULK_MAX} ids), in an inline panel under the list's
 * selection bar.
 *
 * - Each of the four fields (Sasaran pembaca, Karya lokal, Jenis karya, Jenis referensi) is "Tidak diubah" (left out
 *   of `set`), "Kosongkan" (null) or a value of its shared vocabulary. Nothing is sent before one change is chosen.
 * - The server changes the live records and refuses the others (`not_found`, `archived`); the refused ones are listed
 *   by title with their reason, beside the count of the changed ones.
 * - Changing only these fields does not count a migrated record as edited in ALTIS (the server keeps it in the SLiMS
 *   re-sync); the panel says so, as the editor's section does.
 */

/** The choice "clear the field" (the select's `''` is "unchanged"). */
const CLEAR = 'none';

type Choices = Record<keyof RecordBulkBody['set'], string>;

const KEEP_ALL: Choices = { audience: '', localWork: '', localWorkKind: '', referenceKind: '' };

/** The `set` of a bulk change: the fields chosen, null for "Kosongkan". */
function bulkSet(choices: Choices): RecordBulkBody['set'] {
  const set: Record<string, string | null> = {};
  for (const { name } of ACCRED_FIELDS) {
    const choice = choices[name];
    if (choice !== '') set[name] = choice === CLEAR ? null : choice;
  }
  return set as RecordBulkBody['set'];
}

/** The panel under Bibliografi's selection bar (Esc or "Batal" closes it; "Selesai" once applied). */
export function RecordBulkPanel({ records, onClose }: { records: readonly RecordListItem[]; onClose(): void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const refusedId = useId();
  const [choices, setChoices] = useState<Choices>(KEEP_ALL);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RecordBulkResponse | null>(null);
  const titles = useMemo(() => new Map(records.map((r) => [r.id, r.title])), [records]);
  const tooMany = records.length > RECORD_BULK_MAX;
  const done = useRef<HTMLButtonElement>(null);
  // Once applied, the form's buttons are gone: the focus goes to "Selesai".
  useEffect(() => {
    if (outcome !== null) done.current?.focus();
  }, [outcome]);

  const apply = async (): Promise<void> => {
    if (busy) return;
    setError(null);
    const set = bulkSet(choices);
    if (Object.keys(set).length === 0) {
      setError(t('catalog.records.bulk.nothing'));
      return;
    }
    setBusy(true);
    try {
      const body: RecordBulkBody = { ids: records.map((r) => r.id), set };
      setOutcome(await api<RecordBulkResponse>('POST', 'catalog/records/bulk', body));
      // An editor opened later reads the record again (the list shows none of these fields).
      void queryClient.invalidateQueries({ queryKey: ['catalog', 'records', 'detail'] });
    } catch (e) {
      setError(problemText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <InlinePanel
      title={t('catalog.records.bulk.title')}
      onCancel={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        void apply();
      }}>
      <p className="text-sm text-muted-foreground">{t('catalog.records.bulk.description', { count: records.length })}</p>
      {tooMany && <Notice kind="error">{t('catalog.records.list.accred_bulk_too_many', { max: RECORD_BULK_MAX })}</Notice>}
      {error !== null && <Notice kind="error">{error}</Notice>}
      {outcome !== null ? (
        <>
          <Notice kind="success">{t('catalog.records.bulk.updated', { count: outcome.updated })}</Notice>
          {outcome.refused.length > 0 && (
            <div className="grid gap-1">
              <h3 id={refusedId} className="text-sm font-semibold">
                {t('catalog.records.bulk.refused', { count: outcome.refused.length })}
              </h3>
              <ul aria-labelledby={refusedId} className="max-h-60 overflow-y-auto text-sm">
                {outcome.refused.map((r) => (
                  <li key={r.id} className="py-0.5">
                    {titles.get(r.id) ?? r.id}
                    {' — '}
                    {t(`catalog.records.bulk.refused.${r.code}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button ref={done} type="button" size="sm" onClick={onClose}>
              {t('catalog.records.bulk.done')}
            </Button>
          </div>
        </>
      ) : (
        !tooMany && (
          <>
            <p className="max-w-[75ch] text-sm text-muted-foreground">{t('catalog.records.section.accreditation_hint')}</p>
            <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
              {ACCRED_FIELDS.map((f) => (
                <Field key={f.name} label={t(f.labelKey)}>
                  {(c) => (
                    <select {...c} className={SELECT_CLASS} disabled={busy} value={choices[f.name]} onChange={(e) => setChoices({ ...choices, [f.name]: e.target.value })}>
                      <option value="">{t('catalog.records.bulk.keep')}</option>
                      <option value={CLEAR}>{t('catalog.records.bulk.clear')}</option>
                      {f.values.map((value) => (
                        <option key={value} value={value}>
                          {t(`vocab.${f.list}.${value}` as TKey)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                {t(busy ? 'catalog.records.bulk.applying' : 'catalog.records.bulk.apply')}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClose}>
                {t('form.cancel')}
              </Button>
            </div>
          </>
        )
      )}
    </InlinePanel>
  );
}
