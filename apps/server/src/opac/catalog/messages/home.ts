import { defineOpacMessages } from './define.js';

// The OPAC copy of the home page as the library's profile site: the search card, the popular titles, the "about"
// block with its facts, the services and facilities, and the visit block (location, opening hours). Keys start with
// `home.`; the same keys and {placeholders} in both languages.

export const HOME_MESSAGES = defineOpacMessages(
  {
    'home.search.titles': '{count} judul di katalog',
    'home.popular.title': 'Paling sering dipinjam',
    'home.popular.note': 'Dua belas bulan terakhir. Dihitung dari jumlah peminjaman; nama peminjam tidak pernah ditampilkan.',
    'home.popular.all': 'Lihat semua menurut jumlah peminjaman',
    'home.about.title': 'Tentang perpustakaan',
    'home.about.facts': 'Fakta perpustakaan',
    'home.fact.founded': 'Berdiri',
    'home.fact.titles': 'Koleksi',
    'home.fact.titles_value': '{count} judul',
    'home.fact.members': 'Anggota aktif',
    'home.fact.librarians': 'Pustakawan',
    'home.fact.librarians_value': '{count} orang',
    'home.services.title': 'Layanan dan fasilitas',
    'home.services.photos': 'Foto fasilitas',
    'home.visit.title': 'Kunjungi perpustakaan',
    'home.visit.location': 'Lokasi',
    'home.visit.hours': 'Jam buka',
    'home.visit.days': 'Hari',
    'home.visit.time': 'Jam',
  },
  {
    'home.search.titles': '{count} titles in the catalogue',
    'home.popular.title': 'Most borrowed',
    'home.popular.note': 'The last twelve months. Counted from the number of loans; borrowers are never shown.',
    'home.popular.all': 'See all by number of loans',
    'home.about.title': 'About the library',
    'home.about.facts': 'Library facts',
    'home.fact.founded': 'Founded',
    'home.fact.titles': 'Collection',
    'home.fact.titles_value': '{count} titles',
    'home.fact.members': 'Active members',
    'home.fact.librarians': 'Librarians',
    'home.fact.librarians_value': '{count}',
    'home.services.title': 'Services and facilities',
    'home.services.photos': 'Photos of the facilities',
    'home.visit.title': 'Visit the library',
    'home.visit.location': 'Location',
    'home.visit.hours': 'Opening hours',
    'home.visit.days': 'Days',
    'home.visit.time': 'Hours',
  },
);
