import type { DB } from '@altis/db';
import { localDate, type Permission } from '@altis/shared';
import { DossierBody, type SelfAssessmentBody, type Statement1000Body } from '@altis/shared/api/accreditation';
import { issueCode } from '@altis/shared/api/common';
import { REPORT_ZIP_MAX_BYTES, REPORT_ZIP_MAX_ENTRIES, type ReportRunStarted } from '@altis/shared/api/reports';
import type { Transaction } from 'kysely';
import type { KeyringEntry } from '../../crypto/secret-box.js';
import type { JobRegistry } from '../../jobs/types.js';
import { reportFieldErrors, startReportRun } from '../../reports/runs/service.js';
import type { DocumentReport } from '../../reports/types.js';
import { loadAccredSettings } from '../../settings/accreditation.js';
import { instrumentById } from '../instruments/index.js';
import { periodNotFound } from '../periods/errors.js';
import { readProfile } from '../periods/profile.js';
import { snapshotDate } from '../windows.js';
import type { DocPeriod } from './data.js';
import { dossierReport } from './dossier.js';
import { selfAssessmentReport } from './self-assessment.js';
import { statement1000Report } from './statement.js';
import { withheldDrafts, zipEstimate, zipTooLarge, zipUnits } from './zip.js';

// The accreditation documents (spec §10.9): the start of a run of the evidence file, the internal simulation or the
// statement of 1 000 titles for a live period. Every run is stored in Indonesian (the documents are never in another
// language) and goes through the report runs, so the export job writes it and its creator downloads it.
//
// The evidence file comes as a PDF (or its request letter alone, a PDF only), one ZIP, or one ZIP per component
// (stored as a `zip` run with `zipMode: 'components'`). A ZIP whose estimate already passes 5 000 entries or 2 GiB (the
// evidence files' sizes plus one mebibyte per generated PDF) is refused before anything is written. The statistics
// mode has no submission form and no components: its request letter and its per-component ZIP are refused.
//
// A ZIP renders the reports its evidence items draft (the annual library report); given what its caller holds
// (`holds`), the drafted reports the caller may not export are named in the run's `withheld` and left out (the run's
// warnings then say so). Without `holds` (the command line, a measurement), nothing is left out.

export { dossierReport, DOSSIER_PARTS, DOSSIER_ZIP_MODES } from './dossier.js';
export { selfAssessmentReport } from './self-assessment.js';
export { statement1000Report } from './statement.js';

/** The three documents of a period. */
export type AccredDocumentId = 'accreditation.dossier' | 'accreditation.self_assessment' | 'accreditation.statement_1000';

const DOCUMENTS: Readonly<Record<AccredDocumentId, DocumentReport>> = Object.freeze({
  'accreditation.dossier': dossierReport,
  'accreditation.self_assessment': selfAssessmentReport,
  'accreditation.statement_1000': statement1000Report,
});

/**
 * Starts a run of the document `reportId` for the period `periodId` (always in Indonesian). The caller audits it.
 *
 * @throws DomainError `NOT_FOUND` for an unknown or archived period; `VALIDATION_FAILED` `{path: 'part', code:
 *   'invalid'}` for the request letter as a ZIP or without a submission form, `{path: 'format', code: 'invalid_value'}`
 *   for a per-component ZIP without components; `REPORT_TOO_LARGE` `{rows, max, format: 'zip', limit}` for a ZIP over
 *   its bounds
 */
export async function startDocumentRun(
  trx: Transaction<DB>,
  reportId: AccredDocumentId,
  periodId: string,
  body: DossierBody | SelfAssessmentBody | Statement1000Body,
  o: { createdBy: string; now: number; registry: JobRegistry; keyring: readonly KeyringEntry[]; holds?: (permission: Permission) => boolean },
): Promise<ReportRunStarted> {
  const def = DOCUMENTS[reportId];
  const row = await trx.selectFrom('accred_periods').selectAll().where('id', '=', periodId).where('archived_at', 'is', null).executeTakeFirst();
  const instrument = row === undefined ? null : instrumentById(row.instrument_id);
  if (row === undefined || instrument === null) throw periodNotFound();

  let format: 'pdf' | 'zip' = 'pdf';
  let params: Record<string, unknown> = { periodId };
  if (reportId === 'accreditation.dossier') {
    const parsed = DossierBody.safeParse(body);
    if (!parsed.success) throw reportFieldErrors(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), code: issueCode(i) })));
    const b = parsed.data;
    const school = instrument.components.length > 0;
    const part = b.part ?? 'all';
    if (part === 'request_letter' && (b.format !== 'pdf' || !school)) throw reportFieldErrors([{ path: 'part', code: 'invalid' }]);
    if (b.format === 'zip_components' && !school) throw reportFieldErrors([{ path: 'format', code: 'invalid_value' }]);
    format = b.format === 'pdf' ? 'pdf' : 'zip';
    const zipMode = b.format === 'zip_components' ? 'components' : 'combined';
    params = { periodId, part, zipMode };
    if (format === 'zip') {
      const settings = await loadAccredSettings(trx);
      const p: DocPeriod = {
        id: periodId,
        row,
        profile: readProfile(row.profile),
        instrument,
        D: snapshotDate(row.ends_on, localDate(settings.timezone, o.now)),
        school,
        libraryName: '',
        schoolLibrary: settings.libraryType === 'sekolah',
      };
      const withheld = o.holds === undefined ? [] : withheldDrafts(instrument, { periodId, D: p.D }, o.holds);
      if (withheld.length > 0) params = { ...params, withheld };
      const estimate = zipEstimate(await zipUnits(trx, p, zipMode, { withheld }));
      if (estimate.entries > REPORT_ZIP_MAX_ENTRIES) throw zipTooLarge('entries', estimate.entries);
      if (estimate.bytes > REPORT_ZIP_MAX_BYTES) throw zipTooLarge('bytes', estimate.bytes);
    }
  }
  return startReportRun(trx, def, { format, params, locale: 'id', createdBy: o.createdBy, now: o.now, registry: o.registry, keyring: o.keyring });
}
