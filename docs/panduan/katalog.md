# Katalog

Menu **Katalog** di sidebar. Dua istilah yang dipakai di seluruh ALTIS:

- **Cantuman** (bibliografi): data satu judul, yaitu judul, pengarang, penerbit, subjek, nomor panggil.
- **Eksemplar:** satu buku fisik milik sebuah cantuman, dengan barkodnya sendiri. Yang dipinjamkan adalah eksemplar.

[Kembali ke daftar isi](README.md)

## Sebelum mulai: Data Induk dan Lokasi

- **Katalog → Data Induk:** jenis bahan (buku, majalah, dan seterusnya), bahasa, tipe koleksi, pemasok. Tipe koleksi
  menentukan apakah eksemplar boleh dipinjam (misalnya "Referensi" tidak dipinjamkan).
- **Katalog → Lokasi & Rak:** ruang, bagian ruang, dan rak tiap cabang. Bila rak diberi rentang nomor panggil
  (misalnya 800 sampai 899), ALTIS menyarankan rak untuk eksemplar baru. Denah ruang bisa diunggah supaya OPAC
  menunjukkan letak rak.
- **Sistem → Pengaturan → Katalog:** jenis bahan dan tipe koleksi bawaan, pola nomor barkod, profil label, server
  salin katalog (SRU), dan pengaturan pencarian OPAC.

## Cantuman

**Katalog → Bibliografi** menampilkan semua cantuman. Tab di atas daftar menyaring tampilan dan menunjukkan
jumlahnya; chip saringan mempersempit daftar; "Muat lagi" menambah baris.

Menambah cantuman:

1. Tekan **Cantuman baru** dan pilih jenis bahan.
2. Cara tercepat: pindai atau ketik ISBN lalu cari. Bila server salin katalog (SRU) sudah diaktifkan, formulir terisi
   dari cantuman perpustakaan lain. Periksa isinya, lalu simpan.
3. Bila mengetik sendiri: isi judul, pengarang (nama keluarga di depan, misalnya `Toer, Pramoedya Ananta`), penerbit,
   tahun, subjek, dan nomor panggil.
4. Perhatikan kotak **Kemungkinan duplikat** saat mengisi. Bila judul itu sudah ada, buka cantuman yang ada dan
   tambahkan eksemplar di sana.
5. Simpan. Sampul dan lampiran bisa ditambahkan setelah cantuman disimpan.

Hal lain:

- **Lampiran:** berkas atau tautan yang menyertai cantuman. Lampiran publik tampil di OPAC; lampiran bisa juga
  dibatasi untuk anggota yang masuk.
- **Arsipkan** cantuman yang tidak dipakai lagi. Cantuman arsip tidak tampil di OPAC dan bisa dipulihkan.
- **Katalog → Duplikat** memindai seluruh katalog untuk mencari judul ganda, lalu membantu membandingkan dan
  menggabungkan dua cantuman.
- **Katalog → Otoritas** merapikan nama pengarang, penerbit, dan subjek: menggabungkan dua tulisan untuk nama yang
  sama dan mengarsipkan nama yang tidak dipakai lagi.

## Eksemplar

Dari halaman cantuman, buka tab **Eksemplar**:

- **Tambah eksemplar:** satu eksemplar dengan barkod yang Anda pindai atau ketik.
- **Tambah eksemplar dengan pola barkod:** beberapa eksemplar sekaligus; nomor barkod dibuat berurutan dari pola di
  Pengaturan → Katalog.

Untuk setiap eksemplar: cabang, lokasi/rak, tipe koleksi, status, tanggal terima, pemasok, dan harga. Harga dipakai
sebagai biaya penggantian bila eksemplar hilang. Nomor panggil eksemplar boleh dikosongkan untuk mengikuti cantumannya.

**Katalog → Eksemplar** menampilkan eksemplar semua cabang. Pindai barkod di halaman itu untuk langsung membuka
eksemplarnya. Pilih beberapa baris untuk **ubah massal**, misalnya memindahkan lokasi atau mengubah status.

Barkod ISBN di sampul belakang **bukan** barkod eksemplar. ALTIS menolaknya dan meminta barkod label perpustakaan.

**Menyiangi** eksemplar (rusak, usang) dilakukan dari halaman eksemplar. Eksemplar yang disiangi diarsipkan dan
bisa dipakai lagi dengan mengubah statusnya ke Diproses.

## Label dan barkod

1. Siapkan **profil label** di Sistem → Pengaturan → Katalog: ukuran kertas, jumlah kolom dan baris, isi label.
   ALTIS memberi tahu bila label tidak muat di kertasnya.
2. Buka **Katalog → Cetak Label**. Pindai barkod eksemplar untuk memasukkannya ke antrean cetak, atau tambahkan dari
   daftar Bibliografi dan Eksemplar.
3. Pilih profil, lalu **Buat PDF**. Cetak PDF itu pada kertas label dengan skala 100% (tanpa "sesuaikan ke halaman").

Antrean cetak disimpan di peramban yang sedang dipakai. Mengosongkan antrean tidak mengubah data eksemplar.

## Impor dan ekspor

**Katalog → Impor/Ekspor.**

- **Impor cantuman** dari berkas MARC 21, MARCXML, atau CSV. Selalu jalankan **uji kering** dulu: ALTIS membaca seluruh
  berkas tanpa mengubah katalog dan menunjukkan apa yang akan terjadi. Bila hasilnya benar, jalankan impor dengan
  berkas dan opsi yang sama. Impor bisa sekaligus membuat eksemplar bila berkasnya memuat data eksemplar.
- **Ekspor katalog** berjalan di latar belakang; paling banyak 10.000 cantuman teratas per ekspor. Berkasnya bisa
  diunduh selama 7 hari dari Riwayat proses.
- Halaman boleh ditinggalkan selama proses berjalan. Hasilnya ada di **Riwayat proses**.

Untuk pindah dari SLiMS, jangan memakai impor CSV biasa. Pakai [Migrasi dari SLiMS](migrasi-slims.md), yang juga
memindahkan anggota dan pinjaman.
