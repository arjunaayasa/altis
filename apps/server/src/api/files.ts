import {
  CHUNK_DEFAULT_BYTES,
  abortUpload,
  acceptChunk,
  can,
  catalogFileAccess,
  completeUpload,
  createUpload,
  fileResponseHeaders,
  localStorageDriver,
  prepareUpload,
  uploadContext,
  uploadOwner,
  type UploadContext,
} from '@altis/core';
import { DomainError, isUlid } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import {
  UploadCompleteBody,
  UploadCreateBody,
  type UploadChunkResponse,
  type UploadCompleteResponse,
  type UploadCreateResponse,
} from '@altis/shared/api/files';
import { z } from 'zod';
import { problemResponse } from '../http/problem.js';
import { route, type RouteContext, type RouteDecl } from '../http/route.js';
import { validationFailed } from '../http/validate.js';
import { byteRange } from './backups.js';

// The upload and file routes of Task 9 (route catalog "Berkas"; spec §7.5, P10; decision C7). Uploads are
// `mode: system` (a backup upload must work in read-only, §8.6, C7) and belong to the signed-in staff user who
// declared them: another user's upload id is 404. Declaring needs the context's permission, and its `prepare` proves
// twice the size of disk room outside the transaction (S8, R37); the chunk, complete and delete routes touch files, so
// they open their own transactions (`tx: 'self'`). `GET /files/:id` serves a stored file with the headers of
// fileResponseHeaders; a staff file (every file in 1c) needs a full session.
//
// Phase 2 (its spec §8, K12, preflight S18; plan Task 18) extends `GET /files/:id`:
// - who may read a file is `catalogFileAccess` (core, catalog/attachments/access.ts): a run report is never served
//   here (404 to everyone, a super admin included: `GET catalog/runs/:id/report` is its only way out); a public cover
//   or attachment of a record that is hidden, archived or merged (or an archived or staff attachment) is a staff file,
//   and a visitor gets 404 for it (it is no longer published); a staff file still answers a visitor 401;
// - one byte range on every file (`bytes=a-b`, `a-`, `-n`): 206 with Content-Range, 416 RANGE_NOT_SATISFIABLE with
//   `Content-Range: bytes */<size>` past the end; several ranges, another unit or a malformed range are ignored (RFC
//   9110 §14.2), as is a range whose `If-Range` is not the file's ETag, and any range of an empty file;
// - a public file may stay a day in any cache with `ETag: "<sha256>"`, and an `If-None-Match` that names it is a 304;
//   a staff file stays `private, no-store` without an ETag.

const UPLOADS = '/api/v1/files/uploads';

/** The chunk route's body limit: the largest chunk (5 MiB) plus 64 KiB for the multipart framing. */
export const CHUNK_ROUTE_MAX_BYTES = CHUNK_DEFAULT_BYTES + 64 * 1024;

const UploadParams = z.strictObject({ id: ulidField });
/** `n` is a decimal chunk number without sign, exponent or leading zero (`1e3`, `0x1` and `-1` are refused). */
const ChunkParams = z.strictObject({
  id: ulidField,
  n: z
    .string()
    .regex(/^(0|[1-9]\d{0,8})$/)
    .transform(Number),
});

/** The upload owner of the request's staff user (`staff:<id>`); the routes require a session, so there is one. */
function ownerOf(rc: RouteContext<unknown, unknown, unknown>): string {
  if (rc.auth === null) throw new DomainError('AUTH_REQUIRED');
  return uploadOwner(rc.auth.subjectId);
}

/**
 * The upload context `name` of this build, if the request's user may upload into it. Called from `prepare`: a refusal
 * is counted and audited as step 9's are (§7.8, rc.authzDenied).
 *
 * @throws DomainError `VALIDATION_FAILED` (`context`) for a context this build does not have (`test` outside the test
 *   profile), `AUTHZ_DENIED` without the context's permission
 */
async function contextFor(rc: RouteContext<unknown, unknown, unknown>, name: string): Promise<UploadContext> {
  const context = uploadContext(name);
  if (context === null) throw validationFailed([{ path: 'context', code: 'invalid_value' }]);
  if (rc.auth === null) throw new DomainError('AUTH_REQUIRED');
  if (context.permission !== null && !can(rc.auth.grants, context.permission)) throw await rc.authzDenied(context.permission);
  return context;
}

