// The MARC test corpus of Phase 2 Task 6 (K5): 50+ hand-written synthetic records (fictional titles and people, no real
// catalogue data, nothing from SLiMS). Together they cover MARC-8 with diacritics, 260 and 264 _1, every 6XX type
// (610/611 included), 852 and 952, unmapped 5XX/7XX/9XX, 020 with $q, 024 7_ doi and 856. Also: a test-only MARC-8
// encoder (independent of the decoder's table), an ISO 2709 writer for MARC-8 records, and `asData`, which turns a draft
// into the RecordData the export takes.
import type { RecordData, RecordDraft } from '@altis/shared/api/catalog/record-data';
import type { MarcControlField, MarcDataField, MarcRecord } from '../../src/marc/index.js';

// ---- builders ----------------------------------------------------------------------------------------------------

/** A control field. */
export function cf(tag: string, value: string): MarcControlField {
  return { tag, value };
}

/** A data field: `ind` is the two indicators, each subfield is written `<code><value>` (`'aLaskar pelangi'`). */
export function df(tag: string, ind: string, ...subfields: string[]): MarcDataField {
  return { tag, ind1: ind[0] ?? ' ', ind2: ind[1] ?? ' ', subfields: subfields.map((s) => [s.slice(0, 1), s.slice(1)] as [string, string]) };
}

/** A 40-character 008 for books: entered 2026-10-01, single date `date1`, place `io ` (Indonesia), language `lang`. */
export function f008(date1: string, lang: string): string {
  return `261001s${date1}    io ${' '.repeat(12)}000 0${lang} d`;
}

const L_UTF8 = (type: string) => `00000n${type} a2200000 i 4500`;
const L_MARC8 = (type: string) => `00000n${type}  2200000 a 4500`;

export interface CorpusEntry {
  name: string;
  record: MarcRecord;
  /** Stored as MARC-8 ISO 2709 (leader/09 blank): tests read it through readIso2709(marc8Iso2709(record)). */
  marc8?: boolean;
}

// ---- the corpus --------------------------------------------------------------------------------------------------

