// The admin copy of Pengaturan Akreditasi, keys `accreditation.settings.*`, filled by the task that builds those
// screens. `KOMUNITAS_SETTINGS_ID` is the source of the keys and `KOMUNITAS_SETTINGS_EN` is typed against it (a
// missing English text fails `tsc`); both are joined in i18n/komunitas/index.ts, which ADMIN_ID/ADMIN_EN spread, and
// held to the shared rules there (apps/admin/test/komunitas/i18n.test.ts): the same {placeholders} in both languages,
// no English left in `id`, no shared family prefix. The groups of members are labelled by the shared
// `vocab.accred_group.*`.

export const KOMUNITAS_SETTINGS_ID = {
  'accreditation.settings.description':
    'Pengaturan ini dipakai untuk menghitung Laporan Siap Akreditasi dan laporan koleksi. Hitung ulang periode akreditasi setelah mengubahnya.',

  // ---- the sections ----
  'accreditation.settings.section.period': 'Tahun ajaran dan data',
  'accreditation.settings.section.collection': 'Penggolongan koleksi',
  'accreditation.settings.section.collection_hint':
    'Kode tipe koleksi dan jenis bahan seperti tertulis di Data Induk. Tekan Enter atau Tambah untuk memasukkan satu kode.',
  'accreditation.settings.section.thresholds': 'Ambang perhitungan',
  'accreditation.settings.section.website': 'Situs web perpustakaan',
  'accreditation.settings.section.website_hint':
    'Halaman OPAC yang memuat setiap fitur situs web yang dinilai, dan alamat media sosial perpustakaan.',
  'accreditation.settings.section.evidence': 'Berkas bukti',
  'accreditation.settings.section.usage': 'Kunjungan dan impor SLiMS',

  // ---- the settings ----
  'accreditation.settings.school_year_start_month': 'Bulan awal tahun ajaran',
  'accreditation.settings.school_year_start_month_hint': 'Periode tahun ajaran dimulai tanggal 1 bulan ini dan berjalan 12 bulan.',
  'accreditation.settings.live_from': 'Mulai bekerja di ALTIS',
  'accreditation.settings.live_from_hint':
    'Sejak bulan ini penggunaan bulanan diambil dari data ALTIS langsung. Kosongkan untuk memakai bulan pertama yang berisi kunjungan atau pinjaman ALTIS yang bukan hasil migrasi.',
  'accreditation.settings.fiction_collection_types': 'Tipe koleksi fiksi (kode)',
  'accreditation.settings.fiction_collection_types_hint': 'Judul dengan eksemplar bertipe koleksi ini dihitung sebagai fiksi.',
  'accreditation.settings.fiction_call_number_prefixes': 'Awalan nomor panggil fiksi',
  'accreditation.settings.fiction_call_number_prefixes_hint': 'Judul yang nomor panggilnya berawalan salah satu isian ini dihitung sebagai fiksi, misalnya FIK.',
  'accreditation.settings.fiction_ddc_prefixes': 'Awalan DDC fiksi',
  'accreditation.settings.fiction_ddc_prefixes_hint': 'Judul yang klasifikasi DDC-nya berawalan salah satu isian ini dihitung sebagai fiksi, misalnya 813.',
  'accreditation.settings.reference_collection_types': 'Tipe koleksi referensi (kode)',
  'accreditation.settings.reference_collection_types_hint': 'Eksemplar bertipe koleksi ini dihitung sebagai koleksi referensi.',
  'accreditation.settings.electronic_material_types': 'Jenis bahan elektronik (kode)',
  'accreditation.settings.electronic_material_types_hint': 'Judul berjenis bahan ini dihitung sebagai koleksi elektronik, bukan koleksi tercetak.',
  'accreditation.settings.textbook_collection_types': 'Tipe koleksi buku teks (kode)',
  'accreditation.settings.textbook_collection_types_hint':
    'Buku teks utama dan buku panduan guru. Bila kosong, semua koleksi nonreferensi dianggap koleksi pengayaan.',
  'accreditation.settings.used_unit': 'Satuan koleksi terpakai',
  'accreditation.settings.used_unit_hint': 'Bagian koleksi yang dipakai dihitung per judul atau per eksemplar.',
  'accreditation.settings.used_unit.titles': 'Judul',
  'accreditation.settings.used_unit.items': 'Eksemplar',
  'accreditation.settings.processed_threshold': 'Ambang koleksi terolah (%)',
  'accreditation.settings.processed_threshold_hint':
    'Bagian eksemplar yang harus sudah terolah (berbarkod, bernomor panggil, berklasifikasi, dan berlokasi) agar indikator pengorganisasian koleksi tidak bernilai d. Antara {min} dan {max}.',
  'accreditation.settings.undated_share_max': 'Batas eksemplar tanpa tanggal perolehan (%)',
  'accreditation.settings.undated_share_max_hint':
    'Bila bagian eksemplar tanpa tanggal perolehan melebihi batas ini, indikator penambahan koleksi tidak diberi saran jawaban. Antara {min} dan {max}.',
  'accreditation.settings.page.profile': 'Halaman profil perpustakaan',
  'accreditation.settings.page.services': 'Halaman layanan',
  'accreditation.settings.page.contact': 'Halaman kontak',
  'accreditation.settings.page.databases': 'Halaman pangkalan data daring',
  'accreditation.settings.page.faq': 'Halaman tanya jawab (FAQ)',
  'accreditation.settings.page.none': '(tidak dipilih)',
  'accreditation.settings.page.draft': '{title} (/{slug}, draf)',
  'accreditation.settings.page.missing': 'Halaman {id} (tidak ditemukan)',
  'accreditation.settings.page.id_hint': 'Id halaman OPAC (26 karakter). Pengelola Halaman & Berita dapat memilihnya dari daftar.',
  'accreditation.settings.page.unavailable': 'Daftar halaman tidak dapat dibaca; halaman yang tersimpan tetap dipakai.',
  'accreditation.settings.social_urls': 'Alamat media sosial',
  'accreditation.settings.social_urls_hint': 'Alamat lengkap yang diawali http:// atau https://, paling banyak {max}.',
  'accreditation.settings.evidence_max_mb': 'Ukuran terbesar satu berkas bukti (MB)',
  'accreditation.settings.evidence_max_mb_hint': 'Antara {min} dan {max} MB.',
  'accreditation.settings.component_limit_mb': 'Batas ukuran bukti per komponen (MB)',
  'accreditation.settings.component_limit_mb_hint':
    'Komponen yang berkas buktinya melebihi batas ini diberi peringatan di tab Cetak. Antara {min} dan {max} MB.',
  'accreditation.settings.dedupe_legacy': 'Abaikan kunjungan berulang dari data SLiMS',
  'accreditation.settings.dedupe_legacy_hint':
    'Kunjungan hasil migrasi atau impor SLiMS yang tercatat berulang tidak dihitung pada indikator kunjungan; jumlah mentahnya tetap dicetak.',
  'accreditation.settings.unknown_group': 'Kelompok anggota SLiMS yang sudah dihapus',
  'accreditation.settings.unknown_group_hint': 'Kunjungan dan pinjaman anggota yang sudah dihapus di SLiMS dihitung pada kelompok ini.',
  'accreditation.settings.unknown_group.auto': 'Otomatis (siswa untuk perpustakaan sekolah)',
  'accreditation.settings.unknown_group.none': 'Tidak dihitung pada kelompok mana pun',

  // ---- the chip lists ----
  'accreditation.settings.chips.list': '{label}, isi saat ini',
  'accreditation.settings.chips.empty': 'Belum ada isian.',
  'accreditation.settings.chips.add': 'Tambah',
  'accreditation.settings.chips.add_to': 'Tambah ke {label}',
  'accreditation.settings.chips.remove': 'Hapus {value} dari {label}',
  'accreditation.settings.chips.duplicate': '{value} sudah ada di daftar.',
  'accreditation.settings.chips.full': 'Daftar ini paling banyak berisi {max} isian.',

  // ---- the save ----
  'accreditation.settings.changed_elsewhere':
    'Pengaturan akreditasi diubah pengguna lain setelah halaman ini dibuka. Muat pengaturan terbaru, lalu ulangi perubahan Anda.',
  'accreditation.settings.load_newer': 'Muat pengaturan terbaru',
} as const;

