import { createHash } from 'node:crypto';
import { acceptChunk, completeUpload, createUpload, localStorageDriver, uploadContext, uploadOwner } from '@altis/core';
import { withTx } from '@altis/db';
import { newId } from '@altis/shared';
import type { MatrixFixture, MatrixSeed } from '../matrix-fixtures.js';
import type { AreaMatrix } from './catalog.js';
import { seedBranch, seedItem } from './komunitas-circulation.js';

// The matrix rows, fixtures and `system` route ids of stocktake (inventarisasi): one row per route id in the row format
// of db/matrix.test.ts's CATALOG, one fixture per route in the same order. Every route is `deny` in maintenance; the
// minutes PDF and a migrated session's SLiMS report are downloads (`mode: system`). Each call gets a branch of its own with an active session (and, for an
// undo, a copy the caller scanned), so that a super admin's call succeeds (audit once).

const SCAN = 'P:stocktake.scan.use@branchId';
const MANAGE = 'P:stocktake.sessions.manage@branchId';
const API = '/api/v1/branches/:branchId/stocktakes';

/** A branch of its own with a session of `status`; their ids. */
async function seedSession(s: MatrixSeed, status = 'active'): Promise<{ branchId: string; id: string }> {
  const branchId = await seedBranch(s);
  const id = newId();
  await s.h.db
    .insertInto('stocktakes')
    .values({
      id,
      branch_id: branchId,
      name: 'Sesi Matriks',
      scope: '{}',
      status,
      active_key: status === 'finished' || status === 'cancelled' ? null : branchId,
      options: null,
      started_at: s.now,
      started_by: null,
      finished_at: null,
      finished_by: null,
      minutes_file_id: null,
      report_file_id: null,
      source: 'altis',
      created_at: s.now,
      created_by: null,
      updated_at: s.now,
      updated_by: null,
    })
    .execute();
  return { branchId, id };
}

/** A completed `stocktake.codes` upload of `userId`; its id. */
async function stagedCodes(s: MatrixSeed, userId: string): Promise<string> {
  if (s.dataDir === undefined) throw new Error('the stocktake upload fixture needs the DATA_DIR of the app');
  const dataDir = s.dataDir;
  const bytes = Buffer.from('KODE-1\nKODE-2\n', 'utf8');
  const owner = uploadOwner(userId);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const context = uploadContext('stocktake.codes')!;
  await s.h.db.updateTable('upload_sessions').set({ expires_at: s.now - 1 }).where('owner', '=', owner).where('expires_at', '>', s.now).execute();
  const { id } = await withTx(s.h, (trx) => createUpload(trx, { owner, context, size: bytes.byteLength, sha256, now: s.now, dataDir }));
  await acceptChunk(s.h, { id, owner, n: 0, data: bytes, now: s.now, dataDir });
  await completeUpload(s.h, { id, owner, originalName: 'kode.txt', now: s.now, dataDir });
  return id;
}

const rows: Record<string, string> = {
  'stocktake.sessions.list': `GET ${API} | ${SCAN} | - | - | read | deny | none | null | - | -`,
  'stocktake.sessions.create': `POST ${API} | ${MANAGE} | - | - | write | deny | store | stocktake.session.create | handler | -`,
  'stocktake.sessions.get': `GET ${API}/:id | ${SCAN} | - | - | read | deny | none | null | - | -`,
  'stocktake.sessions.items': `GET ${API}/:id/items | ${SCAN} | - | - | read | deny | none | null | - | -`,
  'stocktake.sessions.unknown_codes': `GET ${API}/:id/unknown-codes | ${SCAN} | - | - | read | deny | none | null | - | -`,
  'stocktake.sessions.officers': `GET ${API}/:id/officers | ${SCAN} | - | - | read | deny | none | null | - | -`,
  'stocktake.scans.create': `POST ${API}/:id/scans | ${SCAN} | - | - | write | deny | store | null | handler | -`,
  'stocktake.scans.delete': `DELETE ${API}/:id/scans/:itemId | ${SCAN} | - | - | write | deny | none | null | handler | also:stocktake.scan.cancel_other`,
  'stocktake.uploads.create': `POST ${API}/:id/uploads | ${SCAN} | - | - | write | deny | store | stocktake.upload | handler | -`,
  'stocktake.sessions.finish': `POST ${API}/:id/finish | ${MANAGE} | - | reauth | write | deny | store | stocktake.session.finish | handler | -`,
  'stocktake.sessions.cancel': `POST ${API}/:id/cancel | ${MANAGE} | - | - | write | deny | store | stocktake.session.cancel | handler | -`,
  'stocktake.sessions.minutes': `GET ${API}/:id/minutes | ${SCAN} | - | - | system | deny | none | null | - | -`,
  // ---- the SLiMS report of a migrated session ----
  'stocktake.sessions.slims_report': `GET ${API}/:id/slims-report | ${SCAN} | - | - | system | deny | none | null | - | -`,
};