export const CORPUS: readonly CorpusEntry[] = [
  {
    name: 'novel, 264 _1, RDA, full set',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0001'),
        cf('003', 'ID-JKPN'),
        cf('005', '20200101120000.0'),
        cf('008', f008('2010', 'ind')),
        df('020', '  ', 'a9786020000011'),
        df('040', '  ', 'aID-JKPN', 'bind', 'erda'),
        df('041', '0 ', 'aind'),
        df('082', '04', 'a899.2213', '223'),
        df('090', '  ', 'a899.2213', 'bHIR l'),
        df('100', '1 ', 'aHirata, Andrea,', 'epengarang.'),
        df('245', '10', 'aLaskar pelangi :', 'bsebuah novel /', 'cAndrea Hirata.'),
        df('250', '  ', 'aCetakan ke-5.'),
        df('264', ' 1', 'aYogyakarta :', 'bBentang,', 'c2010.'),
        df('300', '  ', 'axii, 529 halaman ;', 'c20 cm'),
        df('336', '  ', 'atext', 'btxt', '2rdacontent'),
        df('337', '  ', 'aunmediated', 'bn', '2rdamedia'),
        df('338', '  ', 'avolume', 'bnc', '2rdacarrier'),
        df('500', '  ', 'aNovel pertama dari sebuah tetralogi.'),
        df('520', '  ', 'aKisah sepuluh anak di sebuah pulau timah.'),
        df('650', ' 4', 'aFiksi Indonesia.'),
        df('952', '  ', 'aPUSAT', 'bPUSAT', 'cRAK-FIK', 'o899.2213 HIR l', 'pB000001', 'yUMUM'),
      ],
    },
  },
  {
    name: 'MARC-8: German diacritics, 260, translator',
    marc8: true,
    record: {
      leader: L_MARC8('am'),
      fields: [
        cf('001', 'M80001'),
        cf('008', f008('1931', 'ger')),
        df('100', '1 ', 'aGödel, Kurt,', 'd1906-1978.'),
        df('245', '10', 'aÜber formal unentscheidbare Sätze /', 'cKurt Gödel.'),
        df('260', '  ', 'aWien :', 'bSpringer,', 'cc1931.'),
        df('300', '  ', 'a38 p.'),
        df('650', ' 0', 'aLogik.'),
        df('700', '1 ', 'aMüller, Jürgen,', 'etranslator.'),
      ],
    },
  },
  {
    name: 'MARC-8: Vietnamese stacked marks and the horn letters',
    marc8: true,
    record: {
      leader: L_MARC8('am'),
      fields: [
        cf('001', 'M80002'),
        cf('008', f008('2005', 'vie')),
        df('100', '1 ', 'aĐặng, Thùy Trâm,', 'd1942-1970.'),
        df('245', '10', 'aNhật ký Đặng Thùy Trâm /', 'cĐặng Thùy Trâm.'),
        df('260', '  ', 'aHà Nội :', 'bNhà xuất bản Hội Nhà văn,', 'c2005.'),
        df('651', ' 0', 'aViệt Nam', 'xLịch sử.'),
      ],
    },
  },
  {
    name: 'MARC-8: Nordic and Polish letters, copyright sign, ß',
    marc8: true,
    record: {
      leader: L_MARC8('am'),
      fields: [
        cf('001', 'M80003'),
        cf('008', f008('1999', 'swe')),
        df('100', '1 ', 'aÅngström, Øyvind,', 'd1950-'),
        df('245', '10', 'aÆsthetik der Straße und Łódź /', 'cØyvind Ångström ; mit Beiträgen von Paweł Łukasiewicz.'),
        df('260', '  ', 'aStockholm :', 'bNorstedt,', 'c©1999.'),
        df('500', '  ', 'aTeks dalam bahasa Swedia dengan ringkasan bahasa Jerman.'),
        df('700', '1 ', 'aŁukasiewicz, Paweł,', 'ectb'),
      ],
    },
  },
  {
    name: 'MARC-8: French and Spanish accents, cedilla and tilde',
    marc8: true,
    record: {
      leader: L_MARC8('am'),
      fields: [
        cf('001', 'M80004'),
        cf('008', f008('1988', 'fre')),
        df('100', '1 ', 'aPérez, Begoña.'),
        df('245', '13', 'aLe garçon de São Paulo :', 'broman /', 'cBegoña Pérez ; traduit par François Lefèvre.'),
        df('260', '  ', 'aParis :', 'bÉditions du Cèdre,', 'c1988.'),
        df('650', ' 0', 'aRomans brésiliens.'),
        df('700', '1 ', 'aLefèvre, François,', 'etrl'),
      ],
    },
  },
  {
    name: 'MARC-8: Turkish dotless i and Arabic transliteration marks',
    marc8: true,
    record: {
      leader: L_MARC8('am'),
      fields: [
        cf('001', 'M80005'),
        cf('008', f008('2001', 'ind')),
        df('100', '1 ', 'aYılmaz, Ayşe.'),
        df('245', '10', 'aKitab al-ʻilm wa-al-ʼadab /', 'cAyşe Yılmaz.'),
        df('264', ' 1', 'aJakarta :', 'bPustaka Ilmu,', 'c2001.'),
        df('650', ' 4', 'aIlmu pengetahuan Islam.'),
      ],
    },
  },
  {
    name: 'every 6XX type, 610 and 611 as names',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0007'),
        cf('008', f008('2015', 'ind')),
        df('100', '1 ', 'aSastrowardoyo, Dewi.'),
        df('245', '10', 'aSejarah pergerakan nasional /', 'cDewi Sastrowardoyo.'),
        df('264', ' 1', 'aBandung :', 'bPenerbit Merah Putih,', 'c2015.'),
        df('600', '10', 'aSoekarno,', 'd1901-1970', 'xPidato.'),
        df('610', '20', 'aBoedi Oetomo.'),
        df('611', '20', 'aKongres Pemuda', 'n(2 :', 'd1928 :', 'cJakarta)'),
        df('648', ' 7', 'a1908-1945', '2fast'),
        df('650', ' 0', 'aNasionalisme', 'zIndonesia', 'xSejarah', 'y20th century.'),
        df('651', ' 0', 'aIndonesia', 'xPolitics and government.'),
        df('655', ' 7', 'aHistories.', '2lcgft'),
        df('656', ' 7', 'aSejarawan.', '2local'),
      ],
    },
  },
  {
    name: 'items in 952 (Koha style) with prices',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0008'),
        cf('008', f008('2018', 'ind')),
        df('020', '  ', 'a9786020000035'),
        df('245', '00', 'aAntologi puisi remaja /', 'cdisunting oleh Rina Wulandari.'),
        df('264', ' 1', 'aSurabaya :', 'bSastra Muda,', 'c2018.'),
        df('700', '1 ', 'aWulandari, Rina,', 'eeditor.'),
        df('952', '  ', 'aPUSAT', 'cRAK-PUI', 'g45000.00', 'o811 ANT', 'pB000101', 'yUMUM'),
        df('952', '  ', 'aCAB1', 'cREF', 'g45000.00', 'o811 ANT c.2', 'pB000102', 'yREF'),
      ],
    },
  },
  {
    name: 'items in 852 and a holdings 852 without a barcode',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0009'),
        cf('008', f008('2012', 'eng')),
        df('100', '1 ', 'aCarter, Helen.'),
        df('245', '10', 'aField guide to tropical birds /', 'cHelen Carter.'),
        df('264', ' 1', 'aLondon :', 'bGreenleaf,', 'c2012.'),
        df('650', ' 0', 'aBirds', 'zTropics', 'vIdentification.'),
        df('852', '  ', 'aID-JKPN', 'bPUSAT', 'cRAK-598', 'h598.0913', 'iCAR f', 'pB000201'),
        df('852', '  ', 'aID-JKPN', 'bPUSAT', 'cRAK-598', 'h598.0913', 'iCAR f', 'pB000202'),
        df('852', '  ', 'aID-JKPN', 'bCAB2', 'cDEPO', 'h598.0913'),
      ],
    },
  },
  {
    name: 'unmapped 5XX, 7XX and 9XX fields',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0010'),
        cf('008', f008('2008', 'ind')),
        df('100', '1 ', 'aNugroho, Bayu.'),
        df('245', '10', 'aKumpulan esai budaya /', 'cBayu Nugroho.'),
        df('264', ' 1', 'aMalang :', 'bPustaka Kota,', 'c2008.'),
        df('504', '  ', 'aBibliografi: halaman 201-210.'),
        df('505', '0 ', 'aBudaya kota -- Budaya desa -- Budaya maya.'),
        df('546', '  ', 'aTeks dalam bahasa Indonesia.'),
        df('700', '12', 'aNugroho, Bayu.', 'tEsai pilihan.'),
        df('730', '0 ', 'aSerat Centhini.'),
        df('740', '02', 'aBudaya kita.'),
        df('990', '  ', 'aKOLEKSI-KHUSUS'),
        df('999', '  ', 'c1234', 'd1234'),
      ],
    },
  },
  {
    name: '020 with $q, a qualifier in $a and a cancelled ISBN',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0011'),
        cf('008', f008('2019', 'ind')),
        df('020', '  ', 'a979-1234-56-7 (jil. 1)'),
        df('020', '  ', 'a9786020000042', 'q(pbk.)'),
        df('020', '  ', 'a0-306-40615-2', 'qjil. 2', 'z9786020000099'),
        df('245', '00', 'aEnsiklopedia anak nusantara.'),
        df('264', ' 1', 'aJakarta :', 'bCerdas Ceria,', 'c2019.'),
      ],
    },
  },
  {
    name: '024 7_ doi, 024 8_ and an EAN 024 3_',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0012'),
        cf('008', f008('2020', 'eng')),
        df('024', '7 ', 'a10.1234/jpi.2020.0042', '2doi'),
        df('024', '8 ', 'aLAPORAN-2020-07', 'qversi cetak'),
        df('024', '3 ', 'a9771234567003'),
        df('100', '1 ', 'aPratama, Arif.'),
        df('245', '10', 'aLaporan penelitian kualitas air /', 'cArif Pratama.'),
        df('264', ' 1', 'aBogor :', 'bLembaga Riset Air,', 'c2020.'),
        df('650', ' 0', 'aWater quality.'),
      ],
    },
  },
  {
    name: '856 links and an 856 without a URL',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0013'),
        cf('008', f008('2021', 'ind')),
        df('245', '00', 'aPanduan literasi digital.'),
        df('264', ' 1', 'aJakarta :', 'bLiterasi Kita,', 'c2021.'),
        df('856', '40', 'uhttps://example.org/panduan.pdf', 'yTeks lengkap'),
        df('856', '42', 'uhttp://example.org/sampul.jpg'),
        df('856', '4 ', '3Daftar isi', 'zAkses hanya di perpustakaan'),
      ],
    },
  },
  {
    name: 'serial, 022 ISSN',
    record: {
      leader: L_UTF8('as'),
      fields: [
        cf('001', 'S0001'),
        cf('008', '261001c20109999io mr p       0   a0ind d'),
        df('022', '0 ', 'a0126-1238'),
        df('245', '00', 'aJurnal pustaka nusantara.'),
        df('264', ' 1', 'aJakarta :', 'bIkatan Pustakawan,', 'c2010-'),
        df('310', '  ', 'aBulanan'),
        df('362', '0 ', 'aVol. 1, no. 1 (Jan. 2010)-'),
        df('650', ' 4', 'aIlmu perpustakaan', 'vMajalah.'),
      ],
    },
  },
  {
    name: 'map, 255 scale',
    record: {
      leader: L_UTF8('em'),
      fields: [
        cf('001', 'P0001'),
        cf('007', 'aj canzn'),
        cf('008', f008('2016', 'ind')),
        df('110', '2 ', 'aBadan Pemetaan Nasional.'),
        df('245', '10', 'aPeta Jawa Barat /', 'cBadan Pemetaan Nasional.'),
        df('255', '  ', 'aSkala 1:250.000'),
        df('264', ' 1', 'aCibinong :', 'bBadan Pemetaan Nasional,', 'c2016.'),
        df('300', '  ', 'a1 peta :', 'bberwarna ;', 'c60 x 90 cm'),
        df('651', ' 0', 'aJawa Barat', 'vPeta.'),
      ],
    },
  },
  {
    name: 'computer file, 256',
    record: {
      leader: L_UTF8('mm'),
      fields: [
        cf('001', 'E0001'),
        cf('008', f008('2022', 'ind')),
        df('245', '00', 'aBasis data koleksi naskah.'),
        df('256', '  ', 'aData elektronik (1 berkas)'),
        df('264', ' 1', 'aYogyakarta :', 'bArsip Digital,', 'c2022.'),
        df('538', '  ', 'aMembutuhkan peramban web.'),
      ],
    },
  },
  {
    name: 'series in 490 and 830',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0017'),
        cf('008', f008('2014', 'ind')),
        df('100', '1 ', 'aKusuma, Lestari.'),
        df('245', '10', 'aCerita rakyat Sumatra /', 'cLestari Kusuma.'),
        df('264', ' 1', 'aMedan :', 'bTanah Air,', 'c2014.'),
        df('490', '1 ', 'aSeri pustaka nusantara ;', 'v12'),
        df('830', ' 0', 'aSeri pustaka nusantara ;', 'vno. 12.'),
        df('650', ' 4', 'aCerita rakyat', 'zSumatra.'),
      ],
    },
  },
  {
    name: 'series in 440',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0018'),
        cf('008', f008('1995', 'ind')),
        df('100', '1 ', 'aRahman, Abdul.'),
        df('245', '10', 'aCerpen pilihan /', 'cAbdul Rahman.'),
        df('260', '  ', 'aJakarta :', 'bBalai Bacaan,', 'c1995.'),
        df('440', ' 0', 'aKumpulan cerpen ;', 'v3'),
      ],
    },
  },
  {
    name: 'call number from 050 (no 090)',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0019'),
        cf('008', f008('2011', 'eng')),
        df('050', '00', 'aPL5089.H57', 'bL37 2011'),
        df('082', '00', 'a899.2213'),
        df('082', '04', 'a899.221'),
        df('100', '1 ', 'aHirata, Andrea.'),
        df('245', '14', 'aThe rainbow troops /', 'cAndrea Hirata.'),
        df('264', ' 1', 'aNew York :', 'bSea Lantern,', 'c2011.'),
      ],
    },
  },
  {
    name: 'call number from 852 $h, both 090 and 050 absent',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0020'),
        cf('008', f008('2003', 'ind')),
        df('245', '00', 'aKamus istilah pertanian.'),
        df('264', ' 1', 'aBogor :', 'bAgro Media,', 'c2003.'),
        df('852', '  ', 'bPUSAT', 'cREF', 'h630.3 KAM'),
      ],
    },
  },
  {
    name: 'nonfiling article, The',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0021'),
        cf('008', f008('1937', 'eng')),
        df('100', '1 ', 'aTolkin, Jonathan R.'),
        df('245', '14', 'aThe burrow, or, There and back again /', 'cJonathan R. Tolkin.'),
        df('260', '  ', 'aLondon :', 'bAllen,', 'c1937.'),
        df('650', ' 0', 'aFantasy fiction.'),
      ],
    },
  },
  {
    name: '245 with $n, $p and a residual $h',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0022'),
        cf('008', f008('2007', 'ind')),
        df('245', '00', 'aEnsiklopedia flora Indonesia.', 'nJilid 2,', 'pTumbuhan obat', 'h[teks] /', 'ctim penyusun.'),
        df('264', ' 1', 'aJakarta :', 'bLembaga Ilmu,', 'c2007.'),
        df('650', ' 0', 'aMedicinal plants', 'zIndonesia.'),
      ],
    },
  },
  {
    name: 'many agents: editor, translator by $4, organisation and meeting added entries',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0023'),
        cf('008', f008('2017', 'ind')),
        df('245', '00', 'aProsiding temu ilmiah pustakawan /', 'cpenyunting, Sari Dewi ; penerjemah, Tom Baker.'),
        df('264', ' 1', 'aSemarang :', 'bUniversitas Pantai,', 'c2017.'),
        df('700', '1 ', 'aDewi, Sari,', 'epenyunting.'),
        df('700', '1 ', 'aBaker, Tom,', '4trl'),
        df('710', '2 ', 'aUniversitas Pantai.', 'bPerpustakaan.'),
        df('711', '2 ', 'aTemu Ilmiah Pustakawan', 'n(4 :', 'd2017 :', 'cSemarang)'),
        df('650', ' 4', 'aPerpustakaan', 'vKongres.'),
      ],
    },
  },
  {
    name: 'organisation as main entry',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0024'),
        cf('008', f008('2020', 'ind')),
        df('110', '2 ', 'aIndonesia.', 'bKementerian Pendidikan dan Kebudayaan.'),
        df('245', '10', 'aStatistik pendidikan 2020 /', 'cKementerian Pendidikan dan Kebudayaan.'),
        df('264', ' 1', 'aJakarta :', 'bKemendikbud,', 'c2020.'),
        df('650', ' 4', 'aPendidikan', 'xStatistik.'),
      ],
    },
  },
  {
    name: 'meeting as main entry',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0025'),
        cf('008', f008('2019', 'ind')),
        df('111', '2 ', 'aSeminar Nasional Perpustakaan', 'n(3 :', 'd2019 :', 'cJakarta)'),
        df('245', '10', 'aMakalah seminar nasional perpustakaan.'),
        df('264', ' 1', 'aJakarta :', 'bPanitia Seminar,', 'c2019.'),
      ],
    },
  },
  {
    name: 'spoken-word audio',
    record: {
      leader: L_UTF8('im'),
      fields: [
        cf('001', 'A0001'),
        cf('007', 'sd fsngnnmmned'),
        cf('008', f008('2018', 'ind')),
        df('100', '1 ', 'aWibowo, Hendra,', 'enarrator.'),
        df('245', '10', 'aDongeng sebelum tidur /', 'cHendra Wibowo.'),
        df('264', ' 1', 'aJakarta :', 'bSuara Anak,', 'c2018.'),
        df('300', '  ', 'a1 cakram audio (60 menit)'),
        df('336', '  ', 'aspoken word', 'bspw', '2rdacontent'),
        df('337', '  ', 'aaudio', 'bs', '2rdamedia'),
        df('338', '  ', 'aaudio disc', 'bsd', '2rdacarrier'),
      ],
    },
  },
  {
    name: 'video with a system note',
    record: {
      leader: L_UTF8('gm'),
      fields: [
        cf('001', 'V0001'),
        cf('007', 'vd cvaizu'),
        cf('008', f008('2016', 'ind')),
        df('245', '00', 'aJejak rempah nusantara.'),
        df('264', ' 1', 'aJakarta :', 'bSinema Dokumenter,', 'c2016.'),
        df('300', '  ', 'a1 cakram video (90 menit) :', 'bberwarna'),
        df('336', '  ', 'atwo-dimensional moving image', 'btdi', '2rdacontent'),
        df('538', '  ', 'aDVD.'),
        df('700', '1 ', 'aSantoso, Rudi,', 'edirector.'),
      ],
    },
  },
  {
    name: 'thesis (manuscript) with a dissertation note',
    record: {
      leader: L_UTF8('tm'),
      fields: [
        cf('001', 'T0001'),
        cf('008', f008('2021', 'ind')),
        df('100', '1 ', 'aPuspita, Nadia.'),
        df('245', '10', 'aAnalisis layanan referensi digital /', 'cNadia Puspita.'),
        df('264', ' 0', 'aDepok,', 'c2021.'),
        df('300', '  ', 'axiv, 120 lembar'),
        df('502', '  ', 'aSkripsi (S1)--Universitas Contoh, 2021.'),
        df('650', ' 4', 'aLayanan referensi.'),
      ],
    },
  },
  {
    name: 'several notes and summaries',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0029'),
        cf('008', f008('2009', 'ind')),
        df('245', '00', 'aBunga rampai pendidikan.'),
        df('264', ' 1', 'aSolo :', 'bTiga Serangkai,', 'c2009.'),
        df('500', '  ', 'aIndeks.'),
        df('500', '  ', 'aJudul sampul: Rampai pendidikan.'),
        df('500', '  ', 'aEdisi terbatas.'),
        df('520', '  ', 'aMembahas pendidikan dasar.'),
        df('520', '  ', 'aDisertai studi kasus dari tiga provinsi.'),
      ],
    },
  },
  {
    name: 'no 008: language from 041',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0030'),
        df('041', '0 ', 'ajav', 'bind'),
        df('245', '00', 'aSerat wulangreh.'),
        df('264', ' 1', 'aSurakarta :', 'bPustaka Jawa,', 'c1990.'),
      ],
    },
  },
  {
    name: '008 without a language code, 041 with two languages',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0031'),
        cf('008', f008('2002', '   ')),
        df('041', '1 ', 'asun', 'hind'),
        df('245', '00', 'aCarita Sunda kawentar.'),
        df('260', '  ', 'aBandung :', 'bKiblat,', 'c2002.'),
      ],
    },
  },
  {
    name: '006 and 007 control fields',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0032'),
        cf('006', 'm     o  d        '),
        cf('007', 'cr |||||||||||'),
        cf('008', f008('2023', 'ind')),
        df('245', '00', 'aBuku elektronik pengantar statistika.'),
        df('264', ' 1', 'aJakarta :', 'bData Press,', 'c2023.'),
        df('856', '40', 'uhttps://example.org/statistika', 'yAkses daring'),
      ],
    },
  },
  {
    name: '880 parallel script with a $6 link in 245',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0033'),
        cf('008', f008('2010', 'ara')),
        df('245', '10', '6880-01', 'aKitab adab al-muta‘allim /', 'cAhmad Fauzi.'),
        df('264', ' 1', 'aKairo :', 'bDar al-Ma‘rifah,', 'c2010.'),
        df('880', '10', '6245-01/(3/r', 'aكتاب أدب المتعلم /', 'cأحمد فوزي.'),
      ],
    },
  },
  {
    name: 'acquisition data: 541, 590 and a priced 952 (S5)',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0034'),
        cf('008', f008('2024', 'ind')),
        df('020', '  ', 'a9786020000059', 'cRp125.000'),
        df('245', '00', 'aAtlas sejarah kota pelabuhan.'),
        df('264', ' 1', 'aMakassar :', 'bPenerbit Bahari,', 'c2024.'),
        df('541', '1 ', 'aToko Buku Sentosa', 'cPembelian', 'd20240115', 'hRp125.000'),
        df('561', '  ', 'aHibah dari keluarga Daeng.'),
        df('583', '1 ', 'aDiperiksa', 'c20240201'),
        df('590', '  ', 'aCatatan lokal: rak khusus.'),
        df('877', '  ', 'aSuplemen'),
        df('952', '  ', 'aPUSAT', 'cRAK-ATL', 'g125000', 'o911 ATL', 'pB003401', 'yREF'),
        df('952', '  ', 'aPUSAT', 'g125000', 'eHibah'),
      ],
    },
  },
  {
    name: 'relators: unknown code and a compiler term',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0035'),
        cf('008', f008('2013', 'ind')),
        df('245', '00', 'aPentas tari tradisional /', 'cdisusun oleh Maya Sari.'),
        df('264', ' 1', 'aDenpasar :', 'bSeni Bali,', 'c2013.'),
        df('700', '1 ', 'aSari, Maya,', 'epenyusun.'),
        df('700', '1 ', 'aKadek, Wayan,', '4prf'),
        df('700', '1 ', 'aPutra, Gede,', 'ehttp://id.loc.gov/vocabulary/relators/ill'),
        df('700', '1 ', 'aYuliani, Ni Made,', '4http://id.loc.gov/vocabulary/relators/ill'),
      ],
    },
  },
  {
    name: 'subject sources by second indicator',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0036'),
        cf('008', f008('2005', 'eng')),
        df('245', '00', 'aHealth in the islands.'),
        df('264', ' 1', 'aDarwin :', 'bNorthern Press,', 'c2005.'),
        df('650', ' 0', 'aPublic health.'),
        df('650', ' 1', 'aHealth.'),
        df('650', ' 2', 'aPublic Health Administration.'),
        df('650', ' 3', 'aRural health.'),
        df('650', ' 5', 'aSanté publique.'),
        df('650', ' 6', 'aSanté.'),
        df('650', ' 7', 'aKesehatan masyarakat.', '2idsubj'),
      ],
    },
  },
  {
    name: '260 and 264 _1 together, 264 _4 copyright date',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0037'),
        cf('008', f008('2018', 'ind')),
        df('245', '00', 'aResep masakan Minang.'),
        df('260', '  ', 'aPadang :', 'bLama,', 'c2017.'),
        df('264', ' 1', 'aPadang :', 'bRumah Gadang,', 'c2018.'),
        df('264', ' 4', 'c©2018'),
      ],
    },
  },
  {
    name: 'date in brackets and a question mark',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0038'),
        cf('008', '261001q19501959io            000 0ind d'),
        df('245', '00', 'aHikayat raja-raja Pasai.'),
        df('260', '  ', 'a[Batavia] :', 'bBalai Poestaka,', 'c[195-?]'),
      ],
    },
  },
  {
    name: 'year only in 008',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0039'),
        cf('008', f008('1975', 'ind')),
        df('245', '00', 'aPelajaran membaca kelas 1.'),
        df('260', '  ', 'aJakarta :', 'bDepartemen P dan K'),
      ],
    },
  },
  {
    name: 'personal name with numeration and title of honour',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0040'),
        cf('008', f008('1984', 'ind')),
        df('100', '0 ', 'aHamengkubuwono', 'bIX,', 'cSri Sultan,', 'd1912-1988.'),
        df('245', '10', 'aTahta untuk rakyat /', 'cHamengkubuwono IX.'),
        df('260', '  ', 'aJakarta :', 'bGramedia,', 'c1984.'),
        df('600', '00', 'aHamengkubuwono', 'bIX,', 'cSri Sultan,', 'd1912-1988.'),
      ],
    },
  },
  {
    name: 'children picture book with illustrator',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0041'),
        cf('008', f008('2022', 'ind')),
        df('020', '  ', 'a978-602-00-0006-6'),
        df('100', '1 ', 'aLestari, Putri,', 'eauthor.'),
        df('245', '10', 'aKancil dan buaya /', 'cPutri Lestari ; ilustrasi, Dimas Arya.'),
        df('264', ' 1', 'aBandung :', 'bPelangi Anak,', 'c2022.'),
        df('300', '  ', 'a32 halaman :', 'bilustrasi berwarna ;', 'c24 cm'),
        df('650', ' 4', 'aCerita anak.'),
        df('655', ' 7', 'aPicture books.', '2lcgft'),
        df('700', '1 ', 'aArya, Dimas,', 'eillustrator.'),
        df('952', '  ', 'aPUSAT', 'cANAK', 'o398.2 LES k', 'pB004101', 'yUMUM'),
      ],
    },
  },
  {
    name: 'religious text with a uniform title in 130',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0042'),
        cf('008', f008('2000', 'ind')),
        df('130', '0 ', 'aKitab Contoh.', 'lIndonesia.'),
        df('245', '10', 'aKitab contoh :', 'bterjemahan dan tafsir.'),
        df('264', ' 1', 'aJakarta :', 'bLembaga Tafsir,', 'c2000.'),
        df('650', ' 4', 'aTafsir.'),
      ],
    },
  },
  {
    name: 'conference proceedings with 111 and 711',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0043'),
        cf('008', f008('2016', 'eng')),
        df('111', '2 ', 'aInternational Conference on Island Libraries', 'n(1st :', 'd2016 :', 'cBali)'),
        df('245', '10', 'aProceedings of the International Conference on Island Libraries.'),
        df('264', ' 1', 'aDenpasar :', 'bIsland Press,', 'c2016.'),
        df('711', '2 ', 'aWorkshop on Digital Archives', 'n(2nd :', 'd2016 :', 'cBali)'),
      ],
    },
  },
  {
    name: 'multiple identifiers, ISBN-10 and ISSN together',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0044'),
        cf('008', f008('1999', 'eng')),
        df('020', '  ', 'a0-19-852663-6'),
        df('020', '  ', 'a978-0-19-852663-6', 'qhardback'),
        df('022', '  ', 'a0378-5955'),
        df('245', '04', 'aThe annual review of coastal studies.'),
        df('260', '  ', 'aOxford :', 'bShoreline,', 'c1999.'),
      ],
    },
  },
  {
    name: 'edition with a statement of responsibility',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0045'),
        cf('008', f008('2015', 'ind')),
        df('100', '1 ', 'aSantika, Yudi.'),
        df('245', '10', 'aDasar-dasar akuntansi /', 'cYudi Santika.'),
        df('250', '  ', 'aEdisi ke-3 /', 'bdirevisi oleh Tia Anggraini.'),
        df('264', ' 1', 'aJakarta :', 'bSalemba Ilmu,', 'c2015.'),
        df('650', ' 4', 'aAkuntansi.'),
      ],
    },
  },
  {
    name: 'Indonesian title with a subtitle only',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0046'),
        cf('008', f008('2012', 'ind')),
        df('245', '00', 'aPerahu kertas :', 'bkisah dua sahabat.'),
        df('264', ' 1', 'aJakarta :', 'bLangit Biru,', 'c2012.'),
      ],
    },
  },
  {
    name: 'title ending in a question mark',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0047'),
        cf('008', f008('2018', 'ind')),
        df('100', '1 ', 'aHalim, Bima.'),
        df('245', '10', 'aSiapa takut matematika? /', 'cBima Halim.'),
        df('264', ' 1', 'aJakarta :', 'bPintar,', 'c2018.'),
        df('650', ' 4', 'aMatematika', 'vBuku pelajaran.'),
      ],
    },
  },
  {
    name: 'local 09X, 9XX and a Koha 942 without items',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0048'),
        cf('008', f008('2001', 'ind')),
        df('092', '  ', 'aF HAR'),
        df('245', '00', 'aKisah si kancil.'),
        df('260', '  ', 'aJakarta :', 'bBalai Bacaan,', 'c2001.'),
        df('942', '  ', 'cBK', '2ddc'),
        df('998', '  ', 'aimpor-lama'),
      ],
    },
  },
  {
    name: 'genre and occupation subjects only',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0049'),
        cf('008', f008('2020', 'ind')),
        df('245', '00', 'aKisah para nelayan.'),
        df('264', ' 1', 'aAmbon :', 'bPesisir,', 'c2020.'),
        df('655', ' 4', 'aBiografi.'),
        df('656', ' 7', 'aNelayan.', '2local'),
      ],
    },
  },
  {
    name: 'temporal and geographic subjects with subdivisions',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0050'),
        cf('008', f008('2010', 'ind')),
        df('245', '00', 'aRevolusi di Surabaya.'),
        df('264', ' 1', 'aSurabaya :', 'bKota Pahlawan,', 'c2010.'),
        df('648', ' 4', 'a1945-1949.'),
        df('651', ' 4', 'aSurabaya (Indonesia)', 'xSejarah', 'y1945-1949.'),
      ],
    },
  },
  {
    name: 'items with the record call number and a 952 without barcode',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0051'),
        cf('008', f008('2014', 'ind')),
        df('090', '  ', 'a297 ABD t'),
        df('245', '00', 'aTuntunan ibadah sehari-hari.'),
        df('264', ' 1', 'aBandung :', 'bMizan Kecil,', 'c2014.'),
        df('952', '  ', 'aPUSAT', 'pB005101', 'yUMUM'),
        df('952', '  ', 'aPUSAT', 'pB005102'),
        df('952', '  ', 'aPUSAT', 'cGUDANG', 'yTANDON'),
      ],
    },
  },
  {
    name: 'two 1XX fields (bad data): the second becomes an added entry',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0052'),
        cf('008', f008('2011', 'ind')),
        df('100', '1 ', 'aWijaya, Kurnia.'),
        df('100', '1 ', 'aSaputra, Eko.'),
        df('245', '10', 'aPanduan berkebun di rumah /', 'cKurnia Wijaya, Eko Saputra.'),
        df('264', ' 1', 'aJakarta :', 'bHijau,', 'c2011.'),
      ],
    },
  },
  {
    name: 'fields out of tag order',
    record: {
      leader: L_UTF8('am'),
      fields: [
        cf('001', 'B0053'),
        cf('008', f008('2016', 'ind')),
        df('245', '00', 'aAneka kerajinan bambu.'),
        df('650', ' 4', 'aKerajinan tangan.'),
        df('020', '  ', 'a9786020000066'),
        df('264', ' 1', 'aYogyakarta :', 'bKriya,', 'c2016.'),
        df('710', '2 ', 'aBalai Kriya.'),
        df('700', '1 ', 'aRatna, Sinta.'),
        df('600', '10', 'aWiryo, Mbah,', 'd1920-2001.'),
        df('500', '  ', 'aBerisi pola.'),
      ],
    },
  },
  {
    name: 'MARC-8 Indonesian record with no diacritics',
    marc8: true,
    record: {
      leader: L_MARC8('am'),
      fields: [
        cf('001', 'M80054'),
        cf('008', f008('1998', 'ind')),
        df('100', '1 ', 'aSuryadi, Tono.'),
        df('245', '10', 'aBercocok tanam padi /', 'cTono Suryadi.'),
        df('260', '  ', 'aSemarang :', 'bTani Makmur,', 'c1998.'),
        df('650', ' 4', 'aPadi', 'xBudidaya.'),
        df('952', '  ', 'aPUSAT', 'cRAK-633', 'o633.18 SUR b', 'pB005401', 'yUMUM'),
      ],
    },
  },
  {
    name: 'mixed materials kit',
    record: {
      leader: L_UTF8('om'),
      fields: [
        cf('001', 'K0001'),
        cf('008', f008('2019', 'ind')),
        df('245', '00', 'aPaket belajar membatik.'),
        df('264', ' 1', 'aPekalongan :', 'bRumah Batik,', 'c2019.'),
        df('300', '  ', 'a1 kotak (3 buku, 1 cakram video, 5 pola)'),
        df('336', '  ', 'aother', 'bxxx', '2rdacontent'),
        df('337', '  ', 'aunmediated', 'bn', '2rdamedia'),
        df('338', '  ', 'aother unmediated carrier', 'bnz', '2rdacarrier'),
      ],
    },
  },
] as const;

