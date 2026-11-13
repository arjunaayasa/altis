// Stub: replaced by a later change in this milestone.
// The accreditation documents: the start of a dossier, self-assessment or statement run. The signature is final; the
// body throws until the documents are written.
/* eslint-disable @typescript-eslint/no-unused-vars -- the parameters of the final signatures are not read yet */
import type { DB } from '@altis/db';
import type { DossierBody, SelfAssessmentBody, Statement1000Body } from '@altis/shared/api/accreditation';
import type { ReportRunStarted } from '@altis/shared/api/reports';
import type { Transaction } from 'kysely';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import type { JobRegistry } from '../../jobs/types.js';

export { dossierReport, DOSSIER_PARTS, DOSSIER_ZIP_MODES } from './dossier.js';
export { selfAssessmentReport } from './self-assessment.js';
export { statement1000Report } from './statement.js';

/** The three documents of a period. */
export type AccredDocumentId = 'accreditation.dossier' | 'accreditation.self_assessment' | 'accreditation.statement_1000';

function notImplemented(): never {
  throw new Error('not implemented yet');
}

/** Starts a run of the document `reportId` for the period `periodId` (always in Indonesian). */
export async function startDocumentRun(
  trx: Transaction<DB>,
  reportId: AccredDocumentId,
  periodId: string,
  body: DossierBody | SelfAssessmentBody | Statement1000Body,
  o: { createdBy: string; now: number; registry: JobRegistry; keyring: readonly KeyringEntry[] },
): Promise<ReportRunStarted> {
  return notImplemented();
}
