/**
 * The Indonesian catalog: the default language of ALTIS and the source of truth for {@link MessageKey}
 * (decision D29). `en.ts` is typed against these keys, so a message added here without its English text fails `tsc`.
 *
 * Copy rules: plain Indonesian in KBBI spelling, "Anda" capitalized, no jargon where a common word exists
 * ("kata sandi", "cadangan", "pembaruan"). A `{name}` placeholder is replaced by `t()`; both languages must use the
 * same placeholders for a key (i18n.test.ts checks it).
 *
 * Only the strings that the server and the SPA share live here: error codes, permissions, audit actions, roles, mail,
 * the OPAC, the status banners and, from 1c, the op labels (`ops.*`), notifications (`notification.<x>.title|body`),
 * dashboard alerts (`alert.*`) and the maintenance screen; from 1d, the update prechecks (`update.precheck.*`); and
 * the edition names (`edition.*`). The SPA's own screens use `apps/admin/src/i18n/`.
 *
 * No Node built-ins here: the browser bundles this package.
 */
import type { AuditAction } from '../audit-actions.js';
import type { VocabMessageKey } from '../catalog-vocab.js';
import type { ErrorCode } from '../errors.js';
import type { OpKind, OpState } from '../ops.js';
import type { Permission } from '../permissions.js';

/** The keys that exist only in the test profile (spec §12.5, ruling S28), next to `permissionCatalog`'s test entry. */
export interface TestOnlyMessages {
  readonly 'perm.test.branch.manage': string;
  readonly 'perm.module.test': string;
}

