# Kebijakan keamanan (Security policy)

## Melaporkan celah keamanan

Laporkan celah keamanan **secara privat** lewat GitHub: buka tab **Security** repositori ini, lalu
**Report a vulnerability** (*private vulnerability reporting*). Jangan pernah melaporkannya di isu publik,
*discussion*, atau PR.

Sertakan versi ALTIS, runtime (Docker, cPanel, PM2, PC), mesin database, langkah untuk mereproduksi, dan dampak yang
Anda lihat. Jangan menyertakan data pribadi pengguna perpustakaan, sandi, token, atau isi `config.json`.

*Report vulnerabilities privately through the repository's **Security** tab, **Report a vulnerability**. Never in
public issues, discussions or pull requests.*

## Versi yang didukung

Hanya rilis terbaru yang menerima perbaikan keamanan. ALTIS belum mencapai 1.0; perbaikan dirilis sebagai versi baru,
bukan *backport*.

*Supported versions: the latest release only.*

## Build uji dan kunci rilis

- **Jangan pernah memasang build `-test`** (misalnya `altis-0.1.0-test.zip`) untuk data sungguhan. Build uji
  mempercayai kunci pengembangan publik di `tools/keys/dev`, yang kunci privatnya ada di repositori ini: siapa pun
  dapat menandatangani "pembaruan" yang akan diterima build itu. Artefak build uji dari CI juga termasuk.
- Build produksi hanya mempercayai kunci root yang tertanam saat build (`--root-keys`) dan kunci yang dipercaya
  dokumen *keyset* bertanda tangan root-root itu. Build produksi menolak setiap kunci `dev-`.
- Fork yang menerbitkan rilisnya sendiri wajib membuat kunci sendiri ([docs/ops/release-signing.md](docs/ops/release-signing.md))
  dan menjaga kunci privatnya di luar repositori.

*Never deploy a `-test` build: it trusts the public development keys. Production builds trust only the root keys
embedded at build time.*
