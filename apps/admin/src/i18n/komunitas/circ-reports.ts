// The admin copy of the numbers of today on Beranda (screens/dashboard-today.tsx), keys `dashboard.today.*`, and of the
// links from a working screen to its reports (screens/reports/report-links.tsx), `reportLinks.*`. The reports themselves
// speak with the shared `report.*` texts; their module labels are in the reports area.

export const CIRC_REPORTS_ADMIN_ID = {
  'dashboard.today.title': 'Hari ini',
  'dashboard.today.branch': 'Cabang {name}',
  'dashboard.today.loaned': 'Dipinjam hari ini',
  'dashboard.today.returned': 'Dikembalikan hari ini',
  'dashboard.today.overdue': 'Pinjaman terlambat',
  'dashboard.today.holds_ready': 'Reservasi siap diambil',
  'dashboard.today.visits': 'Kunjungan hari ini',
  'reportLinks.label': 'Cetak atau ekspor:',
} as const;

export const CIRC_REPORTS_ADMIN_EN: Record<keyof typeof CIRC_REPORTS_ADMIN_ID, string> = {
  'dashboard.today.title': 'Today',
  'dashboard.today.branch': 'Branch {name}',
  'dashboard.today.loaned': 'Lent today',
  'dashboard.today.returned': 'Returned today',
  'dashboard.today.overdue': 'Overdue loans',
  'dashboard.today.holds_ready': 'Holds ready for pickup',
  'dashboard.today.visits': 'Visits today',
  'reportLinks.label': 'Print or export:',
};
