import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uploadPath } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentDisposition, fileResponseHeaders, localStorageDriver, safeFileName } from '../src/files/serve.js';

// Serving stored files (spec §7.5 "/files/:id"; §13.8 StorageDriver): the response headers that keep a file from
// running as a page of the site, and the local driver keyed by file id.

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

async function collect(source: AsyncIterable<Uint8Array> | null): Promise<Buffer> {
  if (source === null) throw new Error('no content');
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

describe('fileResponseHeaders', () => {
  it('serves a file as an attachment in a sandbox: CSP, CORP, nosniff, its type and length', () => {
    const headers = fileResponseHeaders({ originalName: 'data.zip', mime: 'application/zip', size: 1234 });
    expect(headers).toMatchObject({
      'Content-Type': 'application/zip',
      'Content-Length': '1234',
      'Content-Disposition': `attachment; filename="data.zip"; filename*=UTF-8''data.zip`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  it('serves only PNG, JPEG, GIF, WebP and PDF inline', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']) {
      expect(fileResponseHeaders({ originalName: 'a', mime, size: 1 })['Content-Disposition'], mime).toMatch(/^inline; /);
    }
    for (const mime of ['image/svg+xml', 'text/html', 'application/octet-stream', 'application/zip', 'image/bmp']) {
      expect(fileResponseHeaders({ originalName: 'a', mime, size: 1 })['Content-Disposition'], mime).toMatch(/^attachment; /);
    }
  });

  it('sanitizes the name: no folders, quotes, controls or separators; RFC 5987 encoding for the rest', () => {
    expect(safeFileName('../../x".txt')).toBe('x_.txt');
    expect(safeFileName('..\\..\\boot.ini')).toBe('boot.ini');
    expect(safeFileName('a\u0000b\r\nc\u007f\u0085.pdf')).toBe('abc.pdf');
    expect(safeFileName('  ..  ')).toBe('file');
    // Format characters that can disguise a name: bidi overrides and embeddings, the bidi isolates (LRI, RLI, FSI,
    // PDI), zero-width characters, line separators.
    expect(safeFileName('invoice\u202egpj.exe')).toBe('invoicegpj.exe');
    expect(safeFileName('a\u2066b\u2067c\u2068d\u2069.pdf')).toBe('abcd.pdf');
    expect(safeFileName('laporan\u2067fdp.exe\u2069')).toBe('laporanfdp.exe');
    expect(safeFileName('a\u200bb\u2028c\u2060d\ufeff.txt')).toBe('abcd.txt');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('x'.repeat(300) + '.pdf')).toHaveLength(150);
    expect(safeFileName('x'.repeat(300) + '.pdf').endsWith('.pdf')).toBe(true);
    expect(contentDisposition('attachment', '../../x".txt')).toBe(`attachment; filename="x_.txt"; filename*=UTF-8''x_.txt`);
    expect(contentDisposition('attachment', "Laporan (final)* 'ok'.pdf")).toBe(
      `attachment; filename="Laporan (final)_ 'ok'.pdf"; filename*=UTF-8''Laporan%20%28final%29_%20%27ok%27.pdf`,
    );
    expect(contentDisposition('inline', 'Buku Ζ ñ.png')).toBe(`inline; filename="Buku _ _.png"; filename*=UTF-8''Buku%20%CE%96%20%C3%B1.png`);
  });
});

describe('localStorageDriver', () => {
  let root: string;
  let dataDir: string;

  beforeEach(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-storage-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir);
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('puts a file under uploads/<yyyy>/<mm>/<id> after checking its size and hash, then gets, ranges, stats and deletes it', async () => {
    const driver = localStorageDriver(dataDir);
    const id = newId();
    const data = new Uint8Array(randomBytes(200_000));
    async function* twoParts(): AsyncIterable<Uint8Array> {
      yield data.subarray(0, 70_000);
      yield data.subarray(70_000);
    }
    await driver.put(id, twoParts(), { size: data.byteLength, sha256: sha(data) });
    expect(new Uint8Array(await fsp.readFile(uploadPath(dataDir, id)))).toEqual(data);
    expect(await driver.stat(id)).toEqual({ size: data.byteLength });
    expect(new Uint8Array(await collect(await driver.get(id)))).toEqual(data);
    expect(new Uint8Array(await collect(await driver.get(id, { start: 65_530, end: 131_080 })))).toEqual(data.subarray(65_530, 131_081));
    await driver.delete(id);
    expect(await driver.stat(id)).toBeNull();
    expect(await driver.get(id)).toBeNull();
    await driver.delete(id); // gone already: nothing happens
  });

  it('accepts bytes as they are, and refuses a size or hash that differs from the declared one, leaving nothing', async () => {
    const driver = localStorageDriver(dataDir);
    const data = new Uint8Array(randomBytes(1000));
    const id = newId();
    await driver.put(id, data, { size: 1000, sha256: sha(data) });
    expect(await driver.stat(id)).toEqual({ size: 1000 });

    for (const meta of [
      { size: 999, sha256: sha(data), reason: 'size' },
      { size: 1000, sha256: sha(new Uint8Array(1000)), reason: 'sha256' },
    ]) {
      const other = newId();
      const error = await driver.put(other, data, meta).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isDomainError(error) && [error.code, error.meta?.['reason']]).toEqual(['UPLOAD_MISMATCH', meta.reason]);
      expect(await driver.stat(other)).toBeNull();
      const folder = path.dirname(uploadPath(dataDir, other));
      expect((await fsp.readdir(folder)).filter((name) => name.includes(other))).toEqual([]);
    }
  });

  it('refuses a key that is not a file id', async () => {
    const driver = localStorageDriver(dataDir);
    await expect(driver.stat('../config.json')).rejects.toMatchObject({ code: 'INVALID_PATH_SEGMENT' });
  });
});
