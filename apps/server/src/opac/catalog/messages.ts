import type { Locale } from '@altis/shared';
import { fillPlaceholders } from '@altis/shared/i18n';
import { DETAIL_MESSAGES } from './messages/detail.js';
import { OAI_MESSAGES } from './messages/oai.js';
import { PAGES_MESSAGES } from './messages/pages.js';
import { SEARCH_MESSAGES } from './messages/search.js';
import { SHELL_MESSAGES } from './messages/shell.js';
// ---- Komunitas K2 (visits) ----
import { VISITS_MESSAGES } from './messages/visits.js';

// The OPAC's own copy (Phase 2 Task 3, decision P2-04): the catalogue pages are server-rendered, so their texts live
// here, one file per area (messages/<area>.ts, each owned by its task), not in the shared `opac.*` family of
// @altis/shared (which keeps the 1b pages' texts and is a registry no later task edits). test/opac-messages.test.ts
// holds every area to the shared i18n rules.

export { defineOpacMessages } from './messages/define.js';
export type { OpacMessages } from './messages/define.js';

/** The areas, in a fixed order; a key starts with its area's name (`shell.`, `pages.`, ...). */
export const OPAC_MESSAGE_AREAS = Object.freeze({
  shell: SHELL_MESSAGES,
  pages: PAGES_MESSAGES,
  search: SEARCH_MESSAGES,
  detail: DETAIL_MESSAGES,
  oai: OAI_MESSAGES,
  // ---- Komunitas K2 (visits) ----
  visits: VISITS_MESSAGES,
});

type Areas = typeof OPAC_MESSAGE_AREAS;

/** Every key of the OPAC's own copy. */
export type OpacKey = { [A in keyof Areas]: keyof Areas[A]['id'] & string }[keyof Areas];

const TABLES: Readonly<Record<Locale, Readonly<Record<string, string>>>> = Object.freeze({
  id: Object.freeze(Object.assign({}, ...Object.values(OPAC_MESSAGE_AREAS).map((a) => a.id)) as Record<string, string>),
  en: Object.freeze(Object.assign({}, ...Object.values(OPAC_MESSAGE_AREAS).map((a) => a.en)) as Record<string, string>),
});

/** The text of `key` in `locale`, its `{placeholders}` filled from `vars` as the shared `t()` fills them. */
export function opacText(locale: Locale, key: OpacKey, vars?: Readonly<Record<string, string | number>>): string {
  const template = TABLES[locale][key] ?? TABLES.id[key] ?? key;
  return vars === undefined ? template : fillPlaceholders(template, vars);
}
