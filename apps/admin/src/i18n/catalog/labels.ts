// The admin copy of Cetak Label and the print queue (Phase 2 Task 30), keys `catalog.labels.*`. `id` is the source of
// the keys and `en` is typed against it (a missing English text fails `tsc`); both have the same {placeholders} and
// `id` keeps no English (apps/admin/test/catalog/i18n.test.ts). index.ts joins the areas into CATALOG_ID/CATALOG_EN,
// which ADMIN_ID/ADMIN_EN spread. Terms: "antrean cetak" (the print queue), "butir" (one queued entry), "label",
// "profil label", "posisi awal" (the first free label on the first sheet), "salinan".

export const LABELS_ID = {
  // The print queue, wherever rows are added to it (components/catalog/print-queue.tsx).
  'catalog.labels.queue.add': 'Tambah ke antrean cetak',
  'catalog.labels.queue.added': '{count} butir ditambahkan ke antrean cetak.',
  'catalog.labels.queue.added_none': 'Semua sudah ada di antrean cetak.',
  'catalog.labels.queue.dropped': 'Antrean penuh: {count} butir terlama dikeluarkan.',
  'catalog.labels.queue.open': 'Buka Cetak Label',

  // The screen.
  'catalog.labels.description':
    'Kumpulkan eksemplar dan cantuman di antrean cetak, lalu buat PDF labelnya. Antrean hanya disimpan di peramban ini, untuk akun Anda.',
  'catalog.labels.loading': 'Memuat profil label…',

  // Adding by barcode.
  'catalog.labels.scan.title': 'Tambah dengan barkod',
  'catalog.labels.scan.barcode': 'Barkod eksemplar',
  'catalog.labels.scan.hint': 'Pindai barkod di mana saja di halaman ini, atau ketik barkodnya lalu tekan Tambah.',
  'catalog.labels.scan.submit': 'Tambah',
  'catalog.labels.scan.searching': 'Mencari {barcode}…',
  'catalog.labels.scan.added': '{label} masuk ke antrean.',
  'catalog.labels.scan.already': '{label} sudah ada di antrean.',
  'catalog.labels.scan.not_found': 'Barkod {barcode} tidak ditemukan.',
  'catalog.labels.scan.invalid': 'Barkod {barcode} tidak sah.',
  'catalog.labels.scan.archived': 'Eksemplar {barcode} diarsipkan dan tidak diberi label.',

  // The queue.
  'catalog.labels.queue.title': 'Antrean cetak',
  'catalog.labels.queue.count': '{count} dari {max} butir',
  'catalog.labels.queue.empty':
    'Antrean kosong. Tambahkan eksemplar atau cantuman dari daftar Eksemplar dan Bibliografi, atau pindai barkodnya di sini.',
  'catalog.labels.queue.col.kind': 'Jenis',
  'catalog.labels.queue.col.label': 'Butir',
  'catalog.labels.queue.col.actions': 'Tindakan',
  'catalog.labels.queue.kind.item': 'Eksemplar',
  'catalog.labels.queue.kind.record': 'Cantuman',
  'catalog.labels.queue.remove': 'Keluarkan',
  'catalog.labels.queue.remove_label': 'Keluarkan {label} dari antrean',
  'catalog.labels.queue.clear': 'Kosongkan antrean',
  'catalog.labels.queue.clear_title': 'Kosongkan antrean cetak?',
  'catalog.labels.queue.clear_body': 'Semua {count} butir dikeluarkan dari antrean. Eksemplar dan cantumannya sendiri tidak berubah.',
  'catalog.labels.queue.clear_confirm': 'Kosongkan',

  // The PDF.
  'catalog.labels.print.title': 'Buat PDF',
  'catalog.labels.print.source': 'Cetak label untuk',
  'catalog.labels.print.source_items': 'Eksemplar di antrean ({count})',
  'catalog.labels.print.source_records': 'Cantuman di antrean ({count}), semua eksemplarnya',
  'catalog.labels.print.source_hint': 'Satu PDF memuat satu jenis butir. Buat PDF kedua untuk jenis yang lain.',
  'catalog.labels.print.profile': 'Profil label',
  'catalog.labels.print.profile_hint': 'Profil mengatur ukuran kertas, jumlah kolom dan baris, serta isi label. Profil diubah di Pengaturan › Katalog.',
  'catalog.labels.print.no_profiles': 'Belum ada profil label. Tambahkan profil di Pengaturan › Katalog.',
  'catalog.labels.print.profile_gone': 'Profil label ini tidak ada lagi. Pilih profil lain.',
  'catalog.labels.print.start': 'Posisi awal',
  'catalog.labels.print.start_hint':
    'Nomor label pertama yang masih kosong di lembar pertama, dihitung dari kiri atas ke kanan. Dengan begitu lembar yang sudah terpakai sebagian bisa dipakai lagi.',
  'catalog.labels.print.start_range': 'Isi angka 1 sampai 1.000.',
  'catalog.labels.print.copies': 'Salinan per label',
  'catalog.labels.print.copies_hint': 'Berapa kali setiap label dicetak, 1 sampai 5.',
  'catalog.labels.print.copies_range': 'Isi angka 1 sampai 5.',
  'catalog.labels.print.submit': 'Buat PDF',
  'catalog.labels.print.working': 'Membuat PDF…',
  'catalog.labels.print.empty': 'Tambahkan butir ke antrean dulu.',
  'catalog.labels.print.ready': 'PDF label siap.',
  'catalog.labels.print.open': 'Buka PDF',
  'catalog.labels.print.download': 'Unduh PDF',
  'catalog.labels.print.skipped':
    '{count} butir antrean tidak menghasilkan label: eksemplarnya tidak ada atau sudah diarsipkan, atau cantumannya tidak punya eksemplar.',
  'catalog.labels.print.none':
    'Tidak ada label yang dapat dibuat: semua butir yang dicetak tidak ada lagi, sudah diarsipkan, atau tidak punya eksemplar. PDF-nya berisi satu halaman kosong.',
  'catalog.labels.print.remove_printed': 'Keluarkan yang sudah dicetak dari antrean',
  'catalog.labels.print.limit':
    'Satu PDF memuat paling banyak 1.000 label. Cantuman di antrean dihitung dengan semua eksemplarnya, jadi jumlah labelnya bisa lebih banyak daripada jumlah butir. Kurangi antrean atau cetak per bagian.',

  // The label kinds of a profile (§7).
  'catalog.labels.kind.spine': 'punggung',
  'catalog.labels.kind.barcode': 'barkod',
  'catalog.labels.kind.spine_barcode': 'punggung dan barkod',
} as const;

