import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PHASE1_MIGRATIONS, runMigrations } from '@altis/db';
import { newId } from '@altis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { engineLabel, testDb, testDbContext, type TestDbHandle } from '../../../../tools/test/test-db.js';
import { createApp } from '../../src/app.js';
import { defineRoutes, route, type RouteDecl } from '../../src/http/route.js';
import { createAgent, type AgentReply } from '../agent.js';
import { recordingLogger, sampleConfig } from '../support.js';
import { seedStaff, sessionCookieFor, sessionCsrfFor } from '../support-auth.js';

// The upload and file routes of Task 9 on the engine picked by ALTIS_TEST_DB (spec §7.5, P10; decision C7): a
// session is declared (`POST files/uploads`), its chunks arrive as multipart/form-data (field `chunk`) behind CSRF
// like any write, `complete` checks size, hash and type, and `GET /files/:id` serves a `file`-context upload with the
// headers that keep it from running as a page of the site.

const ctx = testDbContext();
let h: TestDbHandle;

const NOW = Date.UTC(2026, 9, 20, 9, 0, 5);
const CONFIG = sampleConfig();
const SID = '__Host-altis_sid';
const UPLOADS = '/api/v1/files/uploads';
const KIB = 1024;
const MIB = 1024 * KIB;
/** The chunk route's body limit: 5 MiB of chunk plus 64 KiB of multipart framing. */
const CHUNK_ROUTE_MAX = 5 * MIB + 64 * KIB;

const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const code = (res: AgentReply | Response | { json: unknown }): string | undefined => ((res as { json: unknown }).json as { code?: string } | undefined)?.code;

interface Reply {
  status: number;
  json: unknown;
  headers: Headers;
  bytes: Uint8Array;
}

/** A browser signed in as one staff user. */
interface Client {
  userId: string;
  post(p: string, body: unknown, headers?: Record<string, string>): Promise<AgentReply>;
  delete(p: string): Promise<AgentReply>;
  /** `POST <p>` with `form` as multipart/form-data. */
  multipart(p: string, form: FormData | string, headers?: Record<string, string>): Promise<Reply>;
  /** A GET that keeps the body as bytes. */
  fetch(p: string, method?: string): Promise<Reply>;
}

