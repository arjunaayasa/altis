// The admin copy of Duplikat (Phase 2), keys `catalog.duplicates.*`: created empty by Task 3, filled by Task 29. `id`
// is the source of the keys and `en` is typed against it (a missing English text fails `tsc`); both have the same
// {placeholders} and `id` keeps no English (apps/admin/test/catalog/i18n.test.ts). index.ts joins the areas into
// CATALOG_ID/CATALOG_EN, which ADMIN_ID/ADMIN_EN spread. The record fields use the shared `vocab.field.*` labels.

export const DUPLICATES_ID = {
  // ---- the scan ----
  'catalog.duplicates.description':
    'Temukan cantuman ganda yang ISBN-nya sama, atau yang judul dan tahunnya sama, bandingkan berdampingan, lalu gabungkan.',
  'catalog.duplicates.scan': 'Pindai katalog',
  'catalog.duplicates.scan_again': 'Pindai lagi',
  'catalog.duplicates.scanning': 'Pemindaian berjalan',
  'catalog.duplicates.never': 'Katalog belum pernah dipindai.',
  'catalog.duplicates.last_scan': 'Pindaian terakhir selesai {date}.',
  'catalog.duplicates.failed': 'Pindaian terakhir tidak selesai. Jalankan pindaian lagi.',
  'catalog.duplicates.counts': '{isbn} kelompok ISBN sama, {titles} kelompok judul dan tahun sama, {records} cantuman.',
  'catalog.duplicates.report': 'Unduh daftar lengkap (CSV)',
  'catalog.duplicates.preview_note': 'Daftar di bawah memuat {shown} dari {total} kelompok. Daftar lengkap ada di berkas CSV.',
  'catalog.duplicates.leave_hint': 'Pemindaian tetap berjalan bila Anda meninggalkan halaman ini.',

  // ---- the groups ----
  'catalog.duplicates.groups': 'Kelompok kemungkinan duplikat',
  'catalog.duplicates.empty': 'Tidak ditemukan duplikat.',
  'catalog.duplicates.col.group': 'Kelompok',
  'catalog.duplicates.col.reason': 'Alasan',
  'catalog.duplicates.col.records': 'Cantuman',
  'catalog.duplicates.reason.isbn': 'ISBN sama',
  'catalog.duplicates.reason.title_year': 'Judul dan tahun sama',
  'catalog.duplicates.compare': 'Bandingkan',
  'catalog.duplicates.compare_label': 'Bandingkan kelompok {n}',
  'catalog.duplicates.group_done': 'Selesai',

  // ---- compare and merge ----
  'catalog.duplicates.compare.title': 'Bandingkan kelompok {n}',
  'catalog.duplicates.compare.close': 'Tutup perbandingan',
  'catalog.duplicates.compare.target': 'Cantuman yang dipertahankan',
  'catalog.duplicates.compare.source': 'Cantuman yang digabungkan',
  'catalog.duplicates.compare.swap': 'Tukar',
  'catalog.duplicates.compare.caption': 'Perbandingan dua cantuman',
  'catalog.duplicates.compare.field': 'Ruas',
  'catalog.duplicates.compare.kept': 'Dipertahankan',
  'catalog.duplicates.compare.merged_in': 'Digabungkan',
  'catalog.duplicates.compare.differs': 'berbeda',
  'catalog.duplicates.compare.open': 'Buka “{title}” di editor (tab baru)',
  'catalog.duplicates.compare.field.title': 'Judul',
  'catalog.duplicates.compare.field.material_type': 'Jenis bahan',
  'catalog.duplicates.compare.field.items': 'Eksemplar',
  'catalog.duplicates.compare.field.attachments': 'Lampiran',
  'catalog.duplicates.compare.field.updated': 'Diubah',
  'catalog.duplicates.compare.items': '{total} ({available} tersedia)',
  'catalog.duplicates.compare.merged': '“{title}” sudah digabung ke cantuman lain, jadi tidak ditawarkan.',
  'catalog.duplicates.compare.archived': '“{title}” sudah diarsipkan, jadi tidak ditawarkan.',
  'catalog.duplicates.compare.unreadable': 'Cantuman {id} tidak dapat dimuat.',
  'catalog.duplicates.compare.one_left': 'Kelompok ini tinggal satu cantuman aktif.',
  'catalog.duplicates.compare.none_left': 'Kelompok ini tidak punya cantuman aktif lagi.',
  'catalog.duplicates.compare.same': 'Pilih dua cantuman yang berbeda.',
  'catalog.duplicates.merge': 'Gabungkan',
  'catalog.duplicates.merge_hint':
    'Eksemplar, lampiran, pengenal, pengarang, subjek, dan relasi cantuman yang digabungkan dipindahkan ke cantuman yang dipertahankan.',
  'catalog.duplicates.merge.title': 'Gabungkan dua cantuman?',
  'catalog.duplicates.merge.body':
    '“{source}” akan digabung ke “{target}”: eksemplar, lampiran, pengenal, pengarang, subjek, dan relasinya dipindahkan, lalu “{source}” diarsipkan dan alamat OPAC-nya dialihkan ke “{target}”. Penggabungan tidak dapat dibatalkan.',
  'catalog.duplicates.merge.done': '“{source}” sudah digabung ke “{target}”.',
  // ---- the layout of the screen ----
  'catalog.duplicates.compare.open_short': 'Buka',
  'catalog.duplicates.compare.differs_tag': 'Berbeda',
} as const;

