import type { PdfLayout } from '../../../print/layout.js';
import { dateText, msg, orNone, sourceStatusText, type DocPeriod } from '../data.js';
import { COVER, HEADINGS } from '../texts.js';

// Section 1 of the evidence file (spec §10.9): the cover. The library, its parent institution and its number, the
// instrument by its decree (short number and full title) and how sure its text is, the period and its span. The
// statistics mode adds that ALTIS has no instrument for this kind of library yet, so no submission form is printed.

export function writeCover(layout: PdfLayout, p: DocPeriod): void {
  layout.heading(p.school ? HEADINGS.dossier : `${HEADINGS.dossier}: ${COVER.general}`, 1);
  const status = sourceStatusText(p.instrument);
  layout.keyValues([
    [COVER.library, p.libraryName],
    [COVER.school, orNone(p.profile.schoolName)],
    [COVER.npp, orNone(p.profile.npp)],
    [COVER.instrument, p.instrument.decreeTitle],
    [COVER.decree, p.instrument.decree],
    [COVER.source, status ?? COVER.sourceVerified],
    [COVER.period, p.row.name],
    [COVER.span, `${dateText(p.row.starts_on)} – ${dateText(p.row.ends_on)}`],
  ]);
  if (!p.school) layout.paragraph(`${msg('accred.general.cover')}.`, { bold: true });
}
