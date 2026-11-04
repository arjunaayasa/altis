import { RELATION_TYPES, vocabKey } from '@altis/shared';
import type { RecordDetail, RecordListResponse } from '@altis/shared/api/catalog/records';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useFieldArray, type UseFormReturn } from 'react-hook-form';
import { SELECT_CLASS } from '@/components/form-field';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useT } from '@/i18n';
import { ErrorText, RowButtons, errorAt, usePickerSearch } from './agent-picker';
import type { RecordFormValues } from './draft-to-form';

/**
 * The relations of a record (Phase 2 spec §3.1, §13; plan Task 24): the ones this record stores (to another record,
 * with their type: related, other edition, part of, translation of), added by a title search of `GET
 * catalog/records?q=`; and, read only, the ones other records store about this one (§3.1: stored one way, shown both
 * ways).
 */
export function RelationsField({
  form,
  selfId,
  incoming,
}: {
  form: UseFormReturn<RecordFormValues>;
  /** The record itself (never offered), on the edit screen. */
  selfId: string | null;
  incoming: RecordDetail['relations'];
}) {
  const t = useT();
  const { control, register } = form;
  const { fields, append, remove, move } = useFieldArray({ control, name: 'relations' });
  const errors = form.formState.errors;
  const [typed, setTyped] = useState('');
  const search = usePickerSearch<RecordListResponse>('catalog/records', typed);
  const taken = new Set(fields.map((f) => f.relatedId));
  const matches = (search.data?.items ?? []).filter((r) => r.id !== selfId && !taken.has(r.id));
  const options: ComboboxOption[] = matches.map((r) => ({ value: r.id, label: r.year === null ? r.title : `${r.title} (${r.year})` }));

  const pick = (id: string): void => {
    const r = matches.find((m) => m.id === id);
    if (r === undefined) return;
    append({ relatedId: r.id, type: 'related', title: r.title });
    setTyped('');
  };

  return (
    <fieldset className="grid min-w-0 gap-3">
      <legend className="mb-1 text-sm font-medium">{t('catalog.records.section.relations')}</legend>
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('catalog.records.relations.none')}</p>
      ) : (
        <ul className="grid gap-2">
          {fields.map((field, i) => (
            <li key={field.id} className="grid gap-1 rounded-md border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <select className={`${SELECT_CLASS} w-auto`} aria-label={t('catalog.records.relations.type', { title: field.title })} {...register(`relations.${i}.type`)}>
                  {RELATION_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(vocabKey('relation_type', type))}
                    </option>
                  ))}
                </select>
                <Link to={`/admin/catalog/records/${encodeURIComponent(field.relatedId)}`} className="text-primary underline-offset-4 hover:underline">
                  {field.title}
                </Link>
                <span className="ml-auto">
                  <RowButtons name={field.title} index={i} count={fields.length} onMove={move} onRemove={() => remove(i)} />
                </span>
              </div>
              <ErrorText error={errorAt(errors, `relations.${i}.relatedId`) ?? errorAt(errors, `relations.${i}`)} />
            </li>
          ))}
        </ul>
      )}
      <Combobox
        options={options}
        value={null}
        onValueChange={pick}
        placeholder={t('catalog.records.relations.add')}
        aria-label={t('catalog.records.relations.add')}
        searchPlaceholder={t('catalog.records.relations.search')}
        emptyText={typed.trim() === '' ? t('catalog.records.type_to_search') : t('catalog.records.relations.empty')}
        search={typed}
        onSearchChange={setTyped}
        loading={search.isFetching && matches.length === 0 && typed.trim() !== ''}
        loadingText={t('catalog.records.searching')}
      />
      {incoming.length > 0 && (
        <div className="grid gap-1">
          <p className="text-sm font-medium">{t('catalog.records.relations.incoming')}</p>
          <ul className="grid gap-1 text-sm">
            {incoming.map((r) => (
              <li key={`${r.type}:${r.recordId}`} className="flex flex-wrap gap-2">
                <span className="text-muted-foreground">{t(vocabKey('relation_type', r.type))}</span>
                <Link to={`/admin/catalog/records/${encodeURIComponent(r.recordId)}`} className="text-primary underline-offset-4 hover:underline">
                  {r.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}