export const DUPLICATES_EN: Record<keyof typeof DUPLICATES_ID, string> = {
  // ---- the scan ----
  'catalog.duplicates.description':
    'Find records entered twice, with the same ISBN or with the same title and year, compare them side by side, then merge them.',
  'catalog.duplicates.scan': 'Scan the catalogue',
  'catalog.duplicates.scan_again': 'Scan again',
  'catalog.duplicates.scanning': 'Scan in progress',
  'catalog.duplicates.never': 'The catalogue has not been scanned yet.',
  'catalog.duplicates.last_scan': 'The last scan finished {date}.',
  'catalog.duplicates.failed': 'The last scan did not finish. Run the scan again.',
  'catalog.duplicates.counts': '{isbn} groups with the same ISBN, {titles} groups with the same title and year, {records} records.',
  'catalog.duplicates.report': 'Download the full list (CSV)',
  'catalog.duplicates.preview_note': 'The list below holds {shown} of {total} groups. The CSV file has the full list.',
  'catalog.duplicates.leave_hint': 'The scan goes on if you leave this page.',

  // ---- the groups ----
  'catalog.duplicates.groups': 'Groups of likely duplicates',
  'catalog.duplicates.empty': 'No duplicates were found.',
  'catalog.duplicates.col.group': 'Group',
  'catalog.duplicates.col.reason': 'Reason',
  'catalog.duplicates.col.records': 'Records',
  'catalog.duplicates.reason.isbn': 'Same ISBN',
  'catalog.duplicates.reason.title_year': 'Same title and year',
  'catalog.duplicates.compare': 'Compare',
  'catalog.duplicates.compare_label': 'Compare group {n}',
  'catalog.duplicates.group_done': 'Done',

  // ---- compare and merge ----
  'catalog.duplicates.compare.title': 'Compare group {n}',
  'catalog.duplicates.compare.close': 'Close the comparison',
  'catalog.duplicates.compare.target': 'Record to keep',
  'catalog.duplicates.compare.source': 'Record to merge into it',
  'catalog.duplicates.compare.swap': 'Swap',
  'catalog.duplicates.compare.caption': 'Comparison of two records',
  'catalog.duplicates.compare.field': 'Field',
  'catalog.duplicates.compare.kept': 'Kept',
  'catalog.duplicates.compare.merged_in': 'Merged',
  'catalog.duplicates.compare.differs': 'differs',
  'catalog.duplicates.compare.open': 'Open “{title}” in the editor (new tab)',
  'catalog.duplicates.compare.field.title': 'Title',
  'catalog.duplicates.compare.field.material_type': 'Material type',
  'catalog.duplicates.compare.field.items': 'Items',
  'catalog.duplicates.compare.field.attachments': 'Attachments',
  'catalog.duplicates.compare.field.updated': 'Changed',
  'catalog.duplicates.compare.items': '{total} ({available} available)',
  'catalog.duplicates.compare.merged': '“{title}” has been merged into another record, so it is not offered.',
  'catalog.duplicates.compare.archived': '“{title}” is archived, so it is not offered.',
  'catalog.duplicates.compare.unreadable': 'Record {id} could not be loaded.',
  'catalog.duplicates.compare.one_left': 'This group has one live record left.',
  'catalog.duplicates.compare.none_left': 'This group has no live record left.',
  'catalog.duplicates.compare.same': 'Choose two different records.',
  'catalog.duplicates.merge': 'Merge',
  'catalog.duplicates.merge_hint': 'The items, attachments, identifiers, authors, subjects and relations of the merged record move to the record kept.',
  'catalog.duplicates.merge.title': 'Merge two records?',
  'catalog.duplicates.merge.body':
    '“{source}” will be merged into “{target}”: its items, attachments, identifiers, authors, subjects and relations move, then “{source}” is archived and its OPAC address redirects to “{target}”. A merge cannot be undone.',
  'catalog.duplicates.merge.done': '“{source}” has been merged into “{target}”.',
  // ---- the layout of the screen ----
  'catalog.duplicates.compare.open_short': 'Open',
  'catalog.duplicates.compare.differs_tag': 'Differs',
};
