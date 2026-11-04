import type { Locale } from '@altis/shared';

/** The copy of one OPAC area in both languages, with the same keys (frozen). */
export type OpacMessages<K extends string> = Readonly<Record<Locale, Readonly<Record<K, string>>>>;

/**
 * The copy of one OPAC area (Phase 2 Task 3, decision P2-04): Indonesian first (the source of the keys), English with
 * exactly the same keys, or `tsc` fails. Kept apart from ../messages.ts, which joins the areas, so that an area file
 * and the aggregator never import each other.
 */
export function defineOpacMessages<const T extends Readonly<Record<string, string>>>(
  id: T,
  en: { readonly [K in keyof T]: string },
): OpacMessages<keyof T & string> {
  return Object.freeze({ id: Object.freeze({ ...id }), en: Object.freeze({ ...en }) }) as OpacMessages<keyof T & string>;
}
