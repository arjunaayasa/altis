import { RECORD_BULK_MAX, type RecordBulkBody, type RecordBulkResponse, type RecordListItem } from '@altis/shared/api/catalog/records';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { Field, Notice, SELECT_CLASS } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT, type TKey } from '@/i18n';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { ACCRED_FIELDS } from './editor-sections';

/**
 * "Ubah data akreditasi" of Bibliografi: set the accreditation fields of the selected records at once
 * (`POST catalog/records/bulk {ids, set}`, at most {@link RECORD_BULK_MAX} ids).
 *
 * - Each of the four fields (Sasaran pembaca, Karya lokal, Jenis karya, Jenis referensi) is "Tidak diubah" (left out
 *   of `set`), "Kosongkan" (null) or a value of its shared vocabulary. Nothing is sent before one change is chosen.
 * - The server changes the live records and refuses the others (`not_found`, `archived`); the refused ones are listed
 *   by title with their reason, beside the count of the changed ones.
 * - Changing only these fields does not count a migrated record as edited in ALTIS (the server keeps it in the SLiMS
 *   re-sync); the dialog says so, as the editor's section does.
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

export function RecordBulkDialog({
  open,
  records,
  onClose,
}: {
  open: boolean;
  /** The selected rows. */
  records: readonly RecordListItem[];
  onClose(): void;
}) {
  const t = useT();
  const focus = useReturnFocus();
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent closeLabel={t('catalog.records.bulk.close')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
        {open && <BulkBody records={records} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function BulkBody({ records, onClose }: { records: readonly RecordListItem[]; onClose(): void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const refusedId = useId();
  const [choices, setChoices] = useState<Choices>(KEEP_ALL);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RecordBulkResponse | null>(null);
  const titles = useMemo(() => new Map(records.map((r) => [r.id, r.title])), [records]);
  const tooMany = records.length > RECORD_BULK_MAX;

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
    <>
      <DialogHeader>
        <DialogTitle>{t('catalog.records.bulk.title')}</DialogTitle>
        <DialogDescription>{t('catalog.records.bulk.description', { count: records.length })}</DialogDescription>
      </DialogHeader>
      {tooMany && <Notice kind="error">{t('catalog.records.list.accred_bulk_too_many', { max: RECORD_BULK_MAX })}</Notice>}
      {error !== null && <Notice kind="error">{error}</Notice>}
      {outcome !== null ? (
        <div className="flex flex-col gap-3">
          <Notice kind="success">{t('catalog.records.bulk.updated', { count: outcome.updated })}</Notice>
          {outcome.refused.length > 0 && (
            <div className="flex flex-col gap-1">
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
          <DialogFooter>
            <Button type="button" onClick={onClose}>
              {t('catalog.records.bulk.done')}
            </Button>
          </DialogFooter>
        </div>
      ) : (
        !tooMany && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{t('catalog.records.section.accreditation_hint')}</p>
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
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                {t('form.cancel')}
              </Button>
              <Button type="button" disabled={busy} onClick={() => void apply()}>
                {t(busy ? 'catalog.records.bulk.applying' : 'catalog.records.bulk.apply')}
              </Button>
            </DialogFooter>
          </div>
        )
      )}
    </>
  );
}
