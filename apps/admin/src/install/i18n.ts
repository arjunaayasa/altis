import { DEFAULT_LOCALE, t as sharedT, type Locale, type MessageKey } from '@altis/shared';
import { createContext, createElement, useCallback, useContext, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';

/**
 * The install wizard's strings (spec §9.5; plan Task 30): Indonesian first, English complete, in a catalog of its own
 * (the wizard is its own bundle, `install.html`, and never loads the admin SPA's catalog). Problems are worded by the
 * shared `error.<CODE>` messages of @altis/shared, with the server's own detail beneath.
 *
 * Copy rules (as for the admin): plain Indonesian in KBBI spelling, "Anda" capitalized, common words over jargon; a
 * `{name}` placeholder appears in both languages of a key (the parity test).
 */
export const INSTALL_ID = {
  // ---- app: the frame of the wizard -------------------------------------------------------------------------
  'app.title': 'Pemasangan ALTIS',
  'app.subtitle': 'Arsya Library Tracking Information System',
  'app.language': 'Bahasa',
  'app.loading': 'Memuat…',
  'app.retry': 'Coba lagi',
  'app.next': 'Lanjut',
  'app.steps_label': 'Langkah pemasangan',
  'app.step_of': 'Langkah {n} dari {total}',
  'app.installed.title': 'ALTIS sudah terpasang',
  'app.installed.body': 'Pemasangan sudah selesai. Masuk ke ALTIS untuk mulai bekerja.',
  'app.go_login': 'Masuk ke ALTIS',
  'app.unavailable.title': 'Wizard pemasangan tidak dapat dibuka',
  'app.network_error': 'Server tidak dapat dihubungi. Periksa koneksi Anda, lalu coba lagi.',
  'app.trace': 'Kode pelacakan untuk administrator: {id}',

  // ---- step: the names in the step list (steps 0-6) ---------------------------------------------------------
  'step.claim': 'Klaim',
  'step.checks': 'Pemeriksaan',
  'step.database': 'Database',
  'step.profile': 'Profil',
  'step.admin': 'Super admin',
  'step.cron': 'Penjadwal',
  'step.done': 'Selesai',

  // ---- runtime: the runtimes of spec P14 --------------------------------------------------------------------
  'runtime.passenger': 'cPanel (Passenger)',
  'runtime.litespeed': 'LiteSpeed',
  'runtime.pm2': 'PM2 (misalnya aaPanel)',
  'runtime.docker': 'Docker',
  'runtime.service': 'Layanan sistem',
  'runtime.standalone': 'Proses mandiri (PC)',

  // ---- claim: step 0 ----------------------------------------------------------------------------------------
  'claim.title': 'Masukkan kode pemasangan',
  'claim.intro':
    'Supaya hanya pemilik server yang dapat memasang ALTIS, masukkan kode pemasangan 26 karakter yang dibuat server ini.',
  'claim.where.title': 'Di mana kodenya?',
  'claim.where.file': 'Kode tersimpan di berkas install-code.txt di dalam folder data ALTIS.',
  'claim.where.file_manager':
    'Buka File Manager di panel hosting Anda (cPanel, aaPanel, atau yang lain), masuk ke folder data ALTIS, lalu buka berkas install-code.txt. Salin nilai "code" di dalamnya.',
  'claim.where.console':
    'Kode yang sama juga dicetak di log keluaran aplikasi saat ALTIS dijalankan. Pada Docker, kode ada di berkas .env sebagai ALTIS_INSTALL_CODE.',
  'claim.where.expiry': 'Kode berlaku 24 jam. Bila sudah kedaluwarsa, muat ulang halaman ini dan buka lagi install-code.txt untuk kode yang baru.',
  'claim.code': 'Kode pemasangan',
  'claim.code_hint': 'Huruf besar dan kecil sama saja; spasi dan tanda hubung boleh diabaikan.',
  'claim.submit': 'Klaim pemasangan',
  'claim.submitting': 'Memeriksa kode…',
  'claim.invalid': 'Kode pemasangan salah atau sudah kedaluwarsa. Periksa lagi isi install-code.txt.',
  'claim.cookie_lost':
    'Kode diterima, tetapi browser tidak menyimpan cookie pemasangan. Buka halaman ini lewat alamat yang sama dengan ALTIS_BASE_URL (misalnya https://), lalu klaim lagi.',
  'claim.too_many': 'Terlalu banyak percobaan. Coba lagi dalam {time}.',
  'claim.minutes': '{n} menit',
  'claim.seconds': '{n} detik',

  // ---- checks: step 1 ---------------------------------------------------------------------------------------
  'checks.title': 'Pemeriksaan server',
  'checks.intro': 'ALTIS memeriksa server ini dan menguji koneksi dari browser Anda. Ini memerlukan beberapa detik.',
  'checks.runtime': 'Runtime terdeteksi: {runtime}',
  'checks.aapanel_default':
    'ALTIS berjalan sebagai project aaPanel bertipe Default. Buat ulang sebagai Node Project bertipe PM2 dengan berkas app.js, supaya ALTIS punya pekerja latar dan dimulai ulang otomatis.',
  'checks.mandatory': 'Pemeriksaan wajib',
  'checks.status.ok': 'Lolos',
  'checks.status.error': 'Gagal',
  'checks.status.warn': 'Peringatan',
  'checks.name.node': 'Versi Node.js',
  'checks.name.dataDir': 'Folder data dapat ditulis',
  'checks.name.docroot': 'Folder di luar document root',
  'checks.name.wasm': 'WebAssembly',
  'checks.name.timezone': 'Data zona waktu',
  'checks.name.ram': 'Memori (RAM)',
  'checks.fix.node': 'Pilih Node.js 22.16 atau yang lebih baru di panel hosting (Setup Node.js App atau Node Project), lalu mulai ulang aplikasi.',
  'checks.fix.dataDir':
    'Pastikan folder data ada dan dapat ditulis oleh pengguna yang menjalankan aplikasi (pemilik yang sama, izin 700 atau 750).',
  'checks.fix.docroot':
    'Folder aplikasi dan folder data harus berada di luar document root, misalnya ~/altis/app dan ~/altis/altis-data, bukan di dalam public_html.',
  'checks.fix.wasm':
    'Tambahkan variabel lingkungan NODE_OPTIONS=--disable-wasm-trap-handler pada aplikasi Node.js, lalu mulai ulang aplikasi.',
  'checks.fix.timezone': 'Data zona waktu Node.js tidak lengkap. Gunakan Node.js resmi dengan data ICU lengkap.',
  'checks.fix.ram': 'RAM server kurang dari 512 MiB, sehingga ALTIS bisa lambat atau berhenti. Naikkan paket hosting bila bisa.',
  'checks.blocked_preflight': 'Perbaiki pemeriksaan wajib yang gagal, lalu ulangi pemeriksaan.',
  'checks.browser.title': 'Uji dari browser',
  'checks.browser.running': 'Menguji koneksi dari browser…',
  'checks.browser.polling': 'Polling',
  'checks.browser.sse': 'Server-Sent Events (SSE)',
  'checks.browser.methods': 'Metode PUT, PATCH, dan DELETE',
  'checks.browser.chunk': 'Ukuran potongan unggah',
  'checks.browser.works': 'Berfungsi',
  'checks.browser.fails': 'Tidak berfungsi',
  'checks.browser.sse_off': 'Tidak berfungsi; ALTIS memakai polling (biasa pada cPanel dan LiteSpeed).',
  'checks.browser.methods_blocked': 'Diblokir: {methods}. ALTIS akan memakai method override.',
  'checks.browser.chunk_none': 'Tidak ada ukuran yang lolos; unggahan berkas besar mungkin gagal.',
  'checks.exposure.title': 'Paparan berkas',
  'checks.exposure.ok': 'Aman: berkas ALTIS tidak dapat diambil lewat web.',
  'checks.exposure.exposed':
    'Berkas ALTIS dapat diambil lewat web. Folder data atau folder aplikasi berada di dalam document root, sehingga siapa pun dapat mengunduh konfigurasi dan data Anda. Pindahkan folder itu ke luar document root, lalu ulangi pemeriksaan. Pemasangan tidak dapat dilanjutkan sebelum itu.',
  'checks.exposure.error': 'Hasil uji paparan tidak dapat dikirim ke server. Ulangi pemeriksaan.',
  'checks.network.title': 'Proxy dan alamat IP',
  'checks.network.suggestion': 'Terdeteksi {hops} proxy di depan ALTIS. Dengan nilai ini, alamat IP Anda terbaca sebagai {ip}.',
  'checks.network.suggestion_no_ip': 'Terdeteksi {hops} proxy di depan ALTIS.',
  'checks.network.no_suggestion': 'Uji proxy tidak berhasil; jumlah proxy tidak dapat diusulkan.',
  'checks.network.hops': 'Jumlah proxy tepercaya (hops)',
  'checks.network.ip_for_hops': 'Dengan {hops} hop, alamat IP Anda terbaca sebagai {ip}.',
  'checks.network.ip_unknown':
    'Alamat IP untuk nilai ini tidak dapat ditentukan dari uji ini. Pastikan jumlah proxy di depan ALTIS (misalnya Cloudflare atau load balancer penyedia hosting) memang sebanyak ini, lalu konfirmasi.',
  'checks.network.confirm': 'Alamat IP itu memang alamat IP saya.',
  'checks.network.confirm_hops': 'Jumlah proxy ini sudah saya periksa dan benar.',
  'checks.network.confirm_hint': 'Cocokkan dengan alamat IP yang ditampilkan situs pemeriksa IP mana pun.',
  'checks.network.spoofable':
    'Dengan jumlah proxy ini, alamat IP palsu di header X-Forwarded-For diterima server. Pakai jumlah proxy yang diusulkan.',
  'checks.base_url.title': 'Alamat situs',
  'checks.base_url.label': 'Base URL',
  'checks.base_url.hint': 'Alamat yang dipakai browser ini untuk membuka ALTIS: skema, domain, dan port saja, tanpa path.',
  'checks.base_url.path': 'Base URL tidak boleh memuat path, query, atau fragmen.',
  'checks.base_url.invalid': 'Base URL tidak valid.',
  'checks.base_url.mismatch': 'Base URL harus sama dengan alamat yang sedang Anda buka: {origin}.',
  'checks.base_url.proof_failed':
    'Uji base URL gagal: server tidak menjawab uji keaslian. Muat ulang halaman, lalu ulangi pemeriksaan.',
  'checks.rerun': 'Ulangi pemeriksaan',

  // ---- db: step 2 -------------------------------------------------------------------------------------------
  'db.title': 'Database',
  'db.intro': 'Siapkan database yang masih kosong di panel hosting, lalu isi detail koneksinya.',
  'db.dialect': 'Jenis database',
  'db.dialect.mysql': 'MySQL',
  'db.dialect.mariadb': 'MariaDB',
  'db.dialect.postgres': 'PostgreSQL',
  'db.dialect.sqlite': 'SQLite (berkas di folder data)',
  'db.sqlite_note': 'SQLite disimpan sebagai berkas di folder data. Cocok untuk satu proses saja (Docker, PC, atau PM2 satu instance).',
  'db.sqlite_unavailable': 'SQLite tidak tersedia pada runtime ini karena ALTIS berjalan dengan beberapa proses.',
  'db.host': 'Host',
  'db.port': 'Port',
  'db.database': 'Nama database',
  'db.user': 'Pengguna database',
  'db.password': 'Kata sandi database',
  'db.test': 'Uji koneksi',
  'db.testing': 'Menguji koneksi…',
  'db.result.ok': 'Terhubung ke {flavor} {version}.',
  'db.result.pool': 'Setiap proses ALTIS akan membuka hingga {n} koneksi.',
  'db.result.empty': 'Database kosong dan siap dipakai.',
  'db.result.resumable': 'Database ini berisi pemasangan ALTIS yang belum selesai; pemasangan akan dilanjutkan.',
  'db.result.not_empty': 'Database ini tidak kosong. Gunakan database yang kosong.',
  'db.problem.VERSION_TOO_OLD': 'Versi server database terlalu lama.',
  'db.problem.ENGINE_NOT_INNODB': 'Mesin penyimpanan bawaan server bukan InnoDB.',
  'db.problem.NO_FULLTEXT': 'Server database tidak mendukung pencarian full-text.',
  'db.retest': 'Isian berubah. Uji koneksi lagi sebelum melanjutkan.',
  'db.save': 'Simpan dan buat tabel',
  'db.saving': 'Menyimpan konfigurasi…',

  // ---- migrate: step 2, the tables --------------------------------------------------------------------------
  'migrate.title': 'Membuat tabel database',
  'migrate.running': 'Menjalankan migrasi: {applied} dari {total} selesai…',
  'migrate.progress_label': 'Kemajuan migrasi',
  'migrate.keep_open': 'Biarkan halaman ini terbuka sampai selesai.',
  'migrate.done': 'Semua tabel sudah dibuat.',
  'migrate.failed': 'Migrasi berhenti.',

  // ---- profile: step 3 --------------------------------------------------------------------------------------
  'profile.title': 'Profil perpustakaan',
  'profile.name': 'Nama perpustakaan',
  'profile.type': 'Jenis perpustakaan',
  'profile.type.none': '(belum dipilih)',
  'profile.type.sekolah': 'Perpustakaan sekolah',
  'profile.type.perguruan_tinggi': 'Perpustakaan perguruan tinggi',
  'profile.type.umum': 'Perpustakaan umum',
  'profile.type.khusus': 'Perpustakaan khusus',
  'profile.address': 'Alamat',
  'profile.timezone': 'Zona waktu',
  'profile.timezone_hint': 'Nama zona waktu IANA, misalnya Asia/Jakarta (WIB), Asia/Makassar (WITA), atau Asia/Jayapura (WIT).',
  'profile.timezone_invalid': 'Zona waktu ini tidak dikenal.',
  'profile.locale': 'Bahasa tampilan',
  'profile.locale.id': 'Bahasa Indonesia',
  'profile.locale.en': 'English',
  'profile.branch.title': 'Cabang utama',
  'profile.branch.code': 'Kode cabang',
  'profile.branch.code_hint': 'Huruf, angka, garis bawah, atau tanda hubung. Kosongkan untuk memakai PUSAT.',
  'profile.branch.name': 'Nama cabang',
  'profile.branch.name_hint': 'Kosongkan untuk memakai nama perpustakaan.',
  'profile.save': 'Simpan profil',

  // ---- admin: step 4 ----------------------------------------------------------------------------------------
  'admin.title': 'Akun super admin',
  'admin.intro': 'Akun ini memegang semua izin. Simpan kata sandinya baik-baik.',
  'admin.username': 'Nama pengguna',
  'admin.username_hint': '3–64 huruf, angka, titik, garis bawah, atau tanda hubung.',
  'admin.name': 'Nama lengkap',
  'admin.email': 'E-mail',
  'admin.email_hint': 'Opsional. Dipakai untuk mengatur ulang kata sandi.',
  'admin.password': 'Kata sandi',
  'admin.password_hint': 'Paling sedikit 10 karakter. Kata sandi yang umum dipakai akan ditolak.',
  'admin.password_confirm': 'Ulangi kata sandi',
  'admin.password_mismatch': 'Kedua kata sandi tidak sama.',
  'admin.password.too_short': 'Kata sandi terlalu pendek. Gunakan paling sedikit 10 karakter.',
  'admin.password.too_long': 'Kata sandi terlalu panjang.',
  'admin.password.common': 'Kata sandi ini terlalu umum dan mudah ditebak. Pilih yang lain.',
  'admin.field_invalid': 'Periksa lagi isian berikut: {fields}.',
  'admin.two_factor_note':
    'Setelah masuk pertama kali, Anda akan ditawari verifikasi dua langkah (2FA). Aktifkan untuk akun super admin.',
  'admin.save': 'Buat akun',

  // ---- cron: step 5 -----------------------------------------------------------------------------------------
  'cron.title': 'Penjadwal tugas',
  'cron.intro': 'ALTIS menjalankan tugas latar, seperti backup harian, e-mail, dan pembersihan, lewat penjadwal.',
  'cron.required': 'Wajib pada runtime ini.',
  'cron.optional': 'Opsional pada runtime ini: ALTIS sudah menjalankan pekerja latar sendiri.',
  'cron.guidance.cpanel':
    'cPanel atau LiteSpeed: buka menu Cron Jobs, pilih jadwal setiap 5 menit (*/5 * * * *), lalu tempel baris cron di bawah. Bila perintah node tidak dapat dipakai, tempel perintah curl sebagai gantinya.',
  'cron.guidance.aapanel':
    'aaPanel: opsional, karena PM2 sudah menjalankan pekerja latar. Bila ingin dipakai, buat tugas Cron bertipe Shell Script setiap 5 menit yang berisi perintah curl di bawah.',
  'cron.guidance.other':
    'Docker atau PC: opsional, karena ALTIS sudah menjalankan pekerja latar. Penjadwal tambahan boleh menjalankan perintah curl di bawah setiap 5 menit.',
  'cron.cron_line': 'Baris cron (pilihan utama)',
  'cron.curl_line': 'Perintah curl (alternatif)',
  'cron.secret_note': 'Perintah curl memuat token rahasia. Jangan dibagikan.',
  'cron.copy': 'Salin',
  'cron.copied': 'Tersalin',
  'cron.copy_failed': 'Tidak dapat menyalin. Pilih teksnya, lalu salin secara manual.',
  'cron.test': 'Uji penjadwal',
  'cron.testing': 'Memeriksa penjadwal…',
  'cron.detected.worker': 'Pekerja latar ALTIS aktif.',
  'cron.detected.cron_cli': 'Penjadwal terdeteksi: baris cron berjalan pada {time}.',
  'cron.detected.cron_http': 'Penjadwal terdeteksi: URL /_cron dipanggil pada {time}.',
  'cron.not_detected': 'Penjadwal belum terdeteksi. Setelah memasang baris cron, tunggu sampai 5 menit, lalu uji lagi.',
  'cron.not_detected_title': 'Penjadwal belum terdeteksi',
  'cron.finish': 'Selesaikan pemasangan',
  'cron.finishing': 'Menyelesaikan pemasangan…',

  // ---- done: step 6 -----------------------------------------------------------------------------------------
  'done.title': 'Pemasangan selesai',
  'done.body': 'ALTIS siap dipakai. Masuk dengan akun super admin yang baru saja Anda buat.',
  'done.two_factor': 'Setelah masuk, aktifkan verifikasi dua langkah (2FA) untuk akun super admin.',
  'done.login': 'Masuk ke ALTIS',
  // ---- English singulars of counted texts (`<key>_one`, chosen when the count is 1; Indonesian has one form) ----
  'claim.minutes_one': '{n} menit',
  'claim.seconds_one': '{n} detik',
  'checks.network.suggestion_one': 'Terdeteksi {hops} proxy di depan ALTIS. Dengan nilai ini, alamat IP Anda terbaca sebagai {ip}.',
  'checks.network.suggestion_no_ip_one': 'Terdeteksi {hops} proxy di depan ALTIS.',
  'checks.network.ip_for_hops_one': 'Dengan {hops} hop, alamat IP Anda terbaca sebagai {ip}.',
  'db.result.pool_one': 'Setiap proses ALTIS akan membuka hingga {n} koneksi.',
} as const;

export type InstallKey = keyof typeof INSTALL_ID;

/** The English texts, typed against the Indonesian keys: a key added there without its English text fails `tsc`. */
export const INSTALL_EN: Readonly<Record<InstallKey, string>> = {
  'app.title': 'ALTIS installation',
  'app.subtitle': 'Arsya Library Tracking Information System',
  'app.language': 'Language',
  'app.loading': 'Loading…',
  'app.retry': 'Try again',
  'app.next': 'Continue',
  'app.steps_label': 'Installation steps',
  'app.step_of': 'Step {n} of {total}',
  'app.installed.title': 'ALTIS is already installed',
  'app.installed.body': 'The installation is complete. Sign in to ALTIS to start working.',
  'app.go_login': 'Sign in to ALTIS',
  'app.unavailable.title': 'The installation wizard cannot open',
  'app.network_error': 'The server cannot be reached. Check your connection, then try again.',
  'app.trace': 'Trace code for the administrator: {id}',

  'step.claim': 'Claim',
  'step.checks': 'Checks',
  'step.database': 'Database',
  'step.profile': 'Profile',
  'step.admin': 'Super admin',
  'step.cron': 'Scheduler',
  'step.done': 'Done',

  'runtime.passenger': 'cPanel (Passenger)',
  'runtime.litespeed': 'LiteSpeed',
  'runtime.pm2': 'PM2 (for example aaPanel)',
  'runtime.docker': 'Docker',
  'runtime.service': 'System service',
  'runtime.standalone': 'Standalone process (PC)',

  'claim.title': 'Enter the installation code',
  'claim.intro': 'So that only the owner of the server can install ALTIS, enter the 26-character installation code this server created.',
  'claim.where.title': 'Where is the code?',
  'claim.where.file': 'The code is kept in the file install-code.txt inside the ALTIS data folder.',
  'claim.where.file_manager':
    'Open the File Manager of your hosting panel (cPanel, aaPanel or another one), go to the ALTIS data folder and open install-code.txt. Copy the "code" value inside it.',
  'claim.where.console':
    'The same code is also printed to the application output log when ALTIS starts. On Docker, the code is in the .env file as ALTIS_INSTALL_CODE.',
  'claim.where.expiry': 'The code is valid for 24 hours. When it has expired, reload this page and open install-code.txt again for the new code.',
  'claim.code': 'Installation code',
  'claim.code_hint': 'Upper and lower case are the same; spaces and dashes may be left out.',
  'claim.submit': 'Claim the installation',
  'claim.submitting': 'Checking the code…',
  'claim.invalid': 'The installation code is wrong or has expired. Check the content of install-code.txt again.',
  'claim.cookie_lost':
    'The code was accepted, but the browser did not keep the installation cookie. Open this page at the same address as ALTIS_BASE_URL (for example https://), then claim again.',
  'claim.too_many': 'Too many attempts. Try again in {time}.',
  'claim.minutes': '{n} minutes',
  'claim.seconds': '{n} seconds',

  'checks.title': 'Server checks',
  'checks.intro': 'ALTIS checks this server and tests the connection from your browser. This takes a few seconds.',
  'checks.runtime': 'Detected runtime: {runtime}',
  'checks.aapanel_default':
    'ALTIS runs as an aaPanel project of type Default. Create it again as a Node Project of type PM2 with the file app.js, so that ALTIS has a background worker and restarts automatically.',
  'checks.mandatory': 'Mandatory checks',
  'checks.status.ok': 'Passed',
  'checks.status.error': 'Failed',
  'checks.status.warn': 'Warning',
  'checks.name.node': 'Node.js version',
  'checks.name.dataDir': 'Data folder is writable',
  'checks.name.docroot': 'Folders outside the document root',
  'checks.name.wasm': 'WebAssembly',
  'checks.name.timezone': 'Time zone data',
  'checks.name.ram': 'Memory (RAM)',
  'checks.fix.node': 'Choose Node.js 22.16 or later in the hosting panel (Setup Node.js App or Node Project), then restart the application.',
  'checks.fix.dataDir': 'Make sure the data folder exists and is writable by the user that runs the application (same owner, permissions 700 or 750).',
  'checks.fix.docroot':
    'The application folder and the data folder must lie outside the document root, for example ~/altis/app and ~/altis/altis-data, not inside public_html.',
  'checks.fix.wasm': 'Add the environment variable NODE_OPTIONS=--disable-wasm-trap-handler to the Node.js application, then restart it.',
  'checks.fix.timezone': 'The time zone data of Node.js is incomplete. Use an official Node.js build with full ICU data.',
  'checks.fix.ram': 'The server has less than 512 MiB of RAM, so ALTIS may be slow or stop. Upgrade the hosting plan if you can.',
  'checks.blocked_preflight': 'Fix the mandatory checks that failed, then run the checks again.',
  'checks.browser.title': 'Browser test',
  'checks.browser.running': 'Testing the connection from the browser…',
  'checks.browser.polling': 'Polling',
  'checks.browser.sse': 'Server-Sent Events (SSE)',
  'checks.browser.methods': 'PUT, PATCH and DELETE methods',
  'checks.browser.chunk': 'Upload chunk size',
  'checks.browser.works': 'Works',
  'checks.browser.fails': 'Does not work',
  'checks.browser.sse_off': 'Does not work; ALTIS uses polling (usual on cPanel and LiteSpeed).',
  'checks.browser.methods_blocked': 'Blocked: {methods}. ALTIS will use method override.',
  'checks.browser.chunk_none': 'No size passed; uploads of large files may fail.',
  'checks.exposure.title': 'File exposure',
  'checks.exposure.ok': 'Safe: ALTIS files cannot be fetched through the web.',
  'checks.exposure.exposed':
    'ALTIS files can be fetched through the web. The data folder or the application folder lies inside the document root, so anyone can download your configuration and data. Move that folder outside the document root, then run the checks again. The installation cannot continue before that.',
  'checks.exposure.error': 'The result of the exposure test could not be sent to the server. Run the checks again.',
  'checks.network.title': 'Proxies and IP address',
  'checks.network.suggestion': '{hops} proxies were detected in front of ALTIS. With this value, your IP address reads as {ip}.',
  'checks.network.suggestion_no_ip': '{hops} proxies were detected in front of ALTIS.',
  'checks.network.no_suggestion': 'The proxy test did not succeed; no number of proxies can be suggested.',
  'checks.network.hops': 'Number of trusted proxies (hops)',
  'checks.network.ip_for_hops': 'With {hops} hops, your IP address reads as {ip}.',
  'checks.network.ip_unknown':
    "The IP address for this value cannot be determined from this test. Make sure the number of proxies in front of ALTIS (for example Cloudflare or the hosting provider's load balancer) is indeed this many, then confirm.",
  'checks.network.confirm': 'That IP address is indeed my IP address.',
  'checks.network.confirm_hops': 'I have checked this number of proxies and it is right.',
  'checks.network.confirm_hint': 'Compare it with the IP address any IP lookup site shows.',
  'checks.network.spoofable':
    'With this number of proxies the server accepts a forged IP address in the X-Forwarded-For header. Use the suggested number of proxies.',
  'checks.base_url.title': 'Site address',
  'checks.base_url.label': 'Base URL',
  'checks.base_url.hint': 'The address this browser uses to open ALTIS: scheme, domain and port only, without a path.',
  'checks.base_url.path': 'The base URL may not contain a path, a query or a fragment.',
  'checks.base_url.invalid': 'The base URL is not valid.',
  'checks.base_url.mismatch': 'The base URL must be the address you have open now: {origin}.',
  'checks.base_url.proof_failed': 'The base URL test failed: the server did not answer the authenticity test. Reload the page, then run the checks again.',
  'checks.rerun': 'Run the checks again',

  'db.title': 'Database',
  'db.intro': 'Prepare an empty database in the hosting panel, then enter its connection details.',
  'db.dialect': 'Database type',
  'db.dialect.mysql': 'MySQL',
  'db.dialect.mariadb': 'MariaDB',
  'db.dialect.postgres': 'PostgreSQL',
  'db.dialect.sqlite': 'SQLite (a file in the data folder)',
  'db.sqlite_note': 'SQLite is kept as a file in the data folder. It suits a single process only (Docker, PC, or PM2 with one instance).',
  'db.sqlite_unavailable': 'SQLite is not available on this runtime because ALTIS runs with several processes.',
  'db.host': 'Host',
  'db.port': 'Port',
  'db.database': 'Database name',
  'db.user': 'Database user',
  'db.password': 'Database password',
  'db.test': 'Test the connection',
  'db.testing': 'Testing the connection…',
  'db.result.ok': 'Connected to {flavor} {version}.',
  'db.result.pool': 'Each ALTIS process will open up to {n} connections.',
  'db.result.empty': 'The database is empty and ready to use.',
  'db.result.resumable': 'This database holds an unfinished ALTIS installation; the installation will continue.',
  'db.result.not_empty': 'This database is not empty. Use an empty database.',
  'db.problem.VERSION_TOO_OLD': 'The database server version is too old.',
  'db.problem.ENGINE_NOT_INNODB': 'The default storage engine of the server is not InnoDB.',
  'db.problem.NO_FULLTEXT': 'The database server does not support full-text search.',
  'db.retest': 'The fields changed. Test the connection again before continuing.',
  'db.save': 'Save and create the tables',
  'db.saving': 'Saving the configuration…',

  'migrate.title': 'Creating the database tables',
  'migrate.running': 'Running the migrations: {applied} of {total} done…',
  'migrate.progress_label': 'Migration progress',
  'migrate.keep_open': 'Keep this page open until it is done.',
  'migrate.done': 'All tables have been created.',
  'migrate.failed': 'The migration stopped.',

  'profile.title': 'Library profile',
  'profile.name': 'Library name',
  'profile.type': 'Library type',
  'profile.type.none': '(not chosen)',
  'profile.type.sekolah': 'School library',
  'profile.type.perguruan_tinggi': 'University library',
  'profile.type.umum': 'Public library',
  'profile.type.khusus': 'Special library',
  'profile.address': 'Address',
  'profile.timezone': 'Time zone',
  'profile.timezone_hint': 'An IANA time zone name, for example Asia/Jakarta (WIB), Asia/Makassar (WITA) or Asia/Jayapura (WIT).',
  'profile.timezone_invalid': 'This time zone is not known.',
  'profile.locale': 'Display language',
  'profile.locale.id': 'Bahasa Indonesia',
  'profile.locale.en': 'English',
  'profile.branch.title': 'Main branch',
  'profile.branch.code': 'Branch code',
  'profile.branch.code_hint': 'Letters, digits, underscores or dashes. Leave it empty to use PUSAT.',
  'profile.branch.name': 'Branch name',
  'profile.branch.name_hint': 'Leave it empty to use the library name.',
  'profile.save': 'Save the profile',

  'admin.title': 'Super admin account',
  'admin.intro': 'This account holds every permission. Keep its password safe.',
  'admin.username': 'Username',
  'admin.username_hint': '3–64 letters, digits, dots, underscores or dashes.',
  'admin.name': 'Full name',
  'admin.email': 'E-mail',
  'admin.email_hint': 'Optional. Used to reset the password.',
  'admin.password': 'Password',
  'admin.password_hint': 'At least 10 characters. Commonly used passwords are refused.',
  'admin.password_confirm': 'Repeat the password',
  'admin.password_mismatch': 'The two passwords are not the same.',
  'admin.password.too_short': 'The password is too short. Use at least 10 characters.',
  'admin.password.too_long': 'The password is too long.',
  'admin.password.common': 'This password is too common and easy to guess. Choose another one.',
  'admin.field_invalid': 'Check these fields again: {fields}.',
  'admin.two_factor_note': 'After your first sign-in you will be offered two-step verification (2FA). Turn it on for the super admin account.',
  'admin.save': 'Create the account',

  'cron.title': 'Task scheduler',
  'cron.intro': 'ALTIS runs background tasks, such as the daily backup, e-mail and clean-up, through a scheduler.',
  'cron.required': 'Required on this runtime.',
  'cron.optional': 'Optional on this runtime: ALTIS already runs its own background worker.',
  'cron.guidance.cpanel':
    'cPanel or LiteSpeed: open Cron Jobs, choose every 5 minutes (*/5 * * * *), then paste the cron line below. When the node command cannot be used, paste the curl command instead.',
  'cron.guidance.aapanel':
    'aaPanel: optional, because PM2 already runs the background worker. To use it, create a Cron task of type Shell Script every 5 minutes holding the curl command below.',
  'cron.guidance.other': 'Docker or PC: optional, because ALTIS already runs a background worker. An extra scheduler may run the curl command below every 5 minutes.',
  'cron.cron_line': 'Cron line (first choice)',
  'cron.curl_line': 'curl command (alternative)',
  'cron.secret_note': 'The curl command holds a secret token. Do not share it.',
  'cron.copy': 'Copy',
  'cron.copied': 'Copied',
  'cron.copy_failed': 'Copying failed. Select the text, then copy it by hand.',
  'cron.test': 'Test the scheduler',
  'cron.testing': 'Checking the scheduler…',
  'cron.detected.worker': 'The ALTIS background worker is active.',
  'cron.detected.cron_cli': 'Scheduler detected: the cron line ran at {time}.',
  'cron.detected.cron_http': 'Scheduler detected: the /_cron URL was called at {time}.',
  'cron.not_detected': 'No scheduler detected yet. After adding the cron line, wait up to 5 minutes, then test again.',
  'cron.not_detected_title': 'No scheduler detected yet',
  'cron.finish': 'Finish the installation',
  'cron.finishing': 'Finishing the installation…',

  'done.title': 'Installation complete',
  'done.body': 'ALTIS is ready. Sign in with the super admin account you have just created.',
  'done.two_factor': 'After signing in, turn on two-step verification (2FA) for the super admin account.',
  'done.login': 'Sign in to ALTIS',
  // ---- English singulars of counted texts ----
  'claim.minutes_one': '{n} minute',
  'claim.seconds_one': '{n} second',
  'checks.network.suggestion_one': '{hops} proxy was detected in front of ALTIS. With this value, your IP address reads as {ip}.',
  'checks.network.suggestion_no_ip_one': '{hops} proxy was detected in front of ALTIS.',
  'checks.network.ip_for_hops_one': 'With {hops} hop, your IP address reads as {ip}.',
  'db.result.pool_one': 'Each ALTIS process will open up to {n} connection.',
};

export const INSTALL_MESSAGES: Readonly<Record<Locale, Readonly<Record<InstallKey, string>>>> = Object.freeze({
  id: Object.freeze({ ...INSTALL_ID }),
  en: Object.freeze({ ...INSTALL_EN }),
});

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** The text of `key` in `locale`, with every `{name}` filled in one pass (a missing value leaves the placeholder). */
export function installT(locale: Locale, key: InstallKey, params?: Readonly<Record<string, string | number>>): string {
  const table = hasOwn(INSTALL_MESSAGES, locale) ? INSTALL_MESSAGES[locale] : INSTALL_MESSAGES[DEFAULT_LOCALE];
  // A key computed at run time (`runtime.<name>`) that the catalog lacks answers with the key itself.
  const template = hasOwn(table, key) ? table[key] : key;
  if (params === undefined) return template;
  return template.replace(PLACEHOLDER, (whole: string, name: string) => (hasOwn(params, name) && params[name] !== undefined ? String(params[name]) : whole));
}

export type InstallTranslate = (key: InstallKey, params?: Readonly<Record<string, string | number>>) => string;

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/** Sets the language of the wizard below it. */
export function InstallLocaleProvider({ locale, children }: { locale: Locale; children?: ReactNode }) {
  return createElement(LocaleContext.Provider, { value: locale }, children);
}

export function useInstallLocale(): Locale {
  return useContext(LocaleContext);
}

export function useInstallT(): InstallTranslate {
  const locale = useInstallLocale();
  return useCallback<InstallTranslate>((key, params) => installT(locale, key, params), [locale]);
}

/** How a failed request is told: the shared message of its code, the server's own detail, its trace id. */
export interface ProblemText {
  message: string;
  detail: string | null;
  traceId: string | null;
}

/** The words for `error`: an {@link ApiError} by its code (`error.<CODE>`), anything else as a network failure. */
export function problemText(locale: Locale, error: unknown): ProblemText {
  if (error instanceof ApiError) {
    return {
      message: sharedT(locale, `error.${error.code}` as MessageKey),
      detail: error.detail !== undefined && error.detail !== '' ? error.detail : null,
      traceId: error.traceId ?? null,
    };
  }
  return { message: installT(locale, 'app.network_error'), detail: null, traceId: null };
}

/** `bytes` as MiB or KiB in `locale`'s number format (2621440 → "2,5 MiB"). */
export function formatBytes(locale: Locale, bytes: number): string {
  const format = (n: number) => new Intl.NumberFormat(locale === 'id' ? 'id-ID' : 'en-US', { maximumFractionDigits: 2 }).format(n);
  if (bytes >= 1024 * 1024) return `${format(bytes / (1024 * 1024))} MiB`;
  return `${format(bytes / 1024)} KiB`;
}

/** A wait in seconds as minutes (rounded up) from a minute on, else seconds. */
export function formatWait(locale: Locale, seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return installT(locale, minutes === 1 ? 'claim.minutes_one' : 'claim.minutes', { n: minutes });
  }
  const n = Math.max(1, Math.ceil(seconds));
  return installT(locale, n === 1 ? 'claim.seconds_one' : 'claim.seconds', { n });
}
