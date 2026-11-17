import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * Status in words. Green, amber and red mark a state, and the word next to them says it: a colour never stands alone.
 * The classes follow the light and dark themes (the tokens of src/index.css).
 */

export type StatusTone = 'ok' | 'warn' | 'bad';

/** The text colour of a status. */
export const TONE_TEXT: Readonly<Record<StatusTone, string>> = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
};

/** The surface (background and border) of a status box. */
export const TONE_SURFACE: Readonly<Record<StatusTone, string>> = {
  ok: 'border-ok-line bg-ok-bg',
  warn: 'border-warn-line bg-warn-bg',
  bad: 'border-bad-line bg-bad-bg',
};

/** The neutral second layer (side panels, inline panels, table heads). */
export const LAYER = 'bg-layer';

/** A status word in its colour; the word carries the meaning. */
export function StatusText({ tone, className, ...props }: ComponentProps<'span'> & { tone: StatusTone }) {
  return <span className={cn('font-semibold', TONE_TEXT[tone], className)} {...props} />;
}

export type TagTone = StatusTone | 'neutral' | 'accent';

/** The colours of a {@link Tag} (and of the older `Badge`, which looks the same). */
export const TAG_TONE: Readonly<Record<TagTone, string>> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  bad: 'bg-bad-bg text-bad',
  neutral: 'bg-layer-2 text-muted-foreground',
  accent: 'bg-accent-soft text-accent-text',
};

/** The shape of a {@link Tag}. */
export const TAG_SHAPE = 'inline-flex h-5.5 w-fit items-center rounded px-1.75 text-xs font-semibold whitespace-nowrap';

/** A short labelled state (a member's status, "Batas penuh"): a tinted chip whose word says the state. */
export function Tag({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: TagTone }) {
  return <span className={cn(TAG_SHAPE, TAG_TONE[tone], className)} {...props} />;
}
