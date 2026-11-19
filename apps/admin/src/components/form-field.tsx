import { useId, type ComponentProps, type ReactNode } from 'react';
import { PageError } from '@/components/layout/callout';
import { SETTING_ROW, useSettingRows } from '@/components/layout/setting-row';
import { TAG_SHAPE, TAG_TONE, TONE_SURFACE, TONE_TEXT } from '@/components/layout/status';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useT, type TKey } from '@/i18n';
import { fieldErrorText } from '@/lib/form-errors';
import { cn } from '@/lib/utils';

/**
 * The form building blocks of the admin screens (Tasks 28 and 29): a labelled field with its hint and its error
 * (linked to the control through `aria-describedby`, the error also through `aria-invalid`), a checkbox or switch with
 * its label, the native `<select>`/`<textarea>` styles matching `ui/input`, a small badge, and the alerts and notices
 * above or below a form. A field error is an i18n key (lib/form-errors.ts), translated here.
 *
 * They share the look of the layout pieces (components/layout): a field's label in 13 px semibold above its control
 * (34 px high), the error in red words under it, then the hint; a badge looks like a `Tag`; the notices and alerts are
 * callouts, a status always said in words.
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
  wide = false,
  children,
}: {
  id?: string;
  label: string;
  hint?: string;
  error?: FieldErrorLike;
  className?: string;
  /** As a row of a settings card: the control under its label, across the card (a long text, a list). */
  wide?: boolean;
  children: ReactNode | ((control: FieldControl) => ReactNode);
}) {
  const t = useT();
  const ownId = useId();
  const id = givenId ?? ownId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const message = fieldErrorText(t, typeof error === 'string' ? { message: error } : error);
  const asRow = useSettingRows();
  if (asRow) {
    // A row of a settings card: the same label, ids and messages, the label and the hint on the left.
    return (
      <div data-slot="setting-row" className={cn(SETTING_ROW, wide && 'lg:grid-cols-1')}>
        <div className="min-w-0">
          <label htmlFor={id} className="block font-semibold">
            {label}
          </label>
          {hint !== undefined && (
            <p id={hintId} className="text-meta text-muted-foreground">
              {hint}
            </p>
          )}
        </div>
        <div className="grid min-w-0 gap-1.5">
          {typeof children === 'function'
            ? children({
                id,
                'aria-invalid': message === undefined ? undefined : true,
                'aria-describedby': joinIds(message !== undefined && errorId, hint !== undefined && hintId),
              })
            : children}
          {message !== undefined && (
            <p id={errorId} className="text-meta font-semibold text-bad">
              {message}
            </p>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className={cn('grid content-start gap-1.5', className)}>
      <Label htmlFor={id} className="text-meta leading-snug">
        {label}
      </Label>
      {typeof children === 'function'
        ? children({
            id,
            'aria-invalid': message === undefined ? undefined : true,
            'aria-describedby': joinIds(message !== undefined && errorId, hint !== undefined && hintId),
          })
        : children}
      {message !== undefined && (
        <p id={errorId} className="text-meta font-semibold text-bad">
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
  const asRow = useSettingRows();
  if (asRow) {
    // A row of a settings card: the name and the hint on the left, the box on the right.
    return (
      <div data-slot="setting-row" className={cn(SETTING_ROW, 'grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_auto]')}>
        <div className="min-w-0">
          <label htmlFor={id} className="block font-semibold">
            {label}
          </label>
          {hint !== undefined && (
            <p id={hintId} className="text-meta text-muted-foreground">
              {hint}
            </p>
          )}
        </div>
        <input
          {...input}
          id={id}
          type="checkbox"
          role={asSwitch ? 'switch' : undefined}
          aria-describedby={joinIds(hint !== undefined && hintId, input['aria-describedby'])}
          className="size-4 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    );
  }
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
  'flex h-8.5 w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-1 text-base transition-[border-color,box-shadow] duration-150 ease-out outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-bad-bg aria-invalid:focus-visible:border-ring aria-invalid:focus-visible:ring-accent-soft md:text-sm';

/** The look of `ui/input`, for a `<textarea>`. */
export const TEXTAREA_CLASS =
  'flex min-h-18 w-full min-w-0 rounded-md border border-input bg-background px-2.5 py-2 text-base leading-snug transition-[border-color,box-shadow] duration-150 ease-out outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-bad-bg aria-invalid:focus-visible:border-ring aria-invalid:focus-visible:ring-accent-soft md:text-sm';

const BADGE_TONES = {
  neutral: TAG_TONE.neutral,
  info: TAG_TONE.accent,
  warning: TAG_TONE.warn,
  danger: TAG_TONE.bad,
} as const;

/** A short status word next to a value (`sistem`, `Default`, `Nonaktif`, ...): the look of a `Tag`. */
export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: keyof typeof BADGE_TONES }) {
  return <span className={cn(TAG_SHAPE, BADGE_TONES[tone], className)} {...props} />;
}

/** The box of a callout (the look of the layout's `Callout`). */
const CALLOUT_BOX = 'grid gap-1 rounded-md border px-3.5 py-3 text-sm';

/**
 * The outcome of the last action of a screen: a success (`role="status"`, green words) or a failure (`role="alert"`, a
 * red callout whose title is the message, the action under it).
 */
export function Notice({ kind, children, action }: { kind: 'success' | 'error'; children: ReactNode; action?: ReactNode }) {
  if (kind === 'success') {
    return (
      <p role="status" className={cn('rounded-md border px-3.5 py-2.5 text-sm font-semibold', TONE_SURFACE.ok, TONE_TEXT.ok)}>
        {children}
      </p>
    );
  }
  return (
    <div role="alert" className={cn(CALLOUT_BOX, TONE_SURFACE.bad)}>
      <div className={cn('font-bold', TONE_TEXT.bad)}>{children}</div>
      {action !== undefined && <div className="mt-1.5 flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * A problem of the form as a whole (lib/form-errors.ts `problemText`: with the wait of a 429), as the layout's
 * `PageError`: the problem is the title, `children` follow it; nothing for null.
 */
export function ProblemAlert({ error, children }: { error: unknown; children?: ReactNode }) {
  return <PageError error={error}>{children}</PageError>;
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
    <PageError
      tone="warn"
      title={t('form.refetch_failed')}
      error={query.error}
      action={
        <Button type="button" variant="outline" size="sm" className="bg-background" disabled={query.isFetching} onClick={() => void query.refetch()}>
          {t('table.retry')}
        </Button>
      }
    />
  );
}

/** The form-level error `root.server` (an i18n key: a field error no field of the form owns); nothing without one. */
export function RootError({ message }: { message: string | undefined }) {
  const t = useT();
  if (message === undefined) return null;
  return (
    <p role="alert" className="text-meta font-semibold text-bad">
      {t(message as TKey)}
    </p>
  );
}

/** A message: `success` after a save (green words), `info` for a notice (on the neutral layer). */
export function NoticeAlert({ tone = 'info', children }: { tone?: 'info' | 'success'; children: ReactNode }) {
  return (
    <div role="status" className={cn(CALLOUT_BOX, 'justify-items-start', tone === 'success' ? cn(TONE_SURFACE.ok, TONE_TEXT.ok, 'font-semibold') : 'border-border bg-layer text-foreground')}>
      {children}
    </div>
  );
}
