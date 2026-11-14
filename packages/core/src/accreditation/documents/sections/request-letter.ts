import type { PdfLayout } from '../../../print/layout.js';
import type { DocumentCtx } from '../../../reports/types.js';
import { dateText, orNone, type DocPeriod } from '../data.js';
import { FORM, HEADINGS, LETTER, ROLES, letterBody } from '../texts.js';

// Section 2 of the evidence file (spec §10.9): the request for accreditation, a letter filled from the profile and
// signed by the head of school, and the submission form with the data of the instrument's cover, signed by the head of
// school and the head of library. Also printed alone (`part: 'request_letter'`).

/** The place a document is signed in: the profile's regency or city, when known. */
export function signedAt(p: DocPeriod): string | undefined {
  const place = p.profile.address?.regency?.trim();
  return place === undefined || place === '' ? undefined : place;
}

/** A name for a signature block (undefined: an empty line to sign on). */
function nameOf(text: string | null | undefined): string | undefined {
  const s = text?.trim();
  return s === undefined || s === '' ? undefined : s;
}

export function writeRequestLetter(layout: PdfLayout, ctx: DocumentCtx, p: DocPeriod): void {
  const place = signedAt(p);
  const date = dateText(ctx.today);
  layout.heading(HEADINGS.requestLetter, 1);
  layout.keyValues([
    [LETTER.number, ''],
    [LETTER.attachment, LETTER.attachmentValue],
    [LETTER.subject, LETTER.subjectValue],
  ]);
  layout.paragraph(LETTER.to);
  layout.paragraph(LETTER.greeting);
  layout.paragraph(
    letterBody({
      library: p.libraryName,
      school: orNone(p.profile.schoolName),
      npp: orNone(p.profile.npp),
      instrument: `${p.instrument.decreeTitle} (${p.instrument.decree})`,
    }),
  );
  layout.paragraph(LETTER.closing);
  layout.signatureBlocks([{ ...(place === undefined ? {} : { place }), date, role: ROLES.schoolHead, ...withName(p.profile.schoolHead) }]);

  layout.pageBreak();
  layout.heading(HEADINGS.submissionForm, 1);
  const a = p.profile.address ?? {};
  layout.keyValues([
    [FORM.school, orNone(p.profile.schoolName)],
    [FORM.schoolHead, orNone(p.profile.schoolHead)],
    [FORM.library, p.libraryName],
    [FORM.libraryHead, orNone(p.profile.libraryHead)],
    [FORM.npp, orNone(p.profile.npp)],
    [FORM.street, orNone(a.street)],
    [FORM.village, orNone(a.village)],
    [FORM.district, orNone(a.district)],
    [FORM.regency, orNone(a.regency)],
    [FORM.province, orNone(a.province)],
    [FORM.postalCode, orNone(a.postalCode)],
    [FORM.phone, orNone(p.profile.phone)],
    [FORM.website, orNone(p.profile.website)],
    [FORM.email, orNone(p.profile.email)],
  ]);
  layout.signatureBlocks([
    { ...(place === undefined ? {} : { place }), date, role: ROLES.schoolHead, ...withName(p.profile.schoolHead), stamp: true },
    { role: ROLES.libraryHead, ...withName(p.profile.libraryHead), ...withId(p.profile.libraryHeadId) },
  ]);
}

/** `{name}` when the profile has one. */
export function withName(text: string | null | undefined): { name?: string } {
  const name = nameOf(text);
  return name === undefined ? {} : { name };
}

/** `{idLine}` when the profile has the head of library's number. */
export function withId(text: string | null | undefined): { idLine?: string } {
  const id = nameOf(text);
  return id === undefined ? {} : { idLine: id };
}
