// The admin copy of the Cetak tab, keys `accreditation.print.*`, filled by the task that builds those screens.
// `ACCREDITATION_PRINT_ID` is the source of the keys and `ACCREDITATION_PRINT_EN` is typed against it (a missing
// English text fails `tsc`); both are joined in i18n/komunitas/index.ts, which ADMIN_ID/ADMIN_EN spread, and held to
// the shared rules there (apps/admin/test/komunitas/i18n.test.ts): the same {placeholders} in both languages, no
// English left in `id`, no shared family prefix.

export const ACCREDITATION_PRINT_ID = {
  'accreditation.print.title': 'Cetak dan unduh',
  'accreditation.print.intro':
    'Semua berkas akreditasi dibuat dalam bahasa Indonesia. Berkas yang memuat nama tenaga meminta konfirmasi kata sandi lebih dulu.',

  // The internal simulation.
  'accreditation.print.simulation.intro':
    'Untuk pemeriksaan sendiri: perkiraan nilai per komponen, celah terbesar, dan bukti yang belum lengkap. Jangan unggah berkas ini ke SiPAPI.',
  'accreditation.print.simulation.make': 'Buat simulasi (PDF)',

  // The evidence file, its ZIPs and the request letter.
  'accreditation.print.dossier.intro':
    'Untuk diunggah: tanpa nilai, tanpa predikat, dan tanpa jawaban saran. Jawaban setiap butir Anda isi sendiri di SiPAPI.',
  'accreditation.print.dossier.pdf': 'Berkas bukti (PDF)',
  'accreditation.print.dossier.zip': 'ZIP gabungan',
  'accreditation.print.dossier.zip_components': 'ZIP per komponen',
  'accreditation.print.dossier.zip_hint':
    'ZIP per komponen berisi satu ZIP siap unggah untuk setiap komponen, karena SiPAPI menerima bukti per komponen.',
  'accreditation.print.request_letter': 'Templat surat permohonan (PDF)',
  'accreditation.print.request_letter_hint':
    'Surat permohonan akreditasi yang terisi data profil, siap ditandatangani kepala sekolah.',

  // The running size of each component.
  'accreditation.print.sizes.title': 'Ukuran bukti per komponen',
  'accreditation.print.sizes.intro': 'Batas unggah per komponen: {limit} MB (pengaturan Akreditasi).',
  'accreditation.print.sizes.col_component': 'Komponen',
  'accreditation.print.sizes.col_size': 'Ukuran',
  'accreditation.print.sizes.col_state': 'Keterangan',
  'accreditation.print.sizes.size_of': '{size} dari {limit} MB',
  'accreditation.print.sizes.within': 'Dalam batas',
  'accreditation.print.sizes.over': 'Melebihi batas {limit} MB. Perkecil atau kurangi berkasnya sebelum mengunggah.',
  'accreditation.print.component.profil': 'Profil perpustakaan',

  // The statement of 1 000 titles.
  'accreditation.print.statement.intro':
    'Pernyataan jumlah judul koleksi dengan tanggal per dan blok tanda tangan; juga dimuat di berkas bukti.',
  'accreditation.print.statement.make': 'Buat pernyataan (PDF)',

  // The annexes.
  'accreditation.print.annexes.title': 'Lampiran CSV/XLSX',
  'accreditation.print.annexes.intro':
    'Setiap tabel lampiran statistik juga bisa diunduh tersendiri. Lampiran tenaga memuat nama, jadi meminta konfirmasi kata sandi.',
  'accreditation.print.annexes.make': 'Buat {format}: {title}',
  'accreditation.print.annexes.personal': 'Memuat data pribadi',

  // The runs of the period.
  'accreditation.print.runs.title': 'Berkas yang dibuat',
  'accreditation.print.runs.intro': 'Berkas yang Anda buat untuk periode ini, terbaru di atas.',
  'accreditation.print.runs.empty': 'Belum ada berkas yang Anda buat untuk periode ini.',
  'accreditation.print.runs.made': 'Dibuat {date}',
  'accreditation.print.runs.download': 'Unduh',
  'accreditation.print.runs.download_label': 'Unduh {title}, {date}',
  'accreditation.print.runs.expires': 'Tersedia sampai {date}',
  'accreditation.print.runs.expired': 'Kedaluwarsa pada {date}; buat lagi bila perlu.',
  'accreditation.print.runs.failed': 'Gagal dibuat: {reason}',
  'accreditation.print.started': 'Pembuatan {title} dimulai.',
  'accreditation.print.reauth_cancelled': 'Berkas tidak dibuat karena konfirmasi kata sandi dibatalkan.',

  // The warnings of a run, as sentences.
  'accreditation.print.warning.component_over_limit':
    'Komponen {component} berukuran {size}, melebihi batas {limit} MB per komponen. Perkecil berkasnya sebelum mengunggah ke SiPAPI.',
  'accreditation.print.warning.component_over':
    'Komponen {component} berukuran {size}, melebihi batas unggah per komponen. Perkecil berkasnya sebelum mengunggah ke SiPAPI.',
  'accreditation.print.warning.generated_too_large':
    'Daftar {code} melebihi 10.000 baris sehingga tidak dimasukkan ke ZIP; ekspor daftar itu tersendiri dari laporannya.',
  'accreditation.print.warning.file_missing':
    'Berkas bukti “{name}” tidak ditemukan di penyimpanan sehingga tidak dimuat di ZIP. Unggah ulang berkas itu, lalu buat ZIP lagi.',
  'accreditation.print.warning.file_missing_unknown':
    'Satu berkas bukti tidak ditemukan di penyimpanan sehingga tidak dimuat di ZIP, dan berkas itu sudah tidak ada di daftar bukti periode ini. Periksa bukti periode ini, lalu buat ZIP lagi.',
  'accreditation.print.warning.other': 'Peringatan: {code}',
  // ---- Komunitas K5 (reports) ----
  'accreditation.print.warning.report_withheld':
    'Draf laporan untuk {code} tidak dimasukkan ke ZIP karena Anda tidak memegang izin laporan itu. Minta admin menambahkan izinnya, lalu buat ZIP lagi.',
} as const;

