import { BarcodePatternList, type CatalogSettings } from '@altis/shared/api/settings';
import { useId, useState } from 'react';
import { useFieldArray, useWatch, type FieldError, type UseFormReturn } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type AdminKey } from '@/i18n';
import { errorAt, errorText, freeCode, listMax, type CatalogFormValues, type PatternValues } from './form';

/**
 * The barcode pattern editor of Pengaturan › Katalog (Phase 2 spec §3.4, §12.6; plan Task 28): one row per pattern
 * (code, name, prefix, digits, suffix) with an example of the barcode it makes. At least one pattern stays, and a 21st
 * is refused at once with the shared schema's limit (M1); the form checks the rest on save (a duplicate code, a prefix
 * with a space). A saved pattern's code is read-only: the item batches name it.
 */

/** The most patterns the settings hold (M1). */
export const PATTERNS_MAX = listMax(BarcodePatternList);

/** The first barcode a pattern makes (`B0000001`), or a dash while its digits are not a number of 3-12. */
export function patternExample(p: Pick<PatternValues, 'prefix' | 'digits' | 'suffix'> | undefined): string {
  if (p === undefined || !Number.isInteger(p.digits) || p.digits < 3 || p.digits > 12) return '—';
  return `${p.prefix.toUpperCase()}${'1'.padStart(p.digits, '0')}${p.suffix.toUpperCase()}`;
}

/**
 * A list's own error, with this list's words: too many (an entry refused by the editor, `limited`, or the schema's
 * `too_big`), too few, or any other (from the server) as its field message.
 */
export function ListError({
  limited,
  error,
  tooMany,
  tooFew,
  max,
}: {
  limited: boolean;
  error: FieldError | undefined;
  tooMany: AdminKey;
  /** The words of a list that may not be empty. */
  tooFew?: AdminKey;
  max: number;
}) {
  const t = useT();
  if (!limited && error === undefined) return null;
  const type = limited ? 'too_big' : String(error?.type);
  return (
    <p role="alert" className="text-meta font-semibold text-bad">
      {type === 'too_big' ? t(tooMany, { max }) : type === 'too_small' && tooFew !== undefined ? t(tooFew) : errorText(t, error)}
    </p>
  );
}

const FIELDS = ['id', 'name', 'prefix', 'digits', 'suffix'] as const;

