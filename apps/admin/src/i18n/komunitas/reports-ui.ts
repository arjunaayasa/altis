// The admin copy of the report, accreditation and page screens' layout: the names of their filter forms and row menus.
// Keys start with `pages.`, `reports.` or `accreditation.`.

export const REPORTS_UI_ID = {
  // ---- Halaman & Berita ----
  'pages.filters': 'Saringan halaman',
  'pages.action.more_named': 'Tindakan untuk {title}',
  // ---- Akreditasi, Register ----
  'accreditation.registers.action.more_named': 'Tindakan untuk {name}',
} as const;

export const REPORTS_UI_EN: Record<keyof typeof REPORTS_UI_ID, string> = {
  'pages.filters': 'Page filters',
  'pages.action.more_named': 'Actions for {title}',
  'accreditation.registers.action.more_named': 'Actions for {name}',
};
