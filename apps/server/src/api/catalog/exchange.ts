import {
  CATALOG_EXPORT_JOB,
  CATALOG_IMPORT_JOB,
  can,
  createJobRegistry,
  fileResponseHeaders,
  importFormatBeforeStart,
  placeImportWork,
  readSettings,
  recordMarcFile,
  startCatalogExport,
  startCatalogImport,
  takeStagedUpload,
  uploadOwner,
  type JobRegistry,
} from '@altis/core';
import { runWorkDir, statOrNull } from '@altis/platform';
import { DomainError, isDomainError } from '@altis/shared';
import { ulidField } from '@altis/shared/api/common';
import { ExportBody, ImportBody, MarcFormatQuery } from '@altis/shared/api/catalog/exchange';
import type { RunStarted } from '@altis/shared/api/catalog/runs';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { jobHandlers } from '../../jobs/runtime.js';

// The catalog API routes of imports, exports and the MARC of one record (Phase 2 spec §5.3, §5.4, §12.2, §12.3; plan
// Task 31, route catalog; S3, S11, M9; decision P2-11):
//
//   POST catalog/imports              `catalog.import.run`, `store`, audit `catalog.import.start`: the staged upload of
//                                     the caller (`uploadId`, context `catalog.import`) is taken, or a dry run of the
//                                     caller is adopted (`fromRunId`, S3: else `{path: 'fromRunId', code:
//                                     'not_found'}`); the run and its job `catalog.import` → 202 RunStarted. After the
//                                     COMMIT the file becomes `tmp/<runId>/import.bin` (the first slice does it again
//                                     when that was lost) and the worker is woken.
//                                     S11: with `createItems` or an item format (the body's, else the adopted dry
//                                     run's, else the one detected from the upload, as the job will: review C11),
//                                     `prepare` also wants `catalog.items.manage` at the body's `branchId` (403
//                                     through rc.authzDenied). Its job checks the branch of every item it writes or
//                                     updates against the creator's grants (`branch_denied`), with or without a
//                                     `branchId`.
//   POST catalog/exports              `catalog.export.run`, `mode: system` (an export is never locked), `store`,
//                                     audit `catalog.export.start`: the run and its job `catalog.export` → 202
//                                     RunStarted; the file is downloaded from `GET catalog/runs/:id/download`.
//   GET  catalog/records/:id/marc     `catalog.records.read`: the record's MARC, synchronously, `?format=mrc|xml|json`
//                                     (`json`: one MarcJsonRecord as `application/json`, M9), staff audience (S5), as
//                                     an attachment (`xml`/`json` the editor's MARC tab reads too).

const RecordParams = z.strictObject({ id: ulidField });

/** The formats whose rows are items (`createItems` aside). */
function isItemFormat(format: string | null): boolean {
  return format === 'csv-items' || format === 'csv-slims-items';
}

function fieldError(path: string, code: string): DomainError {
  return new DomainError('VALIDATION_FAILED', { detail: 'Permintaan impor tidak valid / The import request is not valid', meta: { errors: [{ path, code }] } });
}

let fallbackRegistry: JobRegistry | null = null;

/** The handlers a run is enqueued with: the job runtime's, else (no runtime in this process yet) the handler array's. */
function registryOf(rc: RouteContext<unknown, unknown, unknown>, type: string): JobRegistry {
  const reg = rc.services.jobs?.registry;
  if (reg?.get(type) !== undefined) return reg;
  fallbackRegistry ??= createJobRegistry(jobHandlers());
  return fallbackRegistry;
}

const importsCreate = route({
  id: 'catalog.imports.create',
  method: 'POST',
  path: '/api/v1/catalog/imports',
  permission: 'catalog.import.run',
  idempotency: 'store',
  audit: 'catalog.import.start',
  body: ImportBody,
  prepare: async (rc): Promise<void> => {
    const b = rc.body;
    // S11: items are written in a branch, which this route's declaration cannot name (no `branchParam`). Whether they
    // are depends on the format the file is read as: one left to detection (the wizard's default) or taken from the
    // adopted dry run counts as the job will see it.
    if (b.branchId !== undefined && (b.createItems || isItemFormat(await importFormatBeforeStart(rc.db.db, rc.services.dataDir, b)))) {
      const grants = rc.auth?.grants;
      if (grants === undefined || !can(grants, 'catalog.items.manage', b.branchId)) throw await rc.authzDenied('catalog.items.manage');
    }
    // S3: a dry run whose work folder is gone (expired, adopted already) cannot be taken over.
    if (b.fromRunId !== undefined && (await statOrNull(runWorkDir(rc.services.dataDir, b.fromRunId)))?.kind !== 'dir') throw fieldError('fromRunId', 'not_found');
  },
  handler: async (rc) => {
    const tx = rc.tx();
    const userId = rc.auth?.subjectId;
    if (userId === undefined) throw new DomainError('AUTH_REQUIRED');
    const dataDir = rc.services.dataDir;
    const b = rc.body;
    let stagingId: string | null = null;
    if (b.uploadId !== undefined) {
      try {
        await takeStagedUpload(tx.trx, { uploadId: b.uploadId, owner: uploadOwner(userId), context: 'catalog.import', dataDir });
      } catch (error) {
        if (isDomainError(error) && error.code === 'NOT_FOUND') throw fieldError('uploadId', 'not_found');
        throw error;
      }
      stagingId = b.uploadId;
    }
    const input = { body: b, stagingId };
    const body: RunStarted = await startCatalogImport(tx, registryOf(rc, CATALOG_IMPORT_JOB), input, { keyring: rc.config.keyring });
    rc.afterCommit(async () => {
      try {
        await placeImportWork(dataDir, body.runId, { stagingId, fromRunId: b.fromRunId ?? null });
      } catch (error) {
        rc.log.warn('catalog import: the file was not put in place after the start; the first slice does it', { runId: body.runId, code: (error as { code?: unknown }).code });
      } finally {
        rc.services.jobs?.kick();
      }
    });
    return { status: 202, body };
  },
});

const exportsCreate = route({
  id: 'catalog.exports.create',
  method: 'POST',
  path: '/api/v1/catalog/exports',
  permission: 'catalog.export.run',
  mode: 'system',
  idempotency: 'store',
  audit: 'catalog.export.start',
  body: ExportBody,
  handler: async (rc) => {
    const body: RunStarted = await startCatalogExport(rc.tx(), registryOf(rc, CATALOG_EXPORT_JOB), rc.body, { keyring: rc.config.keyring });
    rc.afterCommit(() => rc.services.jobs?.kick());
    return { status: 202, body };
  },
});

const recordsMarc = route({
  id: 'catalog.records.marc',
  method: 'GET',
  path: '/api/v1/catalog/records/:id/marc',
  permission: 'catalog.records.read',
  idempotency: 'none',
  audit: null,
  params: RecordParams,
  query: MarcFormatQuery,
  handler: async (rc) => {
    const db = rc.db.db;
    const orgCode = (await readSettings(db, ['catalog.marcOrgCode'], []))['catalog.marcOrgCode'] as string | null;
    const file = await recordMarcFile(db, rc.params.id, rc.query.format, { orgCode, baseUrl: rc.config.baseUrl });
    const headers = fileResponseHeaders({ originalName: file.fileName, mime: file.mime, size: file.body.byteLength });
    return new Response(rc.c.req.method === 'HEAD' ? null : file.body, { status: 200, headers });
  },
});

export const EXCHANGE_ROUTES: RouteDecl[] = [importsCreate, exportsCreate, recordsMarc];
