# Migrasi dari SLiMS

**Katalog → Migrasi SLiMS** memindahkan data SLiMS 9 (SLiMS 8 sebisanya) ke ALTIS: cantuman, eksemplar, lokasi,
lampiran dan sampul, anggota, kunjungan, pinjaman, reservasi, dan denda.

Yang penting dipahami lebih dulu:

- Migrasi hanya **membaca** SLiMS. SLiMS Anda tidak diubah dan bisa tetap dipakai selama masa persiapan.
- Selalu ada **uji kering** sebelum migrasi sungguhan. Uji kering tidak menulis apa pun; hasilnya laporan.
- Migrasi boleh **diulang**. Data yang sudah dipindahkan tidak digandakan.

[Kembali ke daftar isi](README.md)

## Urutan yang dianjurkan

### 1. Siapkan ALTIS

- Pasang ALTIS dan selesaikan "Mulai di sini" di [daftar isi](README.md) sampai profil perpustakaan dan cabang.
- **Buat cadangan** sebelum migrasi sungguhan (Sistem → Cadangan).
- Tipe anggota, lokasi, dan data induk ikut dibawa dari SLiMS, jadi tidak perlu diketik ulang.

### 2. Ambil data dari SLiMS

Pilih salah satu sumber:

- **Berkas dump SQL** (`.sql` atau `.sql.gz`) hasil ekspor basis data SLiMS dari phpMyAdmin atau mysqldump. Ini cara
  yang paling mudah.
- **Koneksi langsung** ke basis data SLiMS (host, port, pengguna, kata sandi, nama basis data). Kata sandi tidak
  disimpan; ALTIS memintanya lagi saat migrasi dijalankan.

Opsional tetapi dianjurkan: **arsip berkas** (.zip) berisi folder `repository/` dan `images/` dari folder SLiMS, supaya
lampiran, sampul, dan foto anggota ikut pindah. Arsip hanya bisa dipilih sebelum uji kering.

### 3. Uji kering pertama

1. Pilih sumber, lalu isi **Opsi**: cabang tujuan, cara membaca harga dan denda (rupiah utuh adalah bawaan), dan
   **nama sumber** (biarkan sama setiap kali mengulang dari SLiMS yang sama).
2. Bagian **Anggota, kunjungan, dan sirkulasi:** pilih tipe anggota cadangan untuk anggota yang tipenya sudah terhapus,
   dan periksa **kelompok akreditasi** tiap tipe anggota.
3. Tekan **Mulai uji kering**. Halaman boleh ditinggalkan; hasilnya ada di Riwayat migrasi.

### 4. Baca laporannya

- **Rekonsiliasi** harus lulus: setiap baris sumber tercatat (dipindahkan, atau dilewati dengan alasannya).
- **Periksa sebelum run nyata:** daftar hal yang perlu perhatian, masing-masing dengan contoh.
- Yang paling sering perlu diperbaiki **di SLiMS**, lalu uji kering diulang:
  - nomor anggota yang bertabrakan (misalnya `b 001` dan `B001` dianggap sama oleh ALTIS);
  - anggota yang tipenya sudah terhapus;
  - pinjaman terbuka yang eksemplarnya sudah tidak ada.

### 5. Migrasi pertama

Dari uji kering yang hasilnya baik, tekan **Jalankan migrasi**. Uji kering berlaku 7 hari dan hanya bisa dipakai oleh
pengguna yang memulainya. Katalog tujuan harus masih kosong, kecuali Anda sengaja mengizinkan katalog yang sudah
berisi.

Setelah selesai, bandingkan beberapa judul dan anggota dengan SLiMS, dan lihat tabel **Cocokkan dengan SLiMS**.

### 6. Masa persiapan

Selama masa ini SLiMS masih dipakai untuk melayani. Di ALTIS, kerjakan daftar periksa **Pindah dari SLiMS**:

- buat peran dan akun petugas; aktifkan dan beri kata sandi paling sedikit satu petugas meja. Akun petugas SLiMS yang
  ikut pindah masuk dalam keadaan nonaktif dan tanpa kata sandi;
- periksa **Aturan Peminjaman**, **Kalender**, dan pengaturan denda;
- aktifkan **perangkat buku tamu** untuk tiap ruang yang memakainya;
- buka **daftar cetak ulang kartu dan label**, lalu jadwalkan pencetakannya;
- berikan izin paksa meja layanan kepada petugas yang perlu mencatat pinjaman bertanggal mundur;
- kenalkan petugas pada layar-layar ALTIS.

**Jangan mencatat pinjaman, pengembalian, pembayaran, atau reservasi di ALTIS pada masa ini**, juga untuk latihan.
Begitu ALTIS mencatat sirkulasi sendiri, mode sirkulasi **Ganti** pada hari pindah ditolak. Untuk latihan transaksi,
pakai pemasangan ALTIS lain yang terpisah.

### 7. Hari pindah

1. **Hentikan transaksi di SLiMS** (tutup layanan sebentar atau lakukan setelah jam layanan).
2. Ambil dump terbaru dari SLiMS.
3. Jalankan uji kering lalu migrasi sekali lagi dengan: mode katalog **Selaraskan dengan SLiMS**, anggota
   **Selaraskan**, dan sirkulasi **Ganti**. Dengan begitu perubahan terakhir di SLiMS ikut terbawa. Cantuman, eksemplar,
   dan anggota yang sudah Anda sunting di ALTIS tidak ditimpa; selisihnya dicatat di laporan.
4. Pastikan rekonsiliasi dan **Cocokkan dengan SLiMS** tanpa selisih yang tidak terjelaskan.

### 8. Mulai melayani

Setelah semua butir wajib di daftar periksa selesai, tombol **Mulai melayani** aktif. Menekannya berarti:

- mulai saat itu layanan berjalan di ALTIS, dan SLiMS tidak dipakai lagi untuk transaksi;
- migrasi ulang masih bisa menambah dan menyelaraskan data, tetapi mode sirkulasi **Ganti** tidak bisa dipakai lagi;
- langkah ini **tidak dapat dibatalkan**.

Simpan SLiMS lama dalam keadaan hanya-baca beberapa waktu sebagai rujukan, dan buat cadangan ALTIS setelah hari pertama
layanan.

## Yang tidak ikut pindah

- **Kata sandi** petugas dan anggota. Petugas diberi kata sandi baru; kata sandi OPAC anggota diatur dari halaman
  anggotanya.
- **Peran dan hak akses** SLiMS. Laporan migrasi memuat daftar grup SLiMS sebagai acuan untuk membuat peran di ALTIS.
- Tabel dan kolom SLiMS yang tidak dikenal (misalnya dari plugin). Laporan uji kering menyebutkannya.

## Bila ada masalah

- Proses berhenti di tengah: buka Riwayat migrasi dan baca peringatannya. Sebagian besar cukup dimulai lagi dari uji
  kering baru.
- "Uji kering ini tidak bisa dipakai lagi": sudah lebih dari 7 hari, sudah dipakai, atau dimulai pengguna lain.
- "Katalog tujuan sudah berisi cantuman": centang izin katalog tidak kosong dan ketik nama perpustakaan, bila memang
  ingin menambahkan ke katalog itu.
