// The admin shell's own copy: the module bar and the sidebar, the top bar's user menu with the colour theme, and the
// shortcuts of Beranda. Joined into ADMIN_ID / ADMIN_EN at their end (i18n/id.ts, i18n/en.ts).

export const SHELL_ID = {
  'shell.sidebar_label': 'Menu {module}',
  'shell.menu': 'Menu',
  'shell.home_overview': 'Ringkasan',
  'shell.shortcuts': 'Pintasan',
  'shell.shortcut.add_member': 'Tambah anggota',
  'shell.public_site': 'Situs publik',
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
  'shell.shortcuts': 'Shortcuts',
  'shell.shortcut.add_member': 'Add member',
  'shell.public_site': 'Public site',
  'shell.breadcrumb_label': 'You are here',
  'shell.theme': 'Theme',
  'shell.theme.light': 'Light',
  'shell.theme.dark': 'Dark',
  'shell.theme.system': 'Follow system',
};
