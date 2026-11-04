import { SUBJECT_TYPES, vocabKey } from '@altis/shared';
import type { SubjectListResponse } from '@altis/shared/api/catalog/authorities';
import { useState } from 'react';
import { useFieldArray, useWatch, type UseFormReturn } from 'react-hook-form';
import { Badge, SELECT_CLASS } from '@/components/form-field';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useT } from '@/i18n';
import { ErrorText, RowButtons, errorAt, useLegend, usePickerSearch } from './agent-picker';
import type { RecordFormValues, SubjectRow } from './draft-to-form';

/**
 * The subjects of a record (Phase 2 spec §13 "subjek (tipe)"; plan Task 24): search `GET catalog/subjects?q=` or add
 * a new term ("Buat baru", kept as `{type, term}` until the save finds or creates it, P2-10); a new term's type is
 * chosen on its row. A subject may be marked primary.
 */
export function SubjectPicker({ form, required }: { form: UseFormReturn<RecordFormValues>; required: boolean }) {
  const t = useT();
  const legend = useLegend('vocab.field.subjects', required);
  const { control, register } = form;
  const { fields, append, remove, move } = useFieldArray({ control, name: 'subjects' });
  const rows = useWatch({ control, name: 'subjects' });
  const errors = form.formState.errors;
  const [typed, setTyped] = useState('');
  const search = usePickerSearch<SubjectListResponse>('catalog/subjects', typed);
  const matches = search.data?.items ?? [];
  const options: ComboboxOption[] = matches.map((s) => ({ value: s.id, label: `${s.term} · ${t(vocabKey('subject_type', s.type))}` }));

  const add = (row: SubjectRow): void => {
    append(row);
    setTyped('');
  };
  const pick = (id: string): void => {
    const s = matches.find((m) => m.id === id);
    if (s === undefined) return;
    add({ ref: { id: s.id, type: s.type, term: s.term, classification: s.classification ?? '', authoritySource: s.authoritySource ?? '' }, isPrimary: rows.length === 0 });
  };
  const create = (term: string): void => {
    if (term.trim() === '') return;
    add({ ref: { id: null, type: 'topic', term: term.trim(), classification: '', authoritySource: '' }, isPrimary: rows.length === 0 });
  };

  return (
    <fieldset className="grid min-w-0 gap-3">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('catalog.records.subjects.none')}</p>
      ) : (
        <ul className="grid gap-2">
          {fields.map((field, i) => {
            const ref = rows[i]?.ref ?? field.ref;
            return (
              <li key={field.id} className="grid gap-2 rounded-md border p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{ref.term}</span>
                  {ref.id !== null && <span className="text-xs text-muted-foreground">{t(vocabKey('subject_type', ref.type))}</span>}
                  {ref.id === null && <Badge tone="info">{t('catalog.records.new_badge')}</Badge>}
                  <span className="ml-auto">
                    <RowButtons name={ref.term} index={i} count={fields.length} onMove={move} onRemove={() => remove(i)} />
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {ref.id === null && (
                    <select className={`${SELECT_CLASS} w-auto`} aria-label={t('catalog.records.subjects.type', { term: ref.term })} {...register(`subjects.${i}.ref.type`)}>
                      {SUBJECT_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {t(vocabKey('subject_type', type))}
                        </option>
                      ))}
                    </select>
                  )}
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      aria-label={t('catalog.records.subjects.primary_label', { term: ref.term })}
                      {...register(`subjects.${i}.isPrimary`)}
                    />
                    <span aria-hidden="true">{t('catalog.records.subjects.primary')}</span>
                  </label>
                </div>
                <ErrorText error={errorAt(errors, `subjects.${i}.ref`) ?? errorAt(errors, `subjects.${i}.ref.term`)} />
              </li>
            );
          })}
        </ul>
      )}
      <Combobox
        options={options}
        value={null}
        onValueChange={pick}
        placeholder={t('catalog.records.subjects.add')}
        aria-label={t('catalog.records.subjects.add')}
        searchPlaceholder={t('catalog.records.subjects.search')}
        emptyText={typed.trim() === '' ? t('catalog.records.create_hint') : t('catalog.records.subjects.empty')}
        search={typed}
        onSearchChange={setTyped}
        loading={search.isFetching && matches.length === 0 && typed.trim() !== ''}
        loadingText={t('catalog.records.searching')}
        action={{ label: typed.trim() === '' ? t('catalog.records.create_hint') : t('catalog.records.create_new', { name: typed.trim() }), onSelect: create }}
      />
      <ErrorText error={errorAt(errors, 'subjects')} />
    </fieldset>
  );
}
