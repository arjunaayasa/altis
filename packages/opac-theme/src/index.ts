// @altis/opac-theme: the look of the public OPAC (spec §4.9, §9.2, decision D30) as one TypeScript string.
//
// It imports nothing outside this package, so the server renders the pages with it now and a later client build can
// reuse it. The server serves OPAC_CSS from memory under a content hash (apps/server/src/opac), which is why it is a
// string and not a file the release has to ship.
//
// S16 (Phase 2 Task 3): the stylesheet is the join, in a fixed order, of one module per owner, so that the Phase 2
// tasks that style the OPAC never edit the same file:
//
//   base.ts    the 1b tokens, accents and page frame (Task 21 may edit the shared tokens)
//   shell.ts   Task 21: header, navigation, search box, skip link, home page
//   pages.ts   Task 20: Halaman & Berita
//   search.ts  Task 33: results, facets, paging
//   detail.ts  Task 34: record detail, availability table, shelf map, citations
//   akun.ts    Komunitas: the OPAC member area and the member links of the public pages
//   home.ts    Komunitas: the home page as the library's profile site (hero band, search card, profile blocks)
//
// The content hash covers the joined string, so a change to any module gives the stylesheet a new URL.

import { BASE_CSS } from './base.js';
import { DETAIL_CSS } from './detail.js';
import { PAGES_CSS } from './pages.js';
import { SEARCH_CSS } from './search.js';
import { SHELL_CSS } from './shell.js';
// ---- Komunitas K2 (visits) ----
import { VISITS_CSS } from './visits.js';
// ---- Komunitas (member area) ----
import { AKUN_CSS } from './akun.js';
// ---- Komunitas (OPAC home page) ----
import { HOME_CSS } from './home.js';

export { ACCENTS, DEFAULT_ACCENT, isAccent } from './base.js';
export type { AccentName } from './base.js';
export { AKUN_CSS, BASE_CSS, DETAIL_CSS, HOME_CSS, PAGES_CSS, SEARCH_CSS, SHELL_CSS, VISITS_CSS };

/** The modules of the stylesheet, in the order they are joined (S16). */
export const OPAC_CSS_MODULES: readonly string[] = Object.freeze([BASE_CSS, SHELL_CSS, PAGES_CSS, SEARCH_CSS, DETAIL_CSS, VISITS_CSS, AKUN_CSS, HOME_CSS]);

/** `modules` as one stylesheet: the non-empty ones, in order, one line break apart. */
export function joinOpacCss(modules: readonly string[]): string {
  return modules.filter((m) => m !== '').join('\n');
}

/** The OPAC stylesheet: {@link OPAC_CSS_MODULES} joined. */
export const OPAC_CSS: string = joinOpacCss(OPAC_CSS_MODULES);
