import type { Locator, Page } from '@playwright/test';
import { NAV } from '../../../apps/admin/src/lib/nav.js';
import { tr, type TextKey } from './text.js';

// The admin shell's navigation as a user goes through it: the module bar under the top bar (Beranda, Katalog, Layanan,
// Anggota, Laporan, OPAC, Sistem), then the sidebar, which lists the pages of the active module only.

type Translate = (key: TextKey, params?: Readonly<Record<string, string | number>>) => string;

const indonesian: Translate = (key, params) => tr('id', key, params);

/** The module bar. */
export function moduleBar(page: Page, t: Translate = indonesian): Locator {
  return page.getByRole('navigation', { name: t('shell.nav_label') });
}

/** The name of the module the navigation item `to` is listed under. */
function moduleOf(to: string, t: Translate): string {
  const item = NAV.find((i) => i.to === to);
  if (item === undefined) throw new Error(`no navigation item ${to}`);
  return item.group === undefined ? t('nav.home') : t(`nav.group.${item.group}`);
}

/** The sidebar of the module `module` (its name as the module bar shows it). */
export function sidebar(page: Page, module: string, t: Translate = indonesian): Locator {
  return page.getByRole('navigation', { name: t('shell.sidebar_label', { module }) });
}

/** The sidebar's link to the navigation item `to`, once its module is the active one. */
export function navLink(page: Page, to: string, t: Translate = indonesian): Locator {
  const item = NAV.find((i) => i.to === to)!;
  const label = item.to === '/admin' ? t('shell.home_overview') : t(item.labelKey);
  return sidebar(page, moduleOf(to, t), t).getByRole('link', { name: label, exact: true });
}

/** Opens the navigation item `to`: its module in the module bar, then the page in the sidebar. */
export async function openNavPage(page: Page, to: string, t: Translate = indonesian): Promise<void> {
  await moduleBar(page, t).getByRole('link', { name: moduleOf(to, t), exact: true }).click();
  await navLink(page, to, t).click();
}
