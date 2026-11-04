// The admin copy of the SRU copy dialog and the ISBN lookup (Phase 2), keys `catalog.sru.*`: created empty by Task 3,
// filled by Task 32. `id` is the source of the keys and `en` is typed against it (a missing English text fails
// `tsc`); both have the same {placeholders} and `id` keeps no English (apps/admin/test/catalog/i18n.test.ts).
// index.ts joins the areas into CATALOG_ID/CATALOG_EN, which ADMIN_ID/ADMIN_EN spread.

export const SRU_ID = {
  // ---- "Salin dari SRU" ----
  'catalog.sru.dialog.title': 'Salin dari SRU',
  'catalog.sru.dialog.description':
    'Cari cantuman di server SRU, lalu pilih satu untuk mengisi formulir. Tidak ada yang tersimpan sebelum Anda menyimpan formulir.',
  'catalog.sru.close': 'Tutup',
  'catalog.sru.form': 'Pencarian SRU',
  'catalog.sru.server': 'Server',
  'catalog.sru.index': 'Cari berdasarkan',
  'catalog.sru.index.isbn': 'Nomor ISBN',
  'catalog.sru.index.title': 'Judul',
  'catalog.sru.index.author': 'Pengarang',
  'catalog.sru.index.any': 'Semua ruas',
  'catalog.sru.term': 'Kata pencarian',
  'catalog.sru.term_required': 'Isi kata pencarian.',
  'catalog.sru.search': 'Cari',
  'catalog.sru.searching': 'Mencari…',
  'catalog.sru.loading': 'Memuat daftar server…',
  'catalog.sru.no_servers': 'Belum ada server SRU yang aktif. Administrator dapat mengaktifkannya di Pengaturan › Katalog.',
  'catalog.sru.server_unavailable': 'Server ini sudah tidak ada atau sudah dinonaktifkan. Tutup dialog lalu buka lagi.',
  'catalog.sru.results': 'Hasil pencarian',
  'catalog.sru.total': '{total} hasil di server, ditampilkan nomor {from} sampai {to}.',
  'catalog.sru.empty': 'Server tidak menemukan cantuman yang cocok.',
  'catalog.sru.refused': 'Server SRU menolak pencarian ini: {message}',
  'catalog.sru.unreadable': 'Sebagian cantuman di halaman ini tidak dapat dibaca dan dilewati.',
  'catalog.sru.prev': 'Halaman sebelumnya',
  'catalog.sru.next': 'Halaman berikutnya',
  'catalog.sru.paging': 'Halaman hasil',

  // ---- a candidate ----
  'catalog.sru.pick': 'Pilih',
  'catalog.sru.pick_label': 'Pilih {title}',
  'catalog.sru.add_item_now': 'Tambah eksemplar sekarang',
  'catalog.sru.add_item_now_hint': 'Setelah cantuman disimpan, tab Eksemplar dibuka agar Anda dapat langsung menambah eksemplar.',
  'catalog.sru.add_item_after_save': 'Setelah disimpan, tab Eksemplar akan dibuka untuk menambah eksemplar.',
  'catalog.sru.isbns': 'Nomor ISBN: {list}',
  'catalog.sru.duplicate': 'Mungkin duplikat (skor {score})',
  'catalog.sru.duplicate_open': 'Buka cantuman yang mirip',
  'catalog.sru.duplicate_open_label': 'Buka cantuman yang mirip dengan {title} di tab baru',
  'catalog.sru.from_source': 'Sumber: {source}',
  'catalog.sru.source.arsya': 'Layanan ISBN',

  // ---- "Cari ISBN" ----
  'catalog.sru.lookup.button': 'Cari ISBN',
  'catalog.sru.lookup.busy': 'Mencari ISBN…',
  'catalog.sru.lookup.invalid': 'ISBN ini tidak valid. Periksa angka-angkanya.',
  'catalog.sru.lookup.title': 'Hasil pencarian ISBN {isbn}',
  'catalog.sru.lookup.description':
    'Kandidat dari sumber salin katalog yang aktif. Pilih satu untuk mengisi formulir; tanda duplikat menunjukkan cantuman serupa yang sudah ada.',
  'catalog.sru.lookup.none': 'Tidak ada sumber yang menemukan ISBN ini.',
  'catalog.sru.lookup.no_sources': 'Belum ada sumber salin katalog yang aktif. Administrator dapat mengaktifkan server SRU di Pengaturan › Katalog.',
  'catalog.sru.lookup.errors': 'Sumber yang tidak menjawab',
  'catalog.sru.lookup.source_failed': '{source}: tidak berhasil. {reason}',
} as const;

