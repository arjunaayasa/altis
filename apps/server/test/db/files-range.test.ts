import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localStorageDriver } from '@altis/core';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { createOpsFence } from '../../src/http/ops-fence.js';
import { flagOf, removeOp, writeFlag, writeOp } from '../ops-support.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor } from '../support-auth.js';

// `GET /files/:id` as Phase 2 extends it (spec §8, K12, preflight S18; plan Task 18) on the engine picked by
// ALTIS_TEST_DB:
// - one byte range on every file: 206 with Content-Range, 416 RANGE_NOT_SATISFIABLE past the end (several ranges or a
//   malformed one are ignored); a HEAD answers the same headers;
// - audio and video are served inline, as raster images and PDF were;
// - a public file may stay a day in any cache, with its SHA-256 as ETag, and the same If-None-Match is a 304; a staff
//   file stays `private, no-store`;
// - a cover or attachment of a hidden, archived or merged record, or a staff attachment, is a staff file: refused to
//   a visitor (404 when it was public, 401 when it is staff by itself);
// - a run report is never served here, to anyone (S18).

const ctx = testDbContext();
let h: TestDbHandle;

/** In the past: an audit entry may not be dated ahead of the real clock. */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

interface Reply {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  code: string | undefined;
}

describe.skipIf(!ctx.available)(`GET /files/:id, Phase 2 [${engineLabel()}]`, () => {
  let root: string;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  let superAdmin: string;
  let bukuId: string;

  /** A GET (or `method`) of `p` with `headers`, signed in with the session `token` (none: a visitor). */
  async function fetchAs(token: string | null, p: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
    const all = new Headers(headers);
    if (token !== null) all.set('cookie', `${SID}=${token}`);
    const res = await app.request(p, { method, headers: all }, { incoming: { socket: { remoteAddress: '203.0.113.20' } } });
    const bytes = new Uint8Array(await res.arrayBuffer());
    let code: string | undefined;
    try {
      code = (JSON.parse(Buffer.from(bytes).toString('utf8')) as { code?: string }).code;
    } catch {
      code = undefined;
    }
    return { status: res.status, headers: res.headers, bytes, code };
  }
  const visitor = (p: string, headers?: Record<string, string>, method?: string) => fetchAs(null, p, headers, method);
  const staff = (p: string, headers?: Record<string, string>, method?: string) => fetchAs(admin, p, headers, method);

  /** A stored file: its blob and its `files` row. */
  async function storedFile(
    data: Uint8Array,
    o: { mime?: string; name?: string; context?: string; access?: 'public' | 'staff'; ownerType?: string | null; ownerId?: string | null } = {},
  ): Promise<string> {
    const id = newId();
    await localStorageDriver(dataDir).put(id, data, { size: data.byteLength, sha256: sha(data) });
    await h.db
      .insertInto('files')
      .values({
        id,
        original_name: o.name ?? 'berkas.bin',
        mime: o.mime ?? 'application/octet-stream',
        size: data.byteLength,
        sha256: sha(data),
        context: o.context ?? 'catalog.attachment',
        owner_type: o.ownerType ?? null,
        owner_id: o.ownerId ?? null,
        access: o.access ?? 'staff',
        status: 'ok',
        created_at: NOW,
        created_by: null,
      })
      .execute();
    return id;
  }

  /** A record; hidden from the OPAC, archived or merged when asked. */
  async function seedRecord(o: { opacVisible?: boolean; archived?: boolean; mergedInto?: string } = {}): Promise<string> {
    const id = newId();
    await h.db
      .insertInto('records')
      .values({
        id,
        material_type_id: bukuId,
        title: 'Bumi Manusia',
        subtitle: null,
        responsibility: null,
        title_key: 'bumi manusia',
        edition: null,
        material_detail: null,
        publisher_id: null,
        publication_place: null,
        publication_year: null,
        publication_date_text: null,
        physical_desc: null,
        series: null,
        classification: null,
        call_number: null,
        language_id: null,
        content_type: null,
        media_type: null,
        carrier_type: null,
        summary: null,
        notes: null,
        cover_file_id: null,
        opac_visible: o.opacVisible === false ? 0 : 1,
        source: 'manual',
        merged_into: o.mergedInto ?? null,
        changed_at: NOW,
        archived_at: o.archived === true || o.mergedInto !== undefined ? NOW : null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return id;
  }

  /** A file attachment of `recordId` with `access`, its file stored with the same access (as the service keeps it). */
  async function attachmentFile(recordId: string, access: 'public' | 'staff', data: Uint8Array = new Uint8Array(randomBytes(50))): Promise<string> {
    const attachmentId = newId();
    const fileId = await storedFile(data, { mime: 'application/pdf', name: 'bab-1.pdf', access, ownerType: 'attachments', ownerId: attachmentId });
    await h.db
      .insertInto('attachments')
      .values({
        id: attachmentId,
        record_id: recordId,
        kind: 'file',
        file_id: fileId,
        url: null,
        title: 'Bab 1',
        description: null,
        access,
        legacy_access_limit: null,
        read_count: 0,
        sort_order: 0,
        archived_at: null,
        created_at: NOW,
        created_by: null,
        updated_at: NOW,
        updated_by: null,
      })
      .execute();
    return fileId;
  }

  /** The record's cover, public as the cover route makes it. */
  async function coverOf(recordId: string): Promise<string> {
    const fileId = await storedFile(new Uint8Array(randomBytes(40)), { mime: 'image/webp', name: 'sampul.webp', context: 'catalog.cover', access: 'public', ownerType: 'records', ownerId: recordId });
    await h.db.updateTable('records').set({ cover_file_id: fileId }).where('id', '=', recordId).execute();
    return fileId;
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-files-range-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir);
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    app = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir });
    const adminUser = await seedStaff(h, { username: 'admin_berkas', now: NOW, roles: [{ key: 'admin' }] });
    admin = await sessionCookieFor(h, adminUser.id, { now: NOW });
    const superUser = await seedStaff(h, { username: 'super_berkas', now: NOW, roles: [{ key: 'super_admin' }] });
    superAdmin = await sessionCookieFor(h, superUser.id, { now: NOW });
    bukuId = (await h.db.selectFrom('material_types').select('id').where('code_key', '=', 'BUKU').executeTakeFirstOrThrow()).id;
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  describe('Range', () => {
    const data = new Uint8Array(randomBytes(1000));
    let fileId: string;
    beforeAll(async () => {
      fileId = await storedFile(data, { name: 'rekaman.bin' });
    });

    it('bytes=0-99 → 206 with those 100 bytes and Content-Range; every file says it takes ranges', async () => {
      const whole = await staff(`/files/${fileId}`);
      expect([whole.status, whole.headers.get('accept-ranges'), whole.bytes.byteLength]).toEqual([200, 'bytes', 1000]);
      const res = await staff(`/files/${fileId}`, { range: 'bytes=0-99' });
      expect(res.status).toBe(206);
      expect(res.bytes).toEqual(data.subarray(0, 100));
      expect(res.headers.get('content-range')).toBe('bytes 0-99/1000');
      expect(res.headers.get('content-length')).toBe('100');
      // The protective headers stay on a partial answer.
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('an open range, a suffix range and a range past the end are cut to the file', async () => {
      const open = await staff(`/files/${fileId}`, { range: 'bytes=990-' });
      expect([open.status, open.headers.get('content-range')]).toEqual([206, 'bytes 990-999/1000']);
      expect(open.bytes).toEqual(data.subarray(990));
      const suffix = await staff(`/files/${fileId}`, { range: 'bytes=-10' });
      expect([suffix.status, suffix.headers.get('content-range')]).toEqual([206, 'bytes 990-999/1000']);
      const long = await staff(`/files/${fileId}`, { range: 'bytes=500-5000' });
      expect([long.status, long.headers.get('content-range'), long.bytes.byteLength]).toEqual([206, 'bytes 500-999/1000', 500]);
    });

    it('bytes=999999- → 416 RANGE_NOT_SATISFIABLE with Content-Range bytes */size', async () => {
      const res = await staff(`/files/${fileId}`, { range: 'bytes=999999-' });
      expect([res.status, res.code, res.headers.get('content-range')]).toEqual([416, 'RANGE_NOT_SATISFIABLE', 'bytes */1000']);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    });

    it('several ranges, another unit or a malformed range are ignored: 200 with the whole file', async () => {
      for (const range of ['bytes=0-1,5-6', 'items=0-1', 'bytes=9-2', 'bytes=x-']) {
        const res = await staff(`/files/${fileId}`, { range });
        expect([res.status, res.bytes.byteLength], range).toEqual([200, 1000]);
      }
    });

    it('a HEAD with a range answers the partial headers without a body', async () => {
      const res = await staff(`/files/${fileId}`, { range: 'bytes=0-99' }, 'HEAD');
      expect([res.status, res.headers.get('content-range'), res.headers.get('content-length'), res.bytes.byteLength]).toEqual([206, 'bytes 0-99/1000', '100', 0]);
    });

    it('L11: an empty file has no byte to range over: any range gets it whole (200, no Content-Range), never bytes 0--1/0', async () => {
      // A SLiMS repository's empty file is migrated as an `ok` file of 0 bytes.
      const empty = await storedFile(new Uint8Array(0), { name: 'kosong.pdf', mime: 'application/pdf' });
      for (const range of ['bytes=-10', 'bytes=0-', 'bytes=0-99']) {
        for (const method of ['GET', 'HEAD']) {
          const res = await staff(`/files/${empty}`, { range }, method);
          expect([res.status, res.headers.get('content-range'), res.headers.get('content-length'), res.bytes.byteLength], `${method} ${range}`).toEqual([200, null, '0', 0]);
        }
      }
    });
  });

  describe('inline audio and video', () => {
    it.each([
      ['audio/mpeg', 'lagu.mp3'],
      ['audio/mp4', 'kuliah.m4a'],
      ['video/mp4', 'video.mp4'],
      ['audio/ogg', 'suara.ogg'],
      ['audio/wav', 'rekaman.wav'],
      ['video/webm', 'klip.webm'],
    ])('%s is served inline, with a range', async (mime, name) => {
      const fileId = await storedFile(new Uint8Array(randomBytes(300)), { mime, name });
      const res = await staff(`/files/${fileId}`, { range: 'bytes=100-199' });
      expect([res.status, res.headers.get('content-type')]).toEqual([206, mime]);
      expect(res.headers.get('content-disposition')).toBe(`inline; filename="${name}"; filename*=UTF-8''${name}`);
    });

    it('text, XML and unknown types stay downloads', async () => {
      for (const mime of ['text/plain', 'application/xml', 'application/octet-stream', 'application/zip']) {
        const res = await staff(`/files/${await storedFile(new Uint8Array(randomBytes(10)), { mime, name: 'x' })}`);
        expect(res.headers.get('content-disposition'), mime).toMatch(/^attachment; /);
      }
    });
  });

  describe('caching', () => {
    it('a public file: ETag "<sha256>", public for a day, and the same If-None-Match → 304 without a body', async () => {
      const data = new Uint8Array(randomBytes(200));
      const fileId = await attachmentFile(await seedRecord(), 'public', data);
      const res = await visitor(`/files/${fileId}`);
      expect(res.status).toBe(200);
      expect(res.bytes).toEqual(data);
      expect(res.headers.get('etag')).toBe(`"${sha(data)}"`);
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
      const again = await visitor(`/files/${fileId}`, { 'if-none-match': `"${sha(data)}"` });
      expect([again.status, again.bytes.byteLength, again.headers.get('etag'), again.headers.get('cache-control')]).toEqual([
        304,
        0,
        `"${sha(data)}"`,
        'public, max-age=86400',
      ]);
      // A weak comparison, a list, and `*` match as well; another tag does not.
      for (const tag of [`W/"${sha(data)}"`, `"x", "${sha(data)}"`, '*']) expect((await visitor(`/files/${fileId}`, { 'if-none-match': tag })).status, tag).toBe(304);
      expect((await visitor(`/files/${fileId}`, { 'if-none-match': '"other"' })).status).toBe(200);
      // If-Range with the ETag keeps the range; with another validator the whole file comes.
      expect((await visitor(`/files/${fileId}`, { range: 'bytes=0-9', 'if-range': `"${sha(data)}"` })).status).toBe(206);
      expect((await visitor(`/files/${fileId}`, { range: 'bytes=0-9', 'if-range': '"old"' })).status).toBe(200);
    });

    it('a staff file stays private, no-store, without an ETag, and If-None-Match never makes it a 304', async () => {
      const data = new Uint8Array(randomBytes(100));
      const fileId = await storedFile(data);
      const res = await staff(`/files/${fileId}`, { 'if-none-match': `"${sha(data)}"` });
      expect([res.status, res.headers.get('cache-control'), res.headers.get('etag')]).toEqual([200, 'private, no-store', null]);
    });
  });

  describe('files of records that are not published', () => {
    it('a public attachment of a hidden record is refused to a visitor (404) and served to staff as a staff file', async () => {
      const fileId = await attachmentFile(await seedRecord({ opacVisible: false }), 'public');
      const res = await visitor(`/files/${fileId}`);
      expect([res.status, res.code]).toEqual([404, 'NOT_FOUND']);
      const own = await staff(`/files/${fileId}`);
      expect([own.status, own.headers.get('cache-control'), own.headers.get('etag')]).toEqual([200, 'private, no-store', null]);
    });

    it('so is a cover or attachment of an archived or merged record, and the cover of a hidden one', async () => {
      const target = await seedRecord();
      for (const fileId of [
        await attachmentFile(await seedRecord({ archived: true }), 'public'),
        await attachmentFile(await seedRecord({ mergedInto: target }), 'public'),
        await coverOf(await seedRecord({ opacVisible: false })),
        await coverOf(await seedRecord({ archived: true })),
      ]) {
        expect((await visitor(`/files/${fileId}`)).status, fileId).toBe(404);
        expect((await staff(`/files/${fileId}`)).status, fileId).toBe(200);
      }
      // The cover of a published record is public.
      const cover = await visitor(`/files/${await coverOf(target)}`);
      expect([cover.status, cover.headers.get('cache-control')]).toEqual([200, 'public, max-age=86400']);
    });

    it('a staff attachment is refused to a visitor (401 AUTH_REQUIRED, as every staff file)', async () => {
      const fileId = await attachmentFile(await seedRecord(), 'staff');
      const res = await visitor(`/files/${fileId}`);
      expect([res.status, res.code]).toEqual([401, 'AUTH_REQUIRED']);
      expect((await staff(`/files/${fileId}`)).status).toBe(200);
    });
  });

  describe('during maintenance (L10: spec §12.3, every OPAC route is allow, and /files/:id serves what they embed)', () => {
    let fenced: ReturnType<typeof createApp>;
    beforeAll(() => {
      // A fence that looks on every request, so that each flag written is seen by the next request.
      const opsFence = createOpsFence({ dataDir, intervalMs: 0, clock: () => Date.now(), onEpoch() {}, onOpEnded() {} });
      fenced = createApp({ state: { phase: 'ready', db: h, config: CONFIG }, version: '0.1.0', buildId: 'b', log: recordingLogger(), clock: () => NOW, dataDir, services: { opsFence } });
    });
    afterEach(async () => {
      await writeFlag(dataDir, null);
      await removeOp(dataDir);
    });

    const fencedGet = async (p: string, headers: Record<string, string> = {}) => {
      const res = await fenced.request(p, { headers: new Headers(headers) }, { incoming: { socket: { remoteAddress: '203.0.113.21' } } });
      return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
    };

    it('an update op\'s flag: a public cover and a public attachment\'s media (a range) are still served; a staff API route is 503', async () => {
      const recordId = await seedRecord();
      const cover = await coverOf(recordId);
      const media = new Uint8Array(randomBytes(300));
      const attachment = await attachmentFile(recordId, 'public', media);
      const written = await writeOp(dataDir, { kind: 'update', state: 'frozen' });
      await writeFlag(dataDir, flagOf('update', written.op.opId));
      const shown = await fencedGet(`/files/${cover}`);
      expect([shown.status, shown.headers.get('cache-control')]).toEqual([200, 'public, max-age=86400']);
      const part = await fencedGet(`/files/${attachment}`, { range: 'bytes=100-199' });
      expect([part.status, part.headers.get('content-range')]).toEqual([206, 'bytes 100-199/300']);
      expect(part.bytes).toEqual(media.subarray(100, 200));
      // The flag is up: a route that is `deny` answers 503 MAINTENANCE.
      expect((await fencedGet('/api/v1/catalog/records', { accept: 'application/json' })).status).toBe(503);
    });

    it('a restore\'s flag: /files/:id is refused like every route but the restore-allow ones', async () => {
      const cover = await coverOf(await seedRecord());
      const written = await writeOp(dataDir, { kind: 'restore', state: 'prechecked' });
      await writeFlag(dataDir, flagOf('restore', written.op.opId));
      const res = await fencedGet(`/files/${cover}`);
      expect([res.status, res.headers.get('retry-after')]).toEqual([503, '30']);
    });
  });

  describe('run reports (S18)', () => {
    it('a migration run report is 404 for a staff session without catalog.migration.run, for a super admin and for a visitor', async () => {
      const runId = newId();
      const reportId = await storedFile(new Uint8Array(Buffer.from('baris,judul\n1,Laskar Pelangi\n')), {
        mime: 'text/plain',
        name: 'laporan.csv',
        context: 'catalog.report',
        ownerType: 'catalog_runs',
        ownerId: runId,
      });
      await h.db
        .insertInto('catalog_runs')
        .values({
          id: runId,
          kind: 'migration',
          status: 'succeeded',
          dry_run: 0,
          format: null,
          options: '{}',
          summary: '{}',
          report_file_id: reportId,
          output_name: null,
          output_size: null,
          expires_at: null,
          job_id: null,
          created_at: NOW,
          created_by: null,
          finished_at: NOW,
        })
        .execute();
      for (const [who, token] of [
        ['admin', admin],
        ['super admin', superAdmin],
        ['visitor', null],
      ] as const) {
        for (const method of ['GET', 'HEAD']) {
          const res = await fetchAs(token, `/files/${reportId}`, {}, method);
          expect(res.status, `${who} ${method}`).toBe(404);
        }
      }
      // A report is never served by its context alone either, whoever owns the row.
      const loose = await storedFile(new Uint8Array(randomBytes(10)), { context: 'catalog.report', access: 'public' });
      expect((await fetchAs(superAdmin, `/files/${loose}`)).status).toBe(404);
    });
  });
});