// ---- a MARC-8 encoder for tests (independent of src/marc/marc8.ts) -------------------------------------------------

/** The ANSEL bytes this corpus uses: spacing letters and combining marks (written before their base). */
const ANSEL_SPACING: Readonly<Record<string, number>> = {
  'Ł': 0xa1,
  'Ø': 0xa2,
  'Đ': 0xa3,
  'Æ': 0xa5,
  'ʼ': 0xae,
  'ʻ': 0xb0,
  'ł': 0xb1,
  'ø': 0xb2,
  'đ': 0xb3,
  'æ': 0xb5,
  'ı': 0xb8,
  'ơ': 0xbc,
  'ư': 0xbd,
  '©': 0xc3,
  'ß': 0xc7,
};
const ANSEL_COMBINING: Readonly<Record<number, number>> = {
  0x0300: 0xe1,
  0x0301: 0xe2,
  0x0302: 0xe3,
  0x0303: 0xe4,
  0x0306: 0xe6,
  0x0308: 0xe8,
  0x0309: 0xe0,
  0x030a: 0xea,
  0x0323: 0xf2,
  0x0327: 0xf0,
};

/** Unicode text → MARC-8 bytes (ASCII + ANSEL); throws for a character outside the corpus's repertoire. */
export function encodeMarc8(text: string): Uint8Array {
  const out: number[] = [];
  // Compose the horn letters first (ơ ư are ANSEL spacing letters), then decompose everything else.
  const chars = Array.from(text.normalize('NFD').replace(/o\u{031B}/gu, 'ơ').replace(/u\u{031B}/gu, 'ư'));
  let i = 0;
  while (i < chars.length) {
    const base = chars[i]!;
    const marks: number[] = [];
    let j = i + 1;
    while (j < chars.length && ANSEL_COMBINING[chars[j]!.codePointAt(0)!] !== undefined) {
      marks.push(ANSEL_COMBINING[chars[j]!.codePointAt(0)!]!);
      j++;
    }
    out.push(...marks);
    const cp = base.codePointAt(0)!;
    if (cp >= 0x20 && cp <= 0x7e) out.push(cp);
    else if (ANSEL_SPACING[base] !== undefined) out.push(ANSEL_SPACING[base]);
    else throw new Error(`encodeMarc8: no MARC-8 form for U+${cp.toString(16).toUpperCase()}`);
    i = j;
  }
  return Uint8Array.from(out);
}

