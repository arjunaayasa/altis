import type { PublisherListResponse } from '@altis/shared/api/catalog/authorities';
import { XIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useController, type UseFormReturn } from 'react-hook-form';
import { Badge } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n';
import { ErrorText, errorAt, useLegend, usePickerSearch } from './agent-picker';
import type { RecordFormValues } from './draft-to-form';

/**
 * The publisher of a record (Phase 2 spec §13 "penerbit"; plan Task 24): the chosen one (or none), a search of
 * `GET catalog/publishers?q=` to choose or change it, or "Buat baru" with the typed name (kept as `{name, place}`
 * until the save finds or creates it, P2-10).
 */
export function PublisherPicker({ form, required }: { form: UseFormReturn<RecordFormValues>; required: boolean }) {
  const t = useT();
  const label = useLegend('vocab.field.publisher', required);
  const labelId = useId();
  const { field } = useController({ control: form.control, name: 'publisher' });
  const chosen = field.value;
  const [typed, setTyped] = useState('');
  const search = usePickerSearch<PublisherListResponse>('catalog/publishers', typed);
  const matches = search.data?.items ?? [];
  const options: ComboboxOption[] = matches.map((p) => ({ value: p.id, label: p.place === null ? p.name : `${p.name} · ${p.place}` }));
  const error = errorAt(form.formState.errors, 'publisher') ?? errorAt(form.formState.errors, 'publisher.name');

  const pick = (id: string): void => {
    const p = matches.find((m) => m.id === id);
    if (p === undefined) return;
    field.onChange({ id: p.id, name: p.name, place: p.place ?? '' });
    setTyped('');
  };
  const create = (name: string): void => {
    if (name.trim() === '') return;
    field.onChange({ id: null, name: name.trim(), place: '' });
    setTyped('');
  };

  return (
    <div className="grid content-start gap-2">
      <Label id={labelId}>{label}</Label>
      {chosen === null ? (
        <p className="text-sm text-muted-foreground">{t('catalog.records.publisher.none')}</p>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{chosen.name}</span>
          {chosen.place !== '' && <span className="text-muted-foreground">{chosen.place}</span>}
          {chosen.id === null && <Badge tone="info">{t('catalog.records.new_badge')}</Badge>}
          <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t('catalog.records.publisher.clear')} onClick={() => field.onChange(null)}>
            <XIcon aria-hidden="true" />
          </Button>
        </p>
      )}
      <Combobox
        options={options}
        value={null}
        onValueChange={pick}
        placeholder={chosen === null ? t('catalog.records.publisher.choose') : t('catalog.records.publisher.change')}
        aria-labelledby={labelId}
        aria-invalid={error === undefined ? undefined : true}
        searchPlaceholder={t('catalog.records.publisher.search')}
        emptyText={typed.trim() === '' ? t('catalog.records.create_hint') : t('catalog.records.publisher.empty')}
        search={typed}
        onSearchChange={setTyped}
        loading={search.isFetching && matches.length === 0 && typed.trim() !== ''}
        loadingText={t('catalog.records.searching')}
        action={{ label: typed.trim() === '' ? t('catalog.records.create_hint') : t('catalog.records.create_new', { name: typed.trim() }), onSelect: create }}
      />
      <ErrorText error={error} />
    </div>
  );
}
