// SLiMS GMDs (`mst_gmd`) as material types (Phase 2 spec §11.4; plan Task 37): each GMD becomes a material type of
// its own, whose code is `gmd_code` (or one made from the name) and whose MARC leader positions, schema.org and DCMI
// types and RDA 336/337/338 codes come from a built-in table of GMD names, by the profile of the seeded material type
// (§2.6) they resemble; a name the table does not know takes the profile of `BUKU`.
//
// The names are the general material designations of AACR2 1.1C (the list SLiMS seeds is drawn from it), their usual
// Indonesian renderings, and a few names libraries add (theses, serials). Clean-room: written from the cataloguing
// standard, not from SLiMS.

/** What a material type takes from its GMD's profile (the columns of `material_types` besides code and names). */
export interface GmdProfile {
  /** Leader/06. */
  marcType: string;
  /** Leader/07. */
  marcLevel: string;
  contentType: string;
  mediaType: string;
  carrierType: string;
  schemaType: string;
  dcmiType: string;
}

const profile = (marcType: string, marcLevel: string, contentType: string, mediaType: string, carrierType: string, schemaType: string, dcmiType: string): GmdProfile =>
  Object.freeze({ marcType, marcLevel, contentType, mediaType, carrierType, schemaType, dcmiType });

/** The profiles, the first eight those of the seeded material types (§2.6). */
const PROFILES = Object.freeze({
  book: profile('a', 'm', 'txt', 'n', 'nc', 'Book', 'Text'),
  ebook: profile('a', 'm', 'txt', 'c', 'cr', 'Book', 'Text'),
  thesis: profile('a', 'm', 'txt', 'n', 'nc', 'Thesis', 'Text'),
  serial: profile('a', 's', 'txt', 'n', 'nc', 'Periodical', 'Text'),
  map: profile('e', 'm', 'cri', 'n', 'nb', 'Map', 'Image'),
  sound: profile('i', 'm', 'spw', 's', 'sd', 'AudioObject', 'Sound'),
  video: profile('g', 'm', 'tdi', 'v', 'vd', 'VideoObject', 'MovingImage'),
  kit: profile('o', 'm', 'xxx', 'n', 'nz', 'CreativeWork', 'Collection'),
  // The other GMDs.
  manuscript: profile('t', 'm', 'txt', 'n', 'nc', 'CreativeWork', 'Text'),
  music: profile('c', 'm', 'ntm', 'n', 'nc', 'CreativeWork', 'Text'),
  musicRecording: profile('j', 'm', 'prm', 's', 'sd', 'MusicRecording', 'Sound'),
  globe: profile('e', 'm', 'crf', 'n', 'nr', 'Map', 'PhysicalObject'),
  picture: profile('k', 'm', 'sti', 'n', 'nb', 'VisualArtwork', 'StillImage'),
  projected: profile('g', 'm', 'sti', 'g', 'gs', 'ImageObject', 'StillImage'),
  filmstrip: profile('g', 'm', 'sti', 'g', 'gf', 'ImageObject', 'StillImage'),
  transparency: profile('g', 'm', 'sti', 'g', 'gt', 'ImageObject', 'StillImage'),
  computerFile: profile('m', 'm', 'cod', 'c', 'cd', 'Dataset', 'Dataset'),
  software: profile('m', 'm', 'cop', 'c', 'cd', 'SoftwareApplication', 'Software'),
  microform: profile('a', 'm', 'txt', 'h', 'he', 'Book', 'Text'),
  microscope: profile('r', 'm', 'sti', 'p', 'pp', 'CreativeWork', 'PhysicalObject'),
  object: profile('r', 'm', 'tdf', 'n', 'nr', 'CreativeWork', 'PhysicalObject'),
  braille: profile('a', 'm', 'tct', 'n', 'nc', 'Book', 'Text'),
} as const);

type ProfileName = keyof typeof PROFILES;