/** ISO 2709 bytes of `rec` with MARC-8 data and the leader as given (its length and base address filled in). */
export function marc8Iso2709(rec: MarcRecord): Uint8Array {
  const enc = (s: string) => encodeMarc8(s);
  const fields = rec.fields.map((f) => {
    const parts: number[] = [];
    if ('value' in f) parts.push(...enc(f.value));
    else {
      parts.push(f.ind1.charCodeAt(0), f.ind2.charCodeAt(0));
      for (const [code, value] of f.subfields) parts.push(0x1f, code.charCodeAt(0), ...enc(value));
    }
    parts.push(0x1e);
    return { tag: f.tag, bytes: parts };
  });
  let dir = '';
  let offset = 0;
  for (const f of fields) {
    dir += f.tag + String(f.bytes.length).padStart(4, '0') + String(offset).padStart(5, '0');
    offset += f.bytes.length;
  }
  const base = 24 + dir.length + 1;
  const total = base + offset + 1;
  const leader = String(total).padStart(5, '0') + rec.leader.slice(5, 12) + String(base).padStart(5, '0') + rec.leader.slice(17, 24);
  const head = Array.from(leader + dir, (c) => c.charCodeAt(0));
  return Uint8Array.from([...head, 0x1e, ...fields.flatMap((f) => f.bytes), 0x1d]);
}

