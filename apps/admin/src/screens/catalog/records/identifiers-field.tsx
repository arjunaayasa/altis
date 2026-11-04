import { IDENTIFIER_TYPES, vocabKey } from '@altis/shared';
import { PlusIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { useId } from 'react';
import { useWatch, type UseFieldArrayReturn, type UseFormReturn } from 'react-hook-form';
import { SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { ErrorText, errorAt, useLegend } from './agent-picker';
import type { RecordFormValues } from './draft-to-form';

/**
 * The identifiers of a record (Phase 2 spec §3.2, §6.3, §13; plan Task 24): ISBN, ISSN, DOI, a control number or
 * another, each with its qualifier ("jil. 2"). An empty row is not sent. The first empty ISBN row is the editor's ISBN
 * field: a scanner burst lands there (edit.tsx), and the ISBN lookup reads the first ISBN.
 *
 * The rows are the editor's field array (the scanner appends to it as well). A stored ISBN or ISSN whose check digit
 * is wrong is kept with a warning (§3.2); `warnings` maps such a value to its warning code, shown on its row.
 */
export function IdentifiersField({
  form,
  array,
  required,
  warnings,
}: {
  form: UseFormReturn<RecordFormValues>;
  array: UseFieldArrayReturn<RecordFormValues, 'identifiers'>;
  required: boolean;
  /** A stored value → its warning code (`isbn_invalid`, `issn_invalid`). */
  warnings: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const legend = useLegend('vocab.field.identifiers', required);
  const hintId = useId();
  const baseId = useId();
  const { register, control } = form;
  const rows = useWatch({ control, name: 'identifiers' });
  const errors = form.formState.errors;
  const { fields, append, remove } = array;

  return (
    <fieldset className="grid min-w-0 gap-3" aria-describedby={hintId}>
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <p id={hintId} className="text-xs text-muted-foreground">
        {t('catalog.records.identifiers.hint')}
      </p>
      <ul className="grid gap-2">
        {fields.map((field, i) => {
          const n = i + 1;
          const valueError = errorAt(errors, `identifiers.${i}.value`) ?? errorAt(errors, `identifiers.${i}`);
          const qualifierError = errorAt(errors, `identifiers.${i}.qualifier`);
          const errorId = `${baseId}-${field.id}-error`;
          const warning = warnings.get((rows[i]?.value ?? '').trim());
          return (
            <li key={field.id} className="grid gap-1">
              <div className="flex flex-wrap items-start gap-2">
                <select className={`${SELECT_CLASS} w-auto`} aria-label={t('catalog.records.identifiers.type', { n })} {...register(`identifiers.${i}.type`)}>
                  {IDENTIFIER_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(vocabKey('identifier_type', type))}
                    </option>
                  ))}
                </select>
                <Input
                  className="min-w-40 flex-1 font-mono"
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('catalog.records.identifiers.value', { n })}
                  aria-invalid={valueError === undefined ? undefined : true}
                  aria-describedby={valueError === undefined ? undefined : errorId}
                  {...register(`identifiers.${i}.value`)}
                />
                <Input
                  className="w-36"
                  maxLength={64}
                  autoComplete="off"
                  placeholder={t('catalog.records.identifiers.qualifier_placeholder')}
                  aria-label={t('catalog.records.identifiers.qualifier', { n })}
                  aria-invalid={qualifierError === undefined ? undefined : true}
                  {...register(`identifiers.${i}.qualifier`)}
                />
                <Button type="button" variant="ghost" size="icon" aria-label={t('catalog.records.identifiers.remove', { n })} onClick={() => remove(i)}>
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
              <ErrorText id={errorId} error={valueError ?? qualifierError} />
              {warning !== undefined && (
                <p className="flex items-center gap-1 text-sm text-warning-foreground">
                  <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
                  {t(`catalog.records.warning.${warning}` as TKey)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => append({ type: 'isbn', value: '', qualifier: '' })}>
          <PlusIcon aria-hidden="true" />
          {t('catalog.records.identifiers.add')}
        </Button>
      </div>
      <ErrorText error={errorAt(errors, 'identifiers')} />
    </fieldset>
  );
}