describe.skipIf(!ctx.available)(`files API [${engineLabel()}]`, () => {
  let root: string;
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  let staff: Client;
  let other: Client;
  let restorer: Client;
  let anonymous: Client;

  async function read(res: Response): Promise<Reply> {
    const bytes = new Uint8Array(await res.arrayBuffer());
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      json = undefined;
    }
    return { status: res.status, json, headers: res.headers, bytes };
  }

  function client(token: string | null, userId = ''): Client {
    const agent = createAgent(app);
    const base: Record<string, string> = {};
    if (token !== null) {
      agent.setCookie(SID, token);
      base['x-csrf-token'] = sessionCsrfFor(CONFIG, token);
      base['cookie'] = `${SID}=${token}`;
    }
    const raw = async (p: string, init: RequestInit): Promise<Reply> =>
      read(await app.request(p, init, { incoming: { socket: { remoteAddress: '203.0.113.10' } } }));
    return {
      userId,
      post: (p, body, headers = {}) => agent.post(p, body, { ...base, ...headers }),
      delete: (p) => agent.delete(p, undefined, base),
      multipart: (p, form, headers = {}) => {
        const h2 = new Headers({ ...base, ...headers });
        if (typeof form === 'string') h2.set('content-type', 'application/json');
        return raw(p, { method: 'POST', headers: h2, body: form });
      },
      fetch: (p, method = 'GET') => raw(p, { method, headers: new Headers(token === null ? {} : { cookie: base['cookie']! }) }),
    };
  }

  async function signedIn(username: string, permissions: string[] | null): Promise<Client> {
    const user = await seedStaff(h, {
      username,
      now: NOW,
      ...(permissions === null ? {} : { roles: [{ permissions: permissions as never }] }),
    });
    return client(await sessionCookieFor(h, user.id, { now: NOW }), user.id);
  }

  const form = (data: Uint8Array): FormData => {
    const f = new FormData();
    f.append('chunk', new Blob([data]), 'blob');
    return f;
  };

  /** Declares an upload of `data` in `context`; the session's id and chunk size. */
  async function declare(who: Client, data: Uint8Array, context = 'test', extra: Record<string, unknown> = {}) {
    const res = await who.post(UPLOADS, { context, size: data.byteLength, sha256: sha(data), chunkBytes: 256 * KIB, ...extra });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json as { id: string; chunkSize: number; chunks: number; expiresAt: number };
  }

  /** Uploads `data` in the test context and completes it as `originalName`; the file id. */
  async function upload(who: Client, data: Uint8Array, originalName: string): Promise<string> {
    const s = await declare(who, data);
    for (let n = 0; n * s.chunkSize < data.byteLength; n += 1) {
      const res = await who.multipart(`${UPLOADS}/${s.id}/chunks/${n}`, form(data.subarray(n * s.chunkSize, (n + 1) * s.chunkSize)));
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    }
    const done = await who.post(`${UPLOADS}/${s.id}/complete`, { originalName });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    return (done.json as { fileId: string }).fileId;
  }

  beforeAll(async () => {
    h = await testDb();
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'altis-files-api-')));
    dataDir = path.join(root, 'data');
    await fsp.mkdir(dataDir);
    await runMigrations(h, { appVersion: '0.1.0', dataDir, migrations: PHASE1_MIGRATIONS });
    app = createApp({
      state: { phase: 'ready', db: h, config: CONFIG },
      version: '0.1.0',
      buildId: 'b',
      log: recordingLogger(),
      clock: () => NOW,
      dataDir,
    });
    staff = await signedIn('staf_unggah', null);
    other = await signedIn('staf_lain', null);
    restorer = await signedIn('pemulih', ['system.backup.restore']);
    anonymous = client(null);
  });

  afterAll(async () => {
    await h?.close();
    if (root !== undefined) await fsp.rm(root, { recursive: true, force: true });
  });

  describe('POST files/uploads', () => {
    it('declares a session: 201 {id, chunkSize, chunks, expiresAt}', async () => {
      const data = new Uint8Array(randomBytes(600 * KIB));
      const s = await declare(staff, data);
      expect(s).toEqual({ id: expect.any(String), chunkSize: 256 * KIB, chunks: 3, expiresAt: NOW + 86_400_000 });
      expect((await staff.delete(`${UPLOADS}/${s.id}`)).status).toBe(204);
    });

    it('needs a session, and the context permission for backup', async () => {
      const body = { context: 'backup', size: 10, sha256: '0'.repeat(64) };
      // A write without a session fails step 8 (no CSRF token can match) before step 9 asks for the session.
      const visitor = await anonymous.post(UPLOADS, body);
      expect([visitor.status, code(visitor)]).toEqual([403, 'CSRF_INVALID']);
      const denied = await staff.post(UPLOADS, body);
      expect([denied.status, code(denied)]).toEqual([403, 'AUTHZ_DENIED']);
      const allowed = await restorer.post(UPLOADS, body);
      expect(allowed.status).toBe(201);
      expect((await restorer.delete(`${UPLOADS}/${(allowed.json as { id: string }).id}`)).status).toBe(204);
    });

    it("a refusal by the context's permission writes authz.denied as step 9 does (§7.8), once a minute per user", async () => {
      const uploader = await signedIn('staf_tanpa_izin', null);
      for (const context of ['backup', 'update', 'backup']) {
        const denied = await uploader.post(UPLOADS, { context, size: 10, sha256: '0'.repeat(64) });
        expect([denied.status, code(denied)], context).toEqual([403, 'AUTHZ_DENIED']);
      }
      const rows = await h.db
        .selectFrom('audit_log')
        .select(['actor_id', 'meta'])
        .where('action', '=', 'authz.denied')
        .where('actor_id', '=', uploader.userId)
        .execute();
      expect(rows.map((r) => JSON.parse(r.meta) as unknown)).toEqual([{ route: 'files.uploads.create', permission: 'system.backup.restore' }]);
    });

    it('refuses a size over the context limit (413) and a malformed declaration (422)', async () => {
      const big = await staff.post(UPLOADS, { context: 'test', size: 16 * MIB + 1, sha256: '0'.repeat(64) });
      expect([big.status, code(big)]).toEqual([413, 'UPLOAD_TOO_LARGE']);
      for (const body of [
        { context: 'other', size: 1, sha256: '0'.repeat(64) },
        { context: 'test', size: 0, sha256: '0'.repeat(64) },
        { context: 'test', size: 1, sha256: 'A'.repeat(64) },
        { context: 'test', size: 1, sha256: '0'.repeat(64), extra: 1 },
      ]) {
        const res = await staff.post(UPLOADS, body);
        expect([res.status, code(res)], JSON.stringify(body)).toEqual([422, 'VALIDATION_FAILED']);
      }
    });

    it('replays the declaration for the same Idempotency-Key', async () => {
      const body = { context: 'test', size: 5, sha256: '1'.repeat(64) };
      const first = await staff.post(UPLOADS, body, { 'idempotency-key': 'upload-key-0001' });
      const again = await staff.post(UPLOADS, body, { 'idempotency-key': 'upload-key-0001' });
      expect(first.status).toBe(201);
      expect(again.json).toEqual(first.json);
      expect((await staff.delete(`${UPLOADS}/${(first.json as { id: string }).id}`)).status).toBe(204);
    });
  });

  describe('POST files/uploads/:id/chunks/:n', () => {
    it('takes chunks as multipart/form-data with an X-CSRF-Token; without the token it is 403', async () => {
      const data = new Uint8Array(randomBytes(256 * KIB + 10));
      const s = await declare(staff, data);
      const noCsrf = await staff.multipart(`${UPLOADS}/${s.id}/chunks/0`, form(data.subarray(0, 256 * KIB)), { 'x-csrf-token': 'nope' });
      expect([noCsrf.status, code(noCsrf)]).toEqual([403, 'CSRF_INVALID']);
      const first = await staff.multipart(`${UPLOADS}/${s.id}/chunks/0`, form(data.subarray(0, 256 * KIB)));
      expect([first.status, first.json]).toEqual([200, { received: 256 * KIB, complete: false }]);
      const last = await staff.multipart(`${UPLOADS}/${s.id}/chunks/1`, form(data.subarray(256 * KIB)));
      expect([last.status, last.json]).toEqual([200, { received: data.byteLength, complete: true }]);
      expect((await staff.delete(`${UPLOADS}/${s.id}`)).status).toBe(204);
    });

    it('answers 413 for a body over the route limit, 415 for a JSON body, 422 without the chunk field', async () => {
      const data = new Uint8Array(randomBytes(300 * KIB));
      const s = await declare(staff, data);
      const tooBig = await staff.multipart(`${UPLOADS}/${s.id}/chunks/0`, form(new Uint8Array(CHUNK_ROUTE_MAX + 1)));
      expect([tooBig.status, code(tooBig)]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
      const json = await staff.multipart(`${UPLOADS}/${s.id}/chunks/0`, JSON.stringify({ chunk: 'AAAA' }));
      expect([json.status, code(json)]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
      const empty = new FormData();
      empty.append('other', 'x');
      const missing = await staff.multipart(`${UPLOADS}/${s.id}/chunks/0`, empty);
      expect([missing.status, code(missing)]).toEqual([422, 'VALIDATION_FAILED']);
      const order = await staff.multipart(`${UPLOADS}/${s.id}/chunks/1`, form(data.subarray(256 * KIB)));
      expect([order.status, code(order), (order.json as { reason?: string }).reason]).toEqual([409, 'UPLOAD_CHUNK_INVALID', 'order']);
      expect((await staff.delete(`${UPLOADS}/${s.id}`)).status).toBe(204);
    });

    it("answers 404 for another user's upload id (chunk, complete and delete alike), and for a bad chunk number", async () => {
      const data = new Uint8Array(randomBytes(100));
      const s = await declare(staff, data);
      const chunk = await other.multipart(`${UPLOADS}/${s.id}/chunks/0`, form(data));
      expect([chunk.status, code(chunk)]).toEqual([404, 'NOT_FOUND']);
      expect((await other.post(`${UPLOADS}/${s.id}/complete`, {})).status).toBe(404);
      expect((await other.delete(`${UPLOADS}/${s.id}`)).status).toBe(404);
      expect((await staff.multipart(`${UPLOADS}/${newId()}/chunks/0`, form(data))).status).toBe(404);
      for (const n of ['-1', '1e3', '0x1', 'x']) {
        const res = await staff.multipart(`${UPLOADS}/${s.id}/chunks/${n}`, form(data));
        expect([res.status, code(res)], n).toEqual([422, 'VALIDATION_FAILED']);
      }
      expect((await staff.delete(`${UPLOADS}/${s.id}`)).status).toBe(204);
      expect((await staff.multipart(`${UPLOADS}/${s.id}/chunks/0`, form(data))).status).toBe(404);
    });
  });

  describe('complete and GET /files/:id', () => {
    it('serves a test-context upload with its bytes and the four protective headers', async () => {
      const data = new Uint8Array(randomBytes(300 * KIB));
      const fileId = await upload(staff, data, 'catatan.bin');
      const res = await staff.fetch(`/files/${fileId}`);
      expect(res.status).toBe(200);
      expect(res.bytes).toEqual(data);
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="catatan.bin"; filename*=UTF-8''catatan.bin`);
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
      expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('content-length')).toBe(String(data.byteLength));
      // Another signed-in staff member may fetch it too; a visitor without a session may not.
      expect((await other.fetch(`/files/${fileId}`)).status).toBe(200);
      const visitor = await anonymous.fetch(`/files/${fileId}`);
      expect([visitor.status, code(visitor)]).toEqual([401, 'AUTH_REQUIRED']);
      expect((await staff.fetch(`/files/${newId()}`)).status).toBe(404);
      expect((await staff.fetch('/files/not-an-id')).status).toBe(404);
    });

    it('serves a PNG inline and a ZIP as an attachment; a hostile name becomes a safe filename*', async () => {
      const png = new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]));
      const pngRes = await staff.fetch(`/files/${await upload(staff, png, 'logo.png')}`);
      expect(pngRes.headers.get('content-type')).toBe('image/png');
      expect(pngRes.headers.get('content-disposition')).toBe(`inline; filename="logo.png"; filename*=UTF-8''logo.png`);

      const zip = new Uint8Array(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(64)]));
      const zipRes = await staff.fetch(`/files/${await upload(staff, zip, '../../x".txt')}`);
      expect(zipRes.headers.get('content-type')).toBe('application/zip');
      expect(zipRes.headers.get('content-disposition')).toBe(`attachment; filename="x_.txt"; filename*=UTF-8''x_.txt`);
      expect(zipRes.bytes).toEqual(zip);

      const svg = new Uint8Array(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
      const svgRes = await staff.fetch(`/files/${await upload(staff, svg, 'gambar.svg')}`);
      expect(svgRes.headers.get('content-type')?.startsWith('image/')).toBe(false);
      expect(svgRes.headers.get('content-disposition')).toMatch(/^attachment; /);
    });

    it('answers a HEAD with the headers and no body', async () => {
      const data = new Uint8Array(randomBytes(1000));
      const fileId = await upload(staff, data, 'a.bin');
      const res = await staff.fetch(`/files/${fileId}`, 'HEAD');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe('1000');
      expect(res.bytes.byteLength).toBe(0);
    });

    it('refuses a completion whose hash differs: 422 UPLOAD_MISMATCH reason sha256', async () => {
      const data = new Uint8Array(randomBytes(100));
      const res = await staff.post(UPLOADS, { context: 'test', size: 100, sha256: sha(new Uint8Array(100)) });
      const { id } = res.json as { id: string };
      expect((await staff.multipart(`${UPLOADS}/${id}/chunks/0`, form(data))).status).toBe(200);
      const done = await staff.post(`${UPLOADS}/${id}/complete`, {});
      expect([done.status, code(done), (done.json as { reason?: string }).reason]).toEqual([422, 'UPLOAD_MISMATCH', 'sha256']);
      expect((await staff.post(`${UPLOADS}/${id}/complete`, {})).status).toBe(404);
    });
  });

  describe('the rawBody declaration (route contract)', () => {
    const base = {
      id: 't.raw',
      method: 'POST',
      path: '/api/v1/t/raw',
      public: true,
      session: 'required',
      idempotency: 'none',
      audit: null,
      tx: 'self',
      rawBody: { type: 'multipart', maxBytes: 1024 },
      handler: async () => ({}),
    } as const;
    const check = (patch: Record<string, unknown>) => () => defineRoutes([{ ...base, ...patch } as unknown as RouteDecl]);

    it('accepts a POST multipart rawBody without a body schema', () => {
      expect(() => defineRoutes([route(base as never)])).not.toThrow();
    });

    it.each([
      ['a GET route', { method: 'GET', tx: undefined }],
      ['a body schema beside it', { body: z.strictObject({}) }],
      ['another type', { rawBody: { type: 'json', maxBytes: 1024 } }],
      ['a maxBytes that is not a positive integer', { rawBody: { type: 'multipart', maxBytes: 0 } }],
      ['a fractional maxBytes', { rawBody: { type: 'multipart', maxBytes: 1.5 } }],
      ['idempotency store', { idempotency: 'store', tx: undefined }],
      ['not an object', { rawBody: 'multipart' }],
    ])('refuses %s: raw_body_invalid', (_what, patch) => {
      expect(check(patch)).toThrow('ROUTE_DECL_INVALID:t.raw:raw_body_invalid');
    });
  });
});