export const SRU_EN: Record<keyof typeof SRU_ID, string> = {
  // ---- "Salin dari SRU" ----
  'catalog.sru.dialog.title': 'Copy from SRU',
  'catalog.sru.dialog.description': 'Search an SRU server, then pick a record to fill the form. Nothing is stored until you save the form.',
  'catalog.sru.close': 'Close',
  'catalog.sru.form': 'SRU search',
  'catalog.sru.server': 'Server (SRU)',
  'catalog.sru.index': 'Search by',
  'catalog.sru.index.isbn': 'ISBN',
  'catalog.sru.index.title': 'Title',
  'catalog.sru.index.author': 'Author',
  'catalog.sru.index.any': 'Any field',
  'catalog.sru.term': 'Search term',
  'catalog.sru.term_required': 'Enter a search term.',
  'catalog.sru.search': 'Search',
  'catalog.sru.searching': 'Searching…',
  'catalog.sru.loading': 'Loading the server list…',
  'catalog.sru.no_servers': 'No SRU server is enabled yet. An administrator can enable one under Settings › Catalogue.',
  'catalog.sru.server_unavailable': 'This server no longer exists or has been disabled. Close the dialog and open it again.',
  'catalog.sru.results': 'Search results',
  'catalog.sru.total': '{total} results on the server, showing numbers {from} to {to}.',
  'catalog.sru.empty': 'The server found no matching record.',
  'catalog.sru.refused': 'The SRU server refused this search: {message}',
  'catalog.sru.unreadable': 'Some records on this page could not be read and were skipped.',
  'catalog.sru.prev': 'Previous page',
  'catalog.sru.next': 'Next page',
  'catalog.sru.paging': 'Result pages',

  // ---- a candidate ----
  'catalog.sru.pick': 'Pick',
  'catalog.sru.pick_label': 'Pick {title}',
  'catalog.sru.add_item_now': 'Add an item now',
  'catalog.sru.add_item_now_hint': 'Once the record is saved, the Items tab opens so that you can add an item straight away.',
  'catalog.sru.add_item_after_save': 'After saving, the Items tab opens so that you can add an item.',
  'catalog.sru.isbns': 'ISBN: {list}',
  'catalog.sru.duplicate': 'Possible duplicate (score {score})',
  'catalog.sru.duplicate_open': 'Open the similar record',
  'catalog.sru.duplicate_open_label': 'Open the record similar to {title} in a new tab',
  'catalog.sru.from_source': 'Source: {source}',
  'catalog.sru.source.arsya': 'ISBN service',

  // ---- "Cari ISBN" ----
  'catalog.sru.lookup.button': 'Look up the ISBN',
  'catalog.sru.lookup.busy': 'Looking up the ISBN…',
  'catalog.sru.lookup.invalid': 'This ISBN is not valid. Check its digits.',
  'catalog.sru.lookup.title': 'ISBN {isbn}: results',
  'catalog.sru.lookup.description':
    'Candidates from the enabled copy-cataloguing sources. Pick one to fill the form; a duplicate mark points to a similar record already in the catalogue.',
  'catalog.sru.lookup.none': 'No source found this ISBN.',
  'catalog.sru.lookup.no_sources': 'No copy-cataloguing source is enabled yet. An administrator can enable an SRU server under Settings › Catalogue.',
  'catalog.sru.lookup.errors': 'Sources that did not answer',
  'catalog.sru.lookup.source_failed': '{source}: no answer. {reason}',
};
