import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PHASE1_MIGRATIONS, claimLock, countRows, runMigrations, withTx } from '@altis/db';
import { dataPath, resetTestFaults, uploadPath } from '@altis/platform';
import { DomainError, isDomainError, newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import {
  CHUNK_DEFAULT_BYTES,
  CHUNK_MIN_BYTES,
  UPLOADS_PER_SUBJECT,
  UPLOAD_CONTEXTS,
  UPLOAD_TTL_MS,
  type UploadContext,
} from '../../src/files/contexts.js';
import { IncrementalSha256, decodeSha256Midstate, encodeSha256Midstate } from '../../src/files/sha256-incremental.js';
import {
  abortUpload,
  acceptChunk,
  completeUpload,
  createUpload,
  prepareUpload,
  takeStagedUpload,
  uploadOwner,
  withUploadLock,
  type UploadLockTiming,
} from '../../src/files/uploads.js';

// Chunked, resumable uploads (spec §7.5, P10, P21; decision C7; preflight M16, M36) on the engine picked by
// ALTIS_TEST_DB: a session declares its context, size and SHA-256 first; chunk n covers bytes from n × chunk_size and
// is written at that offset (a resent chunk is a no-op, a gap is refused); completion checks the size, the hash and
// the magic bytes; a full disk during a chunk removes the partial file and the session (Review Focus 3).
//
// Ruling R1c-4 (P9): the SHA-256 grows with each chunk (a pure-JS midstate saved beside the staged file, so the next
// chunk may reach another process); completion compares digests and reads only the head of the file. The upload's
// lock is renewed while it is held, and a holder that lost it stops before its next change.

const ctx = testDbContext();
const NOW = 1_800_000_000_000;
const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

const BACKUP = UPLOAD_CONTEXTS.backup!;
const TEST = UPLOAD_CONTEXTS.test!;

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** `n` random bytes; with `zip`, they start with a ZIP local file header. */
function payload(n: number, zip = false): Uint8Array {
  const data = new Uint8Array(randomBytes(n));
  if (zip) data.set([0x50, 0x4b, 0x03, 0x04], 0);
  return data;
}

/** The chunks of `data` cut at `size`. */
function chunksOf(data: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < data.byteLength; at += size) out.push(data.subarray(at, Math.min(at + size, data.byteLength)));
  return out;
}

