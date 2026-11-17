import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { problemText } from '@/lib/form-errors';
import { cn } from '@/lib/utils';
import { LAYER, TONE_SURFACE, TONE_TEXT, type StatusTone } from './status';

/** A titled note on the page: neutral, or a status (the title says which). */
export function Callout({
  tone,
  title,
  children,
  action,
  role,
  className,
}: {
  tone?: StatusTone;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: 'alert' | 'status';
  className?: string;
}) {
  return (
    <div role={role} className={cn('grid gap-1 rounded-md border px-3.5 py-3 text-sm', tone === undefined ? cn('border-border', LAYER) : TONE_SURFACE[tone], className)}>
      <p className={cn('font-bold', tone !== undefined && TONE_TEXT[tone])}>{title}</p>
      {children !== undefined && <div className="grid gap-1 text-foreground">{children}</div>}
      {action !== undefined && <div className="mt-1.5 flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * A failure that concerns the whole page or form (a save refused, a conflict with another user, a record that is gone,
 * an action the server refused), as a red callout above the content (`role="alert"`). `title` says what failed; `error`
 * adds the reason in the user's language (lib/form-errors.ts `problemText`, with the wait of a 429). Without a title
 * the reason is the title. Nothing without either. `tone="warn"` for a failure that leaves the page usable.
 */
export function PageError({
  title,
  error,
  children,
  action,
  tone = 'bad',
  className,
}: {
  title?: ReactNode;
  error?: unknown;
  children?: ReactNode;
  action?: ReactNode;
  tone?: Extract<StatusTone, 'bad' | 'warn'>;
  className?: string;
}) {
  const t = useT();
  const reason = error === undefined || error === null ? undefined : problemText(t, error);
  const heading = title ?? reason;
  if (heading === undefined) return null;
  const body = title !== undefined && reason !== undefined ? <p>{reason}</p> : undefined;
  return (
    <Callout role="alert" tone={tone} title={heading} action={action} className={className}>
      {body === undefined && children === undefined ? undefined : (
        <>
          {body}
          {children}
        </>
      )}
    </Callout>
  );
}
