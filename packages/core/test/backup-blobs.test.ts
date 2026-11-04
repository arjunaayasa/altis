import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uploadPath } from '@altis/platform';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkBlob } from '../src/backup/blobs.js';

// Content-addressed blobs (spec §9.9): `backups/blobs/<sha256>` is linked or copied from the upload only when the
// upload's bytes still have the SHA-256 its `files` row names. One that does not (bit rot, an in-place edit of the same
// size) gets no blob, so a restore marks that file `missing` (spec §9.10) instead of refusing the whole archive.

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

describe('linkBlob', () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-blobs-')));
  });

  afterAll(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  async function upload(content: Uint8Array): Promise<string> {
    const id = newId();
    const file = uploadPath(dataDir, id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
    return id;
  }

  const blob = (sha256: string) => path.join(dataDir, 'backups', 'blobs', sha256);

  it('links an upload whose bytes have its SHA-256', async () => {
    const content = Buffer.from('isi berkas yang utuh\n');
    const id = await upload(content);
    expect(await linkBlob(dataDir, { id, size: content.byteLength, sha256: sha(content), status: 'ok' })).toBe(true);
    expect(await fsp.readFile(blob(sha(content)))).toEqual(content);
  });

  it('refuses an upload of the right size whose bytes no longer have its SHA-256: no blob', async () => {
    const content = Buffer.from('isi berkas sebelum rusak\n');
    const damaged = Buffer.from(content);
    damaged[3] = damaged[3]! ^ 0xff;
    const id = await upload(damaged);
    expect(await linkBlob(dataDir, { id, size: content.byteLength, sha256: sha(content), status: 'ok' })).toBe(false);
    await expect(fsp.stat(blob(sha(content)))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a missing upload and one of another size', async () => {
    const content = Buffer.from('isi lain\n');
    expect(await linkBlob(dataDir, { id: newId(), size: content.byteLength, sha256: sha(content), status: 'ok' })).toBe(false);
    const id = await upload(Buffer.concat([content, Buffer.from('x')]));
    expect(await linkBlob(dataDir, { id, size: content.byteLength, sha256: sha(content), status: 'ok' })).toBe(false);
  });
});
