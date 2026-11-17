import type { ShelfStatus } from '@altis/core';
import type { Locale } from '@altis/shared';
import { opacText } from './messages.js';

// A title's copies in words, as a card, a result row and the record page say it (core opac-home/shelf-status.ts
// decides the state): "Tersedia" or "Tersedia 1 dari 3", "Dipinjam, kembali 21 Nov", "Hanya baca di tempat", or "Tidak
// di rak". The colour of the words only repeats them (green, amber, muted). Nothing about who holds a copy.

/** The class of each state's words. */
const STATUS_CLASS: Readonly<Record<ShelfStatus['kind'], string>> = {
  available: 'status status-ok',
  on_loan: 'status status-warn',
  library_use: 'status status-muted',
  unavailable: 'status status-muted',
};

/**
 * A due date (`YYYY-MM-DD`) as short words in `locale` ("21 Nov"), with its year when that is not `year` (a loan due
 * last year, or next).
 */
export function dueText(dueOn: string, locale: Locale, year: number): string {
  const ms = Date.parse(`${dueOn}T00:00:00Z`);
  if (!Number.isFinite(ms)) return dueOn;
  const sameYear = new Date(ms).getUTCFullYear() === year;
  return new Intl.DateTimeFormat(locale === 'id' ? 'id-ID' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(ms);
}

/** The words of `status` in `locale` (see the top of this file). */
export function shelfStatusText(status: ShelfStatus, locale: Locale, year: number): string {
  switch (status.kind) {
    case 'available':
      return status.shelf === status.total
        ? opacText(locale, 'search.card.available')
        : opacText(locale, 'search.card.available_some', { count: status.shelf, total: status.total });
    case 'on_loan':
      return opacText(locale, 'search.card.on_loan', { date: dueText(status.dueOn, locale, year) });
    case 'library_use':
      return opacText(locale, 'search.card.library_use');
    case 'unavailable':
      return opacText(locale, 'search.card.off_shelf');
  }
}

/** The status as a span of coloured words with `extraClass` (nothing for a title without copies). */
export function ShelfStatusLine(props: { status: ShelfStatus | null; locale: Locale; year: number; extraClass?: string }) {
  const { status } = props;
  if (status === null) return null;
  const cls = props.extraClass === undefined ? STATUS_CLASS[status.kind] : `${STATUS_CLASS[status.kind]} ${props.extraClass}`;
  return <span class={cls}>{shelfStatusText(status, props.locale, props.year)}</span>;
}

/** The calendar year of `now` (epoch ms), the one a due date of the same year leaves out. */
export function yearOf(now: number): number {
  return new Date(now).getUTCFullYear();
}