/** Runs `fn` and returns the DomainError it throws (failing the test when it resolves or throws anything else). */
async function domainError(fn: () => Promise<unknown>): Promise<DomainError> {
  try {
    await fn();
  } catch (error) {
    if (isDomainError(error)) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe.skipIf(!ctx.available)(`uploads [${engineLabel()}]`, () => {
  let h: TestDbHandle;
  let dataDir: string;

  async function staff(): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('staff_users')
      .values({
        id,
        username_key: `u_${id.toLowerCase()}`,
        username_display: `u_${id}`,
        name: 'Uji Unggah',
        password_hash: 'x',
        status: 'active',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute();
    return uploadOwner(id);
  }

  function create(owner: string, context: UploadContext, data: Uint8Array, o: { chunkBytes?: number; now?: number; sha256?: string } = {}) {
    return withTx(h, (trx) =>
      createUpload(trx, {
        owner,
        context,
        size: data.byteLength,
        sha256: o.sha256 ?? sha(data),
        ...(o.chunkBytes === undefined ? {} : { chunkBytes: o.chunkBytes }),
        now: o.now ?? NOW,
        dataDir,
      }),
    );
  }

  const chunk = (id: string, owner: string, n: number, data: Uint8Array, now = NOW) =>
    acceptChunk(h, { id, owner, n, data, now, dataDir });

  /** Creates a session for `data` and sends every chunk in order. */
  async function uploaded(owner: string, context: UploadContext, data: Uint8Array, sha256?: string) {
    const s = await create(owner, context, data, { chunkBytes: CHUNK_MIN_BYTES, ...(sha256 === undefined ? {} : { sha256 }) });
    const parts = chunksOf(data, s.chunkSize);
    for (const [n, part] of parts.entries()) await chunk(s.id, owner, n, part);
    return s;
  }

  const stagedFile = (id: string) => dataPath(dataDir, 'tmp', id, 'upload.bin');
  const stagingDir = (id: string) => dataPath(dataDir, 'tmp', id);
  /** `tmp/<id>/upload.midstate`: the SHA-256 midstate of the bytes received so far (R1c-4). */
  const midstateFile = (id: string) => path.join(dataDir, 'tmp', id, 'upload.midstate');
  /** The midstate saved for upload `id`, as a hash that can go on (fails the test when it is missing or corrupt). */
  async function savedDigest(id: string): Promise<IncrementalSha256> {
    const m = decodeSha256Midstate(await fsp.readFile(midstateFile(id), 'utf8'));
    expect(m).not.toBeNull();
    return IncrementalSha256.fromMidstate(m!);
  }
  /** Overwrites `bytes` at `offset` of the staged file of upload `id` (behind the server's back). */
  async function scribble(id: string, offset: number, bytes: Uint8Array): Promise<void> {
    const handle = await fsp.open(stagedFile(id), 'r+');
    try {
      await handle.write(bytes, 0, bytes.byteLength, offset);
    } finally {
      await handle.close();
    }
  }
  const exists = (p: string) =>
    fsp.stat(p).then(
      () => true,
      () => false,
    );
  const session = (id: string) => h.db.selectFrom('upload_sessions').selectAll().where('id', '=', id).executeTakeFirst();
  /** The `notification.disk_low` rows (P21: Diagnostik's `disk.lowAt` and the dashboard read them). */
  const diskLow = () =>
    h.db.selectFrom('notifications').select(['type', 'title_key', 'audience_permission']).where('type', '=', 'disk.low').execute();
  const DISK_LOW = { type: 'disk.low', title_key: 'notification.disk_low.title', audience_permission: 'system.diagnostics.read' };

  beforeAll(async () => {
    h = await testDb();
    dataDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-core-uploads-')));
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
  });

  afterAll(async () => {
    await h?.close();
    if (dataDir !== undefined) await fsp.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await h.db.deleteFrom('upload_sessions').execute();
    await h.db.deleteFrom('settings').where('key', '=', 'system.probe').execute();
    await h.db.deleteFrom('notifications').execute();
  });

  afterEach(() => {
    delete process.env['ALTIS_TEST_FAULT'];
    resetTestFaults();
  });

  describe('contexts', () => {
    it('backup and update are staged ZIP contexts behind their permissions; test is any signed-in staff', () => {
      expect(BACKUP).toEqual({ name: 'backup', permission: 'system.backup.restore', maxBytes: 20 * GIB, magic: ['zip'], kind: 'staged' });
      expect(UPLOAD_CONTEXTS.update).toEqual({ name: 'update', permission: 'system.update.run', maxBytes: GIB, magic: ['zip'], kind: 'staged' });
      expect(TEST).toEqual({ name: 'test', permission: null, maxBytes: 16 * MIB, magic: 'any', kind: 'file' });
      expect([CHUNK_DEFAULT_BYTES, CHUNK_MIN_BYTES, UPLOADS_PER_SUBJECT, UPLOAD_TTL_MS]).toEqual([5 * MIB, 256 * KIB, 3, 86_400_000]);
    });
  });

  describe('createUpload', () => {
    it('fixes the chunk size: the request, else the stored probe result, else 5 MiB, within 256 KiB to 5 MiB', async () => {
      const owner = await staff();
      const data = payload(10);
      expect((await create(owner, BACKUP, data)).chunkSize).toBe(CHUNK_DEFAULT_BYTES);
      expect((await create(owner, BACKUP, data, { chunkBytes: 1 })).chunkSize).toBe(CHUNK_MIN_BYTES);
      await h.db.deleteFrom('upload_sessions').execute();
      expect((await create(owner, BACKUP, data, { chunkBytes: 100 * MIB })).chunkSize).toBe(CHUNK_DEFAULT_BYTES);
      await h.db
        .insertInto('settings')
        .values({
          key: 'system.probe',
          value: JSON.stringify({
            at: NOW,
            polling: true,
            sse: false,
            methods: { put: true, patch: true, delete: true },
            chunkBytes: MIB,
            xff: { spoofable: false, suggestedHops: null },
          }),
          is_secret: 0,
          scope: 'instance',
          updated_at: NOW,
        })
        .execute();
      expect((await create(owner, BACKUP, data)).chunkSize).toBe(MIB);
      await h.db.deleteFrom('upload_sessions').execute();
      expect((await create(owner, BACKUP, data, { chunkBytes: 300 * KIB })).chunkSize).toBe(300 * KIB);
    });

    it('answers the id, the number of chunks and the expiry (24 h), and writes no file yet', async () => {
      const owner = await staff();
      const s = await create(owner, BACKUP, payload(2 * CHUNK_MIN_BYTES + 1), { chunkBytes: CHUNK_MIN_BYTES });
      expect(s).toEqual({ id: expect.any(String), chunkSize: CHUNK_MIN_BYTES, chunks: 3, expiresAt: NOW + UPLOAD_TTL_MS });
      const row = await session(s.id);
      expect(row).toMatchObject({ owner, context: 'backup', sha256: expect.any(String) });
      expect([Number(row!.size), Number(row!.chunk_size), Number(row!.received)]).toEqual([2 * CHUNK_MIN_BYTES + 1, CHUNK_MIN_BYTES, 0]);
      expect(await exists(stagingDir(s.id))).toBe(false);
    });

    it('refuses a size over the context maximum with UPLOAD_TOO_LARGE (413)', async () => {
      const owner = await staff();
      const error = await domainError(() =>
        withTx(h, (trx) => createUpload(trx, { owner, context: TEST, size: 16 * MIB + 1, sha256: '0'.repeat(64), now: NOW, dataDir })),
      );
      expect([error.code, error.status]).toEqual(['UPLOAD_TOO_LARGE', 413]);
    });

    it('refuses a 4th live session of one owner with UPLOAD_LIMIT (429), an expired one not counting', async () => {
      const owner = await staff();
      const other = await staff();
      const data = payload(10);
      await create(owner, BACKUP, data, { now: NOW - UPLOAD_TTL_MS - 1 }); // expired by NOW
      for (let i = 0; i < UPLOADS_PER_SUBJECT; i += 1) await create(owner, BACKUP, data, { now: NOW + i * 1000 });
      const error = await domainError(() => create(owner, BACKUP, data, { now: NOW + 5000 }));
      expect([error.code, error.status]).toEqual(['UPLOAD_LIMIT', 429]);
      // The oldest live session expires 24 h after NOW: the wait is counted from the request.
      expect(error.meta?.['retryAfterS']).toBe(Math.ceil((UPLOAD_TTL_MS - 5000) / 1000));
      await expect(create(other, BACKUP, data)).resolves.toBeDefined();
    });

    it('lets exactly one of two concurrent creates through for an owner with 2 live sessions (M36)', async () => {
      const owner = await staff();
      const data = payload(10);
      await create(owner, BACKUP, data);
      await create(owner, BACKUP, data);
      const results = await Promise.allSettled([create(owner, BACKUP, data), create(owner, BACKUP, data)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((refused.reason as DomainError).code).toBe('UPLOAD_LIMIT');
      expect(await countRows(h.db.selectFrom('upload_sessions').where('owner', '=', owner))).toBe(3);
    });
  });

  describe('prepareUpload', () => {
    it('runs the headroom check for twice the size before any row exists: a refusal is DISK_QUOTA', async () => {
      const refuse = vi.fn(async () => {
        throw new DomainError('DISK_QUOTA', { meta: { reason: 'headroom', code: 'EDQUOT' } });
      });
      const error = await domainError(() => prepareUpload(h, { context: BACKUP, size: 2 * GIB, dataDir, now: NOW, ensureHeadroom: refuse }));
      expect([error.code, error.status]).toEqual(['DISK_QUOTA', 507]);
      expect(refuse).toHaveBeenCalledWith(dataDir, 4 * GIB);
      expect(await countRows(h.db.selectFrom('upload_sessions'))).toBe(0);
      // P21: the refusal is reported (notification.disk_low) as any other full disk.
      expect(await diskLow()).toEqual([DISK_LOW]);
    });

    it('refuses a size over the context maximum before probing the disk', async () => {
      const probe = vi.fn(async () => {});
      const error = await domainError(() => prepareUpload(h, { context: BACKUP, size: 20 * GIB + 1, dataDir, now: NOW, ensureHeadroom: probe }));
      expect(error.code).toBe('UPLOAD_TOO_LARGE');
      expect(probe).not.toHaveBeenCalled();
      await expect(prepareUpload(h, { context: BACKUP, size: 3, dataDir, now: NOW, ensureHeadroom: probe })).resolves.toBeUndefined();
      expect(probe).toHaveBeenCalledWith(dataDir, 6);
      expect(await diskLow()).toEqual([]);
    });
  });

  describe('acceptChunk and completeUpload', () => {
    it('takes a 3-chunk upload in order and completes it with the size and SHA-256 (staged context)', async () => {
      const owner = await staff();
      const data = payload(2 * CHUNK_MIN_BYTES + 1000, true);
      const s = await create(owner, BACKUP, data, { chunkBytes: CHUNK_MIN_BYTES });
      const parts = chunksOf(data, s.chunkSize);
      expect(parts).toHaveLength(3);
      expect(await chunk(s.id, owner, 0, parts[0]!)).toEqual({ received: CHUNK_MIN_BYTES, complete: false });
      expect(await chunk(s.id, owner, 1, parts[1]!)).toEqual({ received: 2 * CHUNK_MIN_BYTES, complete: false });
      expect(await chunk(s.id, owner, 2, parts[2]!)).toEqual({ received: data.byteLength, complete: true });

      const done = await completeUpload(h, { id: s.id, owner, now: NOW, dataDir });
      expect(done).toEqual({ uploadId: s.id, size: data.byteLength, sha256: sha(data), mime: 'application/zip' });
      expect(new Uint8Array(await fsp.readFile(stagedFile(s.id)))).toEqual(data);
      expect(await exists(dataPath(dataDir, 'tmp', s.id, '.complete'))).toBe(true);
      // The session stays for the consuming route; completing again answers the same.
      expect(await session(s.id)).toBeDefined();
      expect(await completeUpload(h, { id: s.id, owner, now: NOW, dataDir })).toEqual(done);
    });

    it('treats a chunk sent again as a no-op: the file is not doubled', async () => {
      const owner = await staff();
      const data = payload(2 * CHUNK_MIN_BYTES + 10, true);
      const s = await create(owner, BACKUP, data, { chunkBytes: CHUNK_MIN_BYTES });
      const parts = chunksOf(data, s.chunkSize);
      await chunk(s.id, owner, 0, parts[0]!);
      await chunk(s.id, owner, 1, parts[1]!);
      expect(await chunk(s.id, owner, 1, parts[1]!)).toEqual({ received: 2 * CHUNK_MIN_BYTES, complete: false });
      expect((await fsp.stat(stagedFile(s.id))).size).toBe(2 * CHUNK_MIN_BYTES);
      expect(Number((await session(s.id))!.received)).toBe(2 * CHUNK_MIN_BYTES);
      await chunk(s.id, owner, 2, parts[2]!);
      expect(await completeUpload(h, { id: s.id, owner, now: NOW, dataDir })).toMatchObject({ sha256: sha(data) });
    });

    it('stores one chunk sent twice at once exactly once, and advances received once (M16)', async () => {
      const owner = await staff();
      const data = payload(2 * CHUNK_MIN_BYTES, true);
      const s = await create(owner, BACKUP, data, { chunkBytes: CHUNK_MIN_BYTES });
      const [first] = chunksOf(data, s.chunkSize);
      const replies = await Promise.all([chunk(s.id, owner, 0, first!), chunk(s.id, owner, 0, first!), chunk(s.id, owner, 0, first!)]);
      for (const reply of replies) expect(reply).toEqual({ received: CHUNK_MIN_BYTES, complete: false });
      expect((await fsp.stat(stagedFile(s.id))).size).toBe(CHUNK_MIN_BYTES);
      expect(Number((await session(s.id))!.received)).toBe(CHUNK_MIN_BYTES);
    });

    it('refuses chunk 2 before chunk 1 with 409 UPLOAD_CHUNK_INVALID reason order', async () => {
      const owner = await staff();
      const data = payload(3 * CHUNK_MIN_BYTES, true);
      const s = await create(owner, BACKUP, data, { chunkBytes: CHUNK_MIN_BYTES });
      const parts = chunksOf(data, s.chunkSize);
      await chunk(s.id, owner, 0, parts[0]!);
      const error = await domainError(() => chunk(s.id, owner, 2, parts[2]!));
      expect([error.code, error.status, error.meta?.['reason']]).toEqual(['UPLOAD_CHUNK_INVALID', 409, 'order']);
      expect((await fsp.stat(stagedFile(s.id))).size).toBe(CHUNK_MIN_BYTES);
    });

    it('refuses a chunk of the wrong length, and one past the end, with reason size', async () => {
      const owner = await staff();
      const data = payload(CHUNK_MIN_BYTES + 100, true);
      const s = await create(owner, BACKUP, data, { chunkBytes: CHUNK_MIN_BYTES });
      const short = await domainError(() => chunk(s.id, owner, 0, data.subarray(0, CHUNK_MIN_BYTES - 1)));
      expect([short.code, short.meta?.['reason']]).toEqual(['UPLOAD_CHUNK_INVALID', 'size']);
      await chunk(s.id, owner, 0, data.subarray(0, CHUNK_MIN_BYTES));
      const long = await domainError(() => chunk(s.id, owner, 1, payload(101)));
      expect([long.code, long.meta?.['reason']]).toEqual(['UPLOAD_CHUNK_INVALID', 'size']);
      await chunk(s.id, owner, 1, data.subarray(CHUNK_MIN_BYTES));
      const past = await domainError(() => chunk(s.id, owner, 2, payload(1)));
      expect([past.code, past.meta?.['reason']]).toEqual(['UPLOAD_CHUNK_INVALID', 'size']);
      expect((await fsp.stat(stagedFile(s.id))).size).toBe(data.byteLength);
    });

    it('refuses complete before every chunk arrived with 409 UPLOAD_INCOMPLETE', async () => {
      const owner = await staff();
      const data = payload(CHUNK_MIN_BYTES + 1, true);
      const s = await create(owner, BACKUP, data, { chunkBytes: CHUNK_MIN_BYTES });
      await chunk(s.id, owner, 0, data.subarray(0, CHUNK_MIN_BYTES));
      const error = await domainError(() => completeUpload(h, { id: s.id, owner, now: NOW, dataDir }));
      expect([error.code, error.status]).toEqual(['UPLOAD_INCOMPLETE', 409]);
    });

    it('refuses a declared SHA-256 that differs with 422 UPLOAD_MISMATCH reason sha256, and removes the staging', async () => {
      const owner = await staff();
      const data = payload(CHUNK_MIN_BYTES + 5, true);
      const s = await uploaded(owner, BACKUP, data, sha(payload(8)));
      const error = await domainError(() => completeUpload(h, { id: s.id, owner, now: NOW, dataDir }));
      expect([error.code, error.status, error.meta?.['reason']]).toEqual(['UPLOAD_MISMATCH', 422, 'sha256']);
      expect(await exists(stagingDir(s.id))).toBe(false);
      expect(await session(s.id)).toBeUndefined();
    });

    it('refuses a backup upload that is not a ZIP with 415 UPLOAD_TYPE_REFUSED', async () => {
      const owner = await staff();
      const data = new Uint8Array(Buffer.from('<?xml version="1.0"?><svg/>'));
      const s = await uploaded(owner, BACKUP, data);
      const error = await domainError(() => completeUpload(h, { id: s.id, owner, now: NOW, dataDir }));
      expect([error.code, error.status]).toEqual(['UPLOAD_TYPE_REFUSED', 415]);
      expect(await exists(stagingDir(s.id))).toBe(false);
      expect(await session(s.id)).toBeUndefined();
    });

    // ---- Phase 2 (catalog): Task 2 (S1) ----
    // A context's magic is a set of kinds from Wave 0 on, so the import and migration uploads of later tasks complete.
    describe('Phase 2 contexts (S1)', () => {
      const IMPORT = UPLOAD_CONTEXTS['catalog.import']!;
      const DUMP = UPLOAD_CONTEXTS['slims.dump']!;
      const MARC_LEADER = '00120nam a2200037 a 4500';

      /** Uploads `data` to `context` and completes it. */
      async function completed(context: UploadContext, data: Uint8Array) {
        const owner = await staff();
        const s = await uploaded(owner, context, data);
        return { s, done: await completeUpload(h, { id: s.id, owner, originalName: 'unggahan', now: NOW, dataDir }) };
      }

      it('a CSV with ; separators (cp1252, CRLF) to catalog.import completes as text', async () => {
        const csv = Buffer.concat([
          Buffer.from('judul;pengarang;isbn\r\n', 'latin1'),
          Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x3b, 0x4e, 0x75, 0xf1, 0x65, 0x7a, 0x3b, 0x0d, 0x0a]), // Café;Nuñez; in cp1252
          Buffer.alloc(CHUNK_MIN_BYTES, 0x41),
        ]);
        const { s, done } = await completed(IMPORT, new Uint8Array(csv));
        expect(done).toEqual({ uploadId: s.id, size: csv.byteLength, sha256: sha(csv), mime: 'text/plain' });
      });

      it('an ISO 2709 (MARC) file to catalog.import completes as iso2709', async () => {
        const record = Buffer.concat([Buffer.from(`${MARC_LEADER}245001100000`, 'latin1'), Buffer.from([0x1e]), Buffer.from('10\u001faJudul\u001e\u001d', 'latin1')]);
        const data = new Uint8Array(Buffer.concat([record, Buffer.alloc(CHUNK_MIN_BYTES, 0x20)]));
        const { s, done } = await completed(IMPORT, data);
        expect(done).toEqual({ uploadId: s.id, size: data.byteLength, sha256: sha(data), mime: 'application/marc' });
      });

      it('a .sql.gz to slims.dump completes as gzip', async () => {
        const gz = new Uint8Array(Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 3]), randomBytes(CHUNK_MIN_BYTES)]));
        const { s, done } = await completed(DUMP, gz);
        expect(done).toEqual({ uploadId: s.id, size: gz.byteLength, sha256: sha(gz), mime: 'application/gzip' });
      });

      it('a PNG to catalog.import → 415 UPLOAD_TYPE_REFUSED, naming the kind found; the upload is discarded', async () => {
        const owner = await staff();
        const png = new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(CHUNK_MIN_BYTES)]));
        const s = await uploaded(owner, IMPORT, png);
        const error = await domainError(() => completeUpload(h, { id: s.id, owner, now: NOW, dataDir }));
        expect([error.code, error.status, error.meta?.['kind']]).toEqual(['UPLOAD_TYPE_REFUSED', 415, 'png']);
        expect(await exists(stagingDir(s.id))).toBe(false);
        expect(await session(s.id)).toBeUndefined();
      });
    });

    it('a file context moves the upload to uploads/, adds a files row and drops the session', async () => {
      const owner = await staff();
      const data = new Uint8Array(Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(CHUNK_MIN_BYTES)]));
      const s = await uploaded(owner, TEST, data);
      const done = await completeUpload(h, { id: s.id, owner, originalName: 'laporan.pdf', now: NOW, dataDir });
      expect(done).toEqual({ fileId: s.id });
      expect(new Uint8Array(await fsp.readFile(uploadPath(dataDir, s.id)))).toEqual(data);
      const row = await h.db.selectFrom('files').selectAll().where('id', '=', s.id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        original_name: 'laporan.pdf',
        mime: 'application/pdf',
        sha256: sha(data),
        context: 'test',
        owner_type: null,
        owner_id: null,
        access: 'staff',
        status: 'ok',
        created_by: owner.slice('staff:'.length),
      });
      expect([Number(row.size), Number(row.created_at)]).toEqual([data.byteLength, NOW]);
      expect(await session(s.id)).toBeUndefined();
      expect(await exists(stagingDir(s.id))).toBe(false);
      // A completion sent again (its answer was lost) finds the file it made.
      expect(await completeUpload(h, { id: s.id, owner, now: NOW, dataDir })).toEqual({ fileId: s.id });
    });

    it('answers NOT_FOUND for another owner, and 410 UPLOAD_EXPIRED for a session past expires_at', async () => {
      const owner = await staff();
      const stranger = await staff();
      const data = payload(10, true);
      const s = await create(owner, BACKUP, data);
      expect((await domainError(() => chunk(s.id, stranger, 0, data))).code).toBe('NOT_FOUND');
      expect((await domainError(() => completeUpload(h, { id: s.id, owner: stranger, now: NOW, dataDir }))).code).toBe('NOT_FOUND');
      const late = NOW + UPLOAD_TTL_MS;
      const expired = await domainError(() => chunk(s.id, owner, 0, data, late));
      expect([expired.code, expired.status]).toEqual(['UPLOAD_EXPIRED', 410]);
      await chunk(s.id, owner, 0, data);
      expect((await domainError(() => completeUpload(h, { id: s.id, owner, now: late, dataDir }))).code).toBe('UPLOAD_EXPIRED');
    });
  });

  describe('a full disk during a chunk (P21, Review Focus 3)', () => {
    // Each chunk makes two writes under tmp/: its bytes into upload.bin, then the SHA-256 midstate (R1c-4). So
    // disk-full:tmp:2 hits the first chunk's midstate, and disk-full:tmp:3 the second chunk's bytes.
    it.each<[string, number]>([
      ['disk-full:tmp:2', 0],
      ['disk-full:tmp:3', 1],
    ])('%s fails chunk %i with DISK_QUOTA (507), leaves no upload.bin, deletes the session and sends disk_low', async (fault, failing) => {
      const owner = await staff();
      const data = payload(3 * CHUNK_MIN_BYTES, true);
      const s = await create(owner, BACKUP, data, { chunkBytes: CHUNK_MIN_BYTES });
      const parts = chunksOf(data, s.chunkSize);
      process.env['ALTIS_TEST_FAULT'] = fault;
      resetTestFaults();
      for (let n = 0; n < failing; n += 1) await chunk(s.id, owner, n, parts[n]!);
      const error = await domainError(() => chunk(s.id, owner, failing, parts[failing]!));
      expect([error.code, error.status]).toEqual(['DISK_QUOTA', 507]);
      expect(await exists(stagedFile(s.id))).toBe(false);
      expect(await exists(stagingDir(s.id))).toBe(false);
      expect(await session(s.id)).toBeUndefined();
      // P21: a notification and the Diagnostik warning (`disk.lowAt` reads this row), once.
      expect(await diskLow()).toEqual([DISK_LOW]);
    });

    it('a full disk while completion writes the staged marker: DISK_QUOTA and disk_low', async () => {
      const owner = await staff();
      const data = payload(CHUNK_MIN_BYTES, true);
      const s = await uploaded(owner, BACKUP, data);
      expect(await diskLow()).toEqual([]);
      process.env['ALTIS_TEST_FAULT'] = 'disk-full:tmp:1';
      resetTestFaults();
      const error = await domainError(() => completeUpload(h, { id: s.id, owner, now: NOW, dataDir }));
      expect([error.code, error.status]).toEqual(['DISK_QUOTA', 507]);
      expect(await diskLow()).toEqual([DISK_LOW]);
    });

    it('other failures send no disk_low', async () => {
      const owner = await staff();
      const data = payload(10, true);
      const s = await create(owner, BACKUP, data);
      expect((await domainError(() => chunk(s.id, owner, 1, data))).code).toBe('UPLOAD_CHUNK_INVALID');
      expect((await domainError(() => completeUpload(h, { id: s.id, owner, now: NOW, dataDir }))).code).toBe('UPLOAD_INCOMPLETE');
      expect(await diskLow()).toEqual([]);
    });
  });

  describe('the digest kept while the chunks arrive (R1c-4, P9)', () => {
    it('saves the SHA-256 midstate of the bytes received beside the staged file after every chunk', async () => {
      const owner = await staff();
      const data = payload(2 * CHUNK_MIN_BYTES + 77, true);
      const s = await create(owner, BACKUP, data, { chunkBytes: CHUNK_MIN_BYTES });
      const parts = chunksOf(data, s.chunkSize);
      for (const [n, part] of parts.entries()) {
        await chunk(s.id, owner, n, part);
        const received = Math.min((n + 1) * CHUNK_MIN_BYTES, data.byteLength);
        const digest = await savedDigest(s.id);
        expect(digest.length).toBe(received);
        expect(digest.digestHex()).toBe(sha(data.subarray(0, received)));
      }
      // A chunk sent again changes nothing.
      await chunk(s.id, owner, 1, parts[1]!);
      expect((await savedDigest(s.id)).length).toBe(data.byteLength);
    });

    it('completes from the kept digest: it reads only the head of the staged file, never the whole of it', async () => {
      const owner = await staff();
      const data = payload(3 * CHUNK_MIN_BYTES, true);
      const s = await uploaded(owner, BACKUP, data);
      // Bytes changed behind the server's back after they were accepted are not read again (the digest of what the
      // chunks brought is the one compared), ...
      await scribble(s.id, CHUNK_MIN_BYTES + 10, new Uint8Array([data[CHUNK_MIN_BYTES + 10]! ^ 0xff]));
      expect(await completeUpload(h, { id: s.id, owner, now: NOW, dataDir })).toEqual({
        uploadId: s.id,
        size: data.byteLength,
        sha256: sha(data),
        mime: 'application/zip',
      });
    });

    it('still sniffs the head on disk: a staged file whose first bytes are no longer a ZIP is refused', async () => {
      const owner = await staff();
      const data = payload(CHUNK_MIN_BYTES + 3, true);
      const s = await uploaded(owner, BACKUP, data);
      await scribble(s.id, 0, new Uint8Array(Buffer.from('%PDF')));
      const error = await domainError(() => completeUpload(h, { id: s.id, owner, now: NOW, dataDir }));
      expect([error.code, error.status]).toEqual(['UPLOAD_TYPE_REFUSED', 415]);
      expect(await exists(stagingDir(s.id))).toBe(false);
    });

    it('refuses a staged file of another size than declared with UPLOAD_MISMATCH reason size', async () => {
      const owner = await staff();
      const data = payload(CHUNK_MIN_BYTES + 3, true);
      const s = await uploaded(owner, BACKUP, data);
      await fsp.truncate(stagedFile(s.id), data.byteLength - 1);
      const error = await domainError(() => completeUpload(h, { id: s.id, owner, now: NOW, dataDir }));
      expect([error.code, error.status, error.meta?.['reason']]).toEqual(['UPLOAD_MISMATCH', 422, 'size']);
      expect(await session(s.id)).toBeUndefined();
    });

    it('catches up a midstate one chunk behind from the stored bytes (the process died before saving it)', async () => {
      const owner = await staff();
      const data = payload(3 * CHUNK_MIN_BYTES - 5, true);
      const s = await create(owner, BACKUP, data, { chunkBytes: CHUNK_MIN_BYTES });
      const parts = chunksOf(data, s.chunkSize);
      await chunk(s.id, owner, 0, parts[0]!);
      const behind = await fsp.readFile(midstateFile(s.id));
      await chunk(s.id, owner, 1, parts[1]!);
      await fsp.writeFile(midstateFile(s.id), behind); // `received` moved, the midstate did not
      await chunk(s.id, owner, 2, parts[2]!);
      const digest = await savedDigest(s.id);
      expect([digest.length, digest.digestHex()]).toEqual([data.byteLength, sha(data)]);
      // And at completion: the last chunk's midstate lost too.
      await fsp.writeFile(midstateFile(s.id), behind);
      expect(await completeUpload(h, { id: s.id, owner, now: NOW, dataDir })).toMatchObject({ sha256: sha(data) });
    });

    it.each<[string, (id: string, data: Uint8Array) => Promise<void>]>([
      ['missing', async (id) => fsp.rm(midstateFile(id))],
      ['corrupt', async (id) => fsp.writeFile(midstateFile(id), '{"v":1,"length":')],
      [
        // Bytes a stalled writer hashed but never committed: a midstate past `received` is never trusted.
        'ahead of received',
        async (id, data) => {
          const ahead = new IncrementalSha256().update(payload(data.byteLength + 64)).midstate();
          await fsp.writeFile(midstateFile(id), encodeSha256Midstate(ahead));
        },
      ],
    ])('rebuilds the midstate when it is %s, from the stored bytes, for the next chunk and for completion', async (_what, spoil) => {
      const owner = await staff();
      const data = payload(3 * CHUNK_MIN_BYTES, true);
      const s = await create(owner, BACKUP, data, { chunkBytes: CHUNK_MIN_BYTES });
      const parts = chunksOf(data, s.chunkSize);
      await chunk(s.id, owner, 0, parts[0]!);
      await chunk(s.id, owner, 1, parts[1]!);
      await spoil(s.id, data);
      await chunk(s.id, owner, 2, parts[2]!);
      expect((await savedDigest(s.id)).digestHex()).toBe(sha(data));
      await spoil(s.id, data);
      expect(await completeUpload(h, { id: s.id, owner, now: NOW, dataDir })).toMatchObject({ sha256: sha(data) });
    });

    it.each<[string, (id: string) => Promise<void>]>([
      ['cut short', (id) => fsp.truncate(stagedFile(id), CHUNK_MIN_BYTES)],
      ['gone', (id) => fsp.rm(stagedFile(id))],
    ])('a midstate that cannot be caught up (the staged bytes were %s) ends the upload: 410 UPLOAD_EXPIRED', async (_what, clean) => {
      const owner = await staff();
      const data = payload(3 * CHUNK_MIN_BYTES, true);
      const s = await create(owner, BACKUP, data, { chunkBytes: CHUNK_MIN_BYTES });
      const parts = chunksOf(data, s.chunkSize);
      await chunk(s.id, owner, 0, parts[0]!);
      await chunk(s.id, owner, 1, parts[1]!);
      await fsp.rm(midstateFile(s.id));
      await clean(s.id);
      const error = await domainError(() => chunk(s.id, owner, 2, parts[2]!));
      expect([error.code, error.status]).toEqual(['UPLOAD_EXPIRED', 410]);
      expect(await session(s.id)).toBeUndefined();
      expect(await exists(stagingDir(s.id))).toBe(false);
    });
  });

  describe('the upload lock, renewed while held (R1c-4)', () => {
    const FAST: UploadLockTiming = { ttlMs: 600, renewMs: 100, waitMs: 0 };
    const lockOwner = async (id: string) =>
      (await h.db.selectFrom('locks').select('owner').where('name', '=', `upload:${id}`).executeTakeFirst())?.owner;

    it('keeps the lock past its TTL while the holder works, so no other request gets in; frees it at the end', async () => {
      const id = newId();
      await withUploadLock(
        h,
        id,
        async (lease) => {
          await sleep(3 * FAST.ttlMs);
          expect(await claimLock(h, `upload:${id}`, newId(), 60_000)).toBe(false);
          await expect(lease.renew()).resolves.toBeUndefined();
          lease.check();
        },
        FAST,
      );
      expect(await lockOwner(id)).toBeUndefined();
    });

    it('a holder whose lock was taken over stops at its next check with 409 TX_CONFLICT reason upload_busy', async () => {
      const id = newId();
      const thief = newId();
      const reached = vi.fn();
      const error = await domainError(() =>
        withUploadLock(
          h,
          id,
          async (lease) => {
            await h.db.updateTable('locks').set({ owner: thief, until: Date.now() + 60_000 }).where('name', '=', `upload:${id}`).execute();
            await lease.renew();
            reached();
          },
          FAST,
        ),
      );
      expect([error.code, error.status, error.meta?.['reason']]).toEqual(['TX_CONFLICT', 409, 'upload_busy']);
      expect(reached).not.toHaveBeenCalled();
      expect(await lockOwner(id)).toBe(thief); // the new holder keeps it
    });

    it('a renewal by the timer that fails makes the next synchronous check throw', async () => {
      const id = newId();
      const error = await domainError(() =>
        withUploadLock(
          h,
          id,
          async (lease) => {
            await h.db.updateTable('locks').set({ owner: newId(), until: Date.now() + 60_000 }).where('name', '=', `upload:${id}`).execute();
            await sleep(3 * FAST.renewMs);
            lease.check();
          },
          FAST,
        ),
      );
      expect([error.code, error.meta?.['reason']]).toEqual(['TX_CONFLICT', 'upload_busy']);
    });

    it('counts a lease that ran out before it was renewed as lost, even when nobody took the lock meanwhile', async () => {
      const id = newId();
      const error = await domainError(() =>
        withUploadLock(
          h,
          id,
          async (lease) => {
            await sleep(400);
            await lease.renew();
          },
          { ttlMs: 250, renewMs: 60_000, waitMs: 0 },
        ),
      );
      expect([error.code, error.meta?.['reason']]).toEqual(['TX_CONFLICT', 'upload_busy']);
    });

    it('a request that cannot get the lock in time answers 409 TX_CONFLICT reason upload_busy', async () => {
      const id = newId();
      expect(await claimLock(h, `upload:${id}`, newId(), 60_000)).toBe(true);
      const ran = vi.fn();
      const error = await domainError(() => withUploadLock(h, id, ran, { ttlMs: 600, renewMs: 100, waitMs: 150 }));
      expect([error.code, error.status, error.meta?.['reason']]).toEqual(['TX_CONFLICT', 409, 'upload_busy']);
      expect(ran).not.toHaveBeenCalled();
    });
  });

  describe('takeStagedUpload and abortUpload', () => {
    it('hands a completed staged upload to its consumer once: the path, size and hash; the session is gone', async () => {
      const owner = await staff();
      const data = payload(CHUNK_MIN_BYTES + 7, true);
      const s = await uploaded(owner, BACKUP, data);
      await completeUpload(h, { id: s.id, owner, now: NOW, dataDir });
      // Another owner, or the wrong context, finds nothing.
      const stranger = await staff();
      expect(
        (await domainError(() => withTx(h, (trx) => takeStagedUpload(trx, { uploadId: s.id, owner: stranger, context: 'backup', dataDir })))).code,
      ).toBe('NOT_FOUND');
      expect(
        (await domainError(() => withTx(h, (trx) => takeStagedUpload(trx, { uploadId: s.id, owner, context: 'update', dataDir })))).code,
      ).toBe('NOT_FOUND');
      const taken = await withTx(h, (trx) => takeStagedUpload(trx, { uploadId: s.id, owner, context: 'backup', dataDir }));
      expect(taken).toEqual({ path: stagedFile(s.id), size: data.byteLength, sha256: sha(data) });
      expect(await session(s.id)).toBeUndefined();
      expect(await exists(stagedFile(s.id))).toBe(true); // the consumer moves it
      expect(
        (await domainError(() => withTx(h, (trx) => takeStagedUpload(trx, { uploadId: s.id, owner, context: 'backup', dataDir })))).code,
      ).toBe('NOT_FOUND');
    });

    it('refuses a staged upload that was not completed with UPLOAD_INCOMPLETE', async () => {
      const owner = await staff();
      const data = payload(100, true);
      const s = await uploaded(owner, BACKUP, data);
      const error = await domainError(() => withTx(h, (trx) => takeStagedUpload(trx, { uploadId: s.id, owner, context: 'backup', dataDir })));
      expect(error.code).toBe('UPLOAD_INCOMPLETE');
      expect(await session(s.id)).toBeDefined();
    });

    it('abortUpload deletes the session and its staging folder; another owner gets NOT_FOUND', async () => {
      const owner = await staff();
      const stranger = await staff();
      const data = payload(CHUNK_MIN_BYTES + 1, true);
      const s = await create(owner, BACKUP, data, { chunkBytes: CHUNK_MIN_BYTES });
      await chunk(s.id, owner, 0, data.subarray(0, CHUNK_MIN_BYTES));
      expect((await domainError(() => abortUpload(h, { id: s.id, owner: stranger, dataDir }))).code).toBe('NOT_FOUND');
      await abortUpload(h, { id: s.id, owner, dataDir });
      expect(await session(s.id)).toBeUndefined();
      expect(await exists(stagingDir(s.id))).toBe(false);
      expect((await domainError(() => chunk(s.id, owner, 1, data.subarray(CHUNK_MIN_BYTES)))).code).toBe('NOT_FOUND');
    });
  });
});
