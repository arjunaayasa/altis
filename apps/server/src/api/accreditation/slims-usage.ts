import {
  createJobRegistry,
  loadAccredSettings,
  placeSlimsWork,
  releaseEndedRunWork,
  startSlimsUsageImport,
  takeStagedUpload,
  testSlimsUsageConnection,
  uploadOwner,
  type JobRegistry,
} from '@altis/core';
import { DomainError, isDomainError } from '@altis/shared';
import { SlimsUsageStartBody, SlimsUsageTestBody, type SlimsUsageTestResponse } from '@altis/shared/api/accreditation';
import type { RunStarted } from '@altis/shared/api/catalog/runs';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { jobHandlers } from '../../jobs/runtime.js';

// The routes of the read-only SLiMS usage import (spec §11.2, §5.2). Both need `accreditation.workspace.manage` and a
// re-authentication within 5 minutes, and are `idempotency: none`: a body may carry a database password, which reaches
// nothing but the source (the test) or the job's sealed secret (the start).
//
// - `accreditation.slims_usage.test` (`mode: read`, `tx: self`: it connects outward, never inside a transaction):
//   what an import would read from the database, always 200 (`{ok: false, code, reason}` when it cannot be read).
// - `accreditation.slims_usage.start`: one import at a time per installation; a live import is joined (200 `{runId,
//   jobId, joined: true}`, its start entry written once per actor). Otherwise the run and its job are created, a dump
//   source's staged upload (context `accreditation.slims_dump`) is taken in the same transaction, the start is audited
//   (`{sourceKind, cutoverOn}`) and 201 `{runId, jobId}`. After the COMMIT the work folders of the runs the start ended
//   are removed and the taken dump is moved into the run's folder at once, so only the run's id protects it while the
//   job waits (the job's first slice does the same if this was lost). The usage rows are global: no period is locked.

const PARAMS = z.strictObject({ id: ulidField });

function fieldError(path: string, code: string): DomainError {
  return new DomainError('VALIDATION_FAILED', {
    detail: 'Permintaan impor penggunaan tidak valid / The usage import request is not valid',
    meta: { errors: [{ path, code }] },
  });
}

let fallbackRegistry: JobRegistry | null = null;

/** The handlers the import is enqueued with: the job runtime's, else (no runtime in this process yet) the handler array's. */
function registryOf(rc: RouteContext<unknown, unknown, unknown>): JobRegistry {
  const reg = rc.services.jobs?.registry;
  if (reg?.get('accreditation.import_slims_usage') !== undefined) return reg;
  fallbackRegistry ??= createJobRegistry(jobHandlers());
  return fallbackRegistry;
}

const testConnection = route({
  id: 'accreditation.slims_usage.test',
  method: 'POST',
  path: '/api/v1/accreditation/slims-usage/test-connection',
  permission: 'accreditation.workspace.manage',
  reauth: true,
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: SlimsUsageTestBody,
  handler: async (rc) => {
    const body: SlimsUsageTestResponse = await testSlimsUsageConnection(rc.body.db);
    return { body };
  },
});

const start = route({
  id: 'accreditation.slims_usage.start',
  method: 'POST',
  path: '/api/v1/accreditation/periods/:id/slims-usage',
  permission: 'accreditation.workspace.manage',
  reauth: true,
  idempotency: 'none',
  audit: 'accreditation.slims_usage.start',
  params: PARAMS,
  body: SlimsUsageStartBody,
  handler: async (rc) => {
    const tx = rc.tx();
    const userId = rc.auth?.subjectId;
    if (userId === undefined) throw new DomainError('AUTH_REQUIRED');
    const dataDir = rc.services.dataDir;
    const b = rc.body;
    const started = await startSlimsUsageImport(tx.trx, rc.params.id, b, {
      now: tx.now,
      createdBy: userId,
      registry: registryOf(rc),
      keyring: rc.config.keyring,
      settings: await loadAccredSettings(tx.trx),
    });
    if (started.joined) {
      // One import at a time: the live one is the answer, and its start is audited once per actor.
      if (!(await rc.auditedBefore({ entity: 'catalog_runs', entityId: started.runId }))) {
        await rc.audit({ entity: 'catalog_runs', entityId: started.runId, meta: { joined: true } });
      }
      const body: RunStarted & { joined: true } = { runId: started.runId, jobId: started.jobId, joined: true };
      return { status: 200, body };
    }
    const uploadId = b.source.kind === 'dump' ? b.source.uploadId : null;
    if (uploadId !== null) {
      try {
        await takeStagedUpload(tx.trx, { uploadId, owner: uploadOwner(userId), context: 'accreditation.slims_dump', dataDir });
      } catch (error) {
        if (isDomainError(error) && error.code === 'NOT_FOUND') throw fieldError('source.uploadId', 'not_found');
        throw error;
      }
    }
    await rc.audit({ entity: 'catalog_runs', entityId: started.runId, meta: { sourceKind: b.source.kind, cutoverOn: b.cutoverOn ?? null } });
    rc.afterCommit(async () => {
      try {
        // The runs the start ended free their folders first: the new run's split needs the space.
        await releaseEndedRunWork(dataDir, started.endedRunIds, rc.log);
        // The dump in the run's folder at once: the first slice may wait (one heavy job at a time).
        await placeSlimsWork(dataDir, started.runId, { fromRunId: null, dumpStagingId: uploadId, filesStagingId: null });
      } finally {
        rc.services.jobs?.kick();
      }
    });
    const body: RunStarted = { runId: started.runId, jobId: started.jobId };
    return { status: 201, body };
  },
});

export const SLIMS_USAGE_ROUTES: RouteDecl[] = [testConnection, start];