/** GMD names (as `gmdNameKey` writes them) and their profile. */
const NAMES: ReadonlyMap<string, ProfileName> = new Map<string, ProfileName>([
  // AACR2 1.1C
  ['text', 'book'],
  ['art original', 'picture'],
  ['art reproduction', 'picture'],
  ['braille', 'braille'],
  ['cartographic material', 'map'],
  ['chart', 'picture'],
  ['computer file', 'computerFile'],
  ['computer software', 'software'],
  ['diorama', 'object'],
  ['electronic resource', 'ebook'],
  ['equipment', 'object'],
  ['filmstrip', 'filmstrip'],
  ['flash card', 'picture'],
  ['game', 'object'],
  ['globe', 'globe'],
  ['kit', 'kit'],
  ['manuscript', 'manuscript'],
  ['map', 'map'],
  ['microform', 'microform'],
  ['microscope slide', 'microscope'],
  ['model', 'object'],
  ['motion picture', 'video'],
  ['multimedia', 'kit'],
  ['music', 'music'],
  ['picture', 'picture'],
  ['realia', 'object'],
  ['slide', 'projected'],
  ['sound recording', 'sound'],
  ['technical drawing', 'picture'],
  ['toy', 'object'],
  ['transparency', 'transparency'],
  ['videorecording', 'video'],
  ['video recording', 'video'],
  // Names libraries use besides them.
  ['cd-rom', 'computerFile'],
  ['cd rom', 'computerFile'],
  ['dvd', 'video'],
  ['digital versatile disc', 'video'],
  ['vcd', 'video'],
  ['e-book', 'ebook'],
  ['ebook', 'ebook'],
  ['online resource', 'ebook'],
  ['music recording', 'musicRecording'],
  ['audio', 'sound'],
  ['cassette', 'sound'],
  ['photograph', 'picture'],
  ['poster', 'picture'],
  ['serial', 'serial'],
  ['journal', 'serial'],
  ['magazine', 'serial'],
  ['newspaper', 'serial'],
  ['thesis', 'thesis'],
  ['dissertation', 'thesis'],
  ['book', 'book'],
  ['monograph', 'book'],
  // Indonesian
  ['teks', 'book'],
  ['buku', 'book'],
  ['buku elektronik', 'ebook'],
  ['sumber elektronik', 'ebook'],
  ['berkas komputer', 'computerFile'],
  ['perangkat lunak', 'software'],
  ['bahan campuran', 'kit'],
  ['bahan kartografis', 'map'],
  ['peta', 'map'],
  ['bola dunia', 'globe'],
  ['globe dunia', 'globe'],
  ['naskah', 'manuscript'],
  ['manuskrip', 'manuscript'],
  ['musik', 'music'],
  ['partitur', 'music'],
  ['rekaman suara', 'sound'],
  ['rekaman musik', 'musicRecording'],
  ['kaset', 'sound'],
  ['rekaman video', 'video'],
  ['film', 'video'],
  ['gambar', 'picture'],
  ['foto', 'picture'],
  ['bagan', 'picture'],
  ['karya seni', 'picture'],
  ['gambar teknik', 'picture'],
  ['mikrofilm', 'microform'],
  ['mikrofis', 'microform'],
  ['mikroform', 'microform'],
  ['slide mikroskop', 'microscope'],
  ['benda', 'object'],
  ['permainan', 'object'],
  ['transparansi', 'transparency'],
  ['terbitan berseri', 'serial'],
  ['majalah', 'serial'],
  ['jurnal', 'serial'],
  ['surat kabar', 'serial'],
  ['koran', 'serial'],
  ['karya ilmiah', 'thesis'],
  ['skripsi', 'thesis'],
  ['tesis', 'thesis'],
  ['disertasi', 'thesis'],
  ['tugas akhir', 'thesis'],
  ['laporan penelitian', 'thesis'],
  ['huruf braille', 'braille'],
]);

/** A GMD name as the table is keyed: accents stripped, lower case, `[`/`]` dropped, white space collapsed. */
function gmdNameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The profile of the GMD `name` and whether the table knows the name (`matched: false`: `BUKU`'s profile). */
export function gmdProfile(name: string): { profile: GmdProfile; matched: boolean } {
  const known = NAMES.get(gmdNameKey(name));
  return known === undefined ? { profile: PROFILES.book, matched: false } : { profile: PROFILES[known], matched: true };
}
