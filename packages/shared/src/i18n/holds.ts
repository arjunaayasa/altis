/**
 * The shared texts of holds and the hold shelf: the audit actions, the error codes and the hold vocabularies of
 * `circulation-vocab.ts`. `HOLDS_ID` is the source of the keys and `HOLDS_EN` is typed against it, so a key without its
 * English text fails `tsc`; both are spread once into the shared catalogs (`i18n/id.ts`, `i18n/en.ts`). The admin
 * screens keep their own strings in `apps/admin/src/i18n/`.
 *
 * No Node built-ins here: the browser bundles this module.
 */

export const HOLDS_ID = {
  // ---- audit.<action> ----
  'audit.circulation.hold.create': 'Membuat reservasi',
  'audit.circulation.hold.cancel': 'Membatalkan reservasi',
  'audit.circulation.hold.ready': 'Menandai reservasi siap diambil',
  'audit.circulation.hold.shelf_clear': 'Mengembalikan eksemplar dari rak tunggu ke rak',
  'audit.circulation.holds.run': 'Memeriksa batas ambil reservasi (tugas terjadwal)',
  // ---- error.<CODE> ----
  'error.CIRC_ITEM_ON_HOLD': 'Eksemplar ini sedang ditahan di rak tunggu untuk anggota lain.',
  'error.CIRC_HOLD_REFUSED': 'Reservasi ini tidak dapat diproses.',
  // ---- vocab.<list>.<value> ----
  'vocab.hold_status.waiting': 'Menunggu',
  'vocab.hold_status.ready': 'Siap diambil',
  'vocab.hold_status.fulfilled': 'Sudah dipinjam',
  'vocab.hold_status.cancelled': 'Dibatalkan',
  'vocab.hold_status.expired': 'Kedaluwarsa',
  'vocab.hold_close_reason.loaned': 'Dipinjam anggota',
  'vocab.hold_close_reason.cancelled_member': 'Dibatalkan anggota',
  'vocab.hold_close_reason.cancelled_staff': 'Dibatalkan petugas',
  'vocab.hold_close_reason.expired_pickup': 'Tidak diambil sampai batas ambil',
  'vocab.hold_close_reason.expired_wait': 'Masa tunggu habis',
  'vocab.hold_close_reason.item_unavailable': 'Eksemplar tidak tersedia lagi',
  'vocab.hold_close_reason.member_archived': 'Anggota diarsipkan',
  'vocab.hold_close_reason.migrated': 'Ditutup saat migrasi',
  'vocab.hold_source.desk': 'Meja layanan',
  'vocab.hold_source.opac': 'OPAC',
  'vocab.hold_source.migrated': 'Migrasi',
  'vocab.hold_refusal.disabled': 'Reservasi sedang tidak dibuka',
  'vocab.hold_refusal.member': 'Keanggotaan tidak aktif atau sudah habis',
  'vocab.hold_refusal.not_allowed': 'Tipe anggota ini tidak boleh memesan',
  'vocab.hold_refusal.limit': 'Batas jumlah reservasi tercapai',
  'vocab.hold_refusal.duplicate': 'Anggota ini sudah memesan judul ini',
  'vocab.hold_refusal.own_loan': 'Anggota ini sedang meminjam judul ini',
  'vocab.hold_refusal.no_copies': 'Tidak ada eksemplar yang bisa dipinjam di cabang ini',
  'vocab.hold_refusal.available': 'Ada eksemplar yang tersedia di rak',
  'vocab.hold_refusal.closed': 'Reservasi ini sudah selesai',
  'vocab.hold_refusal.not_on_shelf': 'Tidak ada eksemplar reservasi ini yang perlu dikembalikan ke rak',
  // ---- hold_slip.*: the hold shelf slip (a receipt roll, in the library's language) ----
  'hold_slip.title': 'RAK TUNGGU',
  'hold_slip.for': 'Untuk',
  'hold_slip.until': 'Ambil paling lambat',
  'hold_slip.item': 'Eksemplar',
} as const;

export const HOLDS_EN: Record<keyof typeof HOLDS_ID, string> = {
  'audit.circulation.hold.create': 'Placed a hold',
  'audit.circulation.hold.cancel': 'Cancelled a hold',
  'audit.circulation.hold.ready': 'Marked a hold ready for pickup',
  'audit.circulation.hold.shelf_clear': 'Put a copy from the hold shelf back on the shelf',
  'audit.circulation.holds.run': 'Checked hold pickup deadlines (scheduled job)',
  'error.CIRC_ITEM_ON_HOLD': 'This item is kept on the hold shelf for another member.',
  'error.CIRC_HOLD_REFUSED': 'This hold cannot be processed.',
  'vocab.hold_status.waiting': 'Waiting',
  'vocab.hold_status.ready': 'Ready for pickup',
  'vocab.hold_status.fulfilled': 'Borrowed',
  'vocab.hold_status.cancelled': 'Cancelled',
  'vocab.hold_status.expired': 'Expired',
  'vocab.hold_close_reason.loaned': 'Borrowed by the member',
  'vocab.hold_close_reason.cancelled_member': 'Cancelled by the member',
  'vocab.hold_close_reason.cancelled_staff': 'Cancelled by staff',
  'vocab.hold_close_reason.expired_pickup': 'Not picked up in time',
  'vocab.hold_close_reason.expired_wait': 'Waited too long',
  'vocab.hold_close_reason.item_unavailable': 'The copy is no longer available',
  'vocab.hold_close_reason.member_archived': 'Member archived',
  'vocab.hold_close_reason.migrated': 'Closed in the migration',
  'vocab.hold_source.desk': 'Service desk',
  'vocab.hold_source.opac': 'Catalogue (OPAC)',
  'vocab.hold_source.migrated': 'Migration',
  'vocab.hold_refusal.disabled': 'Holds are not open at the moment',
  'vocab.hold_refusal.member': 'The membership is not active or has expired',
  'vocab.hold_refusal.not_allowed': 'This member type may not place holds',
  'vocab.hold_refusal.limit': 'The hold limit is reached',
  'vocab.hold_refusal.duplicate': 'This member already holds this title',
  'vocab.hold_refusal.own_loan': 'This member has this title on loan',
  'vocab.hold_refusal.no_copies': 'No copy at this branch may be lent',
  'vocab.hold_refusal.available': 'A copy is on the shelf now',
  'vocab.hold_refusal.closed': 'This hold is no longer active',
  'vocab.hold_refusal.not_on_shelf': 'No copy of this hold has to go back to the shelf',
  'hold_slip.title': 'HOLD SHELF',
  'hold_slip.for': 'For',
  'hold_slip.until': 'Pick up by',
  'hold_slip.item': 'Copy',
};
