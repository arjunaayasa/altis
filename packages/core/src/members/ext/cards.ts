import type { DB } from '@altis/db';
import { DomainError, qrMatrix, t, type CardField, type Locale } from '@altis/shared';
import { MEMBER_CARDS_MAX, type CardProfile } from '@altis/shared/api/member-ops';
import { SITE_IMAGE_MAX_SIDE } from '@altis/shared/api/site-identity';
import type { Kysely, Transaction } from 'kysely';
import { textWidth } from '../../print/afm.js';
import { code128Modules } from '../../print/code128.js';
import { code39Modules } from '../../print/code39.js';
import { JpegError } from '../../print/jpeg.js';
import { PdfDocument, type PdfColor, type PdfImage, type PdfPage } from '../../print/pdf.js';
import { PngError, decodePng } from '../../files/png.js';
import type { StorageDriver } from '../../files/serve.js';

// Member cards: ISO ID-1 cards (85.6 × 54 mm), ten per page (2 × 5), on A4, F4 or Letter, centred, with thin cut
// lines. The front has a band in the library's colour with the title and subtitle (and the logo), the photo when the
// profile shows it and the member has one, the chosen fields, the member number as a Code 128 or Code 39 barcode, and
// a QR code of the member number. With the back enabled, every page of fronts is followed by a page of backs placed
// mirrored per row, so a duplex print puts each back behind its front: the rules text, the place and date, the
// signer's title, signature, stamp and name.
//
// The barcode and the QR code hold the member number only. Pictures are JPEG; one that cannot be read is left out
// (the card prints without it). Text is drawn in the standard fonts (WinAnsi), so a character they cannot show is
// replaced. Everything is computed in memory; 200 cards take well under a second.

const PT_PER_MM = 72 / 25.4;
const CARD_W_MM = 85.6;
const CARD_H_MM = 54;
const COLS = 2;
const ROWS = 5;
const PER_PAGE = COLS * ROWS;

/** The paper sizes in mm. */
const SHEETS: Readonly<Record<CardProfile['sheet'], { w: number; h: number }>> = {
  A4: { w: 210, h: 297 },
  F4: { w: 215, h: 330 },
  Letter: { w: 215.9, h: 279.4 },
};

/** What one card prints of a member. */
export interface CardMember {
  id: string;
  memberNo: string;
  name: string;
  typeName: string;
  className: string | null;
  institution: string | null;
  identityNo: string | null;
  expiresOn: string | null;
  photoFileId: string | null;
}

