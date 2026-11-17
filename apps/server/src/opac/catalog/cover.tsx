import type { CoverClass } from '@altis/opac-theme';
import { ddcClassOf } from '@altis/shared';

// The cover of a title on the OPAC's pages (the home page's cards, the results, the record detail). A stored cover image
// is always shown as it is. A title without one gets a substitute cover drawn by the theme: a muted cloth colour by its
// DDC main class (the theme's `.cover-<class>`: the ten classes and one for "no class"), the title and the main author
// on it, and a spine label with the call number stacked as on the label stuck to the book on the shelf. The substitute
// is `aria-hidden`: the same title, author and call number follow as real text wherever it is drawn. In a result list
// it is only the cloth strip.

/** A spine label prints at most this many lines; the rest of a long call number is left off. */
export const SPINE_LABEL_LINES_MAX = 5;

/** A part of a call number that is a number: digits and points (`899.221`, `3`). */
const NUMERIC = /^[0-9.]+$/;

/**
 * The cover class of a title: the DDC main class (`0`-`9`) of its classification, else of its call number (the first
 * part that is a class number, past a letter prefix such as `R` or `FIK`); the Islamic expansion `2X` is a class of the
 * 200s; anything else, or nothing, is `x`.
 */
export function coverClass(classification: string | null, callNumber: string | null): CoverClass {
  const main = ddcClassOf(classification, callNumber).main;
  if (main === 'NON') return 'x';
  if (main === '2X') return '2';
  return main[0] as CoverClass;
}

/**
 * The lines of a call number as its spine label prints them: each part (split on spaces) on its own line, except that a
 * number following a number stays on its line (`899.221 3 HIR l` → `899.221 3`, `HIR`, `l`); at most
 * {@link SPINE_LABEL_LINES_MAX} lines; none for an empty call number.
 */
export function spineLabelLines(callNumber: string | null): string[] {
  const parts = (callNumber ?? '').trim().split(/\s+/u).filter((p) => p !== '');
  const lines: string[] = [];
  let lastNumeric = false;
  for (const part of parts) {
    const numeric = NUMERIC.test(part);
    if (numeric && lastNumeric && lines.length > 0) lines[lines.length - 1] = `${lines[lines.length - 1]!} ${part}`;
    else lines.push(part);
    lastNumeric = numeric;
  }
  return lines.slice(0, SPINE_LABEL_LINES_MAX);
}

/** What a cover is drawn from. */
export interface CoverSource {
  title: string;
  /** The main author's display name, or null. */
  author: string | null;
  callNumber: string | null;
  classification: string | null;
  /** A stored, public cover image; null: the substitute. */
  coverFileId: string | null;
}

/** Where a cover is drawn: a card of a grid, a row of a result list, the record detail. */
export type CoverSize = 'card' | 'list' | 'detail';

const SIZE_CLASS: Readonly<Record<CoverSize, string>> = { card: '', list: ' book-cover-sm', detail: ' book-cover-lg' };

/**
 * The cover of `book`: its image (`imgClass`, with an empty alt: the title follows as text), or the substitute cover.
 */
export function BookCover(props: { book: CoverSource; size: CoverSize; imgClass: string; width: number; height: number; lazy?: boolean }) {
  const { book, size } = props;
  if (book.coverFileId !== null) {
    return (
      <img
        class={props.imgClass}
        src={`/files/${encodeURIComponent(book.coverFileId)}`}
        alt=""
        loading={props.lazy === false ? undefined : 'lazy'}
        decoding="async"
        width={props.width}
        height={props.height}
      />
    );
  }
  const cls = `book-cover cover-${coverClass(book.classification, book.callNumber)}${SIZE_CLASS[size]}`;
  if (size === 'list') return <span class={cls} aria-hidden="true"></span>;
  const lines = spineLabelLines(book.callNumber);
  const author = book.author === null || book.author.trim() === '' ? null : book.author;
  return (
    <span class={cls} aria-hidden="true">
      <span class="cover-text">
        <span class="cover-title">{book.title}</span>
        {author === null ? null : <span class="cover-author">{author}</span>}
      </span>
      {lines.length === 0 ? null : (
        <span class="spine-label">
          {lines.map((line) => (
            <span>{line}</span>
          ))}
        </span>
      )}
    </span>
  );
}