/**
 * The bytes of the multipart field `chunk`.
 *
 * @throws DomainError `VALIDATION_FAILED`: a body that is not valid multipart (path ''), no file field `chunk`
 */
async function chunkOf(rc: RouteContext<unknown, unknown, unknown>): Promise<Uint8Array> {
  let form: FormData;
  try {
    form = await rc.c.req.formData();
  } catch {
    throw validationFailed([{ path: '', code: 'invalid_format' }]);
  }
  const chunk = form.get('chunk');
  if (chunk === null || typeof chunk === 'string') throw validationFailed([{ path: 'chunk', code: 'invalid_type' }]);
  return new Uint8Array(await chunk.arrayBuffer());
}

/** `source` as a web stream; cancelling the stream (a client gone) ends the iteration, which closes the file. */
function streamOf(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await it.next();
      if (done === true) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await it.return?.();
    },
  });
}

/** POST files/uploads: declares an upload (context, size, SHA-256) and answers its chunk size (201). */
const uploadsCreate = route({
  id: 'files.uploads.create',
  method: 'POST',
  path: UPLOADS,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'store',
  audit: null,
  body: UploadCreateBody,
  prepare: async (rc) => {
    const context = await contextFor(rc, rc.body.context);
    await prepareUpload(rc.db, { context, size: rc.body.size, dataDir: rc.services.dataDir, now: rc.now });
    return context;
  },
  handler: async (rc) => {
    const body: UploadCreateResponse = await createUpload(rc.tx().trx, {
      owner: ownerOf(rc),
      context: rc.prepared as UploadContext,
      size: rc.body.size,
      sha256: rc.body.sha256,
      ...(rc.body.chunkBytes === undefined ? {} : { chunkBytes: rc.body.chunkBytes }),
      now: rc.now,
      dataDir: rc.services.dataDir,
    });
    return { status: 201, body };
  },
});

/** POST files/uploads/:id/chunks/:n: one chunk as multipart/form-data (field `chunk`). */
const uploadsChunk = route({
  id: 'files.uploads.chunk',
  method: 'POST',
  path: `${UPLOADS}/:id/chunks/:n`,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  rawBody: { type: 'multipart', maxBytes: CHUNK_ROUTE_MAX_BYTES },
  params: ChunkParams,
  handler: async (rc) => {
    const data = await chunkOf(rc);
    const body: UploadChunkResponse = await acceptChunk(rc.db, {
      id: rc.params.id,
      owner: ownerOf(rc),
      n: rc.params.n,
      data,
      now: rc.now,
      dataDir: rc.services.dataDir,
    });
    return { body };
  },
});

/** POST files/uploads/:id/complete: verifies the upload; a staged one waits for its consumer, a file one is stored. */
const uploadsComplete = route({
  id: 'files.uploads.complete',
  method: 'POST',
  path: `${UPLOADS}/:id/complete`,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  params: UploadParams,
  body: UploadCompleteBody,
  handler: async (rc) => {
    const body: UploadCompleteResponse = await completeUpload(rc.db, {
      id: rc.params.id,
      owner: ownerOf(rc),
      ...(rc.body.originalName === undefined ? {} : { originalName: rc.body.originalName }),
      now: rc.now,
      dataDir: rc.services.dataDir,
    });
    return { body };
  },
});

/** DELETE files/uploads/:id: cancels an upload (the client starts again with smaller chunks after a 413, P10). */
const uploadsDelete = route({
  id: 'files.uploads.delete',
  method: 'DELETE',
  path: `${UPLOADS}/:id`,
  public: true,
  session: 'required',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  params: UploadParams,
  handler: async (rc) => {
    await abortUpload(rc.db, { id: rc.params.id, owner: ownerOf(rc), dataDir: rc.services.dataDir });
    return { status: 204 };
  },
});

/**
 * Whether an `If-None-Match` header names `etag` (weak comparison, RFC 9110 §13.1.2: a `W/` prefix is ignored; `*`
 * matches the file there is).
 */
