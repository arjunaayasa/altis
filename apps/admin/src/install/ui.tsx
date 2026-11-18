import type { ReactNode } from 'react';
import { TAG_SHAPE, TAG_TONE, TONE_SURFACE, TONE_TEXT } from '@/components/layout';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { problemText, useInstallLocale, useInstallT } from './i18n';

// The few pieces every wizard step draws the same way (Task 30): its heading, a field with its hint and error, a
// problem told in the user's language, a status word. Styling only through the admin's Tailwind classes (CSP: no
// inline style).

/** A native <select> or <textarea> styled like the Input of components/ui. */
export const CONTROL_CLASS =
  'flex w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1 text-base transition-[border-color,box-shadow] duration-150 ease-out outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50 md:text-sm';

export function StepHeading({ title, intro }: { title: string; intro?: string }) {
  return (
    <header className="grid gap-1">
      <h2 className="text-xl leading-tight font-bold">{title}</h2>
      {intro === undefined ? null : <p className="text-sm text-muted-foreground">{intro}</p>}
    </header>
  );
}

export function Section({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="grid gap-3 border-t pt-4">
      <h3 className="text-heading font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The `aria-describedby` of the control of a {@link Field} `id`: its error while one is shown (`${id}-error`), then
 * its hint (`${id}-hint`) when it has one.
 */
export function describedBy(id: string, o: { hint?: boolean; error?: string | null | false }): string | undefined {
  const ids = [typeof o.error === 'string' && `${id}-error`, o.hint === true && `${id}-hint`].filter((x): x is string => x !== false);
  return ids.length === 0 ? undefined : ids.join(' ');
}

/**
 * A labelled control with its hint and its error, which the control names with {@link describedBy}. The error is
 * announced when it appears (`role="alert"`).
 */
export function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string | null; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-meta leading-snug">
        {label}
      </Label>
      {children}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error === undefined || error === null ? null : (
        <p id={`${id}-error`} role="alert" className="text-meta font-semibold text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

/** A failed request: the shared message of its code, the server's detail, the trace id for the administrator. */
export function ProblemAlert({ error, children }: { error: unknown; children?: ReactNode }) {
  const locale = useInstallLocale();
  const t = useInstallT();
  const problem = problemText(locale, error);
  return (
    <div role="alert" className={cn('grid gap-1 rounded-md border px-3.5 py-3 text-sm', TONE_SURFACE.bad)}>
      <p className={cn('font-bold', TONE_TEXT.bad)}>{problem.message}</p>
      {problem.detail === null ? null : <p>{problem.detail}</p>}
      {children}
      {problem.traceId === null ? null : <p className="text-xs">{t('app.trace', { id: problem.traceId })}</p>}
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'error';

/** A short status word in its colour. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cn(TAG_SHAPE, 'shrink-0', TAG_TONE[tone === 'error' ? 'bad' : tone])}>{children}</span>
  );
}

/** Waits `ms`, or rejects with the signal's reason once it aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
