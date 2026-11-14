import { JpegError } from '../../print/jpeg.js';
import type { PdfLayout } from '../../print/layout.js';
import type { DocumentCtx, ReportColumn, ReportRow } from '../../reports/types.js';
import type { AccredMetricId } from '../metric-ids.js';
import { budgetYears } from '../windows.js';
import type { AccredMetricValue } from '../types.js';
import { dateText, moneyText, msg, numberText, orNone, printReportTable, PROFILE_METRICS, storedBytes, type DocPeriod } from './data.js';
import { withId, withName } from './sections/request-letter.js';
import { HEADINGS, PROFILE, ROLES, WORDS } from './texts.js';

// The library profile form (spec §10.9 item 5, the profile's field map): the identity from the profile, the
// collection by medium and kind in titles and copies (the collection matrix annex), the facilities and the opening
// hours from the period, the members and the monthly averages of visitors, uses in the library and loans with the
// divisor they were cut by (the school months for a school), the staff counts, the budget of the period's last year,
// the counts of partnerships, innovations, distinctive programmes and awards, the four photos, and the signatures:
// the head of library with the head of school (school instruments) or the head of the parent institution (the
// statistics mode), with room for the stamp.

type Figures = ReadonlyMap<AccredMetricId, AccredMetricValue>;

/** The number in row `key` (column `col`) of a figure's table, or null. */
function tableNumber(v: AccredMetricValue | undefined, key: string, col = 1): number | null {
  const row = v?.table?.find((r) => r[0] === key);
  const cell = row?.[col];
  return typeof cell === 'number' ? cell : null;
}

/** A count or `—`. */
const countText = (n: number | null | undefined): string => (n === null || n === undefined ? WORDS.none : numberText(n));

/** The previous accreditation on one line: `B (2021), sertifikat 12/2021`. */
function previousText(p: DocPeriod): string {
  const prev = p.profile.previousAccreditation;
  if (prev === null || prev === undefined) return WORDS.none;
  const parts = [prev.grade, prev.year === null || prev.year === undefined ? null : `(${prev.year})`].filter((x) => x !== null && x !== undefined);
  const cert = prev.certificateNo?.trim();
  const head = parts.join(' ');
  return orNone([head, cert === undefined || cert === '' ? '' : `sertifikat ${cert}`].filter((x) => x !== '').join(', '));
}

/** The founding decree on one line: number, date, issuer. */
function decreeText(p: DocPeriod): string {
  const d = p.profile.foundingDecree;
  if (d === null || d === undefined) return WORDS.none;
  const parts = [d.number?.trim(), d.date === null || d.date === undefined ? undefined : dateText(d.date), d.issuer?.trim()].filter((x): x is string => x !== undefined && x !== '');
  return orNone(parts.join(', '));
}

async function writePhotos(layout: PdfLayout, ctx: DocumentCtx, p: DocPeriod): Promise<void> {
  const photos = p.profile.photos ?? {};
  const slots: [string | null | undefined, string][] = [
    [photos.front, PROFILE.photoFront],
    [photos.collection, PROFILE.photoCollection],
    [photos.staff, PROFILE.photoStaff],
    [photos.readingRoom, PROFILE.photoReadingRoom],
  ];
  for (const [fileId, caption] of slots) {
    const bytes = fileId === null || fileId === undefined ? null : await storedBytes(ctx, fileId);
    if (bytes === null) {
      layout.paragraph(`${caption}: ${WORDS.photoMissing}`, { size: 9 });
      continue;
    }
    try {
      layout.image(bytes, { maxWidthMm: 120, maxHeightMm: 70, caption });
    } catch (error) {
      if (!(error instanceof JpegError)) throw error;
      layout.paragraph(`${caption}: ${WORDS.photoUnreadable}`, { size: 9 });
    }
  }
}

