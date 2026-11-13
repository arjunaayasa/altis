import { annexActivitiesReport } from '../accreditation/annexes/activities.js';
import { annexAdditionsReport } from '../accreditation/annexes/additions.js';
import { annexBudgetsReport } from '../accreditation/annexes/budgets.js';
import { annexCollectionMatrixReport } from '../accreditation/annexes/collection-matrix.js';
import { annexDdcReport } from '../accreditation/annexes/ddc.js';
import { annexDocumentsReport } from '../accreditation/annexes/documents.js';
import { annexL14Report } from '../accreditation/annexes/l14.js';
import { annexPartnershipsReport } from '../accreditation/annexes/partnerships.js';
import { annexStaffReport } from '../accreditation/annexes/staff.js';
import { annexUsageMonthlyReport } from '../accreditation/annexes/usage-monthly.js';
import { dossierReport } from '../accreditation/documents/dossier.js';
import { selfAssessmentReport } from '../accreditation/documents/self-assessment.js';
import { statement1000Report } from '../accreditation/documents/statement.js';
import { collectionAccessionRegisterReport } from './collection/accession-register.js';
import { collectionAcquisitionsReport } from './collection/acquisitions.js';
import { collectionAttachmentDownloadsReport } from './collection/attachment-downloads.js';
import { collectionDataQualityReport } from './collection/data-quality.js';
import { collectionDdcRecapReport } from './collection/ddc-recap.js';
import { collectionItemListReport } from './collection/item-list.js';
import { collectionSummaryReport } from './collection/summary.js';
import { collectionTitleListReport } from './collection/title-list.js';
import { TEST_REPORTS } from './test-reports.js';
import type { ReportDefinition } from './types.js';

// The report registry (spec §4.15): every definition the reports screen, the preview, the export runs and the
// accreditation documents know, in blocks per area; each milestone appends its own block at the end. The test build
// profile adds three definitions of a known shape after them (test-reports.ts); a production build has none.

/** Every report definition of this build. */
export const REPORTS: readonly ReportDefinition[] = Object.freeze([
  // ---- Komunitas K1 (collection) ----
  collectionSummaryReport,
  collectionDdcRecapReport,
  collectionAcquisitionsReport,
  collectionTitleListReport,
  collectionItemListReport,
  collectionAccessionRegisterReport,
  collectionDataQualityReport,
  collectionAttachmentDownloadsReport,
  // ---- Komunitas K1 (accreditation annexes) ----
  annexDdcReport,
  annexCollectionMatrixReport,
  annexAdditionsReport,
  annexL14Report,
  annexUsageMonthlyReport,
  annexStaffReport,
  annexBudgetsReport,
  annexActivitiesReport,
  annexPartnershipsReport,
  annexDocumentsReport,
  // ---- Komunitas K1 (accreditation documents) ----
  dossierReport,
  selfAssessmentReport,
  statement1000Report,
  // The test build profile only; the condition stays inline, so a production build drops the spread.
  ...(typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test' ? TEST_REPORTS : []),
]);

const BY_ID: ReadonlyMap<string, ReportDefinition> = new Map(REPORTS.map((def) => [def.id, def]));

/** The definition named `id`, or null. */
export function reportById(id: string): ReportDefinition | null {
  return BY_ID.get(id) ?? null;
}
