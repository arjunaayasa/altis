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
import { membersListReport } from './members/list.js';
// ---- Komunitas (member, visit and circulation reports) ----
import { circulationInLibraryReport, circulationLoansByClassReport } from './circulation/class-matrix.js';
import { circulationItemUsageReport } from './circulation/item-usage.js';
import { circulationLoanHistoryReport } from './circulation/loan-history.js';
import { circulationChargesReport, circulationPaymentsDailyReport } from './circulation/money.js';
import { circulationHoldsReport } from './circulation/holds.js';
import { circulationDueSoonReport, circulationOpenLoansReport, circulationOverdueReport } from './circulation/open-loans.js';
import { circulationSummaryReport } from './circulation/summary.js';
import { circulationTopBorrowersReport, circulationTopTitlesReport } from './circulation/top.js';
import { membersExpiringReport } from './members/expiring.js';
import { membersReprintListReport } from './members/reprint-list.js';
import { membersSummaryReport } from './members/summary.js';
import { visitsListReport } from './visits/list.js';
import { visitsDailyReport, visitsMonthlyReport } from './visits/statistics.js';
// ---- Komunitas K4 (stocktake) ----
import {
  stocktakeByOfficerReport,
  stocktakeHistoryReport,
  stocktakeMisplacedReport,
  stocktakeMissingReport,
  stocktakeProgressReport,
} from './stocktake/index.js';
// ---- Komunitas K5 (reports) ----
import { libraryAnnualReport } from './library/annual-report.js';
import { systemStaffActivityReport } from './system/staff-activity.js';
import { visitsByHourReport } from './visits/by-hour.js';
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
  // ---- Komunitas K2 (members) ----
  membersListReport,
  // ---- Komunitas (member, visit and circulation reports) ----
  membersSummaryReport,
  membersExpiringReport,
  membersReprintListReport,
  visitsMonthlyReport,
  visitsDailyReport,
  visitsListReport,
  circulationSummaryReport,
  circulationLoansByClassReport,
  circulationItemUsageReport,
  circulationTopTitlesReport,
  circulationInLibraryReport,
  circulationLoanHistoryReport,
  circulationOpenLoansReport,
  circulationOverdueReport,
  circulationDueSoonReport,
  circulationHoldsReport,
  circulationChargesReport,
  circulationPaymentsDailyReport,
  circulationTopBorrowersReport,
  // ---- Komunitas K4 (stocktake) ----
  stocktakeProgressReport,
  stocktakeMissingReport,
  stocktakeMisplacedReport,
  stocktakeByOfficerReport,
  stocktakeHistoryReport,
  // ---- Komunitas K5 (reports) ----
  visitsByHourReport,
  systemStaffActivityReport,
  libraryAnnualReport,
  // The test build profile only; the condition stays inline, so a production build drops the spread.
  ...(typeof __BUILD_PROFILE__ !== 'undefined' && __BUILD_PROFILE__ === 'test' ? TEST_REPORTS : []),
]);

const BY_ID: ReadonlyMap<string, ReportDefinition> = new Map(REPORTS.map((def) => [def.id, def]));

/** The definition named `id`, or null. */
export function reportById(id: string): ReportDefinition | null {
  return BY_ID.get(id) ?? null;
}
