import { EDITION_COMMUNITY, type EditionView } from '@altis/shared';
import type { Translate } from '@/i18n';
import type { NavItem } from '@/lib/nav';

/**
 * The edition seam of the admin SPA (ruling R2). The community edition adds no screen and no menu entry of its own:
 * `editionRoutes` is spread into the shell's children (routes.tsx) and `editionNav` is appended to the navigation
 * (lib/nav.ts). A commercial edition is a private fork that fills these two lists; nothing in the community code
 * branches on {@link EDITION}.
 */

/** The edition this build is ('community'; shown as "Edisi Komunitas"). */
export const EDITION = EDITION_COMMUNITY;

/** The edition's own shell routes, children of the shell. Community: none. */
export const editionRoutes = [] as const;

/** The edition's own navigation items, listed after the community ones. Community: none. */
export const editionNav: NavItem[] = [];

/**
 * How the dashboard, Diagnostik and Tentang name an edition (`EditionView.edition`): the community edition by its
 * name in the UI language ("Edisi Komunitas"), any other as the server words it.
 */
export function editionName(t: Translate, edition: string): string {
  return edition === EDITION_COMMUNITY ? t('edition.community') : edition;
}

/** How an edition's status (`EditionView.status`) reads: 'active' in the UI language, any other as the server words it. */
export function editionStatus(t: Translate, view: EditionView): string {
  return view.status === 'active' ? t('edition.status.active') : view.status;
}