const onSession =
  (body?: (s: MatrixSeed) => unknown | Promise<unknown>): MatrixFixture =>
  async (s) => {
    const { branchId, id } = await seedSession(s);
    return { params: { branchId, id }, ...(body === undefined ? {} : { body: await body(s) }) };
  };

const fixtures: Record<string, MatrixFixture> = {
  'stocktake.sessions.list': async (s) => ({ params: { branchId: (await seedSession(s)).branchId } }),
  'stocktake.sessions.create': async (s) => ({ params: { branchId: await seedBranch(s) }, body: { name: 'Inventarisasi Matriks', scope: {} } }),
  'stocktake.sessions.get': onSession(),
  'stocktake.sessions.items': async (s) => ({ ...(await onSession()(s)), query: { state: 'pending' } }),
  'stocktake.sessions.unknown_codes': onSession(),
  'stocktake.sessions.officers': onSession(),
  'stocktake.scans.create': onSession(() => ({ barcode: 'TIDAK-ADA-1' })),
  'stocktake.scans.delete': async (s) => {
    const { branchId, id } = await seedSession(s);
    const item = await seedItem(s, branchId);
    await s.h.db
      .insertInto('stocktake_items')
      .values({
        stocktake_id: id,
        item_id: item.id,
        expected: 1,
        state: 'found',
        expected_location_id: null,
        expected_status: 'available',
        stat_ddc: null,
        collection_type_id: null,
        scanned_at: s.now,
        scanned_by: s.user?.id ?? null,
        scanned_by_name: null,
        scanned_location_id: null,
        result: null,
      })
      .execute();
    await s.h.db.updateTable('stocktakes').set({ total: 1, found: 1 }).where('id', '=', id).execute();
    return { params: { branchId, id, itemId: item.id } };
  },
  'stocktake.uploads.create': onSession(async (s) => ({ uploadId: s.user === null ? newId() : await stagedCodes(s, s.user.id) })),
  'stocktake.sessions.finish': onSession(() => ({ confirmName: 'Sesi Matriks', markMissing: true, restoreFound: true })),
  'stocktake.sessions.cancel': onSession(),
  'stocktake.sessions.minutes': onSession(),
  // ---- the SLiMS report of a migrated session: a finished session with its stored report ----
  'stocktake.sessions.slims_report': async (s) => {
    const { branchId, id } = await seedSession(s, 'finished');
    if (s.dataDir === undefined) throw new Error('the SLiMS report fixture needs the DATA_DIR of the app');
    const bytes = Buffer.from('<html><body>Laporan</body></html>', 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const fileId = newId();
    await localStorageDriver(s.dataDir).put(fileId, bytes, { size: bytes.byteLength, sha256 });
    await s.h.db
      .insertInto('files')
      .values({
        id: fileId,
        original_name: 'stock_take_report.html',
        mime: 'application/octet-stream',
        size: bytes.byteLength,
        sha256,
        context: 'stocktake.slims_report',
        owner_type: 'stocktakes',
        owner_id: id,
        access: 'staff',
        status: 'ok',
        created_at: s.now,
        created_by: null,
      })
      .execute();
    await s.h.db.updateTable('stocktakes').set({ report_file_id: fileId, source: 'migrated' }).where('id', '=', id).execute();
    return { params: { branchId, id } };
  },
};

export const MATRIX: AreaMatrix = {
  rows,
  fixtures,
  maintenance: {},
  systemRoutes: ['stocktake.sessions.minutes', 'stocktake.sessions.slims_report'],
};
