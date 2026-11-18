/** The tabs of OPAC › Halaman awal, in their order; each is the last part of its address (the routes read them too). */
export const OPAC_HOME_TABS = Object.freeze(['slider', 'profil', 'layanan', 'galeri', 'jam', 'blok'] as const);

export type OpacHomeTab = (typeof OPAC_HOME_TABS)[number];
