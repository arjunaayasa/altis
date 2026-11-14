import {
  MEMBER_IMPORT_REPORT_HEADER,
  MEMBER_IMPORT_REPORT_KEEP_MS,
  fileResponseHeaders,
  getMemberImport,
  localStorageDriver,
  runMemberImport,
  takeStagedUpload,
  uploadOwner,
  writeRunReport,
} from '@altis/core';
import { withTx } from '@altis/db';
import { dataPath, readBytes, removeTree, renameRetry, runWorkPath, type DataPath } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import { MemberImportBody, type MemberImportStartResponse, type MemberImportView } from '@altis/shared/api/members';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// The CSV member import (a run of `catalog_runs` with kind `member_import`; the file is a completed upload of the staged
// context `members.import`):
//
//   POST members/imports              members.import.run   MemberImportBody → 202 MemberImportStartResponse   members.import.start
//   GET  members/imports/:id          members.import.run   → MemberImportView
//   GET  members/imports/:id/report   members.import.run   → text/csv (line, member number, reason code)    mode system
//
// The import runs in the request (at most 5 000 rows; a larger file is 422 MEMBER_IMPORT_FORMAT `too_many_rows`): the
// upload is taken, every row checked and, unless it is a dry run, written, the run finished, `members.import.start` and
// `members.import.finish` audited, all in the handler's transaction. After the COMMIT a dry run's file becomes the
// run's `import.bin` (its sample is read from it when asked, never stored) and the refused rows become the run's report
// file. Declared before `members/:id`. The report is a download, so the edition never locks it (`system`).

const API = '/api/v1/members/imports';
const IdParams = z.strictObject({ id: ulidField });

/** The most bytes of a member import file (the `members.import` upload context's limit). */
const IMPORT_MAX_BYTES = 50 * 1024 * 1024;

function uploadNotFound(): DomainError {
  return new DomainError('VALIDATION_FAILED', { detail: 'Berkas unggahan tidak ditemukan / The uploaded file was not found', meta: { errors: [{ path: 'uploadId', code: 'not_found' }] } });
}

function runNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Impor anggota tidak ditemukan / Member import not found' });
}

const importsCreate = route({
  id: 'members.imports.create',
  method: 'POST',
  path: API,
  permission: 'members.import.run',
  idempotency: 'store',
  audit: 'members.import.start',
  alsoAudits: ['members.import.finish'],
  body: MemberImportBody,
  handler: async (rc) => {
    const tx = rc.tx();
    const userId = rc.auth?.subjectId;
    if (userId === undefined) throw new DomainError('AUTH_REQUIRED');
    const dataDir = rc.services.dataDir;
    let staged: DataPath;
    try {
      staged = (await takeStagedUpload(tx.trx, { uploadId: rc.body.uploadId, owner: uploadOwner(userId), context: 'members.import', dataDir })).path;
    } catch (error) {
      if (isDomainError(error) && error.code === 'NOT_FOUND') throw uploadNotFound();
      throw error;
    }
    const bytes = await readBytes(staged, IMPORT_MAX_BYTES);
    if (bytes === null) throw uploadNotFound();
    const result = await runMemberImport(tx, { bytes, mode: rc.body.mode, dryRun: rc.body.dryRun });
    const uploadId = rc.body.uploadId;
    const dryRun = rc.body.dryRun;
    const now = rc.now;
    rc.afterCommit(async () => {
      try {
        if (dryRun) await renameRetry(staged, runWorkPath(dataDir, result.runId, 'import.bin'));
        await removeTree(dataPath(dataDir, 'tmp', uploadId));
        if (result.refused.length > 0) {
          const rows = result.refused.map((r) => [String(r.line), r.memberNo, r.reason]);
          const fileId = await writeRunReport(rc.db, localStorageDriver(dataDir), result.runId, MEMBER_IMPORT_REPORT_HEADER, rows, { now, createdBy: userId });
          await withTx(rc.db, (trx) => trx.updateTable('catalog_runs').set({ report_file_id: fileId }).where('id', '=', result.runId).execute());
        }
      } catch (error) {
        rc.log.warn('member import: the file or the report was not kept after the run', { runId: result.runId, code: (error as { code?: unknown }).code });
      }
    });
    const body: MemberImportStartResponse = { id: result.runId, status: 'succeeded' };
    return { status: 202, body };
  },
});

const importsGet = route({
  id: 'members.imports.get',
  method: 'GET',
  path: `${API}/:id`,
  permission: 'members.import.run',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => {
    const file = await readBytes(runWorkPath(rc.services.dataDir, rc.params.id, 'import.bin'), IMPORT_MAX_BYTES).catch(() => null);
    const body: MemberImportView = await getMemberImport(rc.db.db, rc.params.id, { file, now: rc.now });
    return { body };
  },
});

/** The run's report of refused rows; a HEAD answers the headers without opening the file. */
const importsReport = route({
  id: 'members.imports.report',
  method: 'GET',
  path: `${API}/:id/report`,
  permission: 'members.import.run',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => {
    const db = rc.db.db;
    const run = await db.selectFrom('catalog_runs').select(['id', 'kind', 'report_file_id', 'finished_at', 'created_at']).where('id', '=', rc.params.id).executeTakeFirst();
    if (run === undefined || run.kind !== 'member_import') throw runNotFound();
    if (Number(run.finished_at ?? run.created_at) + MEMBER_IMPORT_REPORT_KEEP_MS <= rc.now) {
      throw new DomainError('CATALOG_RUN_EXPIRED', { detail: 'Laporan impor ini sudah kedaluwarsa / This import report has expired' });
    }
    if (run.report_file_id === null) throw new DomainError('NOT_FOUND', { detail: 'Impor ini tidak punya laporan / This import has no report' });
    const file = await db
      .selectFrom('files')
      .select(['id', 'original_name', 'size'])
      .where('id', '=', run.report_file_id)
      .where('owner_type', '=', 'catalog_runs')
      .where('owner_id', '=', run.id)
      .where('status', '=', 'ok')
      .executeTakeFirst();
    if (file === undefined) throw new DomainError('NOT_FOUND', { detail: 'Laporan impor tidak ditemukan / The import report was not found' });
    const driver = localStorageDriver(rc.services.dataDir);
    const headers = fileResponseHeaders({ originalName: file.original_name, mime: 'text/csv; charset=utf-8', size: Number(file.size) });
    if (rc.c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
    const content = await driver.get(file.id);
    if (content === null) throw new DomainError('NOT_FOUND', { detail: 'Laporan impor tidak ditemukan / The import report was not found' });
    const chunks: Uint8Array[] = [];
    for await (const chunk of content) chunks.push(chunk);
    return new Response(Buffer.concat(chunks), { status: 200, headers });
  },
});

export const MEMBER_IMPORT_ROUTES: RouteDecl[] = [importsCreate, importsGet, importsReport];
