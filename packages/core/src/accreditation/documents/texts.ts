// The wording of the accreditation documents (the evidence file, its ZIP sheets, the simulation and the statement of
// 1 000 titles). These documents are always in Indonesian, whatever language the requester reads, and they are never
// shown on a screen, so their texts live here as constants rather than in the message catalogue. The labels the
// documents share with the workspace (indicator paraphrases, evidence items, notes, components, vocabularies) come from
// the shared messages in Indonesian.
//
// The evidence file prints no score at all: none of its texts names an answer, a suggestion, a predicate or the
// estimated final score. Only the simulation's texts (`SIM`) speak about those.

/** Section headings of the evidence file, in their printed order. */
export const HEADINGS = Object.freeze({
  dossier: 'Berkas Bukti Akreditasi Perpustakaan',
  requestLetter: 'Surat Permohonan Akreditasi Perpustakaan',
  submissionForm: 'Formulir Pengajuan Akreditasi Perpustakaan',
  statement: 'Surat Pernyataan Memiliki Koleksi Paling Sedikit 1.000 Judul',
  certificateName: 'Pernyataan Penulisan Sertifikat',
  profile: 'Data Profil Perpustakaan',
  sheets: 'Lembar Indikator Kinerja',
  registers: 'Daftar Register',
  annex: 'Lampiran Statistik',
  snp: 'Kepatuhan Standar Nasional Perpustakaan Sekolah',
  titleList: 'Daftar Judul Koleksi',
});

/** The roles of the signature blocks. */
export const ROLES = Object.freeze({
  schoolHead: 'Kepala Sekolah',
  libraryHead: 'Kepala Perpustakaan',
  parentHead: 'Kepala Lembaga Induk',
});

/** Words printed in many places. */
export const WORDS = Object.freeze({
  none: '—',
  noData: 'tidak ada data',
  present: 'ada',
  missing: 'belum',
  npp: 'NPP',
  approvedBy: 'Disahkan Kepala Perpustakaan',
  photoUnreadable: 'Foto tidak dapat dicetak: berkasnya bukan JPEG RGB atau abu-abu yang utuh.',
  photoMissing: 'Foto belum diunggah.',
  emptyTable: 'Tidak ada baris.',
});

/** The source status of an instrument that is a copy not yet compared with the official text (the shared message). */
export const SOURCE_UNVERIFIED = 'belum diverifikasi dengan teks resmi';

/** The page footer of every document: release, instrument and its source status, period, print date and page. */
export function footerText(o: { version: string; decree: string; status: string | null; period: string; date: string }, page: number, pages: number): string {
  const instrument = o.status === null ? o.decree : `${o.decree} (${o.status})`;
  return `Dibuat ALTIS ${o.version} · ${instrument} · ${o.period} · dicetak ${o.date} · halaman ${page}/${pages}`;
}

/** The page header of the evidence file and the statement: the library and its number. */
export function headerText(library: string, npp: string | null): string {
  return `${library} · ${WORDS.npp} ${npp ?? WORDS.none}`;
}

/** Labels of the cover. */
export const COVER = Object.freeze({
  library: 'Nama perpustakaan',
  school: 'Lembaga induk',
  npp: 'Nomor Pokok Perpustakaan (NPP)',
  instrument: 'Instrumen',
  decree: 'Nomor keputusan',
  source: 'Status sumber',
  sourceVerified: 'teks resmi',
  period: 'Periode',
  span: 'Rentang',
  general: 'Statistik dan Profil Perpustakaan',
});

/** The request letter (filled from the profile) and the submission form. */
export const LETTER = Object.freeze({
  number: 'Nomor',
  attachment: 'Lampiran',
  attachmentValue: '1 (satu) berkas',
  subject: 'Perihal',
  subjectValue: 'Permohonan Akreditasi Perpustakaan',
  to: 'Kepada Yth. Kepala Perpustakaan Nasional Republik Indonesia, u.p. Tim Akreditasi Perpustakaan, di Jakarta',
  greeting: 'Dengan hormat,',
  closing:
    'Demikian permohonan ini kami sampaikan. Atas perhatian dan kerja sama Bapak/Ibu, kami ucapkan terima kasih.',
});

