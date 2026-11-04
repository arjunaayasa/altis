import {
  archiveRecord,
  checkDuplicates,
  createRecord,
  listRecords,
  mergeRecord,
  readSettings,
  recordDetail,
  restoreRecord,
  setCover,
  updateRecord,
} from '@altis/core';
import type { FieldWarning, StoreResponse } from '@altis/shared/api/catalog/common';
import {
  CoverBody,
  DuplicateCheckBody,
  MergeBody,
  RecordCreateBody,
  RecordListQuery,
  RecordPatchBody,
  type DuplicateCheckResponse,
  type RecordDetail,
  type RecordListResponse,
} from '@altis/shared/api/catalog/records';
import { ulidField, versionField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// The catalog API routes of bibliographic records (Phase 2 spec §3.1–§3.3, §12.2; plan Task 16, route catalog): list,
// get, create, update, archive, restore, merge, cover, duplicates. `GET catalog/records/:id/marc` is Task 31's
// (decision P2-11).
//
// - Reads need `catalog.records.read`, writes `catalog.records.manage`; records are global (no branch).
// - The writes are `store` routes and answer `StoreResponse` (`{id, version, warnings?}`), never the detail (S15):
//   the stored response stays far below 60 000 bytes whatever the record holds, and the editor reads the record again
//   with GET. A create answers 201.
// - Archive and restore take the row's `version` in their body (`{version}`), as every optimistic write does.
// - The services audit in the handler's transaction (one entry each, `catalog.record.*`; the cover is an update) and
//   publish `catalog.record.changed` as their last statement.
// - `POST catalog/records/duplicates` only reads (`mode: read`, nothing stored): the editor calls it while a
//   librarian types; the threshold is the setting `catalog.dedupe.threshold`.

const RECORDS = '/api/v1/catalog/records';
const RecordParams = z.strictObject({ id: ulidField });
/** The body of archive and restore: the record's version. */
const VersionBody = z.strictObject({ version: versionField });

/** A store route's answer: the id and the new version, and the warnings when there are any. */
function storeResponse(id: string, version: number, warnings: readonly FieldWarning[] = []): StoreResponse {
  return warnings.length === 0 ? { id, version } : { id, version, warnings: [...warnings] };
}

const recordsList = route({
  id: 'catalog.records.list',
  method: 'GET',
  path: RECORDS,
  permission: 'catalog.records.read',
  idempotency: 'none',
  audit: null,
  query: RecordListQuery,
  handler: async (rc) => {
    const body: RecordListResponse = await listRecords(rc.db.db, rc.query, { now: rc.now });
    return { body };
  },
});

const recordsGet = route({
  id: 'catalog.records.get',
  method: 'GET',
  path: `${RECORDS}/:id`,
  permission: 'catalog.records.read',
  idempotency: 'none',
  audit: null,
  params: RecordParams,
  handler: async (rc) => {
    const body: RecordDetail = await recordDetail(rc.db.db, rc.params.id);
    return { body };
  },
});

const recordsCreate = route({
  id: 'catalog.records.create',
  method: 'POST',
  path: RECORDS,
  permission: 'catalog.records.manage',
  idempotency: 'store',
  audit: 'catalog.record.create',
  body: RecordCreateBody,
  handler: async (rc) => {
    const r = await createRecord(rc.tx(), rc.body);
    return { status: 201, body: storeResponse(r.id, r.version, r.warnings) };
  },
});

const recordsUpdate = route({
  id: 'catalog.records.update',
  method: 'PATCH',
  path: `${RECORDS}/:id`,
  permission: 'catalog.records.manage',
  idempotency: 'store',
  audit: 'catalog.record.update',
  params: RecordParams,
  body: RecordPatchBody,
  handler: async (rc) => {
    const r = await updateRecord(rc.tx(), rc.params.id, rc.body);
    return { body: storeResponse(r.id, r.version, r.warnings) };
  },
});

const recordsArchive = route({
  id: 'catalog.records.archive',
  method: 'DELETE',
  path: `${RECORDS}/:id`,
  permission: 'catalog.records.manage',
  idempotency: 'store',
  audit: 'catalog.record.archive',
  params: RecordParams,
  body: VersionBody,
  handler: async (rc) => {
    const { version } = await archiveRecord(rc.tx(), rc.params.id, rc.body.version);
    return { body: storeResponse(rc.params.id, version) };
  },
});

const recordsRestore = route({
  id: 'catalog.records.restore',
  method: 'POST',
  path: `${RECORDS}/:id/restore`,
  permission: 'catalog.records.manage',
  idempotency: 'store',
  audit: 'catalog.record.restore',
  params: RecordParams,
  body: VersionBody,
  handler: async (rc) => {
    const { version } = await restoreRecord(rc.tx(), rc.params.id, rc.body.version);
    return { body: storeResponse(rc.params.id, version) };
  },
});

/** POST catalog/records/:id/merge: merges `sourceId` into this record (`version` is this record's). */
const recordsMerge = route({
  id: 'catalog.records.merge',
  method: 'POST',
  path: `${RECORDS}/:id/merge`,
  permission: 'catalog.records.manage',
  idempotency: 'store',
  audit: 'catalog.record.merge',
  params: RecordParams,
  body: MergeBody,
  handler: async (rc) => {
    const { version } = await mergeRecord(rc.tx(), rc.params.id, rc.body.sourceId, rc.body.version);
    return { body: storeResponse(rc.params.id, version) };
  },
});

const recordsCover = route({
  id: 'catalog.records.cover',
  method: 'PUT',
  path: `${RECORDS}/:id/cover`,
  permission: 'catalog.records.manage',
  idempotency: 'store',
  audit: 'catalog.record.update',
  params: RecordParams,
  body: CoverBody,
  handler: async (rc) => {
    const { version } = await setCover(rc.tx(), rc.params.id, rc.body.fileId, rc.body.version);
    return { body: storeResponse(rc.params.id, version) };
  },
});

const recordsDuplicates = route({
  id: 'catalog.records.duplicates',
  method: 'POST',
  path: `${RECORDS}/duplicates`,
  permission: 'catalog.records.manage',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  body: DuplicateCheckBody,
  handler: async (rc) => {
    const { trx } = rc.tx();
    const settings = await readSettings(trx, ['catalog.dedupe.threshold'], rc.config.keyring);
    const threshold = settings['catalog.dedupe.threshold'] as number;
    const body: DuplicateCheckResponse = { candidates: await checkDuplicates(trx, rc.body, threshold), threshold };
    return { body };
  },
});

export const RECORDS_ROUTES: RouteDecl[] = [
  recordsList,
  recordsGet,
  recordsCreate,
  recordsUpdate,
  recordsArchive,
  recordsRestore,
  recordsMerge,
  recordsCover,
  recordsDuplicates,
];
