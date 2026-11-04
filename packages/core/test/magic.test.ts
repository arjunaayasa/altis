import { describe, expect, it } from 'vitest';
import { MAGIC_HEAD_BYTES, detectType } from '../src/files/magic.js';

// The type of an upload from its first bytes (spec §7.5: "tipe dicek dari magic bytes; SVG ditolak sebagai gambar").
// Only the allow-listed raster images and PDF are ever served inline (serve.ts), so an SVG must never come out as an
// `image/*` type, whatever its prolog looks like.

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

describe('detectType', () => {
  it('reads a ZIP local file header (and an empty archive) as zip', () => {
    expect(detectType(bytes('PK', [3, 4, 20, 0, 0, 0]))).toEqual({ kind: 'zip', mime: 'application/zip' });
    expect(detectType(bytes('PK', [5, 6], [0, 0, 0, 0]))).toEqual({ kind: 'zip', mime: 'application/zip' });
  });

  it('reads %PDF- as pdf', () => {
    expect(detectType(bytes('%PDF-1.7\n%âãÏÓ'))).toEqual({ kind: 'pdf', mime: 'application/pdf' });
  });

  it('reads the PNG, JPEG, GIF and WebP signatures as their image types', () => {
    expect(detectType(bytes([0x89], 'PNG\r\n', [0x1a], '\n', [0, 0, 0, 13]))).toEqual({ kind: 'png', mime: 'image/png' });
    expect(detectType(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toEqual({ kind: 'jpeg', mime: 'image/jpeg' });
    expect(detectType(bytes('GIF89a', [1, 0, 1, 0]))).toEqual({ kind: 'gif', mime: 'image/gif' });
    expect(detectType(bytes('GIF87a', [1, 0, 1, 0]))).toEqual({ kind: 'gif', mime: 'image/gif' });
    expect(detectType(bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 '))).toEqual({ kind: 'webp', mime: 'image/webp' });
  });

  it('reads an XML prolog followed by <svg as svg, never as an image type', () => {
    const svg = detectType(bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'));
    expect(svg.kind).toBe('svg');
    expect(svg.mime.startsWith('image/')).toBe(false);
  });

  it('reads a bare <svg, after a BOM, whitespace, a comment or a doctype, as svg too (any case)', () => {
    for (const text of [
      '<svg width="1"/>',
      '\ufeff  \n<SVG/>',
      '<!-- made by hand -->\n<svg/>',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg/>',
    ]) {
      const found = detectType(new Uint8Array(Buffer.from(text, 'utf8')));
      expect(found.kind, text).toBe('svg');
      expect(found.mime.startsWith('image/'), text).toBe(false);
    }
  });

  it('does not take XML without an <svg element for svg (Phase 2: it is xml)', () => {
    expect(detectType(bytes('<?xml version="1.0"?><note>hi</note>')).kind).toBe('xml');
  });

  it('reads 8 random bytes with a NUL, and an empty head, as unknown; a truncated signature is never its type', () => {
    expect(detectType(bytes([0x13, 0x37, 0xc0, 0xde, 0x00, 0x7f, 0xee, 0x01]))).toEqual({
      kind: 'unknown',
      mime: 'application/octet-stream',
    });
    expect(detectType(new Uint8Array(0)).kind).toBe('unknown');
    // Without a NUL, Phase 2 reads them as text (S1); never as the type their first bytes began.
    expect(detectType(bytes('PK', [3])).kind).toBe('text');
    expect(detectType(bytes([0x89], 'PN')).kind).toBe('text');
    expect(detectType(bytes('PK', [3, 0])).kind).toBe('unknown');
    expect(detectType(bytes('RIFF', [0, 0, 0, 0], 'AVI ')).kind).toBe('unknown');
  });

  it('looks at no more than MAGIC_HEAD_BYTES bytes', () => {
    const late = Buffer.concat([Buffer.from('<?xml version="1.0"?>'), Buffer.alloc(MAGIC_HEAD_BYTES, 0x20), Buffer.from('<svg/>')]);
    expect(detectType(new Uint8Array(late)).kind).toBe('xml');
    const nul = Buffer.concat([Buffer.alloc(MAGIC_HEAD_BYTES, 0x41), Buffer.from([0])]);
    expect(detectType(new Uint8Array(nul)).kind).toBe('text');
  });

  // ---- Phase 2 (catalog): Task 2 (S1) ----
  // One sample per new kind, in the fixed order: the binary formats, then xml, then iso2709, then text.
  describe('Phase 2 kinds (S1)', () => {
    /** A leader of a MARC 21 record (ISO 2709): length 00120, base address of data 00037, entry map 4500. */
    const LEADER = '00120nam a2200037 a 4500';
    const MARC = bytes(LEADER, '245001100000', [0x1e], '10', [0x1f], 'aJudul', [0x1e, 0x1d]);

    it('reads each new kind from its signature, with its media type', () => {
      const cases: [Uint8Array, string, string][] = [
        [bytes('ID3', [4, 0, 0, 0, 0, 0x0f, 0x76]), 'mp3', 'audio/mpeg'],
        // An MPEG-1 Layer III frame header, no ID3 tag: 128 kbit/s, 44.1 kHz.
        [bytes([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]), 'mp3', 'audio/mpeg'],
        [bytes([0xff, 0xf3, 0x84, 0xc4]), 'mp3', 'audio/mpeg'],
        [bytes([0, 0, 0, 0x20], 'ftypisom', [0, 0, 2, 0], 'isomiso2mp41'), 'mp4', 'video/mp4'],
        [bytes([0, 0, 0, 0x20], 'ftypM4A ', [0, 0, 0, 0], 'M4A mp42isom'), 'mp4', 'audio/mp4'],
        [bytes('OggS', [0, 2, 0, 0, 0, 0, 0, 0, 0, 0]), 'ogg', 'audio/ogg'],
        [bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt ', [16, 0, 0, 0]), 'wav', 'audio/wav'],
        [bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84], 'webm', [0x42, 0x87]), 'webm', 'video/webm'],
        [bytes([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 3]), 'gzip', 'application/gzip'],
        [bytes('<?xml version="1.0" encoding="UTF-8"?>\n<collection xmlns="http://www.loc.gov/MARC21/slim"/>'), 'xml', 'application/xml'],
        [MARC, 'iso2709', 'application/marc'],
        [bytes('judul;pengarang;isbn\r\nLaskar Pelangi;Andrea Hirata;9789793062792\r\n'), 'text', 'text/plain'],
      ];
      for (const [head, kind, mime] of cases) expect(detectType(head), kind).toEqual({ kind, mime });
    });

    it('xml: a `<` first after a UTF-8 BOM and white space', () => {
      expect(detectType(bytes([0xef, 0xbb, 0xbf], '  \r\n\t<record><leader/></record>')).kind).toBe('xml');
      expect(detectType(bytes('<marc:collection xmlns:marc="http://www.loc.gov/MARC21/slim"/>')).kind).toBe('xml');
      // A binary file whose first byte is `<` (random bytes, 1 in 256) is not XML: XML text holds no NUL.
      expect(detectType(bytes('<', [0x00, 0x9f, 0x3c, 0x00])).kind).toBe('unknown');
      expect(detectType(bytes('text <then> markup')).kind).toBe('text');
    });

    it('a CSV that begins with five digits is text, not ISO 2709 (no leader, no field terminator)', () => {
      const csv = bytes('12345;Judul Buku;Pengarang;Penerbit;2001;9789793062792;000;1;2;3;4\r\n12346;Lain;X;Y;2002;;;;;;\r\n');
      expect(detectType(csv).kind).toBe('text');
      expect(detectType(bytes('00120,nam a2200037 a 4500,x\r\n')).kind).toBe('text');
      // A leader alone, without the directory's terminator where its base address says, is not a record either.
      expect(detectType(bytes(LEADER, '245001100000XX')).kind).toBe('text');
    });

    it('ISO 2709 with a dirty leader length still reads as iso2709 (the reader reports it per record)', () => {
      expect(detectType(bytes('99999nam a2200037 a 4500', '245001100000', [0x1e], 'x')).kind).toBe('iso2709');
    });

    it('a JPEG is never an MP3 frame, a UTF-16 text never an MP3; image brands of ftyp are not mp4; Matroska is not webm (nor text)', () => {
      expect(detectType(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])).kind).toBe('jpeg');
      expect(detectType(bytes([0xff, 0xfe], 'a', [0], 'b', [0])).kind).toBe('unknown');
      expect(detectType(bytes([0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0], 'avifmif1')).kind).toBe('unknown');
      expect(detectType(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0], 'mif1heic')).kind).toBe('unknown');
      expect(detectType(bytes([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x82, 0x88], 'matroska', [0x42, 0x87])).kind).toBe('unknown');
      // MPEG frame sync of another layer, or with a reserved sampling rate, is not MP3.
      expect(detectType(bytes([0xff, 0xfd, 0x90, 0x64, 0])).kind).toBe('unknown');
      expect(detectType(bytes([0xff, 0xfb, 0x9c, 0x64, 0])).kind).toBe('unknown');
    });

    it('an SVG stays svg (never xml, never an image type)', () => {
      expect(detectType(bytes('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')).kind).toBe('svg');
    });
  });
});