/** The body of the request letter. */
export function letterBody(o: { library: string; school: string; npp: string; instrument: string }): string {
  return (
    `Bersama surat ini kami mengajukan permohonan akreditasi untuk ${o.library} pada ${o.school}, Nomor Pokok ` +
    `Perpustakaan (NPP) ${o.npp}, dengan instrumen ${o.instrument}. Sebagai kelengkapan, kami lampirkan formulir ` +
    'pengajuan, surat pernyataan memiliki koleksi paling sedikit 1.000 judul, salinan NPP, salinan SK pendirian ' +
    'perpustakaan, instrumen yang telah diisi, dan bukti fisik.'
  );
}

/** The fields of the submission form (the instrument's cover data). */
export const FORM = Object.freeze({
  school: 'Nama sekolah',
  schoolHead: 'Kepala sekolah',
  library: 'Nama perpustakaan',
  libraryHead: 'Kepala perpustakaan',
  npp: 'Nomor Pokok Perpustakaan (NPP)',
  street: 'Alamat',
  village: 'Desa/kelurahan',
  district: 'Kecamatan',
  regency: 'Kabupaten/kota',
  province: 'Provinsi',
  postalCode: 'Kode pos',
  phone: 'Telepon',
  website: 'Laman',
  email: 'E-mail',
});

/** The statement of 1 000 titles. */
export function statementBody(o: { role: string; school: string; library: string; count: string; date: string }): string {
  return (
    `Yang bertanda tangan di bawah ini, ${o.role} ${o.school}, menyatakan bahwa ${o.library} memiliki koleksi ` +
    `sebanyak ${o.count} judul per ${o.date}, dihitung dari koleksi yang tercatat di sistem otomasi perpustakaan. ` +
    'Daftar judul koleksi terlampir.'
  );
}

export const STATEMENT = Object.freeze({
  closing: 'Demikian pernyataan ini kami buat dengan sebenarnya untuk dipergunakan sebagaimana mestinya.',
  notComputed: 'Jumlah judul belum dihitung: jalankan Hitung ulang pada ruang kerja akreditasi sebelum mencetak pernyataan ini.',
});

/** The line printed instead of a title list longer than a PDF holds. */
export function titleListTooLong(rows: number, max: number): string {
  return (
    `Daftar judul berisi lebih dari ${max} judul (paling sedikit ${rows}), sehingga tidak dicetak di sini. Ekspor ` +
    'daftar itu tersendiri lewat laporan Daftar Judul (CSV atau XLSX) dengan tanggal per yang sama.'
  );
}

/** The certificate name statement. */
export const CERTIFICATE = Object.freeze({
  intro: 'Kami menyatakan bahwa nama dan alamat perpustakaan yang ditulis pada sertifikat akreditasi adalah sebagai berikut:',
  name: 'Nama perpustakaan pada sertifikat',
  school: 'Lembaga induk',
  address: 'Alamat lengkap',
});

/** The library profile form. */
export const PROFILE = Object.freeze({
  identity: 'Identitas',
  collection: 'Koleksi',
  facilities: 'Sarana',
  services: 'Layanan',
  staff: 'Tenaga perpustakaan',
  budget: 'Anggaran',
  counts: 'Kerja sama dan kegiatan',
  photos: 'Foto',
  signatures: 'Pengesahan',
  npp: 'Nomor Pokok Perpustakaan (NPP)',
  previous: 'Hasil akreditasi sebelumnya',
  status: 'Status',
  founded: 'Tahun berdiri',
  decree: 'SK pendirian',
  school: 'Lembaga induk',
  schoolHead: 'Kepala sekolah',
  parentHead: 'Kepala lembaga induk',
  libraryHead: 'Kepala perpustakaan',
  libraryHeadId: 'NIP/NIK kepala perpustakaan',
  floor: 'Luas ruang (m²)',
  userPcs: 'Komputer untuk pemustaka',
  bandwidth: 'Kecepatan internet (Mbps)',
  hours: 'Jam layanan per minggu',
  members: 'Anggota aktif',
  visitors: 'Pengunjung per bulan',
  reads: 'Bahan dibaca di tempat per bulan',
  loans: 'Bahan dipinjam per bulan',
  divisorSchool: 'Pembagi bulan sekolah',
  divisorOther: 'Pembagi (bulan berdata)',
  population: 'Warga sekolah (siswa, guru, tenaga kependidikan)',
  staffTotal: 'Jumlah tenaga',
  librarians: 'Pustakawan',
  educated: 'Berpendidikan ilmu perpustakaan',
  certified: 'Bersertifikat kompetensi',
  association: 'Anggota asosiasi profesi',
  budgetYear: 'Tahun anggaran',
  budgetLibrary: 'Anggaran perpustakaan per tahun',
  budgetCommunity: 'Sumbangan masyarakat',
  budgetCollection: 'Belanja koleksi',
  budgetParent: 'Anggaran lembaga induk',
  partners: 'Kerja sama',
  innovation: 'Inovasi',
  uniqueness: 'Keunikan',
  awards: 'Penghargaan',
  photoFront: 'Tampak depan perpustakaan',
  photoCollection: 'Ruang koleksi',
  photoStaff: 'Tenaga perpustakaan',
  photoReadingRoom: 'Ruang baca',
});

