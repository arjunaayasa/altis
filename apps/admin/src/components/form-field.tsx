import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';
import { useId, type ComponentProps, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useT, type TKey } from '@/i18n';
import { fieldErrorText, problemText } from '@/lib/form-errors';
import { cn } from '@/lib/utils';

/**
 * The form building blocks of the admin screens (Tasks 28 and 29): a labelled field with its hint and its error
 * (linked to the control through `aria-describedby`, the error also through `aria-invalid`), a checkbox or switch with
 * its label, the native `<select>`/`<textarea>` styles matching `ui/input`, a small badge, and the alerts and notices
 * above or below a form. A field error is an i18n key (lib/form-errors.ts), translated here.
 */

/** The props a field hands its control. */
export interface FieldControl {
  id: string;
  'aria-invalid': true | undefined;
  'aria-describedby': string | undefined;
}

/** A react-hook-form field error (`errors.name`), or just its message key (`errors.name?.message`). */
type FieldErrorLike = string | { type?: string | number; message?: string } | undefined;

function joinIds(...ids: (string | false | undefined)[]): string | undefined {
  const list = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  return list.length === 0 ? undefined : list.join(' ');
}

/** The ids an input names in `aria-describedby`: its hint and its error, when shown (the ids {@link Field} gives them). */
export function describedBy(id: string, o: { hint?: boolean; error?: unknown }): string | undefined {
  return joinIds(o.error !== undefined && o.error !== null && `${id}-error`, o.hint === true && `${id}-hint`);
}

/**
 * A label, the control, the field's error message and a hint. The control is either
 * - a render function (`children`), which gets the id and the aria attributes to spread on the input; or
 * - an element that carries them itself: then pass its `id`, and wire `aria-invalid` and {@link describedBy}.
 *
 * `error` is the field's react-hook-form error or its message key; an unknown key or a Zod message shows the text of
 * its type (lib/form-errors.ts `fieldErrorText`).
 */
export function Field({
  id: givenId,
  label,
  hint,
  error,
  className,
  children,
}: {
  id?: string;
  label: string;
  hint?: string;
  error?: FieldErrorLike;
  className?: string;
  children: ReactNode | ((control: FieldControl) => ReactNode);
}) {
  const t = useT();
  const ownId = useId();
  const id = givenId ?? ownId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const message = fieldErrorText(t, typeof error === 'string' ? { message: error } : error);
  return (
    <div className={cn('grid content-start gap-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      {typeof children === 'function'
        ? children({
            id,
            'aria-invalid': message === undefined ? undefined : true,
            'aria-describedby': joinIds(message !== undefined && errorId, hint !== undefined && hintId),
          })
        : children}
      {message !== undefined && (
        <p id={errorId} className="text-sm text-destructive">
          {message}
        </p>
      )}
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * A checkbox with its label to the right and an optional hint below. With `asSwitch` it is announced as an on/off
 * switch (`role="switch"`, for a setting that takes effect as a whole, like a 2FA requirement); it still looks and
 * works like a native checkbox.
 */
export function CheckField({
  label,
  hint,
  asSwitch = false,
  className,
  ...input
}: Omit<ComponentProps<'input'>, 'type' | 'role'> & { label: string; hint?: string; asSwitch?: boolean }) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={cn('grid gap-1', className)}>
      <div className="flex items-start gap-2">
        <input
          {...input}
          id={id}
          type="checkbox"
          role={asSwitch ? 'switch' : undefined}
          aria-describedby={joinIds(hint !== undefined && hintId, input['aria-describedby'])}
          className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Label htmlFor={id} className="leading-snug font-normal">
          {label}
        </Label>
      </div>
      {hint !== undefined && (
        <p id={hintId} className="pl-6 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/** The look of `ui/input`, for a native `<select>`. */
export const SELECT_CLASS =
  'flex h-8.5 w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1 text-base transition-[border-color,box-shadow] duration-150 ease-out outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-bad-bg md:text-sm';

/** The look of `ui/input`, for a `<textarea>`. */
export const TEXTAREA_CLASS =
  'flex min-h-18 w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-2 text-base leading-snug transition-[border-color,box-shadow] duration-150 ease-out outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-bad-bg md:text-sm';

const BADGE_TONES = {
  neutral: 'bg-layer-2 text-muted-foreground',
  info: 'bg-accent-soft text-accent-text',
  warning: 'bg-warn-bg text-warn',
  danger: 'bg-bad-bg text-bad',
} as const;

/** A short status word next to a value (`sistem`, `Default`, `Nonaktif`, ...). */
export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: keyof typeof BADGE_TONES }) {
  return (
    <span
      className={cn('inline-flex h-5.5 items-center rounded-sm px-1.5 text-xs font-semibold whitespace-nowrap', BADGE_TONES[tone], className)}
      {...props}
    />
  );
}

/** The outcome of the last action of a screen: a success (`role="status"`) or a failure (`role="alert"`). */
export function Notice({ kind, children, action }: { kind: 'success' | 'error'; children: ReactNode; action?: ReactNode }) {
  if (kind === 'success') {
    return (
      <p role="status" className="flex items-center gap-2 rounded-md border border-ok-line bg-ok-bg px-3.5 py-2.5 text-sm font-semibold text-ok">
        <CircleCheckIcon className="size-4 shrink-0" aria-hidden="true" />
        {children}
      </p>
    );
  }
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{children}</span>
        {action}
      </AlertDescription>
    </Alert>
  );
}

/** A problem of the form as a whole (lib/form-errors.ts `problemText`: with the wait of a 429); nothing for null. */
export function ProblemAlert({ error, children }: { error: unknown; children?: ReactNode }) {
  const t = useT();
  if (error === null || error === undefined) return null;
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription>
        <p>{problemText(t, error)}</p>
        {children}
      </AlertDescription>
    </Alert>
  );
}

/** What {@link RefetchProblem} reads of a query (`useQuery`'s result). */
interface Refetchable {
  isRefetchError: boolean;
  isFetching: boolean;
  error: unknown;
  refetch(): Promise<unknown>;
}

/**
 * A background read of data already on screen failed (React Query keeps the data on a failed refetch,
 * `isRefetchError`): the screen keeps showing that data, so a form being filled keeps what was typed (and its dirty
 * guard, lib/dirty-forms.ts). This notice says the latest data could not be loaded, why, and offers "Coba lagi".
 * Nothing in any other state: a read that failed before any data came is the screen's own blocking problem.
 */
export function RefetchProblem({ query }: { query: Refetchable }) {
  const t = useT();
  if (!query.isRefetchError) return null;
  return (
    <Alert className="border-warning-foreground/30 bg-warning text-warning-foreground">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className="text-current">
        <p>{t('form.refetch_failed')}</p>
        <p>{problemText(t, query.error)}</p>
        <Button type="button" variant="outline" size="sm" className="mt-1" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {t('table.retry')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** The form-level error `root.server` (an i18n key: a field error no field of the form owns); nothing without one. */
export function RootError({ message }: { message: string | undefined }) {
  const t = useT();
  if (message === undefined) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {t(message as TKey)}
    </p>
  );
}

/** A message: `success` after a save, `info` for a notice. */
export function NoticeAlert({ tone = 'info', children }: { tone?: 'info' | 'success'; children: ReactNode }) {
  return (
    <Alert role="status" className={tone === 'success' ? 'border-primary/30' : undefined}>
      {tone === 'success' ? <CircleCheckIcon aria-hidden="true" className="text-primary" /> : <InfoIcon aria-hidden="true" />}
      <AlertDescription className="text-foreground">{children}</AlertDescription>
    </Alert>
  );
}
