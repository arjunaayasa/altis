import type { PdfLayout } from '../../../print/layout.js';
import type { DocumentCtx } from '../../../reports/types.js';
import { dateText, orNone, type DocPeriod } from '../data.js';
import { CERTIFICATE, HEADINGS, ROLES } from '../texts.js';
import { signedAt, withId, withName } from './request-letter.js';

// Section 4 of the evidence file (spec §10.9): how the library's name and address are to be written on the
// certificate, exactly, signed by the head of school and the head of library.

/** The full address of the profile on one line, the parts it has. */
export function addressLine(p: DocPeriod): string {
  const a = p.profile.address ?? {};
  const parts = [a.street, a.village, a.district, a.regency, a.province, a.postalCode].map((x) => x?.trim() ?? '').filter((x) => x !== '');
  return orNone(parts.join(', '));
}

export function writeCertificateName(layout: PdfLayout, ctx: DocumentCtx, p: DocPeriod): void {
  layout.heading(HEADINGS.certificateName, 1);
  layout.paragraph(CERTIFICATE.intro);
  const name = p.profile.certificateName?.trim();
  layout.keyValues([
    [CERTIFICATE.name, name === undefined || name === '' ? p.libraryName : name],
    [CERTIFICATE.school, orNone(p.profile.schoolName)],
    [CERTIFICATE.address, addressLine(p)],
  ]);
  const place = signedAt(p);
  layout.signatureBlocks([
    { ...(place === undefined ? {} : { place }), date: dateText(ctx.today), role: ROLES.schoolHead, ...withName(p.profile.schoolHead), stamp: true },
    { role: ROLES.libraryHead, ...withName(p.profile.libraryHead), ...withId(p.profile.libraryHeadId) },
  ]);
}