/** `leader` with the positions every writer recomputes (00-04 length, 09 coding, 12-16 base address) masked. */
export function maskLeader(leader: string): string {
  return `#####${leader.slice(5, 9)}#${leader.slice(10, 12)}#####${leader.slice(17)}`;
}

// ---- the mapping's inputs ----------------------------------------------------------------------------------------

/** The material types of the seed (§2.6) by leader/06 + /07; anything else is the default (null). */
const MATERIAL_TYPES: Readonly<Record<string, string>> = {
  am: 'BUKU',
  as: 'BERSERI',
  em: 'PETA',
  im: 'AUDIO',
  jm: 'AUDIO',
  gm: 'VIDEO',
  om: 'CAMPURAN',
  tm: 'KARYA-ILMIAH',
};

export function materialTypeCodeFor(leader06: string, leader07: string): string | null {
  return MATERIAL_TYPES[leader06 + leader07] ?? null;
}

export const ASDATA_CREATED = Date.UTC(2026, 9, 1, 8, 0, 0);
export const ASDATA_UPDATED = Date.UTC(2026, 9, 2, 9, 30, 15);

/**
 * The RecordData a stored draft would load as (`loadRecordData`), for the export: `links` become public URL attachments
 * and each item gets its `locationCode`; the material type's leader codes come from the draft's original leader.
 */
