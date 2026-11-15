import { DEFAULT_CARD_PROFILE, type CardProfile } from '@altis/shared/api/member-ops';
import { describe, expect, it } from 'vitest';
import { buildMemberCardsPdf, cardBarcodeModules, type CardMember } from '../../src/members/ext/cards.js';
import { TINY_JPEG_BASELINE } from '../fixtures/tiny.jpg.js';
import { decodeCode128, decodeCode39 } from '../support/barcode-decode.js';

// Member cards: the barcode holds the member number (Code 39 when the profile asks and the number fits it, Code 128
// otherwise) and reads back; a sheet of 200 cards with photos, a logo and the back is made well within five seconds,
// ten cards a page, the pictures stored once each as JPEG; more than 200 members is refused.

const members = (n: number): CardMember[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `M${i}`,
    memberNo: `SISWA-${String(i + 1).padStart(4, '0')}`,
    name: `Anggota Nomor ${i + 1} dengan Nama yang Cukup Panjang`,
    typeName: 'Siswa',
    className: 'VII-A',
    institution: 'SMP Contoh',
    identityNo: '0012345678',
    expiresOn: '2027-07-14',
    photoFileId: i % 2 === 0 ? 'photo' : null,
  }));

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

describe('member cards', () => {
  it('the barcode reads back as the member number, in Code 39 when it fits and Code 128 otherwise', () => {
    expect(decodeCode128(cardBarcodeModules('b 001-x', 'code128')).text).toBe('b 001-x');
    expect(decodeCode39(cardBarcodeModules('SISWA-0001', 'code39'))).toBe('SISWA-0001');
    // `#` is not in Code 39's set: the card falls back to Code 128.
    expect(decodeCode128(cardBarcodeModules('A#1', 'code39')).text).toBe('A#1');
  });

  it('200 cards with photos, a logo and the back take well under five seconds; ten per page, each picture stored once', async () => {
    const profile: CardProfile = {
      ...DEFAULT_CARD_PROFILE,
      logoFileId: 'logo',
      back: { ...DEFAULT_CARD_PROFILE.back, enabled: true, rulesText: 'Kartu wajib dibawa saat meminjam.\nKartu hilang segera dilaporkan.', city: 'Bandung', signerName: 'Kepala' },
    };
    const started = performance.now();
    const pdf = await buildMemberCardsPdf({
      profile,
      members: members(200),
      startAt: 3,
      locale: 'id',
      libraryName: 'Perpustakaan Contoh',
      today: '2026-11-15',
      picture: async () => TINY_JPEG_BASELINE,
    });
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(5000);
    const body = text(pdf);
    expect(body.startsWith('%PDF-1.4')).toBe(true);
    // 200 cards from position 3: 21 pages of fronts, each followed by its backs.
    expect(body.match(/\/Type \/Page /g)).toHaveLength(42);
    // The photo (one file, on 100 cards) and the logo: two pictures, each stored once.
    expect(body.match(/\/Filter \/DCTDecode/g)).toHaveLength(2);
  });

  it('refuses more than 200 members in one sheet', async () => {
    const failure = await buildMemberCardsPdf({
      profile: DEFAULT_CARD_PROFILE,
      members: members(201),
      startAt: 1,
      locale: 'en',
      libraryName: 'Library',
      today: '2026-11-15',
      picture: async () => null,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toMatchObject({ code: 'MEMBER_CARD_LIMIT', meta: { max: 200 } });
  });
});