function etagListed(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch.split(',').some((tag) => {
    const t = tag.trim();
    return t === '*' || (t.startsWith('W/') ? t.slice(2) : t) === etag;
  });
}

/**
 * GET /files/:id: a stored file with fileResponseHeaders (spec §7.5, §8). An id that is not a ULID, an unknown file, one
 * that is not `ok`, a run report (S18), or one whose content is gone or has another size: 404. A file that is not
 * public (catalogFileAccess) needs a full session (AUTH_REQUIRED, AUTH_MFA_REQUIRED; a visitor gets NOT_FOUND for a
 * file that is public by itself but whose record is not published). Range, ETag and caching: see the top of this file.
 * A HEAD answers the headers without opening the file.
 *
 * `maintenance: allow` (Phase 2): it is the only way the OPAC shows what it embeds (covers, page and news images, the
 * shelf-map floor plan, the viewer's `<audio>`/`<video>`), and every OPAC route is `allow` (spec §12.3), so an update's
 * flag must not break their images. A restore still refuses it, as every route but the `restore-allow` ones.
 */
const filesGet = route({
  id: 'files.get',
  method: 'GET',
  path: '/files/:id',
  public: true,
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    const id = (rc.params as Record<string, string>)['id'] ?? '';
    if (!isUlid(id)) throw new DomainError('NOT_FOUND');
    const row = await rc.db.db
      .selectFrom('files')
      .select(['original_name', 'mime', 'size', 'sha256', 'access', 'status', 'context', 'owner_type', 'owner_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (row === undefined || row.status !== 'ok') throw new DomainError('NOT_FOUND');
    const access = await catalogFileAccess(rc.db.db, row);
    if (access === 'never') throw new DomainError('NOT_FOUND');
    if (access !== 'public') {
      if (rc.auth === null) throw new DomainError(access === 'unpublished' ? 'NOT_FOUND' : 'AUTH_REQUIRED');
      if (rc.auth.stage !== 'full') throw new DomainError('AUTH_MFA_REQUIRED');
    }
    const size = Number(row.size);
    const driver = localStorageDriver(rc.services.dataDir);
    const stored = await driver.stat(id);
    if (stored === null || stored.size !== size) throw new DomainError('NOT_FOUND');
    const headers = fileResponseHeaders({
      originalName: row.original_name,
      mime: row.mime,
      size,
      ...(access === 'public' ? { public: { sha256: row.sha256 } } : {}),
    });
    const etag = headers['ETag'];
    if (etag !== undefined && etagListed(rc.c.req.header('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': headers['Cache-Control']! } });
    }
    // An If-Range can only name the ETag a public file was sent with; any other validator gets the whole file. An empty
    // file (a migrated SLiMS file of 0 bytes) has no byte a range could name: it is served whole (RFC 9110 §14.2 lets a
    // server ignore Range), never as a 206 of `bytes 0--1/0`, as the run downloads do.
    const range = size === 0 ? null : byteRange(rc.c.req.header('range'), rc.c.req.header('if-range'), etag ?? `"${row.sha256}"`, size);
    if (range === 'unsatisfiable') {
      const refused = problemResponse(
        new DomainError('RANGE_NOT_SATISFIABLE', {
          detail: `Rentang di luar berkas ${size} byte / The range lies outside the ${size}-byte file`,
        }),
        rc.requestId,
      );
      refused.headers.set('Content-Range', `bytes */${size}`);
      refused.headers.set('Cache-Control', headers['Cache-Control']!);
      return refused;
    }
    if (range !== null) {
      headers['Content-Length'] = String(range[1] - range[0] + 1);
      headers['Content-Range'] = `bytes ${range[0]}-${range[1]}/${size}`;
    }
    const status = range === null ? 200 : 206;
    if (rc.c.req.method === 'HEAD') return new Response(null, { status, headers });
    const content = await driver.get(id, range === null ? undefined : { start: range[0], end: range[1] });
    if (content === null) throw new DomainError('NOT_FOUND');
    return new Response(streamOf(content), { status, headers });
  },
});

export const FILES_ROUTES: RouteDecl[] = [uploadsCreate, uploadsChunk, uploadsComplete, uploadsDelete, filesGet];