/** `#rrggbb` as a PDF colour. */
function hexColor(hex: string): PdfColor {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** `s` cut (with an ellipsis) to fit `maxW` points at `size`. */
function fit(s: string, font: 'Helvetica' | 'Helvetica-Bold' | 'Courier', size: number, maxW: number): string {
  if (textWidth(s, font, size) <= maxW) return s;
  let out = s;
  while (out.length > 1 && textWidth(`${out}…`, font, size) > maxW) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

/** The words of `text` broken into lines of at most `maxW` points (at most `maxLines`, the last one cut). */
function wrap(text: string, size: number, maxW: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter((w) => w !== '')) {
      const next = line === '' ? word : `${line} ${word}`;
      if (textWidth(next, 'Helvetica', size) <= maxW) line = next;
      else {
        if (line !== '') lines.push(line);
        line = fit(word, 'Helvetica', size, maxW);
      }
    }
    lines.push(line);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fit(`${kept[maxLines - 1]!} …`, 'Helvetica', size, maxW);
  return kept;
}

/** The barcode modules of `memberNo`: the profile's symbology, Code 128 when Code 39 cannot hold the number. */
export function cardBarcodeModules(memberNo: string, symbology: CardProfile['symbology']): boolean[] {
  if (symbology === 'code39') {
    try {
      return code39Modules(memberNo);
    } catch {
      // A character outside Code 39's set: Code 128 holds every printable ASCII character.
    }
  }
  return code128Modules(memberNo);
}

function drawBars(page: PdfPage, x: number, y: number, w: number, h: number, modules: readonly boolean[]): void {
  const quiet = 10;
  const unit = Math.min(w / (modules.length + 2 * quiet), 0.4 * PT_PER_MM);
  const left = x + (w - modules.length * unit) / 2;
  let start = -1;
  for (let m = 0; m <= modules.length; m += 1) {
    if (modules[m] === true) {
      if (start < 0) start = m;
    } else if (start >= 0) {
      page.rect(left + start * unit, y, (m - start) * unit, h);
      start = -1;
    }
  }
}

function drawQr(page: PdfPage, x: number, y: number, size: number, text: string): void {
  const qr = qrMatrix(text);
  const unit = size / (qr.size + 2);
  page.rect(x, y, size, size, { color: [1, 1, 1] });
  for (let row = 0; row < qr.size; row += 1) {
    let start = -1;
    for (let col = 0; col <= qr.size; col += 1) {
      const dark = col < qr.size && qr.dark[row]![col] === true;
      if (dark && start < 0) start = col;
      if (!dark && start >= 0) {
        page.rect(x + (1 + start) * unit, y + size - (2 + row) * unit, (col - start) * unit, unit);
        start = -1;
      }
    }
  }
}

/** Reads a stored file whole (null when it is gone). */
async function readStored(storage: StorageDriver, fileId: string): Promise<Uint8Array | null> {
  const stream = await storage.get(fileId);
  if (stream === null) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const p of stream) {
    parts.push(p);
    size += p.byteLength;
    if (size > 2 * 1024 * 1024) return null; // a card picture is at most 500 KB
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** What a card sheet is built from besides the members. */
export interface CardSheetInput {
  profile: CardProfile;
  members: readonly CardMember[];
  startAt: number;
  locale: Locale;
  /** The library's name, printed on the band when the profile's subtitle is empty. */
  libraryName: string;
  /** The date printed on the back (`YYYY-MM-DD`). */
  today: string;
  /** Reads a stored picture (photo, logo, signature, stamp); null when it cannot. */
  picture(fileId: string): Promise<Uint8Array | null>;
  /**
   * The file of the site's logo (the site identity's), printed on the band when the profile names no logo of its own;
   * null or absent: none.
   */
  siteLogoFileId?: string | null;
}

/** Whether `bytes` begin with the PNG signature. */
function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

/** The label of a card field in `locale`. */
function fieldLabel(locale: Locale, f: CardField): string {
  return t(locale, `vocab.card_field.${f}`);
}

/** `YYYY-MM-DD` as `DD-MM-YYYY`. */
function shownDate(d: string): string {
  return `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
}

/**
 * The card sheet PDF (see the top of this file).
 *
 * @throws DomainError MEMBER_CARD_LIMIT for more than MEMBER_CARDS_MAX members
 */
export async function buildMemberCardsPdf(i: CardSheetInput): Promise<Uint8Array> {
  const { profile, members, locale } = i;
  if (members.length > MEMBER_CARDS_MAX) {
    throw new DomainError('MEMBER_CARD_LIMIT', { detail: `Paling banyak ${MEMBER_CARDS_MAX} kartu / At most ${MEMBER_CARDS_MAX} cards`, meta: { max: MEMBER_CARDS_MAX } });
  }
  const sheet = SHEETS[profile.sheet];
  const doc = new PdfDocument({ title: profile.front.title || 'Kartu anggota' });
  const cache = new Map<string, PdfImage | null>();
  const image = async (fileId: string | null): Promise<PdfImage | null> => {
    if (fileId === null) return null;
    if (cache.has(fileId)) return cache.get(fileId)!;
    let img: PdfImage | null = null;
    const bytes = await i.picture(fileId);
    if (bytes !== null) {
      try {
        // A card picture is a JPEG; the site's logo is a PNG the server stored (its transparency kept on the band).
        img = isPng(bytes) ? doc.addPixels(decodePng(bytes, { maxSide: SITE_IMAGE_MAX_SIDE })) : doc.addJpeg(bytes);
      } catch (error) {
        if (!(error instanceof JpegError) && !(error instanceof PngError)) throw error;
      }
    }
    cache.set(fileId, img);
    return img;
  };
  const logo = await image(profile.logoFileId ?? i.siteLogoFileId ?? null);
  const signature = profile.back.enabled ? await image(profile.back.signatureFileId) : null;
  const stamp = profile.back.enabled ? await image(profile.back.stampFileId) : null;

  const cw = CARD_W_MM * PT_PER_MM;
  const ch = CARD_H_MM * PT_PER_MM;
  const left0 = ((sheet.w - COLS * CARD_W_MM) / 2) * PT_PER_MM;
  const top0 = ((sheet.h - ROWS * CARD_H_MM) / 2) * PT_PER_MM;
  const pageH = sheet.h * PT_PER_MM;
  const band = hexColor(profile.front.bandColor);
  const bandText = hexColor(profile.front.textColor);
  const first = (i.startAt - 1) % PER_PAGE;
  const total = first + members.length;
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));

  /** The lower left corner of slot `cell` of a page (mirrored per row for a back page). */
  const slotXY = (cell: number, mirrored: boolean): { x: number; y: number } => {
    const row = Math.floor(cell / COLS);
    const col = mirrored ? COLS - 1 - (cell % COLS) : cell % COLS;
    return { x: left0 + col * cw, y: pageH - top0 - (row + 1) * ch };
  };

  for (let p = 0; p < pageCount; p += 1) {
    const front = doc.addPage(sheet.w * PT_PER_MM, pageH);
    const backPage = profile.back.enabled ? doc.addPage(sheet.w * PT_PER_MM, pageH) : null;
    for (let cell = 0; cell < PER_PAGE; cell += 1) {
      const n = p * PER_PAGE + cell - first;
      if (n < 0 || n >= members.length) continue;
      const m = members[n]!;
      const { x, y } = slotXY(cell, false);
      const photo = profile.front.showPhoto ? await image(m.photoFileId) : null;
      drawFront(front, x, y, cw, ch, m, { profile, band, bandText, logo, photo, locale, libraryName: i.libraryName });
      if (backPage !== null) {
        const b = slotXY(cell, true);
        drawBack(backPage, b.x, b.y, cw, ch, { profile, signature, stamp, today: i.today });
      }
    }
  }
  return doc.toBytes();
}

function drawFront(
  page: PdfPage,
  x: number,
  y: number,
  w: number,
  h: number,
  m: CardMember,
  o: { profile: CardProfile; band: PdfColor; bandText: PdfColor; logo: PdfImage | null; photo: PdfImage | null; locale: Locale; libraryName: string },
): void {
  const pad = 2.5 * PT_PER_MM;
  page.rect(x, y, w, h, { stroke: true });
  // The band.
  const bandH = 11 * PT_PER_MM;
  page.rect(x, y + h - bandH, w, bandH, { color: o.band });
  let textLeft = x + pad;
  if (o.logo !== null) {
    const s = bandH - 2 * PT_PER_MM;
    page.image(o.logo, x + pad, y + h - bandH + PT_PER_MM, s * (o.logo.width / o.logo.height), s);
    textLeft += s * (o.logo.width / o.logo.height) + 1.5 * PT_PER_MM;
  }
  const bandW = x + w - pad - textLeft;
  page.text(textLeft, y + h - 5 * PT_PER_MM, fit(o.profile.front.title, 'Helvetica-Bold', 8, bandW), { font: 'Helvetica-Bold', size: 8, color: o.bandText });
  const subtitle = o.profile.front.subtitle !== '' ? o.profile.front.subtitle : o.libraryName;
  page.text(textLeft, y + h - 9 * PT_PER_MM, fit(subtitle, 'Helvetica', 6.5, bandW), { font: 'Helvetica', size: 6.5, color: o.bandText });

  // The photo (3:4) on the left.
  const bodyTop = y + h - bandH - 1.5 * PT_PER_MM;
  let fieldsLeft = x + pad;
  const photoH = 24 * PT_PER_MM;
  const photoW = photoH * 0.75;
  if (o.profile.front.showPhoto) {
    if (o.photo !== null) page.image(o.photo, x + pad, bodyTop - photoH, photoW, photoH);
    else page.rect(x + pad, bodyTop - photoH, photoW, photoH, { stroke: true });
    fieldsLeft += photoW + 2 * PT_PER_MM;
  }
  // The QR code at the right of the fields.
  const qrSize = 17 * PT_PER_MM;
  const qrX = x + w - pad - qrSize;
  if (o.profile.qr) drawQr(page, qrX, bodyTop - qrSize, qrSize, m.memberNo);
  const fieldsW = (o.profile.qr ? qrX - 1.5 * PT_PER_MM : x + w - pad) - fieldsLeft;
  // The fields, label over value.
  let line = bodyTop - 2.6 * PT_PER_MM;
  const values: Record<CardField, string | null> = {
    memberNo: m.memberNo,
    name: m.name,
    type: m.typeName,
    className: m.className,
    institution: m.institution,
    identityNo: m.identityNo,
    expiresOn: m.expiresOn === null ? null : shownDate(m.expiresOn),
  };
  for (const f of o.profile.front.fields) {
    const v = values[f];
    if (v === null || v === '') continue;
    if (line < y + 13 * PT_PER_MM) break;
    page.text(fieldsLeft, line, fit(fieldLabel(o.locale, f), 'Helvetica', 5, fieldsW), { font: 'Helvetica', size: 5 });
    line -= 2.6 * PT_PER_MM;
    const bold = f === 'name' || f === 'memberNo';
    const size = f === 'name' ? 8 : 7;
    page.text(fieldsLeft, line, fit(v, bold ? 'Helvetica-Bold' : 'Helvetica', size, fieldsW), { font: bold ? 'Helvetica-Bold' : 'Helvetica', size });
    line -= 3.4 * PT_PER_MM;
  }
  // The barcode along the bottom, with the number under it.
  const barsH = 7 * PT_PER_MM;
  const barsY = y + 4.5 * PT_PER_MM;
  const barsX = fieldsLeft;
  const barsW = x + w - pad - barsX;
  drawBars(page, barsX, barsY, barsW, barsH, cardBarcodeModules(m.memberNo, o.profile.symbology));
  const no = fit(m.memberNo, 'Courier', 6.5, barsW);
  page.text(barsX + (barsW - textWidth(no, 'Courier', 6.5)) / 2, y + 1.8 * PT_PER_MM, no, { font: 'Courier', size: 6.5 });
}

function drawBack(page: PdfPage, x: number, y: number, w: number, h: number, o: { profile: CardProfile; signature: PdfImage | null; stamp: PdfImage | null; today: string }): void {
  const pad = 3 * PT_PER_MM;
  const b = o.profile.back;
  page.rect(x, y, w, h, { stroke: true });
  const rules = wrap(b.rulesText, 6, w - 2 * pad, 7);
  let line = y + h - pad - 4;
  for (const r of rules) {
    page.text(x + pad, line, r, { font: 'Helvetica', size: 6 });
    line -= 7.2;
  }
  // The signature block on the right half.
  const blockX = x + w / 2;
  const blockW = w / 2 - pad;
  let by = y + 22 * PT_PER_MM;
  const place = [b.city, shownDate(o.today)].filter((s) => s !== '').join(', ');
  page.text(blockX, by, fit(place, 'Helvetica', 6, blockW), { font: 'Helvetica', size: 6 });
  by -= 7;
  page.text(blockX, by, fit(b.signerTitle, 'Helvetica', 6, blockW), { font: 'Helvetica', size: 6 });
  const picH = 10 * PT_PER_MM;
  if (o.stamp !== null) page.image(o.stamp, blockX - 4 * PT_PER_MM, by - picH - 1, picH * (o.stamp.width / o.stamp.height), picH);
  if (o.signature !== null) page.image(o.signature, blockX, by - picH - 1, picH * (o.signature.width / o.signature.height), picH);
  page.text(blockX, y + pad, fit(b.signerName, 'Helvetica-Bold', 6.5, blockW), { font: 'Helvetica-Bold', size: 6.5 });
}

type Db = Kysely<DB> | Transaction<DB>;

/**
 * The members `ids` as cards print them, in the order of `ids` (an id that is gone or anonymised is left out).
 */
export async function cardMembers(db: Db, ids: readonly string[], locale: Locale): Promise<CardMember[]> {
  const unique = [...new Set(ids)];
  const rows: CardMember[] = [];
  for (let k = 0; k < unique.length; k += 200) {
    const part = unique.slice(k, k + 200);
    const found = await db
      .selectFrom('members as m')
      .leftJoin('member_types as t', 't.id', 'm.member_type_id')
      .select(['m.id', 'm.member_no_display', 'm.name', 't.name_id', 't.name_en', 'm.class_name', 'm.institution', 'm.identity_no', 'm.expires_on', 'm.photo_file_id'])
      .where('m.id', 'in', part)
      .where('m.anonymized_at', 'is', null)
      .execute();
    for (const r of found) {
      rows.push({
        id: r.id,
        memberNo: r.member_no_display,
        name: r.name,
        typeName: (locale === 'en' ? (r.name_en ?? r.name_id) : r.name_id) ?? '',
        className: r.class_name,
        institution: r.institution,
        identityNo: r.identity_no,
        expiresOn: r.expires_on,
        photoFileId: r.photo_file_id,
      });
    }
  }
  const order = new Map(unique.map((id, n) => [id, n]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

/** A picture reader over the storage driver, for {@link CardSheetInput.picture}. */
export function storedPicture(storage: StorageDriver): (fileId: string) => Promise<Uint8Array | null> {
  return (fileId) => readStored(storage, fileId);
}