const BASE = {
  // ---- error.<CODE>: one per entry of ERROR_CODES ------------------------------------------------------------
  // The wording for AUTH_INVALID_CREDENTIALS and AUTH_TOO_MANY_ATTEMPTS never says whether the account exists.
  'error.INTERNAL': 'Terjadi kesalahan pada server. Silakan coba lagi; jika berulang, hubungi administrator.',
  'error.NOT_INSTALLED': 'ALTIS belum dipasang. Selesaikan pemasangan terlebih dahulu.',
  'error.ALREADY_INSTALLED': 'ALTIS sudah terpasang pada database ini.',
  'error.DB_UNAVAILABLE': 'Database tidak dapat dijangkau saat ini. Silakan coba lagi sebentar lagi.',
  'error.DB_NOT_EMPTY': 'Database tujuan belum kosong. Gunakan database yang kosong.',
  'error.DB_UNSUPPORTED': 'Jenis atau versi database ini tidak didukung.',
  'error.INVALID_CONFIG': 'Konfigurasi tidak valid. Periksa isiannya, lalu coba lagi.',
  'error.INVALID_BASE_URL':
    'Alamat situs (baseUrl) tidak valid. Tulis dalam bentuk http(s)://alamat[:port], tanpa jalur, query, atau fragmen.',
  'error.DOCROOT_EXPOSED':
    'Folder data atau folder aplikasi berada di dalam folder yang dapat dibuka lewat web. Pindahkan ke luar document root.',
  'error.SQLITE_NOT_ALLOWED':
    'SQLite tidak dapat dipakai pada lingkungan hosting ini. Gunakan MySQL, MariaDB, atau PostgreSQL.',
  'error.DISK_QUOTA': 'Ruang penyimpanan atau kuota disk habis. Kosongkan ruang, lalu coba lagi.',
  'error.STATE_CORRUPT': 'Berkas keadaan ALTIS rusak atau tidak dapat dibaca. Hubungi administrator.',
  'error.RELEASE_INVALID': 'Berkas rilis ALTIS tidak valid atau tidak lengkap. Pasang ulang rilis tersebut.',
  'error.SCHEMA_TOO_NEW': 'Database lebih baru daripada versi ALTIS yang berjalan. Pasang versi ALTIS yang lebih baru.',
  'error.UNIQUE_VIOLATION': 'Data dengan nilai yang sama sudah ada.',
  'error.INVALID_PATH_SEGMENT': 'Nama berkas atau folder tidak valid.',
  'error.SCHEMA_CONFLICT': 'Struktur database tidak sesuai dengan yang diharapkan ALTIS. Hubungi administrator.',
  'error.TX_CONFLICT': 'Perubahan ini bertabrakan dengan proses lain. Silakan coba lagi.',
  'error.NOT_FOUND': 'Data atau halaman yang diminta tidak ditemukan.',
  'error.AUTH_REQUIRED': 'Silakan masuk terlebih dahulu.',
  'error.AUTH_INVALID_CREDENTIALS': 'Nama pengguna atau kata sandi salah.',
  'error.AUTH_TOO_MANY_ATTEMPTS': 'Terlalu banyak percobaan. Tunggu beberapa saat, lalu coba lagi.',
  'error.AUTH_BUSY': 'Server sedang sibuk memeriksa kata sandi. Silakan coba lagi sebentar lagi.',
  'error.AUTH_MFA_REQUIRED': 'Masukkan kode dari aplikasi autentikator Anda untuk melanjutkan.',
  'error.AUTH_MFA_INVALID': 'Kode salah, sudah dipakai, atau sudah kedaluwarsa. Coba kode yang baru.',
  'error.AUTH_REAUTH_REQUIRED': 'Untuk keamanan, konfirmasi dulu kata sandi Anda.',
  'error.AUTH_PASSWORD_CHANGE_REQUIRED': 'Anda harus mengganti kata sandi sebelum melanjutkan.',
  'error.AUTH_ACCOUNT_DISABLED': 'Akun ini tidak aktif. Hubungi administrator.',
  'error.AUTH_RESET_TOKEN_INVALID':
    'Tautan atur ulang kata sandi tidak valid, sudah kedaluwarsa, atau sudah dipakai. Minta tautan yang baru.',
  'error.PASSWORD_TOO_WEAK': 'Kata sandi belum memenuhi syarat. Pakai kata sandi yang lebih panjang dan tidak umum dipakai.',
  'error.MFA_ALREADY_ENABLED': 'Autentikasi dua langkah sudah aktif.',
  'error.MFA_NOT_ENABLED': 'Autentikasi dua langkah belum diaktifkan.',
  'error.MFA_REQUIRED_BY_POLICY': 'Autentikasi dua langkah diwajibkan untuk peran Anda, jadi tidak dapat dimatikan.',
  'error.AUTHZ_DENIED': 'Anda tidak memiliki izin untuk melakukan ini.',
  'error.AUTHZ_ESCALATION': 'Perubahan ditolak karena melebihi hak akses Anda sendiri.',
  'error.LAST_SUPER_ADMIN': 'Harus tersisa sedikitnya satu Super Admin yang aktif.',
  'error.ROLE_SYSTEM_READONLY': 'Peran sistem (Super Admin dan Admin) tidak dapat diubah atau dihapus.',
  'error.ROLE_IN_USE': 'Peran ini masih dipakai pengguna. Lepaskan dulu peran ini dari para penggunanya.',
  'error.ROLE_SCOPE_INVALID':
    'Cakupan izin tidak sesuai: izin global tidak dapat diberikan per cabang, begitu juga sebaliknya.',
  'error.BRANCH_DEFAULT_ARCHIVE': 'Cabang default tidak dapat diarsipkan.',
  'error.CSRF_INVALID': 'Permintaan ditolak karena token keamanannya tidak cocok. Muat ulang halaman, lalu coba lagi.',
  'error.ORIGIN_DENIED': 'Permintaan ditolak karena berasal dari alamat yang tidak dikenal. Buka ALTIS lewat alamat situs yang resmi.',
  'error.VALIDATION_FAILED': 'Isian belum benar. Periksa kolom yang ditandai.',
  'error.INVALID_JSON': 'Data yang dikirim tidak dapat dibaca.',
  'error.PAYLOAD_TOO_LARGE': 'Data yang dikirim terlalu besar.',
  'error.UNSUPPORTED_MEDIA_TYPE': 'Jenis data yang dikirim tidak didukung.',
  'error.CONFLICT_STALE': 'Data ini sudah diubah oleh orang lain. Muat ulang, lalu coba lagi.',
  'error.IDEMPOTENCY_KEY_INVALID': 'Kunci pencegah pengiriman ganda (Idempotency-Key) tidak valid.',
  'error.IDEMPOTENCY_IN_PROGRESS': 'Permintaan yang sama sedang diproses. Tunggu sebentar, lalu periksa hasilnya.',
  'error.IDEMPOTENCY_KEY_REUSED': 'Kunci pencegah pengiriman ganda ini sudah dipakai untuk permintaan yang berbeda.',
  'error.CONFIG_LOCKED_BY_ENV': 'Pengaturan ini dikunci oleh variabel lingkungan sehingga tidak dapat diubah dari sini.',
  'error.TRUST_PROXY_INVALID':
    'Jumlah proxy tepercaya (trustProxy.hops) tidak cocok dengan cara permintaan ini sampai ke server.',
  'error.SMTP_NOT_CONFIGURED': 'Pengiriman email belum diatur. Isi pengaturan SMTP terlebih dahulu.',
  'error.SMTP_FAILED': 'Email tidak dapat dikirim. Periksa pengaturan SMTP, lalu coba lagi.',
  'error.SECRET_UNREADABLE': 'Data rahasia yang tersimpan tidak dapat dibaca. Hubungi administrator.',
  'error.ADMIN_UNAVAILABLE': 'Antarmuka admin belum tersedia karena belum dibangun.',
  'error.AUDIT_MISSING':
    'Terjadi kesalahan internal: aksi ini tidak tercatat dalam catatan audit. Hubungi administrator.',
  // 1c
  'error.OPS_IN_PROGRESS': 'Operasi sistem lain sedang berjalan. Tunggu sampai selesai, lalu coba lagi.',
  'error.OPS_BLOCKED_BY_BACKUP': 'Sedang ada pencadangan yang panjang. Tunggu sampai selesai sebelum memulai operasi ini.',
  'error.OPS_NONE': 'Tidak ada operasi sistem yang sedang berjalan.',
  'error.OPS_POINT_OF_NO_RETURN': 'Operasi ini sudah melewati titik tanpa kembali, sehingga tidak dapat dibatalkan lagi.',
  'error.OPS_FREEZE_TIMEOUT':
    'Sistem belum dapat dihentikan sementara karena masih ada tugas yang berjalan. Operasi dibatalkan; coba lagi beberapa saat lagi.',
  'error.OPS_FREEZE_BROKEN':
    'Pemeliharaan dimatikan saat operasi ini berjalan, sehingga data sempat berubah. Operasi dibatalkan tanpa mengubah data; mulai lagi.',
  'error.OPS_AUTH_REQUIRED':
    'Halaman operasi ini hanya dapat dibuka oleh staf berizin yang sudah masuk, atau dari peramban yang memulai operasi.',
  'error.MAINTENANCE': 'ALTIS sedang dalam pemeliharaan. Silakan coba lagi beberapa saat lagi.',
  'error.JOB_NOT_RETRYABLE': 'Tugas ini tidak dapat diulang dalam keadaannya sekarang.',
  'error.JOB_NOT_CANCELLABLE': 'Tugas ini sudah selesai sehingga tidak dapat dibatalkan.',
  'error.JOB_LEASE_LOST': 'Tugas ini sudah diambil alih proses lain, jadi pekerjaan ini dihentikan.',
  'error.CRON_TOKEN_INVALID': 'Token cron tidak valid.',
  'error.EVENTS_CURSOR_EXPIRED': 'Penanda pembaruan sudah kedaluwarsa. Muat ulang data, lalu mulai lagi.',
  'error.REALTIME_SSE_DISABLED':
    'Pembaruan langsung (SSE) sedang dimatikan di server ini. Aplikasi memeriksa pembaruan secara berkala.',
  'error.REALTIME_PROBE_REQUIRED':
    'Uji koneksi langsung belum lolos. Jalankan uji peramban di halaman Diagnostik sebelum mengaktifkan SSE.',
  'error.UPLOAD_LIMIT':
    'Terlalu banyak unggahan yang belum selesai. Selesaikan atau batalkan salah satunya, lalu coba lagi.',
  'error.UPLOAD_TOO_LARGE': 'Berkas melebihi ukuran maksimum yang diizinkan.',
  'error.UPLOAD_CHUNK_INVALID':
    'Potongan berkas ditolak karena urutan atau ukurannya tidak sesuai. Ulangi unggahan dari awal.',
  'error.UPLOAD_INCOMPLETE': 'Unggahan belum lengkap. Kirim dulu semua potongan berkas.',
  'error.UPLOAD_MISMATCH':
    'Isi berkas tidak cocok dengan ukuran atau kode periksa (SHA-256) yang dinyatakan. Unggah ulang berkasnya.',
  'error.UPLOAD_TYPE_REFUSED': 'Jenis berkas ini tidak diizinkan.',
  'error.UPLOAD_EXPIRED': 'Sesi unggahan sudah kedaluwarsa. Mulai unggahan yang baru.',
  'error.METHOD_OVERRIDE_DENIED': 'Penggantian metode permintaan tidak diizinkan untuk permintaan ini.',
  'error.BACKUP_NOT_READY':
    'Cadangan atau unduhan ini belum siap. Tunggu sampai selesai, atau siapkan unduhannya terlebih dahulu.',
  'error.BACKUP_INVALID': 'Berkas cadangan tidak valid atau rusak.',
  'error.BACKUP_SCHEMA_TOO_NEW':
    'Cadangan ini dibuat oleh ALTIS yang lebih baru daripada versi yang berjalan. Pasang versi ALTIS yang lebih baru untuk memulihkannya.',
  'error.BACKUP_PASSPHRASE_REQUIRED': 'Cadangan ini dienkripsi. Masukkan frasa sandinya.',
  'error.BACKUP_PASSPHRASE_INVALID': 'Frasa sandi cadangan salah.',
  'error.BACKUP_CONFIRM_REQUIRED':
    'Cadangan ini berasal dari pemasangan ALTIS lain. Ketik nama perpustakaan untuk memastikan data yang ada boleh diganti.',
  'error.RESTORE_CONFLICTS':
    'Pemulihan dihentikan karena sebagian data cadangan tidak dapat dimuat ke database ini. Unduh laporan konflik untuk melihat rinciannya.',
  'error.INSTALL_CLAIM_REQUIRED': 'Masukkan kode pemasangan terlebih dahulu.',
  'error.INSTALL_CODE_INVALID': 'Kode pemasangan salah atau sudah kedaluwarsa.',
  'error.INSTALL_STEP_ORDER': 'Langkah pemasangan ini belum dapat dilakukan. Selesaikan dulu langkah sebelumnya.',
  'error.INSTALL_EXPOSED':
    'Folder data atau folder aplikasi ternyata dapat dibuka lewat web, sehingga pemasangan diblokir. Pindahkan ke luar document root, lalu ulangi.',
  'error.CRON_NOT_DETECTED': 'Cron belum terdeteksi berjalan. Atur cron sesuai petunjuk, tunggu sebentar, lalu coba lagi.',
  'error.DATA_VOLUME_MISSING':
    'Folder data ALTIS tidak ditemukan; volume Docker kemungkinan belum terpasang. Pasang volume data yang benar, lalu mulai ulang ALTIS.',
  'error.DATA_DIR_MISMATCH':
    'Folder data tidak cocok dengan pemasangan ini. Arahkan ALTIS ke folder data yang benar, lalu mulai ulang.',
  'error.RANGE_NOT_SATISFIABLE': 'Rentang byte yang diminta berada di luar ukuran berkas.',
  'error.JOB_NOT_INTERACTIVE': 'Tugas ini berjalan otomatis di latar belakang dan tidak dapat dijalankan dari halaman ini.',
  'error.BACKUP_PREPARE_IN_PROGRESS':
    'Unduhan cadangan ini masih disiapkan dengan pilihan lain. Tunggu sampai selesai atau batalkan, lalu siapkan lagi.',
  // 1d: no placeholders (problem+json carries none); a code's reason never changes its message.
  'error.UPDATE_NONE': 'Versi ini tidak tersedia sebagai pembaruan. Periksa pembaruan lagi.',
  'error.UPDATE_NOT_ENTITLED': 'Rilis ini tidak tercakup edisi ini.',
  'error.UPDATE_PRECHECK_FAILED':
    'Pembaruan belum dapat dipasang karena pemeriksaan awal tidak lolos. Lihat rinciannya di halaman Pembaruan.',
  'error.UPDATE_PACKAGE_INVALID':
    'Paket pembaruan ditolak karena rusak, tanda tangannya tidak sah, atau isinya tidak sesuai. Unduh atau unggah ulang paket yang resmi.',
  'error.UPDATE_DOWNLOAD_FAILED':
    'Paket pembaruan tidak dapat diunduh dari server pembaruan. Coba lagi nanti, atau unggah paketnya secara manual.',
  'error.UPDATE_HIDDEN':
    'Pembaruan satu klik tidak tersedia pada image Docker. Perbarui dengan menarik image yang baru (docker compose pull, lalu docker compose up -d).',
  'error.UPDATE_SCHEMA_HOLD_FAILED':
    'Pembaruan database untuk versi ini gagal, jadi ALTIS tetap dalam pemeliharaan. Jalankan lagi versi sebelumnya, lalu pulihkan cadangan yang dibuat sebelum pembaruan.',
  'error.UPDATE_BOOT_FAILED': 'Versi baru gagal dijalankan, sehingga ALTIS kembali memakai versi sebelumnya.',
  'error.UPDATE_CHECK_THROTTLED': 'Pembaruan baru saja diperiksa. Tunggu sebentar, lalu periksa lagi.',
  'error.FEED_INVALID':
    'Daftar rilis dari server pembaruan tidak sah atau sudah kedaluwarsa, jadi tidak dipakai. Coba lagi nanti.',
  'error.FEED_UNREACHABLE':
    'Server pembaruan tidak dapat dihubungi. Periksa koneksi internet server, atau unggah paket pembaruan secara manual.',
  'error.ROLLBACK_UNAVAILABLE':
    'Tidak dapat kembali ke versi sebelumnya: versi itu tidak ada, tidak cocok dengan database sekarang, berkasnya sudah hilang, atau versi baru masih sedang dijalankan.',
  'error.RELEASE_PENDING':
    'Versi baru ALTIS sedang dijalankan atau sedang memperbarui database. Tunggu sampai selesai, lalu coba lagi.',

  // ---- perm.<permission>: one per catalog key, then the module labels ----------------------------------------
  'perm.system.settings.read': 'Melihat pengaturan',
  'perm.system.settings.manage': 'Mengelola pengaturan',
  'perm.system.config.manage': 'Mengelola konfigurasi sistem',
  'perm.system.users.read': 'Melihat pengguna',
  'perm.system.users.manage': 'Mengelola pengguna',
  'perm.system.roles.manage': 'Mengelola peran',
  'perm.system.branches.manage': 'Mengelola cabang',
  'perm.system.audit.read': 'Melihat catatan audit',
  'perm.system.audit.export': 'Mengekspor catatan audit',
  'perm.system.jobs.read': 'Melihat tugas latar belakang',
  'perm.system.jobs.manage': 'Mengelola tugas latar belakang',
  'perm.system.backup.read': 'Melihat cadangan',
  'perm.system.backup.create': 'Membuat cadangan',
  'perm.system.backup.download': 'Mengunduh cadangan',
  'perm.system.backup.restore': 'Memulihkan cadangan',
  'perm.system.update.read': 'Melihat pembaruan',
  'perm.system.update.run': 'Menjalankan pembaruan',
  'perm.system.diagnostics.read': 'Melihat diagnostik',
  'perm.system.diagnostics.manage': 'Mengelola diagnostik',
  'perm.module.system': 'Sistem',

  // ---- audit.<action>: one per entry of AUDIT_ACTIONS --------------------------------------------------------
  'audit.auth.login.success': 'Berhasil masuk',
  'audit.auth.login.failed': 'Gagal masuk',
  'audit.auth.logout': 'Keluar',
  'audit.auth.remember.reuse': 'Token ingat saya dipakai ulang (semua token pengguna dicabut)',
  'audit.auth.2fa.enable': 'Mengaktifkan autentikasi dua langkah (2FA)',
  'audit.auth.2fa.disable': 'Menonaktifkan autentikasi dua langkah (2FA)',
  'audit.auth.2fa.recovery_codes': 'Membuat kode cadangan 2FA yang baru',
  'audit.auth.password.change': 'Mengganti kata sandi',
  'audit.auth.password.reset': 'Mengatur ulang kata sandi lewat tautan email',
  'audit.auth.profile.update': 'Memperbarui profil',
  'audit.auth.session.revoke': 'Mencabut sesi',
  'audit.authz.denied': 'Akses ditolak',
  'audit.users.create': 'Membuat pengguna',
  'audit.users.update': 'Mengubah data pengguna',
  'audit.users.disable': 'Menonaktifkan pengguna',
  'audit.users.enable': 'Mengaktifkan pengguna',
  'audit.users.password.reset': 'Mengatur ulang kata sandi pengguna',
  'audit.users.2fa.reset': 'Mengatur ulang 2FA pengguna',
  'audit.users.roles.update': 'Mengubah peran pengguna',
  'audit.roles.create': 'Membuat peran',
  'audit.roles.update': 'Mengubah peran',
  'audit.roles.delete': 'Menghapus peran',
  'audit.branches.create': 'Membuat cabang',
  'audit.branches.update': 'Mengubah cabang',
  'audit.branches.archive': 'Mengarsipkan cabang',
  'audit.settings.update': 'Mengubah pengaturan',
  'audit.system.config.update': 'Mengubah konfigurasi sistem',
  'audit.system.config.email_test': 'Mengirim email uji',
  'audit.system.config.cron_token_rotate': 'Mengganti token cron',
  'audit.audit.export': 'Mengekspor catatan audit',
  // 1c
  'audit.backup.create': 'Membuat cadangan',
  'audit.backup.download': 'Menyiapkan unduhan cadangan',
  'audit.backup.upload': 'Mengunggah berkas cadangan',
  'audit.backup.restore': 'Memulihkan data dari cadangan',
  'audit.jobs.retry': 'Mengulang tugas latar belakang',
  'audit.jobs.cancel': 'Membatalkan tugas latar belakang',
  'audit.schedules.update': 'Mengubah jadwal tugas',
  'audit.ops.cancel': 'Membatalkan operasi sistem',
  'audit.ops.takeover': 'Mengambil alih operasi sistem',
  'audit.diagnostics.clock_confirm': 'Mengonfirmasi bahwa jam server sudah benar',
  'audit.diagnostics.realtime': 'Mengubah pengaturan pembaruan langsung (SSE)',
  'audit.diagnostics.probe_result': 'Menyimpan hasil uji peramban',
  'audit.maintenance.on': 'Menyalakan mode pemeliharaan',
  'audit.maintenance.off': 'Mematikan mode pemeliharaan',
  'audit.system.secrets_rotate': 'Memutar kunci penyimpanan data rahasia',
  'audit.install.complete': 'Menyelesaikan pemasangan ALTIS',
  'audit.install.reset': 'Mengatur ulang pemasangan ALTIS',
  'audit.audit.purge': 'Menghapus catatan audit yang sudah lewat masa simpan',
  // 1d
  'audit.update.apply': 'Menjalankan pembaruan ALTIS',
  'audit.update.rollback': 'Kembali ke versi ALTIS sebelumnya',
  'audit.update.upload': 'Mengunggah paket pembaruan',
  'audit.update.channel': 'Mengganti kanal pembaruan',
  'audit.release.unpin': 'Melepas pin versi rilis, sehingga versi itu boleh dipasang lagi',

  // ---- role.<key>: the two system roles (their names are fixed, decision D5) ---------------------------------
  'role.super_admin': 'Super Admin',
  'role.admin': 'Admin',

  // ---- mail: plain text only (decision D17) ------------------------------------------------------------------
  // The subject is one line: the caller strips CR/LF from the values it substitutes into it.
  'mail.password_reset.subject': 'Atur ulang kata sandi Anda di {library}',
  'mail.password_reset.body': [
    'Halo {name},',
    '',
    'Kami menerima permintaan untuk mengatur ulang kata sandi akun "{username}" di {library}.',
    '',
    'Buka tautan berikut untuk membuat kata sandi yang baru. Tautan ini berlaku {minutes} menit dan hanya dapat dipakai satu kali:',
    '',
    '{link}',
    '',
    'Jika Anda tidak meminta ini, abaikan saja email ini. Kata sandi Anda tidak berubah.',
    '',
    'Salam,',
    '{library}',
  ].join('\n'),
  'mail.email_test.subject': 'Email uji dari {library}',
  'mail.email_test.body': [
    'Ini adalah email uji dari ALTIS untuk {library}.',
    '',
    'Jika Anda dapat membacanya, pengiriman email (SMTP) sudah berfungsi. Anda tidak perlu membalas pesan ini.',
  ].join('\n'),

  // ---- opac: the temporary public pages of Phase 1b ----------------------------------------------------------
  'opac.home.title': 'Katalog',
  'opac.home.coming_soon':
    'Pencarian katalog daring akan segera tersedia. Sementara itu, silakan berkunjung ke perpustakaan kami.',
  'opac.home.staff_login': 'Masuk untuk staf',
  'opac.lang.switch': 'Pilih bahasa',
  'opac.not_found.title': 'Halaman tidak ditemukan',
  'opac.not_found.body': 'Halaman yang Anda cari tidak ada atau sudah dipindahkan. Kembali ke beranda untuk melanjutkan.',
  'opac.error.title': 'Terjadi kesalahan',
  'opac.error.body':
    'Maaf, ada gangguan di sisi kami. Silakan coba lagi nanti. Jika masalah berlanjut, sebutkan kode {code} kepada petugas perpustakaan.',
  'opac.maintenance.title': 'Sedang dalam pemeliharaan',
  'opac.maintenance.body': 'Layanan sedang dipelihara sebentar. Silakan kembali beberapa saat lagi.',
  // 1c Task 19: on the maintenance page of a path under /admin (the admin itself is closed during maintenance).
  'opac.maintenance.update_link': 'Ikuti kemajuan operasi sistem',

  // ---- banner: the status banners of the admin shell (§13, decision D32); no params --------------------------
  'banner.maintenance': 'ALTIS sedang dalam pemeliharaan. Sebagian fitur mungkin tidak tersedia untuk sementara.',
  'banner.clock':
    'Jam server tampak bergeser dari waktu yang sebenarnya. Periksa jam server atau konfirmasi di halaman Diagnostik.',

  // ---- ops: the exclusive operations of 1c (spec §9.4) and the page that follows them -------------------------
  'ops.kind.install-migrate': 'Pemasangan: menyiapkan database',
  'ops.kind.update': 'Pembaruan',
  'ops.kind.rollback': 'Kembali ke versi sebelumnya',
  'ops.kind.restore': 'Pemulihan dari cadangan',
  'ops.kind.backup': 'Pencadangan',
  'ops.kind.migrate': 'Migrasi database',
  'ops.kind.reset': 'Pengaturan ulang pemasangan',
  'ops.state.checking': 'Memeriksa pembaruan',
  'ops.state.downloading': 'Mengunduh',
  'ops.state.verified': 'Terverifikasi',
  'ops.state.frozen': 'Sistem dihentikan sementara',
  'ops.state.backed_up': 'Cadangan pengaman selesai',
  'ops.state.staged': 'Versi baru disiapkan',
  'ops.state.switched': 'Beralih ke versi baru',
  'ops.state.booting': 'Memulai versi baru',
  'ops.state.migrating': 'Memperbarui struktur database',
  'ops.state.verifying': 'Memverifikasi',
  'ops.state.done': 'Selesai',
  'ops.state.aborted': 'Dibatalkan',
  'ops.state.reverting': 'Mengembalikan versi sebelumnya',
  'ops.state.rolled_back': 'Dikembalikan ke versi sebelumnya',
  'ops.state.restoring': 'Memulihkan data dari cadangan',
  'ops.state.restored': 'Data dipulihkan',
  'ops.state.restore_failed': 'Pemulihan data gagal',
  'ops.state.prechecked': 'Pemeriksaan awal lolos',
  'ops.state.pre_restore': 'Membuat cadangan pengaman',
  'ops.state.preserving': 'Menyimpan data yang dipertahankan',
  'ops.state.loading': 'Memuat data cadangan',
  'ops.state.finalizing': 'Menyelesaikan',
  'ops.state.failed_restoring_pre': 'Gagal; mengembalikan data semula',
  'ops.state.failed': 'Gagal',
  'ops.state.exporting': 'Mengekspor data',
  'ops.state.running': 'Berjalan',
  'ops.state.needs_attention': 'Perlu ditangani',
  'ops.page.title': 'Operasi sistem',
  'ops.page.none': 'Tidak ada operasi sistem yang sedang berjalan.',
  'ops.page.drive_hint':
    'Biarkan halaman ini tetap terbuka agar operasi terus berjalan. Bila ditutup, operasi tetap dilanjutkan oleh cron atau pekerja latar belakang, atau saat halaman ini dibuka lagi.',
  'ops.page.cancel': 'Batalkan operasi',
  'ops.page.takeover': 'Ambil alih operasi',
  'ops.page.resume': 'Lanjutkan operasi',
  'ops.page.cli_hint':
    'Bila halaman ini tidak dapat dibuka, jalankan "node app.js jobs:run" di server untuk melanjutkan operasi.',
  // 1c Task 19: the rest of the operations page /admin/_update, and its 401 page during a restore.
  'ops.page.kind': 'Jenis operasi',
  'ops.page.state': 'Tahap',
  'ops.page.progress': 'Kemajuan',
  'ops.page.error': 'Kesalahan',
  'ops.page.report': 'Unduh laporan',
  'ops.page.cancel_confirm': 'Batalkan operasi ini? Operasi dihentikan dan data tetap seperti sebelum operasi dimulai.',
  'ops.page.cli_steps': 'Operasi ini perlu ditangani langsung di server. Jalankan perintah berikut dari folder aplikasi ALTIS:',
  'ops.page.done': 'Operasi selesai. Anda akan dibawa kembali ke halaman admin dalam 3 detik.',
  'ops.page.back': 'Kembali ke halaman admin',
  'ops.page.retrying': 'Koneksi ke server terputus. Mencoba lagi…',
  'ops.page.lost': 'Halaman ini tidak dapat lagi mengikuti operasi. Muat ulang halaman, atau masuk kembali sebagai administrator.',
  'ops.page.no_script': 'Aktifkan JavaScript agar halaman ini dapat memantau dan menjalankan operasi.',
  'ops.page.browser_only.title': 'Operasi hanya dapat diikuti dari peramban yang memulai atau mengambil alihnya',
  'ops.page.browser_only.body':
    'Selama data dipulihkan atau database diubah, ALTIS tidak memeriksa sesi masuk. Buka halaman ini di peramban yang memulai atau mengambil alih operasi, atau tunggu sampai langkah ini selesai, lalu masuk kembali. Di server, log mencatat apa yang terjadi, dan node app.js ops:resume melanjutkan operasi yang perlu perhatian.',
  // 1c Task 19, ruling R1c-9: the page's own re-authentication (cancel, takeover) and its sign-in link.
  'ops.page.sign_in': 'Masuk untuk membatalkan atau mengambil alih',
  'ops.page.reauth.title': 'Konfirmasi kata sandi',
  'ops.page.reauth.body': 'Membatalkan atau mengambil alih operasi memerlukan konfirmasi kata sandi Anda.',
  'ops.page.reauth.password': 'Kata sandi',
  'ops.page.reauth.code': 'Kode autentikator (6 angka)',
  'ops.page.reauth.submit': 'Konfirmasi',
  'ops.page.reauth.dismiss': 'Tutup',
  'ops.page.reauth.password_missing': 'Isi kata sandi Anda.',
  'ops.page.reauth.code_invalid': 'Kode autentikator terdiri atas 6 angka.',
  'ops.page.reauth.wrong_password': 'Kata sandi salah.',
  // 1d: a failed schemaHold update (§9.8 row 3) names the `pre_update` backup; the update's precheck label.
  'ops.page.schema_hold':
    'Pembaruan database untuk versi ini gagal, jadi ALTIS tetap dalam pemeliharaan. Jalankan lagi image Docker atau berkas zip versi sebelumnya, lalu pulihkan cadangan {backupId} yang dibuat sebelum pembaruan.',
  'ops.page.db_restore_needed': 'Pemulihan database diperlukan bila pembaruan ini gagal.',
  // 1d Task 29: the operations page without an op names a bundled release whose prechecks failed (§9.8 row 2).
  'ops.page.bundled_blocked': 'Rilis {version} di folder aplikasi tidak dipasang karena tidak lolos pra-cek:',

  // ---- notification.<x>.title / .body: the body key is the title key with .title replaced by .body (M44) -------
  'notification.backup_done.title': 'Cadangan selesai',
  'notification.backup_done.body': 'Cadangan {name} berhasil dibuat dan siap dipakai.',
  'notification.backup_failed.title': 'Cadangan gagal',
  'notification.backup_failed.body':
    'Cadangan {name} gagal dibuat. Periksa halaman Cadangan atau Diagnostik untuk penyebabnya.',
  'notification.backup_skipped.title': 'Cadangan terjadwal dilewati',
  'notification.backup_skipped.body':
    'Cadangan terjadwal dilewati karena diperkirakan memakan waktu terlalu lama tanpa cron. Pasang cron, atau buat cadangan manual dari halaman Cadangan.',
  'notification.restore_done.title': 'Pemulihan selesai',
  'notification.restore_done.body':
    'Data berhasil dipulihkan dari cadangan {name}. Semua sesi masuk diatur ulang, jadi masuk kembali bila diminta.',
  'notification.restore_failed.title': 'Pemulihan gagal',
  'notification.restore_failed.body':
    'Pemulihan dari cadangan {name} gagal. Bila data sempat berubah, ALTIS mengembalikannya ke keadaan sebelum pemulihan. Periksa halaman Cadangan untuk rinciannya.',
  'notification.job_dead.title': 'Tugas latar belakang gagal',
  'notification.job_dead.body':
    'Tugas {name} gagal berulang kali dan dihentikan. Buka halaman Tugas dan Jadwal untuk melihat penyebabnya atau mengulanginya.',
  'notification.disk_low.title': 'Ruang penyimpanan hampir habis',
  'notification.disk_low.body':
    'Ruang penyimpanan atau kuota disk hampir habis, sehingga cadangan dan unggahan bisa gagal. Kosongkan ruang atau tambah kuota.',
  'notification.clock_anomaly.title': 'Jam server tampak bergeser',
  'notification.clock_anomaly.body':
    'Jam server tampak mundur atau melompat. Jadwal dihitung ulang dan pembersihan data lama dijeda. Periksa jam server, lalu konfirmasi di halaman Diagnostik.',
  'notification.exposure_failed.title': 'Berkas ALTIS dapat dibuka lewat web',
  'notification.exposure_failed.body':
    'Berkas yang seharusnya tertutup dapat diambil lewat web, misalnya {url}. Pindahkan folder data dan folder aplikasi ke luar document root.',
  'notification.ops_attention.title': 'Operasi sistem perlu ditangani',
  'notification.ops_attention.body':
    'Operasi {name} berhenti bergerak lebih dari 15 menit. Buka halaman operasi untuk melanjutkan, mengambil alih, atau membatalkannya.',
  'notification.audit_broken.title': 'Catatan audit tidak utuh',
  'notification.audit_broken.body':
    'Rantai catatan audit terputus di entri nomor {seq}: ada entri yang diubah atau hilang. Segera periksa halaman Log audit.',
  'notification.update_available.title': 'Pembaruan tersedia',
  'notification.update_available.body': 'ALTIS versi {version} sudah tersedia. Buka halaman Pembaruan untuk memasangnya.',
  // 1d. `{version}`: the release the update (or the bundled release) aimed at; for update_rolled_back, the version
  // left behind (a reverted update's target, or the version a manual rollback left).
  'notification.update_done.title': 'Pembaruan selesai',
  'notification.update_done.body': 'ALTIS sudah diperbarui ke versi {version}.',
  'notification.update_failed.title': 'Pembaruan gagal',
  'notification.update_failed.body':
    'Pembaruan ke versi {version} gagal dan dibatalkan sebelum ada yang berubah. ALTIS tetap berjalan pada versi sekarang. Buka halaman Pembaruan untuk melihat penyebabnya.',
  'notification.update_rolled_back.title': 'Kembali ke versi sebelumnya',
  'notification.update_rolled_back.body':
    'ALTIS kembali ke versi sebelumnya dan meninggalkan versi {version}. Data tetap utuh. Buka halaman Pembaruan untuk rinciannya.',
  'notification.update_restored.title': 'Pembaruan gagal, data dipulihkan',
  'notification.update_restored.body':
    'Pembaruan ke versi {version} gagal. ALTIS kembali ke versi sebelumnya dan memulihkan database dari cadangan yang dibuat sebelum pembaruan.',
  'notification.update_restore_failed.title': 'Pemulihan setelah pembaruan gagal',
  'notification.update_restore_failed.body':
    'Pembaruan ke versi {version} gagal dan database tidak dapat dipulihkan secara otomatis. ALTIS tetap dalam pemeliharaan; buka halaman operasi sistem untuk langkah pemulihannya.',
  'notification.update_blocked.title': 'Rilis baru tidak dipasang',
  'notification.update_blocked.body':
    'Rilis {version} yang ada di server tidak lolos pemeriksaan awal, jadi tidak dipasang dan ALTIS tetap berjalan pada versi sekarang. Buka halaman Pembaruan untuk melihat alasannya.',

  // ---- alert: the dashboard alerts of 1c (decision C33); no placeholders ---------------------------------------
  'alert.runner_stale':
    'Belum ada pekerja latar belakang atau cron yang berjalan akhir-akhir ini, jadi tugas terjadwal dan cadangan otomatis tidak berjalan. Atur cron di halaman Diagnostik.',
  'alert.clock_anomaly':
    'Jam server tampak bergeser. Pembersihan data lama dijeda sampai jam dikonfirmasi di halaman Diagnostik.',
  'alert.exposure_failed':
    'Berkas di folder data atau folder aplikasi dapat diambil lewat web. Pindahkan folder tersebut ke luar document root.',
  'alert.backup_missing': 'Belum ada cadangan yang berhasil dalam beberapa hari terakhir.',
  'alert.backup_failed': 'Cadangan terakhir gagal dibuat. Periksa halaman Cadangan.',
  'alert.jobs_dead': 'Ada tugas latar belakang yang gagal dan dihentikan. Periksa halaman Tugas dan Jadwal.',
  'alert.disk_low': 'Ruang penyimpanan hampir habis. Kosongkan ruang agar cadangan dan unggahan tidak gagal.',
  'alert.ops_attention': 'Ada operasi sistem yang berhenti dan perlu ditangani. Buka halaman operasi untuk melanjutkannya.',
  'alert.ip_trust':
    'Alamat IP pengunjung tidak dapat dipercaya karena pengaturan proxy tampak keliru, sehingga pembatasan per alamat IP kurang akurat. Periksa halaman Diagnostik.',
  'alert.audit_broken': 'Catatan audit tidak utuh: ada entri yang berubah atau hilang. Periksa halaman Log audit.',
  // 1d: the alert kinds Task 29 adds to ALERT_KINDS.
  'alert.keyset_full':
    'Berkas kunci rilis (keyset) sudah penuh, sehingga dokumen kunci yang baru ditolak. Periksa halaman Diagnostik.',
  'alert.update_blocked':
    'Rilis baru yang ada di server tidak lolos pemeriksaan awal dan tidak dipasang. Buka halaman Pembaruan untuk melihat alasannya.',
  'alert.bundled_ignored':
    'Rilis yang ada di folder aplikasi tidak dipasang: versinya tidak lebih baru, sudah pernah gagal, atau sengaja ditahan. Lihat halaman Pembaruan.',
  'alert.schema_hold':
    'Versi baru menunggu pembaruan database dan ALTIS dalam pemeliharaan. Buka halaman operasi sistem untuk mengikuti atau menanganinya.',

  // ---- update.precheck: the prechecks of an update (§9.6 step 2), one per UPDATE_PRECHECK_FAILED reason, then the
  // entitlement and the notes the Pembaruan screen shows beside them -------------------------------------------
  'update.precheck.not_newer': 'Versi ini tidak lebih baru daripada versi yang sedang berjalan.',
  'update.precheck.min_upgrade_from':
    'Versi yang berjalan terlalu lama untuk langsung diperbarui ke versi ini. Pasang dulu rilis batu loncatan yang disebutkan.',
  'update.precheck.boot_protocol':
    'Versi ini memerlukan app.js yang lebih baru. Pasang secara manual: ganti berkas aplikasi dengan zip lengkapnya, seperti saat pemasangan pertama.',
  'update.precheck.min_node': 'Versi Node.js di server terlalu lama untuk versi ini.',
  'update.precheck.min_db': 'Versi database terlalu lama untuk versi ini.',
  'update.precheck.snapshot_backup': 'Sedang ada pencadangan yang berjalan. Tunggu sampai selesai.',
  'update.precheck.entitlement': 'Rilis ini tidak tercakup edisi ini.',
  'update.precheck.db_restore_needed':
    'Bila pembaruan ini gagal, database harus dipulihkan dari cadangan yang dibuat sebelum pembaruan.',
  'update.precheck.stepping_stone':
    'Ini rilis batu loncatan. Setelah terpasang, periksa pembaruan lagi untuk memasang versi terbaru.',
  'update.precheck.estimate': 'Perkiraan lama pemeliharaan: {minutes} menit.',

  // ---- edition: the running edition as the dashboard and Diagnostik name it (EditionView); no placeholders -----
  'edition.community': 'Edisi Komunitas',
  'edition.status.active': 'Aktif',

  // ---- maintenance: the blocking screen of the admin SPA while the flag is on (decision C20) -------------------
  'maintenance.screen.title': 'ALTIS sedang dalam pemeliharaan',
  'maintenance.screen.body':
    'Layanan dihentikan sementara untuk pemeliharaan, misalnya pemulihan cadangan atau pembaruan. Halaman ini memeriksa ulang setiap 15 detik dan terbuka sendiri setelah selesai.',
  // 1c Task 19, ruling R1c-9: the screen's link to the operations page, for whoever may open it.
  'maintenance.screen.link': 'Ikuti kemajuan operasi sistem',

  // ---- Phase 2 (catalog): Task 2 ----------------------------------------------------------------------------
  // The Phase 2 registries (its spec §12): permissions and their modules, audit actions, error codes, and the two
  // dashboard alerts (B2). One term per concept: "cantuman" (record), "eksemplar" (item), "otoritas", "data induk",
  // "lampiran", "katalog daring (OPAC)".
  'perm.catalog.records.read': 'Melihat katalog dan mencetak label',
  'perm.catalog.records.manage': 'Mengelola cantuman bibliografi',
  'perm.catalog.authorities.manage': 'Mengelola otoritas (nama, subjek, penerbit)',
  'perm.catalog.masters.manage': 'Mengelola data induk katalog',
  'perm.catalog.locations.manage': 'Mengelola lokasi dan rak',
  'perm.catalog.items.manage': 'Mengelola eksemplar',
  'perm.catalog.import.run': 'Mengimpor data katalog',
  'perm.catalog.export.run': 'Mengekspor data katalog',
  'perm.catalog.migration.run': 'Menjalankan migrasi dari SLiMS',
  'perm.opac.pages.manage': 'Mengelola halaman dan berita OPAC',
  'perm.module.catalog': 'Katalog',
  'perm.module.opac': 'Katalog daring (OPAC)',

  'audit.catalog.record.create': 'Membuat cantuman',
  'audit.catalog.record.update': 'Mengubah cantuman',
  'audit.catalog.record.archive': 'Mengarsipkan cantuman',
  'audit.catalog.record.restore': 'Memulihkan cantuman dari arsip',
  'audit.catalog.record.merge': 'Menggabungkan cantuman',
  'audit.catalog.attachment.create': 'Menambahkan lampiran',
  'audit.catalog.attachment.update': 'Mengubah lampiran',
  'audit.catalog.attachment.archive': 'Mengarsipkan lampiran',
  'audit.catalog.item.create': 'Menambahkan eksemplar',
  'audit.catalog.item.update': 'Mengubah eksemplar',
  'audit.catalog.item.archive': 'Mengarsipkan eksemplar',
  'audit.catalog.item.batch_create': 'Menambahkan sejumlah eksemplar sekaligus',
  'audit.catalog.item.bulk_update': 'Mengubah banyak eksemplar sekaligus',
  'audit.catalog.authority.create': 'Membuat otoritas',
  'audit.catalog.authority.update': 'Mengubah otoritas',
  'audit.catalog.authority.archive': 'Mengarsipkan otoritas',
  'audit.catalog.authority.merge': 'Menggabungkan otoritas',
  'audit.catalog.master.create': 'Membuat data induk',
  'audit.catalog.master.update': 'Mengubah data induk',
  'audit.catalog.master.archive': 'Mengarsipkan data induk',
  'audit.catalog.import.start': 'Memulai impor katalog',
  'audit.catalog.import.finish': 'Menyelesaikan impor katalog',
  'audit.catalog.export.start': 'Memulai ekspor katalog',
  'audit.catalog.export.download': 'Mengunduh hasil ekspor katalog',
  'audit.catalog.migration.start': 'Memulai migrasi dari SLiMS',
  'audit.catalog.migration.finish': 'Menyelesaikan migrasi dari SLiMS',
  'audit.catalog.search.reindex': 'Membangun ulang indeks pencarian',
  'audit.opac.page.create': 'Membuat halaman atau berita OPAC',
  'audit.opac.page.update': 'Mengubah halaman atau berita OPAC',
  'audit.opac.page.archive': 'Mengarsipkan halaman atau berita OPAC',

  'error.CATALOG_RECORD_HAS_ITEMS': 'Cantuman ini masih memiliki eksemplar aktif. Arsipkan atau pindahkan eksemplarnya terlebih dahulu.',
  'error.CATALOG_IN_USE': 'Data ini masih dipakai oleh cantuman atau eksemplar aktif, jadi belum dapat diarsipkan.',
  'error.CATALOG_MERGE_INVALID': 'Penggabungan ini tidak dapat dilakukan. Pilih tujuan lain yang masih aktif.',
  'error.ITEM_STATUS_TRANSITION': 'Status eksemplar tidak dapat diubah langsung ke status tersebut.',
  'error.CATALOG_IMPORT_FORMAT': 'Berkas impor tidak sesuai dengan format yang dipilih atau tidak dapat dibaca.',
  'error.CATALOG_RUN_EXPIRED': 'Berkas hasil proses ini sudah kedaluwarsa dan dihapus. Jalankan prosesnya lagi.',
  'error.CATALOG_LABEL_LIMIT': 'Terlalu banyak label untuk sekali cetak. Cetak paling banyak 1.000 label sekaligus.',
  'error.CATALOG_OUTBOUND_BLOCKED': 'Alamat server tersebut mengarah ke jaringan internal, jadi tidak dihubungi.',
  'error.CATALOG_OUTBOUND_FAILED':
    'Server luar tidak dapat dihubungi atau jawabannya tidak dapat dipakai. Silakan coba lagi nanti.',
  'error.CATALOG_SRU_INVALID': 'Jawaban server SRU tidak sesuai dengan standar SRU.',
  'error.MIGRATION_SOURCE_UNREACHABLE':
    'Database SLiMS sumber tidak dapat dihubungi. Periksa alamat, nama pengguna, dan kata sandinya.',
  'error.MIGRATION_SOURCE_UNSUPPORTED': 'Versi atau susunan data SLiMS ini tidak didukung oleh migrasi.',
  'error.MIGRATION_TARGET_NOT_EMPTY':
    'Katalog ALTIS sudah berisi data. Izinkan migrasi ke katalog yang tidak kosong bila Anda memang ingin menambahkannya.',

  'alert.search_index_mismatch':
    'Indeks pencarian tidak sesuai dengan isi katalog, sehingga hasil pencarian bisa kurang lengkap. Bangun ulang indeks di halaman Diagnostik.',
  'alert.oai_misconfigured':
    'OAI-PMH aktif tetapi email admin belum diisi, sehingga aplikasi pemanen data menerima pesan kesalahan. Isi email admin di pengaturan OPAC.',
  // ---- Phase 2 (catalog): Task 4 ----
  // vocab.<list>.<value>: one label per value of each list of VOCAB_LISTS (catalog-vocab.ts), shared by the admin SPA
  // and the OPAC; no placeholders. The RDA terms have no label here: they are shown as they are (decision D2-06).
  'vocab.item_status.on_order': 'Dalam pemesanan',
  'vocab.item_status.processing': 'Diproses',
  'vocab.item_status.available': 'Tersedia',
  'vocab.item_status.not_for_loan': 'Baca di tempat',
  'vocab.item_status.repair': 'Perbaikan',
  'vocab.item_status.missing': 'Tidak ditemukan di rak',
  'vocab.item_status.lost': 'Dinyatakan hilang',
  'vocab.item_status.withdrawn': 'Disiangi',
  'vocab.item_event.created': 'Dibuat',
  'vocab.item_event.updated': 'Diubah',
  'vocab.item_event.status': 'Status diubah',
  'vocab.item_event.moved': 'Dipindahkan',
  'vocab.item_event.archived': 'Diarsipkan',
  'vocab.item_event.imported': 'Diimpor',
  'vocab.item_event.migrated': 'Dimigrasikan dari SLiMS',
  'vocab.field.subtitle': 'Anak judul',
  'vocab.field.responsibility': 'Pernyataan tanggung jawab',
  'vocab.field.edition': 'Edisi',
  'vocab.field.material_detail': 'Keterangan khusus bahan',
  'vocab.field.publisher': 'Penerbit',
  'vocab.field.publication_place': 'Tempat terbit',
  'vocab.field.publication_year': 'Tahun terbit',
  'vocab.field.physical_desc': 'Deskripsi fisik',
  'vocab.field.series': 'Judul seri',
  'vocab.field.classification': 'Klasifikasi',
  'vocab.field.call_number': 'Nomor panggil',
  'vocab.field.language': 'Bahasa',
  'vocab.field.rda': 'Jenis isi, media, dan wadah (RDA)',
  'vocab.field.summary': 'Ringkasan',
  'vocab.field.notes': 'Catatan',
  'vocab.field.identifiers': 'Pengenal (ISBN, ISSN, DOI)',
  'vocab.field.agents': 'Pengarang dan kontributor',
  'vocab.field.subjects': 'Subjek',
  'vocab.field_state.hidden': 'Tersembunyi',
  'vocab.field_state.optional': 'Opsional',
  'vocab.field_state.required': 'Wajib',
  'vocab.relator.aut': 'Pengarang',
  'vocab.relator.edt': 'Penyunting',
  'vocab.relator.trl': 'Penerjemah',
  'vocab.relator.ill': 'Ilustrator',
  'vocab.relator.cmp': 'Komponis',
  'vocab.relator.drt': 'Sutradara',
  'vocab.relator.pro': 'Produser',
  'vocab.relator.cre': 'Pencipta',
  'vocab.relator.ctb': 'Kontributor',
  'vocab.identifier_type.isbn': 'ISBN (buku)',
  'vocab.identifier_type.issn': 'ISSN (terbitan berseri)',
  'vocab.identifier_type.doi': 'DOI (objek digital)',
  'vocab.identifier_type.control': 'Nomor kontrol',
  'vocab.identifier_type.other': 'Pengenal lain',
  'vocab.relation_type.related': 'Terkait',
  'vocab.relation_type.other_edition': 'Edisi lain',
  'vocab.relation_type.part_of': 'Bagian dari',
  'vocab.relation_type.translation_of': 'Terjemahan dari',
  'vocab.agent_type.person': 'Orang',
  'vocab.agent_type.organization': 'Badan',
  'vocab.agent_type.meeting': 'Pertemuan',
  'vocab.subject_type.topic': 'Topik',
  'vocab.subject_type.geographic': 'Geografis',
  'vocab.subject_type.name': 'Nama',
  'vocab.subject_type.temporal': 'Kurun waktu',
  'vocab.subject_type.genre': 'Genre/bentuk',
  'vocab.subject_type.occupation': 'Pekerjaan',
  'vocab.thesaurus_rel.use': 'Gunakan (USE)',
  'vocab.thesaurus_rel.uf': 'Digunakan untuk (UF)',
  'vocab.thesaurus_rel.bt': 'Istilah luas (BT)',
  'vocab.thesaurus_rel.nt': 'Istilah sempit (NT)',
  'vocab.thesaurus_rel.rt': 'Istilah terkait (RT)',
  'vocab.thesaurus_rel.sa': 'Lihat juga (SA)',
  'vocab.location_kind.room': 'Ruang',
  'vocab.location_kind.area': 'Bagian ruang',
  'vocab.location_kind.shelf': 'Rak',
  'vocab.acq_source.purchase': 'Pembelian',
  'vocab.acq_source.gift': 'Hadiah',
  'vocab.acq_source.exchange': 'Tukar-menukar',
  'vocab.acq_source.deposit': 'Serah simpan',
  'vocab.acq_source.other': 'Lainnya',
  'vocab.custom_field_type.text': 'Teks singkat',
  'vocab.custom_field_type.longtext': 'Teks panjang',
  'vocab.custom_field_type.number': 'Angka',
  'vocab.custom_field_type.date': 'Tanggal',
  'vocab.custom_field_type.select': 'Pilihan tunggal',
  'vocab.custom_field_type.multiselect': 'Pilihan ganda',
  'vocab.custom_field_type.boolean': 'Ya/tidak',
  'vocab.custom_field_type.url': 'Alamat web (URL)',
  'vocab.custom_field_entity.records': 'Cantuman',
  'vocab.custom_field_entity.items': 'Eksemplar',
  'vocab.attachment_kind.file': 'Berkas',
  'vocab.attachment_kind.url': 'Tautan',
  'vocab.attachment_access.public': 'Publik',
  'vocab.attachment_access.staff': 'Hanya staf',
  'vocab.attachment_media.pdf': 'Dokumen PDF',
  'vocab.attachment_media.audio': 'Rekaman suara',
  'vocab.attachment_media.video': 'Rekaman video',
  'vocab.attachment_media.image': 'Gambar',
  'vocab.attachment_media.url': 'Tautan web',
  'vocab.attachment_media.other': 'Lainnya',
  'vocab.facet.mt': 'Jenis bahan',
  'vocab.facet.lg': 'Bahasa',
  'vocab.facet.ct': 'Tipe koleksi',
  'vocab.facet.br': 'Cabang',
  'vocab.facet.lc': 'Lokasi',
  'vocab.facet.av': 'Ketersediaan',
  'vocab.facet.at': 'Lampiran',
  'vocab.facet.sb': 'Subjek',
  'vocab.facet.cl': 'Kelas',
  'vocab.import_format.marc21': 'Berkas MARC 21 (ISO 2709)',
  'vocab.import_format.marcxml': 'Berkas MARCXML',
  'vocab.import_format.csv-records': 'CSV cantuman ALTIS',
  'vocab.import_format.csv-items': 'CSV eksemplar ALTIS',
  'vocab.import_format.csv-slims': 'CSV cantuman SLiMS',
  'vocab.import_format.csv-slims-items': 'CSV eksemplar SLiMS',
  'vocab.export_format.marc21': 'Berkas MARC 21 (ISO 2709)',
  'vocab.export_format.marcxml': 'Berkas MARCXML',
  'vocab.export_format.marcjson': 'Berkas MARC-in-JSON (JSON Lines)',
  'vocab.export_format.csv-records': 'CSV cantuman ALTIS',
  'vocab.export_format.csv-items': 'CSV eksemplar ALTIS',
  'vocab.run_kind.import': 'Impor',
  'vocab.run_kind.export': 'Ekspor',
  'vocab.run_kind.migration': 'Migrasi SLiMS',
  'vocab.run_kind.dedupe_scan': 'Pindai duplikat',
  'vocab.run_status.queued': 'Menunggu',
  'vocab.run_status.running': 'Berjalan',
  'vocab.run_status.succeeded': 'Berhasil',
  'vocab.run_status.failed': 'Gagal',
  'vocab.run_status.cancelled': 'Dibatalkan',
  'vocab.page_kind.page': 'Halaman',
  'vocab.page_kind.news': 'Berita',
  'vocab.page_status.draft': 'Draf',
  'vocab.page_status.published': 'Terbit',
  'vocab.page_locale.id': 'Bahasa Indonesia',
  'vocab.page_locale.en': 'Bahasa Inggris',
  'vocab.body_format.markdown': 'Markdown sederhana',
  'vocab.body_format.html': 'HTML (disanitasi)',
  // ---- Komunitas K1 (edition lane) ----
  'error.BACKUP_EDITION_TABLES': 'Database ini memuat tabel jalur lain; pulihkan dengan kode yang mengenalnya.',
} satisfies Record<string, string>;