export const LABELS_EN: Record<keyof typeof LABELS_ID, string> = {
  'catalog.labels.queue.add': 'Add to the print queue',
  'catalog.labels.queue.added': '{count} entries added to the print queue.',
  'catalog.labels.queue.added_none': 'All of them are in the print queue already.',
  'catalog.labels.queue.dropped': 'The queue is full: the {count} oldest entries were taken out.',
  'catalog.labels.queue.open': 'Open Print labels',

  'catalog.labels.description':
    'Collect items and records in the print queue, then make a PDF of their labels. The queue is kept in this browser only, for your account.',
  'catalog.labels.loading': 'Loading the label profiles…',

  'catalog.labels.scan.title': 'Add by barcode',
  'catalog.labels.scan.barcode': 'Item barcode',
  'catalog.labels.scan.hint': 'Scan a barcode anywhere on this page, or type it and press Add.',
  'catalog.labels.scan.submit': 'Add',
  'catalog.labels.scan.searching': 'Looking up {barcode}…',
  'catalog.labels.scan.added': '{label} is in the queue.',
  'catalog.labels.scan.already': '{label} is in the queue already.',
  'catalog.labels.scan.not_found': 'Barcode {barcode} was not found.',
  'catalog.labels.scan.invalid': 'Barcode {barcode} is not valid.',
  'catalog.labels.scan.archived': 'Item {barcode} is archived and gets no label.',

  'catalog.labels.queue.title': 'Print queue',
  'catalog.labels.queue.count': '{count} of {max} entries',
  'catalog.labels.queue.empty': 'The queue is empty. Add items or records from the Items and Bibliographic records lists, or scan their barcodes here.',
  'catalog.labels.queue.col.kind': 'Kind',
  'catalog.labels.queue.col.label': 'Entry',
  'catalog.labels.queue.col.actions': 'Actions',
  'catalog.labels.queue.kind.item': 'Item',
  'catalog.labels.queue.kind.record': 'Record',
  'catalog.labels.queue.remove': 'Take out',
  'catalog.labels.queue.remove_label': 'Take {label} out of the queue',
  'catalog.labels.queue.clear': 'Empty the queue',
  'catalog.labels.queue.clear_title': 'Empty the print queue?',
  'catalog.labels.queue.clear_body': 'All {count} entries leave the queue. The items and records themselves do not change.',
  'catalog.labels.queue.clear_confirm': 'Empty',

  'catalog.labels.print.title': 'Make the PDF',
  'catalog.labels.print.source': 'Print labels for',
  'catalog.labels.print.source_items': 'The queued items ({count})',
  'catalog.labels.print.source_records': 'The queued records ({count}), all their items',
  'catalog.labels.print.source_hint': 'One PDF holds one kind of entry. Make a second PDF for the other kind.',
  'catalog.labels.print.profile': 'Label profile',
  'catalog.labels.print.profile_hint':
    'A profile sets the paper size, the columns and rows, and what a label shows. Profiles are changed in Settings › Catalogue.',
  'catalog.labels.print.no_profiles': 'There is no label profile yet. Add one in Settings › Catalogue.',
  'catalog.labels.print.profile_gone': 'This label profile no longer exists. Choose another one.',
  'catalog.labels.print.start': 'Start position',
  'catalog.labels.print.start_hint':
    'The number of the first free label on the first sheet, counted from the top left to the right. This way a sheet that is partly used can be used again.',
  'catalog.labels.print.start_range': 'Enter a number from 1 to 1,000.',
  'catalog.labels.print.copies': 'Copies per label',
  'catalog.labels.print.copies_hint': 'How many times each label is printed, 1 to 5.',
  'catalog.labels.print.copies_range': 'Enter a number from 1 to 5.',
  'catalog.labels.print.submit': 'Make PDF',
  'catalog.labels.print.working': 'Making the PDF…',
  'catalog.labels.print.empty': 'Add entries to the queue first.',
  'catalog.labels.print.ready': 'The label PDF is ready.',
  'catalog.labels.print.open': 'Open PDF',
  'catalog.labels.print.download': 'Download PDF',
  'catalog.labels.print.skipped':
    '{count} queued entries gave no label: the item no longer exists or is archived, or the record has no items.',
  'catalog.labels.print.none':
    'No label could be made: every printed entry no longer exists, is archived or has no items. The PDF holds one blank page.',
  'catalog.labels.print.remove_printed': 'Take the printed entries out of the queue',
  'catalog.labels.print.limit':
    'One PDF holds at most 1,000 labels. A queued record counts with all its items, so there can be more labels than entries. Shorten the queue or print it in parts.',

  'catalog.labels.kind.spine': 'spine',
  'catalog.labels.kind.barcode': 'barcode',
  'catalog.labels.kind.spine_barcode': 'spine and barcode',
};
