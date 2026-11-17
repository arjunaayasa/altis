import { AGENT_TYPES, RELATOR_ROLES, vocabKey } from '@altis/shared';
import type { AgentListResponse } from '@altis/shared/api/catalog/authorities';
import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { get, useFieldArray, useWatch, type FieldError, type FieldErrors, type UseFormReturn } from 'react-hook-form';
import { Badge, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { cn } from '@/lib/utils';
import { fieldErrorText } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';
import type { AgentRow, RecordFormValues } from './draft-to-form';

/**
 * The agents of a record (Phase 2 spec §13 "pemilih agen (cari/buat, peran)"; plan Task 24): the names on the record,
 * each with its role (a MARC relator) and whether it is the main entry (one at most, as MARC 100 is), in order.
 *
 * - "Tambah": a combobox that searches `GET catalog/agents?q=` as the librarian types, plus "Buat baru" with the typed
 *   name. A new name stays a reference `{type, name, dates}` in the form; the server finds or creates the agent when
 *   the record is saved (decision P2-10), so no authority permission is needed here.
 * - A new name's type and dates can be set on its row; an existing one is shown as the authority holds it.
 *
 * Also the pickers' shared parts: {@link useDebounced} and {@link usePickerSearch}.
 */

/** `value`, once it has not changed for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** How many matches a picker lists. */
export const PICKER_LIMIT = 10;

/**
 * A picker's server search: `GET <path>?q=<typed>&limit=10`, 250 ms after the last key, only once something is typed
 * (an empty box lists nothing: the catalogue may hold 100 000 names). The previous matches stay while the next load.
 */
export function usePickerSearch<T>(path: string, typed: string) {
  const q = useDebounced(typed.trim(), 250);
  const query = new URLSearchParams({ q, limit: String(PICKER_LIMIT) });
  return useApiQuery<T>({
    queryKey: ['catalog', 'picker', path, q],
    path: `${path}?${query.toString()}`,
    enabled: q !== '',
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** The error of the form field at `path` (a row's or a list's own), as a field shows it; undefined when none. */
export function errorAt(errors: FieldErrors<RecordFormValues>, path: string): FieldError | undefined {
  const error: unknown = get(errors, path);
  return typeof error === 'object' && error !== null && typeof (error as FieldError).message === 'string' ? (error as FieldError) : undefined;
}

/** A field error's text, or nothing. */
export function ErrorText({ id, error }: { id?: string; error: FieldError | undefined }) {
  const t = useT();
  const text = fieldErrorText(t, error);
  if (text === undefined) return null;
  return (
    <p id={id} className="text-meta font-semibold text-bad">
      {text}
    </p>
  );
}

/** A list section's legend: the label, marked when the template requires it. */
export function useLegend(labelKey: TKey, required: boolean): string {
  const t = useT();
  const label = t(labelKey);
  return required ? t('catalog.records.required', { label }) : label;
}

/** The legend of a list field inside a part of the editor: the label's look (the part's heading may say the same). */
export const LIST_LEGEND = 'mb-1.5 text-meta leading-snug font-semibold';

/** The order buttons and "remove" of one row of a list: short words, each named with the row ("Naikkan …"). */
export function RowButtons({ name, index, count, onMove, onRemove }: { name: string; index: number; count: number; onMove(from: number, to: number): void; onRemove(): void }) {
  const t = useT();
  return (
    <span className="flex gap-1">
      <Button type="button" variant="ghost" size="sm" aria-label={t('catalog.records.move_up', { name })} disabled={index === 0} onClick={() => onMove(index, index - 1)}>
        {t('catalog.records.row.up')}
      </Button>
      <Button type="button" variant="ghost" size="sm" aria-label={t('catalog.records.move_down', { name })} disabled={index === count - 1} onClick={() => onMove(index, index + 1)}>
        {t('catalog.records.row.down')}
      </Button>
      <Button type="button" variant="ghost" size="sm" aria-label={t('catalog.records.remove', { name })} onClick={onRemove}>
        {t('catalog.records.row.remove')}
      </Button>
    </span>
  );
}

/**
 * The agents' list. Its part of the editor shows the heading and the hint (`hintId`, which describes the list): the
 * legend is said to screen readers only.
 */
export function AgentPicker({ form, required, hintId }: { form: UseFormReturn<RecordFormValues>; required: boolean; hintId: string }) {
  const t = useT();
  const legend = useLegend('vocab.field.agents', required);
  const { control, register, setValue } = form;
  const { fields, append, remove, move } = useFieldArray({ control, name: 'agents' });
  const rows = useWatch({ control, name: 'agents' });
  const errors = form.formState.errors;
  const [typed, setTyped] = useState('');
  const search = usePickerSearch<AgentListResponse>('catalog/agents', typed);
  const matches = search.data?.items ?? [];
  const options: ComboboxOption[] = matches.map((a) => ({
    value: a.id,
    label: a.dates === null ? a.name : `${a.name} (${a.dates})`,
    keywords: [t(vocabKey('agent_type', a.type))],
  }));

  const noMain = (): boolean => !rows.some((r) => r.isMain);
  const add = (row: AgentRow): void => {
    append(row);
    setTyped('');
  };
  const pick = (id: string): void => {
    const agent = matches.find((a) => a.id === id);
    if (agent === undefined) return;
    add({ ref: { id: agent.id, type: agent.type, name: agent.name, dates: agent.dates ?? '', authoritySource: agent.authoritySource ?? '' }, role: 'aut', isMain: noMain() });
  };
  const create = (name: string): void => {
    if (name.trim() === '') return;
    add({ ref: { id: null, type: 'person', name: name.trim(), dates: '', authoritySource: '' }, role: 'aut', isMain: noMain() });
  };
  /** One main entry at most: ticking a row clears the others. */
  const setMain = (index: number, on: boolean): void => {
    rows.forEach((_, i) => setValue(`agents.${i}.isMain`, i === index ? on : false, { shouldDirty: true }));
  };
  const listError = errorAt(errors, 'agents');

  return (
    <fieldset className="grid min-w-0 gap-3" aria-describedby={hintId}>
      <legend className="sr-only">{legend}</legend>
      {fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('catalog.records.agents.none')}</p>
      ) : (
        <ul className="grid gap-2">
          {fields.map((field, i) => {
            const ref = rows[i]?.ref ?? field.ref;
            const rowError = errorAt(errors, `agents.${i}.ref`) ?? errorAt(errors, `agents.${i}.ref.name`);
            return (
              <li key={field.id} className="grid gap-2 rounded-md border px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{ref.name}</span>
                  {ref.id !== null && ref.dates !== '' && <span className="text-sm text-muted-foreground">{ref.dates}</span>}
                  {ref.id !== null && <span className="text-xs text-muted-foreground">{t(vocabKey('agent_type', ref.type))}</span>}
                  {ref.id === null && <Badge>{t('catalog.records.new_badge')}</Badge>}
                  <span className="ml-auto">
                    <RowButtons name={ref.name} index={i} count={fields.length} onMove={move} onRemove={() => remove(i)} />
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <select className={cn(SELECT_CLASS, 'w-auto')} aria-label={t('catalog.records.agents.role', { name: ref.name })} {...register(`agents.${i}.role`)}>
                    {RELATOR_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {t(vocabKey('relator', role))}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      aria-label={t('catalog.records.agents.main_label', { name: ref.name })}
                      checked={rows[i]?.isMain ?? false}
                      onChange={(e) => setMain(i, e.target.checked)}
                    />
                    <span aria-hidden="true">{t('catalog.records.agents.main')}</span>
                  </label>
                  {ref.id === null && (
                    <>
                      <select className={cn(SELECT_CLASS, 'w-auto')} aria-label={t('catalog.records.agents.type', { name: ref.name })} {...register(`agents.${i}.ref.type`)}>
                        {AGENT_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {t(vocabKey('agent_type', type))}
                          </option>
                        ))}
                      </select>
                      <Input className="w-36" maxLength={64} autoComplete="off" aria-label={t('catalog.records.agents.dates', { name: ref.name })} {...register(`agents.${i}.ref.dates`)} />
                    </>
                  )}
                </div>
                <ErrorText error={rowError} />
              </li>
            );
          })}
        </ul>
      )}
      <Combobox
        options={options}
        value={null}
        onValueChange={pick}
        placeholder={t('catalog.records.agents.add')}
        aria-label={t('catalog.records.agents.add')}
        searchPlaceholder={t('catalog.records.agents.search')}
        emptyText={typed.trim() === '' ? t('catalog.records.create_hint') : t('catalog.records.agents.empty')}
        search={typed}
        onSearchChange={setTyped}
        loading={search.isFetching && matches.length === 0 && typed.trim() !== ''}
        loadingText={t('catalog.records.searching')}
        action={{ label: typed.trim() === '' ? t('catalog.records.create_hint') : t('catalog.records.create_new', { name: typed.trim() }), onSelect: create }}
      />
      <ErrorText error={listError} />
    </fieldset>
  );
}