/**
 * The catalog. The two test-profile keys are spread in only when `__BUILD_PROFILE__` is `'test'`, with the condition
 * written out here (no intermediate constant) so that esbuild folds it and drops the object literal from a production
 * bundle, as `permissionCatalog` does for its test entry; the release build's leak scan fails when it does not.
 */
export const ID_MESSAGES: Readonly<typeof BASE & TestOnlyMessages> = Object.freeze({
  ...BASE,
  ...((typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test'
    ? { 'perm.test.branch.manage': 'Mengelola cabang (khusus uji)', 'perm.module.test': 'Uji' }
    : {}) as TestOnlyMessages),
});

/** A key of the catalog; `id.ts` is the source of truth. */
export type MessageKey = keyof typeof ID_MESSAGES;

/** The two keys of {@link TestOnlyMessages}. */
export type TestOnlyKey = keyof TestOnlyMessages;

/**
 * Compile-time completeness: a new error code, catalog permission, audit action, op kind or op state without its
 * `error.`, `perm.`, `audit.`, `ops.kind.` or `ops.state.` message fails `tsc` here, with the missing keys named in
 * the error. Nothing is exported at run time.
 */
type MissingFamilyKeys = Exclude<
  `error.${ErrorCode}` | `perm.${Permission}` | `audit.${AuditAction}` | `ops.kind.${OpKind}` | `ops.state.${OpState}`,
  MessageKey
>;
export type AssertEveryFamilyKeyHasAMessage<T extends never = MissingFamilyKeys> = T;

// ---- Phase 2 (catalog): Task 4 ----
/**
 * Compile-time completeness of the catalog vocabularies: a value added to a list of `VOCAB_LISTS` (catalog-vocab.ts)
 * without its `vocab.<list>.<value>` message fails `tsc` here, with the missing keys named in the error.
 */
type MissingVocabKeys = Exclude<VocabMessageKey, MessageKey>;
export type AssertEveryVocabValueHasAMessage<T extends never = MissingVocabKeys> = T;
