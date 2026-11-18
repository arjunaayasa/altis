import type { Locator, Page } from '@playwright/test';
import { NAV } from '../../../apps/admin/src/lib/nav.js';
import { tr, type TextKey } from './text.js';

// The admin shell's navigation as a user goes through it: the sidebar on the left lists Beranda as a link and every
// group (Layanan, Anggota, Katalog, Laporan, Situs / OPAC, Sistem) as a button that shows or hides its pages.

type Translate = (key: TextKey, params?: Readonly<Record<string, string | number>>) => string;

const indonesian: Translate = (key, params) => tr('id', key, params);

/** The sidebar's navigation. */
export function mainNav(page: Page, t: Translate = indonesian): Locator {
  return page.getByRole('navigation', { name: t('shell.nav_label') });
}

/** The buttons of the groups, in the order of the sidebar. */
export function groupButtons(page: Page, t: Translate = indonesian): Locator {
  return mainNav(page, t).locator('button[aria-expanded]');
}

/** The name of the group the navigation item `to` is listed under (Beranda for the item of no group). */
function groupOf(to: string, t: Translate): string {
  const item = NAV.find((i) => i.to === to);
  if (item === undefined) throw new Error(`no navigation item ${to}`);
  return item.group === undefined ? t('nav.home') : t(`nav.group.${item.group}`);
}

/** The button of the group named `group`. */
export function groupButton(page: Page, group: string, t: Translate = indonesian): Locator {
  return mainNav(page, t).getByRole('button', { name: group, exact: true });
}

/** The list of pages of the group named `group` (hidden while the group is closed). */
export function groupPages(page: Page, group: string, t: Translate = indonesian): Locator {
  return mainNav(page, t).getByRole('list', { name: t('shell.sidebar_label', { module: group }), includeHidden: true });
}

/** The sidebar's link to the navigation item `to` (visible once its group is open). */
export function navLink(page: Page, to: string, t: Translate = indonesian): Locator {
  const item = NAV.find((i) => i.to === to)!;
  if (item.group === undefined) return mainNav(page, t).getByRole('link', { name: t(item.labelKey), exact: true });
  return groupPages(page, groupOf(to, t), t).getByRole('link', { name: t(item.labelKey), exact: true });
}

/** Opens the group named `group` when it is closed. */
export async function openGroup(page: Page, group: string, t: Translate = indonesian): Promise<void> {
  const button = groupButton(page, group, t);
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
}

/** Opens the navigation item `to`: its group in the sidebar when it is closed, then the page. */
export async function openNavPage(page: Page, to: string, t: Translate = indonesian): Promise<void> {
  const item = NAV.find((i) => i.to === to);
  if (item === undefined) throw new Error(`no navigation item ${to}`);
  if (item.group !== undefined) await openGroup(page, groupOf(to, t), t);
  await navLink(page, to, t).click();
}
