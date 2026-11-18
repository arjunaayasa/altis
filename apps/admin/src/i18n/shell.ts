// The admin shell's own copy: the sidebar (its sections, collapsing it, the drawer of a narrow screen), the top bar
// and its user menu with the colour theme. Joined into ADMIN_ID / ADMIN_EN at their end (i18n/id.ts, i18n/en.ts).
// `shell.home_overview` is no longer drawn; the end-to-end helpers still name it, and it goes away with them.

export const SHELL_ID = {
  'shell.sidebar_label': 'Menu {module}',
  'shell.menu': 'Menu',
  'shell.home_overview': 'Ringkasan',
  'shell.public_site': 'Situs publik',
  'shell.public_site_hint': '(tab baru)',
  'shell.sidebar_collapse': 'Ciutkan menu',
  'shell.sidebar_expand': 'Lebarkan menu',
  'nav.section.daily': 'Kerja harian',
  'nav.section.collection': 'Koleksi',
  'nav.section.site': 'Situs & sistem',
  'nav.opac.identity': 'Identitas situs',
  'login.back_to_site': 'Kembali ke situs',
  'shell.breadcrumb_label': 'Lokasi halaman',
  'shell.theme': 'Tema',
  'shell.theme.light': 'Terang',
  'shell.theme.dark': 'Gelap',
  'shell.theme.system': 'Ikuti sistem',
} as const;

export const SHELL_EN: Record<keyof typeof SHELL_ID, string> = {
  'shell.sidebar_label': '{module} menu',
  'shell.menu': 'Menu',
  'shell.home_overview': 'Overview',
  'shell.public_site': 'Public site',
  'shell.public_site_hint': '(new tab)',
  'shell.sidebar_collapse': 'Collapse menu',
  'shell.sidebar_expand': 'Expand menu',
  'nav.section.daily': 'Daily work',
  'nav.section.collection': 'Collection',
  'nav.section.site': 'Site & system',
  'nav.opac.identity': 'Site identity',
  'login.back_to_site': 'Back to the site',
  'shell.breadcrumb_label': 'You are here',
  'shell.theme': 'Theme',
  'shell.theme.light': 'Light',
  'shell.theme.dark': 'Dark',
  'shell.theme.system': 'Follow system',
};
