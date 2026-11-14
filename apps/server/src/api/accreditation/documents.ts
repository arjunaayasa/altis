import { createJobRegistry, startDocumentRun, type AccredDocumentId, type JobRegistry } from '@altis/core';
import { DomainError } from '@altis/shared';
import { DossierBody, SelfAssessmentBody, Statement1000Body } from '@altis/shared/api/accreditation';
import { ulidField } from '@altis/shared/api/common';
import type { ReportRunStarted } from '@altis/shared/api/reports';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';
import { jobHandlers } from '../../jobs/runtime.js';

// The routes of a period's accreditation documents (spec §5.2, §10.9). Each starts a report run of its document, in
// Indonesian whatever the requester reads, and queues its export; the run is downloaded through the report run routes.
// Each needs `accreditation.workspace.read`, is a `system` route (it makes a file) and appends one `reports.run.start`
// `{runId, reportId, format}` (never a parameter value):
//
//   POST accreditation/periods/:id/dossier          the evidence file: `{format: pdf | zip | zip_components, part?}`;
//                                                   it prints the staff's names, so a fresh re-authentication first
//   POST accreditation/periods/:id/self-assessment  the internal simulation with the estimated score; personal too
//   POST accreditation/periods/:id/statement-1000   the statement of 1 000 titles with the title list; it names no one,
//                                                   so it needs no re-authentication
//
// Each answers 200 `{id, jobId}`. A ZIP whose estimate passes 5 000 entries or 2 GiB is refused 422 REPORT_TOO_LARGE.

const PERIODS = '/api/v1/accreditation/periods';
const IdParams = z.strictObject({ id: ulidField });
/** The job that writes a run's file. */
const REPORTS_EXPORT_JOB = 'reports.export';

let fallbackRegistry: JobRegistry | null = null;

/** The handlers a run is enqueued with: the job runtime's, else (no runtime in this process yet) the handler array's. */
function registryOf(rc: RouteContext<unknown, unknown, unknown>): JobRegistry {
  const reg = rc.services.jobs?.registry;
  if (reg?.get(REPORTS_EXPORT_JOB) !== undefined) return reg;
  fallbackRegistry ??= createJobRegistry(jobHandlers());
  return fallbackRegistry;
}

/** Starts the run of `reportId` (in `format`) for the period of the path, audits it and kicks the queue. */
async function startRun<B extends DossierBody | SelfAssessmentBody | Statement1000Body>(
  rc: RouteContext<B, unknown, { id: string }>,
  reportId: AccredDocumentId,
  format: 'pdf' | 'zip',
): Promise<{ status: number; body: ReportRunStarted }> {
  const userId = rc.auth?.subjectId;
  if (userId === undefined) throw new DomainError('AUTH_REQUIRED');
  const body = await startDocumentRun(rc.tx().trx, reportId, rc.params.id, rc.body, {
    createdBy: userId,
    now: rc.now,
    registry: registryOf(rc as RouteContext<unknown, unknown, unknown>),
    keyring: rc.config.keyring,
  });
  await rc.audit({ entity: 'report_runs', entityId: body.id, meta: { runId: body.id, reportId, format } });
  rc.afterCommit(() => rc.services.jobs?.kick());
  return { status: 200, body };
}

const dossier = route({
  id: 'accreditation.dossier.create',
  method: 'POST',
  path: `${PERIODS}/:id/dossier`,
  permission: 'accreditation.workspace.read',
  reauth: true,
  mode: 'system',
  idempotency: 'store',
  audit: 'reports.run.start',
  params: IdParams,
  body: DossierBody,
  handler: (rc) => startRun(rc, 'accreditation.dossier', rc.body.format === 'pdf' ? 'pdf' : 'zip'),
});

const selfAssessment = route({
  id: 'accreditation.self_assessment.create',
  method: 'POST',
  path: `${PERIODS}/:id/self-assessment`,
  permission: 'accreditation.workspace.read',
  reauth: true,
  mode: 'system',
  idempotency: 'store',
  audit: 'reports.run.start',
  params: IdParams,
  body: SelfAssessmentBody,
  handler: (rc) => startRun(rc, 'accreditation.self_assessment', 'pdf'),
});

const statement = route({
  id: 'accreditation.statement_1000.create',
  method: 'POST',
  path: `${PERIODS}/:id/statement-1000`,
  permission: 'accreditation.workspace.read',
  mode: 'system',
  idempotency: 'store',
  audit: 'reports.run.start',
  params: IdParams,
  body: Statement1000Body,
  handler: (rc) => startRun(rc, 'accreditation.statement_1000', 'pdf'),
});

export const DOCUMENT_ROUTES: RouteDecl[] = [dossier, selfAssessment, statement];
