import type { SnpResultView } from '@altis/shared/api/accreditation';
import type { PdfLayout } from '../../../print/layout.js';
import { msg, numberText } from '../data.js';
import { HEADINGS, SNP, SNP_OUTCOMES, WORDS } from '../texts.js';

// Section 8 of the evidence file (spec §10.9): the school standards the evaluation checked, each met or not (or only
// reported), with its rule and the value it was checked on; never a score of the instrument.

export function writeSnp(layout: PdfLayout, snp: readonly SnpResultView[]): void {
  if (snp.length === 0) return;
  layout.heading(HEADINGS.snp, 1);
  layout.paragraph(SNP.intro, { size: 9 });
  layout.table(
    [
      { header: SNP.code, weight: 1.2 },
      { header: SNP.standard, weight: 3 },
      { header: SNP.rule, weight: 4 },
      { header: SNP.value, weight: 1.2, align: 'right' },
      { header: SNP.outcome, weight: 1.6 },
    ],
    snp.map((s) => [s.code, msg(s.labelKey), msg(s.rule), s.value === null ? WORDS.none : numberText(s.value), SNP_OUTCOMES[s.outcome] ?? s.outcome]),
  );
}