export function BarcodePatternsEditor({ form, readOnly }: { form: UseFormReturn<CatalogFormValues, unknown, CatalogSettings>; readOnly: boolean }) {
  const t = useT();
  const baseId = useId();
  const { control, register, getValues } = form;
  const array = useFieldArray({ control, name: 'barcode.patterns' });
  const rows = useWatch({ control, name: 'barcode.patterns' });
  const [limited, setLimited] = useState(false);
  const errors = form.formState.errors;
  const listError = errorAt(errors, 'barcode.patterns');

  const add = (): void => {
    if (array.fields.length >= PATTERNS_MAX) {
      setLimited(true);
      return;
    }
    setLimited(false);
    const taken = getValues('barcode.patterns').map((p) => p.id);
    array.append({ id: freeCode('pola', array.fields.length + 1, taken), name: '', prefix: '', digits: 7, suffix: '', locked: false });
  };

  const remove = (i: number): void => {
    setLimited(false);
    array.remove(i);
  };

  return (
    <fieldset className="grid min-w-0 gap-3" aria-describedby={`${baseId}-hint`}>
      <legend className="mb-1 text-sm font-semibold">{t('catalog.settings.patterns.legend')}</legend>
      <p id={`${baseId}-hint`} className="text-xs text-muted-foreground">
        {t('catalog.settings.patterns.hint')} {t('catalog.settings.code_locked')}
      </p>
      <div aria-hidden="true" className="hidden grid-cols-[7rem_minmax(0,1fr)_5rem_4.5rem_5rem_7rem_4.5rem] gap-2 text-xs font-semibold text-muted-foreground md:grid">
        <span>{t('catalog.settings.patterns.col.id')}</span>
        <span>{t('catalog.settings.patterns.col.name')}</span>
        <span>{t('catalog.settings.patterns.col.prefix')}</span>
        <span>{t('catalog.settings.patterns.col.digits')}</span>
        <span>{t('catalog.settings.patterns.col.suffix')}</span>
        <span>{t('catalog.settings.patterns.col.example')}</span>
      </div>
      <ul className="grid gap-3 md:gap-2">
        {array.fields.map((field, i) => {
          const n = i + 1;
          const row = rows[i];
          const fieldErrors = FIELDS.map((name) => ({ name, error: errorAt(errors, `barcode.patterns.${i}.${name}`) }));
          const rowError = errorAt(errors, `barcode.patterns.${i}`);
          const errorId = (name: string) => `${baseId}-${field.id}-${name}-error`;
          const aria = (name: (typeof FIELDS)[number]) => {
            const error = fieldErrors.find((f) => f.name === name)?.error;
            return { 'aria-invalid': error === undefined ? undefined : true, 'aria-describedby': error === undefined ? undefined : errorId(name) } as const;
          };
          return (
            <li key={field.id} className="grid gap-1">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-[7rem_minmax(0,1fr)_5rem_4.5rem_5rem_7rem_4.5rem] md:items-center">
                <Input
                  className="font-mono"
                  maxLength={32}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('catalog.settings.patterns.id', { n })}
                  readOnly={row?.locked === true}
                  {...aria('id')}
                  {...register(`barcode.patterns.${i}.id`)}
                  disabled={readOnly}
                />
                <Input maxLength={64} aria-label={t('catalog.settings.patterns.name', { n })} {...aria('name')} {...register(`barcode.patterns.${i}.name`)} disabled={readOnly} />
                <Input
                  className="font-mono uppercase"
                  maxLength={16}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('catalog.settings.patterns.prefix', { n })}
                  {...aria('prefix')}
                  {...register(`barcode.patterns.${i}.prefix`)}
                  disabled={readOnly}
                />
                <Input
                  type="number"
                  inputMode="numeric"
                  min={3}
                  max={12}
                  aria-label={t('catalog.settings.patterns.digits', { n })}
                  {...aria('digits')}
                  {...register(`barcode.patterns.${i}.digits`, { valueAsNumber: true })}
                  disabled={readOnly}
                />
                <Input
                  className="font-mono uppercase"
                  maxLength={16}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('catalog.settings.patterns.suffix', { n })}
                  {...aria('suffix')}
                  {...register(`barcode.patterns.${i}.suffix`)}
                  disabled={readOnly}
                />
                {/* Plain text, not <output>: a live region would announce every keystroke of the prefix. */}
                <span className="truncate font-mono text-sm" title={t('catalog.settings.patterns.col.example')}>
                  {patternExample(row)}
                </span>
                {!readOnly && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t('catalog.settings.patterns.remove', { n })}
                    disabled={array.fields.length <= 1}
                    onClick={() => remove(i)}
                  >
                    {t('system.remove')}
                  </Button>
                )}
              </div>
              {fieldErrors.map(({ name, error }) =>
                error === undefined ? null : (
                  <p key={name} id={errorId(name)} className="text-meta font-semibold text-bad">
                    {t(`catalog.settings.patterns.col.${name}`)}: {errorText(t, error)}
                  </p>
                ),
              )}
              {rowError !== undefined && <p className="text-meta font-semibold text-bad">{errorText(t, rowError)}</p>}
            </li>
          );
        })}
      </ul>
      {!readOnly && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={add}>
            {t('catalog.settings.patterns.add')}
          </Button>
        </div>
      )}
      <ListError
        limited={limited}
        error={listError}
        tooMany="catalog.settings.patterns.too_many"
        tooFew="catalog.settings.patterns.too_few"
        max={PATTERNS_MAX}
      />
    </fieldset>
  );
}
