import { defineOpacMessages } from './define.js';

// The OPAC copy of the shell (Phase 2): the page frame, the home page, robots and sitemaps, and the status pages.
// Owned by Task 21; Task 3 wrote the status pages of opacStatusResponse (S17). Keys start with `shell.`. Copy rules as
// for the shared catalogs: plain Indonesian, "Anda", one term per concept; the same {placeholders} in both languages.
// The ten DDC main classes are our own short wording of the class names, not a copy of a published schedule.

export const SHELL_MESSAGES = defineOpacMessages(
  {
    // Task 3 (S17): the status pages a browser gets for 410, 429 and 503 (404 is the shared `opac.not_found.*`).
    'shell.status.410.title': 'Sudah tidak tersedia',
    'shell.status.410.body': 'Halaman ini sudah dihapus dan tidak tersedia lagi. Kembali ke beranda untuk melanjutkan.',
    'shell.status.429.title': 'Terlalu banyak permintaan',
    'shell.status.429.body': 'Anda mengirim terlalu banyak permintaan dalam waktu singkat. Tunggu sebentar, lalu coba lagi.',
    'shell.status.503.title': 'Layanan sedang tidak tersedia',
    'shell.status.503.body': 'Katalog tidak dapat dibuka saat ini. Silakan coba lagi beberapa saat lagi.',
    // Task 21: the page frame.
    'shell.skip_link': 'Langsung ke konten utama',
    'shell.nav.label': 'Menu utama',
    'shell.search.label': 'Cari di katalog',
    'shell.search.placeholder': 'Judul, pengarang, subjek, atau ISBN',
    'shell.search.submit': 'Cari',
    // The footer's link to the source code (AGPL-3.0 section 13).
    'shell.footer.source': 'Kode sumber (AGPL-3.0)',
    // Task 21: the home page.
    'shell.home.description': 'Katalog daring {library}: cari buku dan koleksi lain, lihat judul baru, dan baca berita perpustakaan.',
    'shell.home.new_titles': 'Judul baru',
    'shell.home.promoted': 'Judul unggulan',
    'shell.home.news': 'Berita terbaru',
    'shell.home.news_all': 'Semua berita',
    'shell.home.classes': 'Jelajahi menurut kelas',
    'shell.home.class.0': 'Karya umum, informasi, dan komputer',
    'shell.home.class.1': 'Filsafat dan psikologi',
    'shell.home.class.2': 'Agama',
    'shell.home.class.3': 'Ilmu sosial',
    'shell.home.class.4': 'Bahasa',
    'shell.home.class.5': 'Sains dan matematika',
    'shell.home.class.6': 'Teknologi dan ilmu terapan',
    'shell.home.class.7': 'Kesenian dan rekreasi',
    'shell.home.class.8': 'Kesusastraan',
    'shell.home.class.9': 'Sejarah dan geografi',
  },
  {
    'shell.status.410.title': 'No longer available',
    'shell.status.410.body': 'This page has been removed and is no longer available. Go back to the home page to continue.',
    'shell.status.429.title': 'Too many requests',
    'shell.status.429.body': 'You sent too many requests in a short time. Wait a moment, then try again.',
    'shell.status.503.title': 'Service unavailable',
    'shell.status.503.body': 'The catalogue cannot be opened right now. Please try again in a few minutes.',
    'shell.skip_link': 'Skip to main content',
    'shell.nav.label': 'Main menu',
    'shell.search.label': 'Search the catalogue',
    'shell.search.placeholder': 'Title, author, subject or ISBN',
    'shell.search.submit': 'Search',
    'shell.footer.source': 'Source code (AGPL-3.0)',
    'shell.home.description': 'The online catalogue of {library}: search books and other materials, see new titles and read library news.',
    'shell.home.new_titles': 'New titles',
    'shell.home.promoted': 'Featured titles',
    'shell.home.news': 'Latest news',
    'shell.home.news_all': 'All news',
    'shell.home.classes': 'Browse by class',
    'shell.home.class.0': 'General works, information and computing',
    'shell.home.class.1': 'Philosophy and psychology',
    'shell.home.class.2': 'Religion',
    'shell.home.class.3': 'Social sciences',
    'shell.home.class.4': 'Language',
    'shell.home.class.5': 'Science and mathematics',
    'shell.home.class.6': 'Technology and applied sciences',
    'shell.home.class.7': 'Arts and recreation',
    'shell.home.class.8': 'Literature',
    'shell.home.class.9': 'History and geography',
  },
);