export function asData(d: RecordDraft, o: { id?: string; updatedAt?: number } = {}): RecordData {
  const { publisher, agents, subjects, items, ...rest } = d;
  const ldr = d.marcExtra.find((f) => f.tag === 'LDR')?.data;
  return {
    ...rest,
    id: o.id ?? '01JTESTRECORD0000000000001',
    createdAt: ASDATA_CREATED,
    updatedAt: o.updatedAt ?? ASDATA_UPDATED,
    changedAt: o.updatedAt ?? ASDATA_UPDATED,
    opacVisible: true,
    promoted: false,
    archived: false,
    mergedInto: null,
    materialType: {
      id: '01JTESTMATERIALTYPE0000001',
      code: d.materialTypeCode ?? 'BUKU',
      nameId: 'Buku',
      nameEn: 'Book',
      marcType: ldr?.[6] ?? 'a',
      marcLevel: ldr?.[7] ?? 'm',
      schemaType: 'Book',
      dcmiType: 'Text',
    },
    language: d.languageCode ? { code: d.languageCode, nameId: d.languageCode, nameEn: d.languageCode } : null,
    publisher: publisher ? { id: '01JTESTPUBLISHER0000000001', name: publisher.name, ...(publisher.place ? { place: publisher.place } : {}) } : null,
    agents: agents.map((a, i) => ({ ...a, id: `01JTESTAGENT${String(i).padStart(14, '0')}` })),
    subjects: subjects.map((s, i) => ({ ...s, id: `01JTESTSUBJECT${String(i).padStart(12, '0')}` })),
    coverFileId: null,
    attachments: d.links.map((l, i) => ({
      id: `01JTESTATTACH${String(i).padStart(13, '0')}`,
      kind: 'url' as const,
      fileId: null,
      url: l.url,
      title: l.title ?? '',
      access: 'public' as const,
      mime: null,
    })),
    relations: [],
    items: items.map((it, i) => ({
      id: `01JTESTITEM${String(i).padStart(15, '0')}`,
      barcode: it.barcode,
      branchId: '01JTESTBRANCH0000000000001',
      branchCode: it.branchCode ?? 'PUSAT',
      locationId: it.locationCode ? `01JTESTLOCATION${String(i).padStart(11, '0')}` : null,
      locationCode: it.locationCode ?? null,
      callNumber: it.callNumber ?? null,
      status: 'available' as const,
      collectionTypeCode: it.collectionTypeCode ?? 'UMUM',
      loanable: true,
      selfService: true,
    })),
    customPublic: [],
  };
}