export const ACCREDITATION_PRINT_EN: Readonly<Record<keyof typeof ACCREDITATION_PRINT_ID, string>> = {
  'accreditation.print.title': 'Print and download',
  'accreditation.print.intro':
    'Every accreditation file is made in Indonesian. Files that name staff ask you to confirm your password first.',

  'accreditation.print.simulation.intro':
    'For your own review: the estimated score per component, the largest gaps and the missing evidence. Do not upload this file to SiPAPI.',
  'accreditation.print.simulation.make': 'Make the simulation (PDF)',

  'accreditation.print.dossier.intro':
    'For uploading: no score, no grade and no suggested answers. You enter the answer of each item yourself in SiPAPI.',
  'accreditation.print.dossier.pdf': 'Evidence file (PDF)',
  'accreditation.print.dossier.zip': 'One combined ZIP',
  'accreditation.print.dossier.zip_components': 'One ZIP per component',
  'accreditation.print.dossier.zip_hint':
    'The ZIP per component holds one ready-to-upload ZIP for each component, because SiPAPI takes the evidence per component.',
  'accreditation.print.request_letter': 'Request letter template (PDF)',
  'accreditation.print.request_letter_hint':
    'The accreditation request letter filled with the profile data, ready for the head of school to sign.',

  'accreditation.print.sizes.title': 'Evidence size per component',
  'accreditation.print.sizes.intro': 'Upload limit per component: {limit} MB (Accreditation settings).',
  'accreditation.print.sizes.col_component': 'Component',
  'accreditation.print.sizes.col_size': 'Size',
  'accreditation.print.sizes.col_state': 'Remark',
  'accreditation.print.sizes.size_of': '{size} of {limit} MB',
  'accreditation.print.sizes.within': 'Within the limit',
  'accreditation.print.sizes.over': 'Over the {limit} MB limit. Shrink or remove files before uploading.',
  'accreditation.print.component.profil': 'Library profile',

  'accreditation.print.statement.intro':
    'The statement of the number of titles, with its as-of date and signature block; it is also part of the evidence file.',
  'accreditation.print.statement.make': 'Make the statement (PDF)',

  'accreditation.print.annexes.title': 'CSV/XLSX annexes',
  'accreditation.print.annexes.intro':
    'Each statistical annex table can also be downloaded on its own. The staff annex holds names, so it asks for your password.',
  'accreditation.print.annexes.make': 'Make {format}: {title}',
  'accreditation.print.annexes.personal': 'Holds personal data',

  'accreditation.print.runs.title': 'Files made',
  'accreditation.print.runs.intro': 'The files you made for this period, newest first.',
  'accreditation.print.runs.empty': 'You have not made any file for this period yet.',
  'accreditation.print.runs.made': 'Made {date}',
  'accreditation.print.runs.download': 'Download',
  'accreditation.print.runs.download_label': 'Download {title}, {date}',
  'accreditation.print.runs.expires': 'Available until {date}',
  'accreditation.print.runs.expired': 'Expired on {date}; make it again if needed.',
  'accreditation.print.runs.failed': 'Could not be made: {reason}',
  'accreditation.print.started': 'Making {title} has started.',
  'accreditation.print.reauth_cancelled': 'The file was not made because the password confirmation was cancelled.',

  'accreditation.print.warning.component_over_limit':
    'Component {component} is {size}, over the limit of {limit} MB per component. Shrink its files before uploading to SiPAPI.',
  'accreditation.print.warning.component_over':
    'Component {component} is {size}, over the upload limit per component. Shrink its files before uploading to SiPAPI.',
  'accreditation.print.warning.generated_too_large':
    'The list {code} has more than 10,000 rows, so it was left out of the ZIP; export that list on its own from its report.',
  'accreditation.print.warning.file_missing':
    'The evidence file “{name}” was not found in the storage, so it is not in the ZIP. Upload that file again, then make the ZIP again.',
  'accreditation.print.warning.file_missing_unknown':
    "An evidence file was not found in the storage, so it is not in the ZIP, and it is no longer in this period's evidence list. Check this period's evidence, then make the ZIP again.",
  'accreditation.print.warning.other': 'Warning: {code}',
  // ---- Komunitas K5 (reports) ----
  'accreditation.print.warning.report_withheld':
    "The report draft for {code} was left out of the ZIP because you do not hold that report's permission. Ask an administrator to add it, then make the ZIP again.",
};