export async function writeProfileForm(
  layout: PdfLayout,
  ctx: DocumentCtx,
  p: DocPeriod,
  o: { figures: Figures; matrix: { columns: readonly ReportColumn[]; rows: readonly ReportRow[] } | null },
): Promise<void> {
  const prof = p.profile;
  const f = o.figures;
  layout.heading(HEADINGS.profile, 1);

  layout.heading(PROFILE.identity, 2);
  layout.keyValues([
    [PROFILE.npp, orNone(prof.npp)],
    [PROFILE.previous, previousText(p)],
    [PROFILE.status, prof.status === null || prof.status === undefined ? WORDS.none : msg(`vocab.school_status.${prof.status}`)],
    [PROFILE.founded, orNone(prof.foundedYear)],
    [PROFILE.decree, decreeText(p)],
    [PROFILE.school, orNone(prof.schoolName)],
    [p.school ? PROFILE.schoolHead : PROFILE.parentHead, orNone(prof.schoolHead)],
    [PROFILE.libraryHead, orNone(prof.libraryHead)],
    [PROFILE.libraryHeadId, orNone(prof.libraryHeadId)],
  ]);

  layout.heading(PROFILE.collection, 2);
  if (o.matrix === null) layout.paragraph(WORDS.noData, { size: 9 });
  else printReportTable(layout, o.matrix.columns, o.matrix.rows);

  layout.heading(PROFILE.facilities, 2);
  layout.keyValues([
    [PROFILE.floor, countText(p.row.floor_m2)],
    [PROFILE.userPcs, countText(p.row.user_pcs)],
    [PROFILE.bandwidth, countText(p.row.bandwidth_mbps)],
  ]);

  layout.heading(PROFILE.services, 2);
  const averages = f.get(PROFILE_METRICS.averages);
  const divisor = averages?.facts?.['divisor'];
  const services: [string, string][] = [
    [PROFILE.hours, countText(p.row.hours_per_week)],
    [PROFILE.members, countText(f.get(PROFILE_METRICS.members)?.value)],
    [PROFILE.visitors, countText(tableNumber(averages, 'visitors', 2))],
    [PROFILE.reads, countText(tableNumber(averages, 'in_library_uses', 2))],
    [PROFILE.loans, countText(tableNumber(averages, 'loans', 2))],
    [p.school ? PROFILE.divisorSchool : PROFILE.divisorOther, typeof divisor === 'number' ? numberText(divisor) : WORDS.none],
  ];
  if (p.school) {
    const { students, teachers, edu_staff: eduStaff } = p.row;
    const population = students === null || teachers === null || eduStaff === null ? null : Number(students) + Number(teachers) + Number(eduStaff);
    services.push([PROFILE.population, countText(population)]);
  }
  layout.keyValues(services);
  for (const n of averages?.notes ?? []) layout.paragraph(msg(n.key, n.params), { size: 9 });

  layout.heading(PROFILE.staff, 2);
  const staff = f.get(PROFILE_METRICS.staff);
  layout.keyValues([
    [PROFILE.staffTotal, countText(tableNumber(staff, 'total'))],
    [PROFILE.librarians, countText(tableNumber(staff, 'librarians'))],
    [PROFILE.educated, countText(tableNumber(staff, 'education_library'))],
    [PROFILE.certified, countText(tableNumber(staff, 'competency_cert'))],
    [PROFILE.association, countText(tableNumber(staff, 'association_member'))],
  ]);

  layout.heading(PROFILE.budget, 2);
  const budget = f.get(PROFILE_METRICS.budget);
  const currency = budget?.table?.find((r) => r[0] === 'currency')?.[1];
  const money = (key: string): string => {
    const minor = tableNumber(budget, key);
    return minor === null ? WORDS.none : moneyText(minor / 100, typeof currency === 'string' ? currency : null);
  };
  layout.keyValues([
    [PROFILE.budgetYear, String(budgetYears(p.row.ends_on)[2])],
    [PROFILE.budgetLibrary, money('library_minor')],
    [PROFILE.budgetCommunity, money('community_minor')],
    [PROFILE.budgetCollection, money('collection_minor')],
    [PROFILE.budgetParent, money('parent_minor')],
  ]);

  layout.heading(PROFILE.counts, 2);
  const counts = f.get(PROFILE_METRICS.counts);
  layout.keyValues([
    [PROFILE.partners, countText(tableNumber(counts, 'partners'))],
    [PROFILE.innovation, countText(tableNumber(counts, 'innovation'))],
    [PROFILE.uniqueness, countText(tableNumber(counts, 'uniqueness'))],
    [PROFILE.awards, countText(tableNumber(counts, 'award'))],
  ]);

  layout.heading(PROFILE.photos, 2);
  await writePhotos(layout, ctx, p);

  layout.heading(PROFILE.signatures, 2);
  const date = dateText(ctx.today);
  const place = p.profile.address?.regency?.trim();
  layout.signatureBlocks([
    { ...(place === undefined || place === '' ? {} : { place }), date, role: ROLES.libraryHead, ...withName(prof.libraryHead), ...withId(prof.libraryHeadId) },
    { role: p.school ? ROLES.schoolHead : ROLES.parentHead, ...withName(prof.schoolHead), stamp: true },
  ]);
}