/** The labels of an indicator sheet. */
export const SHEET = Object.freeze({
  /** "Pelayanan Perpustakaan butir 7". */
  item: (component: string, n: string) => `${component} butir ${n}`,
  value: 'Nilai mentah',
  formula: 'Rumus',
  source: 'Sumber data',
  notes: 'Catatan mutu data',
  evidence: 'Daftar periksa bukti fisik',
  detail: 'Rincian',
  report: 'Laporan',
  screen: 'Layar ALTIS',
  file: 'Berkas',
  // ---- Komunitas K5 (reports) ----
  draft: 'Draf dari laporan ALTIS',
});

/** The source of a value (`basis`), as the sheets print it. */
export const BASIS: Readonly<Record<string, string>> = Object.freeze({
  live: 'data ALTIS',
  migrated: 'data hasil migrasi dari SLiMS',
  imported: 'impor agregat dari SLiMS',
  manual: 'isian manual',
  register: 'register perpustakaan',
  setting: 'isian periode dan pengaturan',
  members: 'data anggota',
  none: 'tidak ada data',
});

/** The unit printed after a value. */
export const UNITS: Readonly<Record<string, string>> = Object.freeze({
  percent: '%',
  mbps: 'Mbps',
  years: 'tahun',
});

/** The outcome of a school standard. */
export const SNP_OUTCOMES: Readonly<Record<string, string>> = Object.freeze({
  pass: 'Memenuhi',
  fail: 'Belum memenuhi',
  reported: 'Dilaporkan',
  not_evaluated: 'Belum dihitung',
  not_available: 'Belum tersedia',
});

export const SNP = Object.freeze({
  intro: 'Kepatuhan pada Standar Nasional Perpustakaan Sekolah/Madrasah untuk standar yang dapat dihitung dari data ALTIS.',
  code: 'Kode',
  standard: 'Standar',
  rule: 'Syarat',
  value: 'Nilai',
  outcome: 'Hasil',
});

/** The annex sections. */
export const ANNEX = Object.freeze({
  staffList: 'Daftar tenaga perpustakaan',
  trainings: 'Pelatihan tenaga perpustakaan',
  ratios: 'Tenaga dan rasio',
  activitiesOf: (kind: string) => `Kegiatan: ${kind}`,
});

/** The internal simulation. */
export const SIM = Object.freeze({
  title: 'Simulasi Penilaian Mandiri',
  prerequisites: 'Prasyarat pendaftaran',
  pass: 'terpenuhi',
  fail: 'belum terpenuhi',
  components: 'Skor per komponen',
  component: 'Komponen',
  sum: 'Skor',
  max: 'Maksimum',
  n: 'Jumlah butir',
  weight: 'Bobot',
  estimate: 'Perkiraan nilai akhir',
  range: 'Rentang perkiraan nilai akhir',
  answered: (answered: number, total: number) => `terjawab ${answered}/${total}`,
  predicate: 'Predikat',
  unanswered: 'Butir yang belum terjawab',
  noneUnanswered: 'Semua butir sudah terjawab.',
  gaps: 'Sepuluh celah terbesar dan tindakan yang disarankan',
  gap: 'Celah',
  action: 'Tindakan',
  missingEvidence: 'Bukti yang belum lengkap per komponen',
  noneMissing: 'Semua butir bukti sudah ada.',
  answers: 'Jawaban manual dan jawaban pengganti',
  noAnswers: 'Belum ada jawaban manual atau jawaban pengganti.',
  item: 'Butir',
  mode: 'Jenis',
  manual: 'manual',
  override: 'pengganti saran',
  answer: 'Jawaban',
  suggestion: 'Saran ALTIS',
  note: 'Catatan',
  notes: 'Semua catatan per butir',
  noNotes: 'Tidak ada catatan.',
  notScored: 'Instrumen ini tidak dinilai; simulasi hanya menampilkan prasyarat pendaftaran.',
  notComputed: 'Hasil belum dihitung: jalankan Hitung ulang pada ruang kerja akreditasi.',
});
