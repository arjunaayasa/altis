# Inventarisasi

**Layanan → Inventarisasi** adalah stock opname per cabang: mencocokkan buku di rak dengan catatan ALTIS.

[Kembali ke daftar isi](README.md)

## Langkah

1. **Buat sesi baru.** Beri nama dan tentukan cakupannya: seluruh cabang, atau lokasi/rak tertentu (lokasi di bawahnya
   ikut). Mengerjakan satu ruang per sesi membuat pekerjaan lebih mudah dibagi.
2. **Pindai eksemplar di rak.** Beberapa petugas bisa memindai sekaligus dari perangkat masing-masing; pemindai bekerja
   di mana pun di halaman itu. Layanan peminjaman tetap berjalan selama sesi.
3. **Tanpa sambungan di rak?** Kumpulkan barkod ke berkas teks atau CSV (satu kode per baris), lalu unggah. Kode itu
   dicatat sebagai pindaian Anda.
4. **Perhatikan penjelasan tiap pindaian:**
   - *salah tempat:* ditemukan, tetapi seharusnya di lokasi lain;
   - *tercatat dipinjam:* buku ada di rak padahal pinjamannya belum ditutup. Periksa di Meja Layanan;
   - *tak terduga:* di luar cakupan sesi atau milik cabang lain;
   - *kode tak dikenal:* bukan barkod eksemplar.
5. **Selesaikan sesi.** ALTIS menunjukkan berapa eksemplar yang belum ditemukan. Anda bisa memilih:
   - menandai yang belum ditemukan sebagai **hilang** (hanya yang berstatus tersedia atau tidak dipinjamkan; eksemplar
     yang sedang dipinjam tidak pernah ditandai hilang);
   - mengembalikan eksemplar berstatus hilang yang ternyata ditemukan menjadi **tersedia**.
6. **Cetak berita acara (PDF)** sebagai bukti kegiatan. Berita acara ini juga bisa dilampirkan sebagai bukti di ruang
   Akreditasi.

## Catatan

- Sesi yang dibatalkan tidak mengubah eksemplar apa pun; pindaiannya tetap tersimpan.
- Setelah sesi diselesaikan, pemindaian ditutup. Periksa dulu daftar "belum ditemukan" sebelum menandainya hilang:
  buku yang sedang dibaca di ruang baca atau menunggu di troli belum tentu hilang.
- Bila sesi tampak macet saat diselesaikan, lihat Sistem → Diagnostik (bagian Inventarisasi) atau Sistem → Tugas dan
  Jadwal.