export const KOMUNITAS_SETTINGS_EN: Readonly<Record<keyof typeof KOMUNITAS_SETTINGS_ID, string>> = {
  'accreditation.settings.description':
    'These settings are used to compute the accreditation report and the collection reports. Recalculate the accreditation periods after changing them.',

  // ---- the sections ----
  'accreditation.settings.section.period': 'School year and data',
  'accreditation.settings.section.collection': 'Collection groups',
  'accreditation.settings.section.collection_hint':
    'Collection type and material type codes as written in the master data. Press Enter or Add to enter one code.',
  'accreditation.settings.section.thresholds': 'Calculation thresholds',
  'accreditation.settings.section.website': 'Library website',
  'accreditation.settings.section.website_hint': 'The OPAC pages that hold each assessed feature of the website, and the library’s social media addresses.',
  'accreditation.settings.section.evidence': 'Evidence files',
  'accreditation.settings.section.usage': 'Visits and the SLiMS import',

  // ---- the settings ----
  'accreditation.settings.school_year_start_month': 'First month of the school year',
  'accreditation.settings.school_year_start_month_hint': 'A school year period starts on the 1st of this month and lasts 12 months.',
  'accreditation.settings.live_from': 'Working in ALTIS since',
  'accreditation.settings.live_from_hint':
    'From this month on, monthly usage comes straight from the ALTIS data. Leave it empty to use the first month with an ALTIS visit or loan that was not migrated.',
  'accreditation.settings.fiction_collection_types': 'Fiction collection types (codes)',
  'accreditation.settings.fiction_collection_types_hint': 'Titles with copies of these collection types count as fiction.',
  'accreditation.settings.fiction_call_number_prefixes': 'Fiction call number prefixes',
  'accreditation.settings.fiction_call_number_prefixes_hint': 'Titles whose call number starts with one of these count as fiction, for example FIK.',
  'accreditation.settings.fiction_ddc_prefixes': 'Fiction DDC prefixes',
  'accreditation.settings.fiction_ddc_prefixes_hint': 'Titles whose DDC class starts with one of these count as fiction, for example 813.',
  'accreditation.settings.reference_collection_types': 'Reference collection types (codes)',
  'accreditation.settings.reference_collection_types_hint': 'Copies of these collection types count as the reference collection.',
  'accreditation.settings.electronic_material_types': 'Electronic material types (codes)',
  'accreditation.settings.electronic_material_types_hint': 'Titles of these material types count as the electronic collection, not the printed one.',
  'accreditation.settings.textbook_collection_types': 'Textbook collection types (codes)',
  'accreditation.settings.textbook_collection_types_hint':
    'Main textbooks and teacher guides. When empty, every non-reference title counts as enrichment.',
  'accreditation.settings.used_unit': 'Unit of collection use',
  'accreditation.settings.used_unit_hint': 'The share of the collection in use is counted per title or per copy.',
  'accreditation.settings.used_unit.titles': 'Titles',
  'accreditation.settings.used_unit.items': 'Copies',
  'accreditation.settings.processed_threshold': 'Processed collection threshold (%)',
  'accreditation.settings.processed_threshold_hint':
    'The share of copies that must be processed (with a barcode, a call number, a class and a location) for the collection organisation indicator not to score d. Between {min} and {max}.',
  'accreditation.settings.undated_share_max': 'Most copies without an acquisition date (%)',
  'accreditation.settings.undated_share_max_hint':
    'When a larger share of copies has no acquisition date, the collection additions indicator gets no suggested answer. Between {min} and {max}.',
  'accreditation.settings.page.profile': 'Library profile page',
  'accreditation.settings.page.services': 'Services page',
  'accreditation.settings.page.contact': 'Contact page',
  'accreditation.settings.page.databases': 'Online databases page',
  'accreditation.settings.page.faq': 'Questions and answers (FAQ) page',
  'accreditation.settings.page.none': '(none)',
  'accreditation.settings.page.draft': '{title} (/{slug}, draft)',
  'accreditation.settings.page.missing': 'Page {id} (not found)',
  'accreditation.settings.page.id_hint': 'The OPAC page id (26 characters). Whoever manages Pages & News can pick it from a list.',
  'accreditation.settings.page.unavailable': 'The page list could not be read; the stored pages stay in use.',
  'accreditation.settings.social_urls': 'Social media addresses',
  'accreditation.settings.social_urls_hint': 'Full addresses starting with http:// or https://, at most {max}.',
  'accreditation.settings.evidence_max_mb': 'Largest evidence file (MB)',
  'accreditation.settings.evidence_max_mb_hint': 'Between {min} and {max} MB.',
  'accreditation.settings.component_limit_mb': 'Evidence size limit per component (MB)',
  'accreditation.settings.component_limit_mb_hint':
    'A component whose evidence files go over this limit gets a warning on the Print tab. Between {min} and {max} MB.',
  'accreditation.settings.dedupe_legacy': 'Leave out repeated visits from SLiMS data',
  'accreditation.settings.dedupe_legacy_hint':
    'Repeated visits that came from the SLiMS migration or import are not counted by the visits indicator; their raw total is still printed.',
  'accreditation.settings.unknown_group': 'Group of members deleted in SLiMS',
  'accreditation.settings.unknown_group_hint': 'Visits and loans of members deleted in SLiMS count in this group.',
  'accreditation.settings.unknown_group.auto': 'Automatic (students for a school library)',
  'accreditation.settings.unknown_group.none': 'Not counted in any group',

  // ---- the chip lists ----
  'accreditation.settings.chips.list': '{label}, current entries',
  'accreditation.settings.chips.empty': 'Nothing entered yet.',
  'accreditation.settings.chips.add': 'Add',
  'accreditation.settings.chips.add_to': 'Add to {label}',
  'accreditation.settings.chips.remove': 'Remove {value} from {label}',
  'accreditation.settings.chips.duplicate': '{value} is in the list already.',
  'accreditation.settings.chips.full': 'This list holds at most {max} entries.',

  // ---- the save ----
  'accreditation.settings.changed_elsewhere':
    'Another user changed the accreditation settings after this page was opened. Load the newest settings, then make your change again.',
  'accreditation.settings.load_newer': 'Load the newest settings',
};
