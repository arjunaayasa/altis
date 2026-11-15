/**
 * The shared texts of the SLiMS migration's member, visit and circulation stages: the cut-over audit action, the error
 * a `replace` run meets once ALTIS lends on its own, and the names of the numbers "Cocokkan dengan SLiMS" compares.
 * `SLIMS_PEOPLE_ID` is the source of the keys and `SLIMS_PEOPLE_EN` is typed against it; both are spread once into the
 * shared catalogs (`i18n/id.ts`, `i18n/en.ts`).
 *
 * No Node built-ins here: the browser bundles this module.
 */

export const SLIMS_PEOPLE_ID = {
  // ---- audit.<action> ----
  'audit.catalog.migration.cutover': 'Menandai langkah pindah dari SLiMS',
  // ---- error.<CODE> ----
  'error.MIGRATION_CIRCULATION_LIVE':
    'ALTIS sudah mencatat sirkulasi sendiri, jadi sirkulasi SLiMS tidak dapat diimpor ulang dengan mode ganti. Pakai mode tambah.',
  // ---- migration.match.<key>: the numbers "Cocokkan dengan SLiMS" compares ----
  'migration.match.open_loans': 'Pinjaman terbuka',
  'migration.match.items_on_loan': 'Eksemplar dipinjam',
  'migration.match.open_loans_item_missing': 'Pinjaman terbuka yang eksemplarnya tidak ada di ALTIS',
  'migration.match.overdue_loans': 'Pinjaman terlambat',
  'migration.match.unpaid_fines_minor': 'Total denda belum lunas',
  'migration.match.active_members': 'Anggota aktif',
  'migration.match.expired_members': 'Anggota kedaluwarsa',
  'migration.match.holds': 'Reservasi',
  'migration.match.visits_month': 'Kunjungan per bulan',
} as const;

export const SLIMS_PEOPLE_EN: Record<keyof typeof SLIMS_PEOPLE_ID, string> = {
  'audit.catalog.migration.cutover': 'Marked a step of the move from SLiMS',
  'error.MIGRATION_CIRCULATION_LIVE':
    'ALTIS already records circulation of its own, so the SLiMS circulation cannot be imported again in replace mode. Use append mode.',
  'migration.match.open_loans': 'Open loans',
  'migration.match.items_on_loan': 'Items on loan',
  'migration.match.open_loans_item_missing': 'Open loans whose item ALTIS does not have',
  'migration.match.overdue_loans': 'Overdue loans',
  'migration.match.unpaid_fines_minor': 'Unpaid fines in total',
  'migration.match.active_members': 'Active members',
  'migration.match.expired_members': 'Expired members',
  'migration.match.holds': 'Holds',
  'migration.match.visits_month': 'Visits per month',
};
