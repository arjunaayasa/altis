import type { ComponentProps, FormEvent, ReactNode } from 'react';
import { Field } from '@/components/form-field';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

/** The row of labelled filters above a list: one row on a wide screen (search wider), two columns on a narrow one. */
export const FILTER_ROW = 'grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(220px,2fr)_repeat(3,minmax(130px,1fr))]';

/**
 * The labelled filters above a list, as one named form: every filter is a {@link FilterField} with its label above the
 * control. On a wide screen they share one row (the search field twice as wide); on a narrow one the search takes a
 * line of its own and the others go two by two. Enter in a typed filter submits the form (`onSubmit`; a hidden submit
 * button makes that work with several fields); a select usually applies at once in its `onChange`. `actions` sit at
 * the end of the row, on the controls' line ("Hapus saringan", "Ekspor CSV").
 */
export function FilterRow({
  label,
  onSubmit,
  submitLabel,
  actions,
  className,
  children,
}: {
  /** The form's name, said by screen readers ("Saringan anggota"). */
  label: string;
  onSubmit?(event: FormEvent<HTMLFormElement>): void;
  /** The hidden submit button's name; "Terapkan saringan" by default. */
  submitLabel?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <form
      noValidate
      aria-label={label}
      onSubmit={(event) => {
        if (onSubmit === undefined) event.preventDefault();
        else onSubmit(event);
      }}
      className={cn('flex flex-wrap items-end gap-3', className)}>
      {children}
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      <button type="submit" className="sr-only" tabIndex={-1}>
        {submitLabel ?? t('table.filter_apply')}
      </button>
    </form>
  );
}

/**
 * One filter of a {@link FilterRow}: a {@link Field} (label above, control at the admin's 34 px height, hint and error
 * linked to it) that takes its share of the row; `wide` for the search field.
 */
export function FilterField({ wide = false, className, ...field }: ComponentProps<typeof Field> & { wide?: boolean }) {
  return <Field {...field} className={cn('min-w-0', wide ? 'flex-[2_1_220px]' : 'flex-[1_1_130px]', className)} />;
}
