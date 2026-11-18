import { CircleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The bar that stays at the bottom of the window while a long form is open: a word on the form's state on the left
 * ("Ada perubahan yang belum disimpan"; with `tone="bad"` what keeps it from being saved, announced as an alert and
 * marked with an icon beside its words), the buttons on the right, the primary one last. It spans the content area
 * (it undoes the padding of the page), so it is the last thing of the screen.
 */
export function SaveBar({ message, tone = 'neutral', className, children }: { message?: ReactNode; tone?: 'neutral' | 'bad'; className?: string; children: ReactNode }) {
  return (
    <div
      data-slot="save-bar"
      className={cn('sticky bottom-0 z-[5] -mx-4 mt-5 -mb-4 flex flex-wrap items-center gap-2 border-t bg-background px-4 py-2.5 lg:-mx-6 lg:-mb-6 lg:px-6', className)}>
      {/* Always there, so a message that appears later is announced. */}
      <p role={tone === 'bad' ? 'alert' : 'status'} className={cn('flex min-w-0 items-center gap-1.5', tone === 'bad' ? 'font-medium text-bad' : 'text-muted-foreground')}>
        {message !== undefined && tone === 'bad' && <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />}
        {message}
      </p>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
