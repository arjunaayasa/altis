import { forwardRef, type ComponentProps } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

export type FileInputProps = Omit<ComponentProps<'input'>, 'type' | 'children'> & {
  /**
   * The chosen file's name, written beside the button (null: none chosen yet). Left out where the screen shows the
   * chosen file in its own words, or takes it at once (an upload that starts on choosing).
   */
  chosen?: string | null;
};

/**
 * A file field in the admin's own words. The browser draws a file input with its own button and status ("Choose File",
 * "No file chosen") in the browser's language, whatever the page's. So the input lies, transparent, over a button
 * drawn like the outline buttons: a click on the button and a key on the focused field are the input's own, and its
 * label, its form, its events and its value stay as they were. The button shows the input's focus and its disabled
 * state.
 */
export const FileInput = forwardRef<HTMLInputElement, FileInputProps>(function FileInput({ chosen, className, ...props }, ref) {
  const t = useT();
  return (
    <span className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1', className)}>
      <span
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'relative overflow-hidden has-[input:disabled]:opacity-50 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring',
        )}
      >
        <span aria-hidden="true">{t('form.file.choose')}</span>
        <input
          ref={ref}
          type="file"
          className="absolute inset-0 size-full cursor-pointer opacity-0 file:cursor-pointer disabled:cursor-not-allowed"
          {...props}
        />
      </span>
      {chosen !== undefined && <span className="min-w-0 text-sm break-all text-muted-foreground">{chosen ?? t('form.file.none')}</span>}
    </span>
  );
});
