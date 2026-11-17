import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The classes of a field that takes the whole width of a {@link FormSection} (a name, an address, a note). */
export const FORM_FULL = 'sm:col-span-full';

/**
 * One part of a form: its title and a sentence on the left (above on a narrow screen), its fields on the right in two
 * columns (three on a wide screen), a thin rule above every part but the first. The fields are a fieldset named by the
 * title; `disabled` turns them all off (a reader without the right to change them).
 */
export function FormSection({ title, intro, disabled = false, className, children }: { title: string; intro?: ReactNode; disabled?: boolean; className?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('grid gap-x-8 gap-y-4 border-t py-5 first:border-t-0 first:pt-1 md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]', className)}>
      <div className="grid content-start gap-1">
        <h2 id={id} className="text-base font-bold">
          {title}
        </h2>
        {intro !== undefined && <p className="text-sm text-muted-foreground">{intro}</p>}
      </div>
      <fieldset disabled={disabled} className="grid min-w-0 content-start gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
        <legend className="sr-only">{title}</legend>
        {children}
      </fieldset>
    </section>
  );
}

/**
 * The buttons at the end of a form, under a thin rule: the primary one first ("Simpan"), then "Batal", then a word on
 * the form's state ("Ada perubahan yang belum disimpan").
 */
export function FormBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2 border-t pt-4', className)}>{children}</div>;
}
