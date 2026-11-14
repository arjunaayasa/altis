import type { PrerequisitesView } from '@altis/shared/api/accreditation';
import type { PdfLayout } from '../../../print/layout.js';
import type { DocumentCtx } from '../../../reports/types.js';
import { dateText, numberText, orNone, type DocPeriod } from '../data.js';
import { HEADINGS, ROLES, STATEMENT, statementBody } from '../texts.js';
import { signedAt, withName } from './request-letter.js';

// Section 3 of the evidence file (spec §10.9) and the body of the statement document: the statement that the library
// holds at least 1 000 titles, with the count and its date as the evaluation found them (the registration
// prerequisites), and a signature block. The statement printed alone names no one: its block has the role, place and
// date and an empty line for the name, so it holds no personal data (`names: false`).

/** Who signs the statement: the head of school for a school instrument, else the head of the parent institution. */
export function statementRole(p: DocPeriod): string {
  return p.school ? ROLES.schoolHead : ROLES.parentHead;
}

export function writeStatement(
  layout: PdfLayout,
  ctx: DocumentCtx,
  p: DocPeriod,
  prerequisites: PrerequisitesView | null,
  o: { names: boolean },
): void {
  const role = statementRole(p);
  layout.heading(HEADINGS.statement, 1);
  if (prerequisites === null) {
    layout.paragraph(STATEMENT.notComputed, { bold: true });
  } else {
    layout.paragraph(
      statementBody({
        role,
        school: orNone(p.profile.schoolName),
        library: p.libraryName,
        count: numberText(prerequisites.titles.count),
        date: dateText(prerequisites.titles.asOf),
      }),
    );
  }
  layout.paragraph(STATEMENT.closing);
  const place = signedAt(p);
  layout.signatureBlocks([
    {
      ...(place === undefined ? {} : { place }),
      date: dateText(ctx.today),
      role,
      ...(o.names ? withName(p.profile.schoolHead) : {}),
      stamp: true,
    },
  ]);
}
