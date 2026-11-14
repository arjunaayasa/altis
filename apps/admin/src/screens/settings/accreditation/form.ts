import { ACCRED_GROUPS, isCalendarDate, isUlid, type AccredGroup } from '@altis/shared';
import {
  AccreditationSettingsBody,
  USED_UNITS,
  WebsiteFeatures,
  evidenceMbField,
  processedThresholdPctField,
  schoolYearStartMonthField,
  undatedShareMaxPctField,
  type AccreditationSettingsView,
  type UsedUnit,
} from '@altis/shared/api/settings';
import { z } from 'zod';
import { listMax, sameValue } from '../catalog/form';
import { wholeNumberIn } from '../library';

export { listMax };

/**
 * The form model of Pengaturan › Akreditasi: the values the form edits, their checks (the bounds and the entry
 * schemas of the shared {@link AccreditationSettingsBody}, which the server applies too), the group as the form would
 * store it ({@link settingsOf}), and the `PUT settings/accreditation` body: only the settings that changed, a list or
 * the website features whole ({@link accreditationBody}).
 */

/** The OPAC page settings of the website features. */
export const PAGE_KEYS = ['profilePageId', 'servicesPageId', 'contactPageId', 'databasesPageId', 'faqPageId'] as const;

export type PageKey = (typeof PAGE_KEYS)[number];

/** The choices of `unknownMemberGroup.default`: `auto`, a group, or `none` (stored as null). */
export type UnknownGroupChoice = AccredGroup | 'auto' | 'none';

export const UNKNOWN_GROUP_CHOICES: readonly UnknownGroupChoice[] = ['auto', ...ACCRED_GROUPS, 'none'];

/** The values of the whole form: a date or a page that may be absent is `''` here. */
export interface AccredFormValues {
  schoolYearStartMonth: number;
  liveFrom: string;
  fiction: { collectionTypeCodes: string[]; callNumberPrefixes: string[]; ddcPrefixes: string[] };
  referenceCollectionTypeCodes: string[];
  electronicMaterialTypeCodes: string[];
  textbookCollectionTypeCodes: string[];
  usedUnit: UsedUnit;
  k7: { processedThresholdPct: number };
  undatedShareMaxPct: number;
  websiteFeatures: Record<PageKey, string> & { socialUrls: string[] };
  evidence: { maxMb: number; componentLimitMb: number };
  visits: { dedupeLegacy: boolean };
  unknownMemberGroup: { default: UnknownGroupChoice };
}

/** The paths of the form's lists (each edited as chips). */
export type ChipListName =
  | 'fiction.collectionTypeCodes'
  | 'fiction.callNumberPrefixes'
  | 'fiction.ddcPrefixes'
  | 'referenceCollectionTypeCodes'
  | 'electronicMaterialTypeCodes'
  | 'textbookCollectionTypeCodes'
  | 'websiteFeatures.socialUrls';

// The list schemas of the shared body (their entry schema and their largest length are the server's).
const body = AccreditationSettingsBody.shape;
const fiction = body.fiction.unwrap().shape;
const features = WebsiteFeatures.shape;

/** Each list's schema, by its form path. */
export const LIST_SCHEMAS: Readonly<Record<ChipListName, z.ZodArray<z.ZodType<string, string>>>> = {
  'fiction.collectionTypeCodes': fiction.collectionTypeCodes.unwrap(),
  'fiction.callNumberPrefixes': fiction.callNumberPrefixes.unwrap(),
  'fiction.ddcPrefixes': fiction.ddcPrefixes.unwrap(),
  referenceCollectionTypeCodes: body.referenceCollectionTypeCodes.unwrap(),
  electronicMaterialTypeCodes: body.electronicMaterialTypeCodes.unwrap(),
  textbookCollectionTypeCodes: body.textbookCollectionTypeCodes.unwrap(),
  'websiteFeatures.socialUrls': features.socialUrls.unwrap(),
};

/** A page id: empty (no page) or a ULID. */
const pageField = z
  .string()
  .trim()
  .check((ctx) => {
    if (ctx.value !== '' && !isUlid(ctx.value)) ctx.issues.push({ code: 'invalid_format', format: 'ulid', input: ctx.value });
  });

/** A date that may be empty (none). */
const optionalDate = z.string().check((ctx) => {
  if (ctx.value !== '' && !isCalendarDate(ctx.value)) ctx.issues.push({ code: 'invalid_format', format: 'date', input: ctx.value });
});

/** The form's checks: the numbers within the shared bounds, the lists and pages by the shared schemas. */
export const AccredForm = z.strictObject({
  schoolYearStartMonth: wholeNumberIn(schoolYearStartMonthField),
  liveFrom: optionalDate,
  fiction: z.strictObject({
    collectionTypeCodes: LIST_SCHEMAS['fiction.collectionTypeCodes'],
    callNumberPrefixes: LIST_SCHEMAS['fiction.callNumberPrefixes'],
    ddcPrefixes: LIST_SCHEMAS['fiction.ddcPrefixes'],
  }),
  referenceCollectionTypeCodes: LIST_SCHEMAS.referenceCollectionTypeCodes,
  electronicMaterialTypeCodes: LIST_SCHEMAS.electronicMaterialTypeCodes,
  textbookCollectionTypeCodes: LIST_SCHEMAS.textbookCollectionTypeCodes,
  usedUnit: z.enum(USED_UNITS),
  k7: z.strictObject({ processedThresholdPct: wholeNumberIn(processedThresholdPctField) }),
  undatedShareMaxPct: wholeNumberIn(undatedShareMaxPctField),
  websiteFeatures: z.strictObject({
    profilePageId: pageField,
    servicesPageId: pageField,
    contactPageId: pageField,
    databasesPageId: pageField,
    faqPageId: pageField,
    socialUrls: LIST_SCHEMAS['websiteFeatures.socialUrls'],
  }),
  evidence: z.strictObject({ maxMb: wholeNumberIn(evidenceMbField), componentLimitMb: wholeNumberIn(evidenceMbField) }),
  visits: z.strictObject({ dedupeLegacy: z.boolean() }),
  unknownMemberGroup: z.strictObject({ default: z.enum(UNKNOWN_GROUP_CHOICES as [UnknownGroupChoice, ...UnknownGroupChoice[]]) }),
});

export type AccredFormInput = z.input<typeof AccredForm>;
export type AccredFormOutput = z.output<typeof AccredForm>;

/** The bounds a number field shows in its hint. */
export const BOUNDS = {
  processedThresholdPct: processedThresholdPctField,
  undatedShareMaxPct: undatedShareMaxPctField,
  evidenceMb: evidenceMbField,
} as const;

/** The form's values for the stored group. */
export function accredFormValues(view: AccreditationSettingsView): AccredFormValues {
  const f = view.websiteFeatures;
  return {
    schoolYearStartMonth: view.schoolYearStartMonth,
    liveFrom: view.liveFrom ?? '',
    fiction: { collectionTypeCodes: [...view.fiction.collectionTypeCodes], callNumberPrefixes: [...view.fiction.callNumberPrefixes], ddcPrefixes: [...view.fiction.ddcPrefixes] },
    referenceCollectionTypeCodes: [...view.referenceCollectionTypeCodes],
    electronicMaterialTypeCodes: [...view.electronicMaterialTypeCodes],
    textbookCollectionTypeCodes: [...view.textbookCollectionTypeCodes],
    usedUnit: view.usedUnit,
    k7: { processedThresholdPct: view.k7.processedThresholdPct },
    undatedShareMaxPct: view.undatedShareMaxPct,
    websiteFeatures: {
      profilePageId: f.profilePageId ?? '',
      servicesPageId: f.servicesPageId ?? '',
      contactPageId: f.contactPageId ?? '',
      databasesPageId: f.databasesPageId ?? '',
      faqPageId: f.faqPageId ?? '',
      socialUrls: [...(f.socialUrls ?? [])],
    },
    evidence: { maxMb: view.evidence.maxMb, componentLimitMb: view.evidence.componentLimitMb },
    visits: { dedupeLegacy: view.visits.dedupeLegacy },
    unknownMemberGroup: { default: view.unknownMemberGroup.default ?? 'none' },
  };
}

/** The website features as they are stored: a page or the social addresses only when given. */
export function compactFeatures(f: { [K in PageKey]?: string | undefined } & { socialUrls?: readonly string[] | undefined }): WebsiteFeatures {
  const out: WebsiteFeatures = {};
  for (const key of PAGE_KEYS) {
    const id = f[key];
    if (id !== undefined && id !== '') out[key] = id;
  }
  if (f.socialUrls !== undefined && f.socialUrls.length > 0) out.socialUrls = [...f.socialUrls];
  return out;
}

/** The checked values as the group's settings (every key present). */
export function settingsOf(v: AccredFormOutput): AccreditationSettingsView {
  return {
    schoolYearStartMonth: v.schoolYearStartMonth,
    fiction: { collectionTypeCodes: v.fiction.collectionTypeCodes, callNumberPrefixes: v.fiction.callNumberPrefixes, ddcPrefixes: v.fiction.ddcPrefixes },
    referenceCollectionTypeCodes: v.referenceCollectionTypeCodes,
    electronicMaterialTypeCodes: v.electronicMaterialTypeCodes,
    usedUnit: v.usedUnit,
    websiteFeatures: compactFeatures(v.websiteFeatures),
    liveFrom: v.liveFrom === '' ? null : v.liveFrom,
    evidence: { maxMb: v.evidence.maxMb, componentLimitMb: v.evidence.componentLimitMb },
    textbookCollectionTypeCodes: v.textbookCollectionTypeCodes,
    k7: { processedThresholdPct: v.k7.processedThresholdPct },
    undatedShareMaxPct: v.undatedShareMaxPct,
    visits: { dedupeLegacy: v.visits.dedupeLegacy },
    unknownMemberGroup: { default: v.unknownMemberGroup.default === 'none' ? null : v.unknownMemberGroup.default },
  };
}

/** The groups whose settings are nested one level in the body (`fiction.ddcPrefixes`, `k7.processedThresholdPct`, …). */
const NESTED = ['fiction', 'evidence', 'k7', 'visits', 'unknownMemberGroup'] as const;

type Stored = Record<string, unknown>;

/** The group as stored, with the website features compacted (an empty list and an absent one are the same). */
function comparable(view: AccreditationSettingsView): Stored {
  return { ...view, websiteFeatures: compactFeatures(view.websiteFeatures) } as unknown as Stored;
}

/** The `PUT settings/accreditation` body: only what differs from `view` (a list and the website features whole). */
export function accreditationBody(next: AccreditationSettingsView, view: AccreditationSettingsView): AccreditationSettingsBody {
  const after = comparable(next);
  const before = comparable(view);
  const out: Stored = {};
  for (const key of Object.keys(after)) {
    if ((NESTED as readonly string[]).includes(key)) {
      const a = after[key] as Stored;
      const b = before[key] as Stored;
      const changed: Stored = {};
      for (const sub of Object.keys(a)) if (!sameValue(a[sub], b[sub])) changed[sub] = a[sub];
      if (Object.keys(changed).length > 0) out[key] = changed;
    } else if (!sameValue(after[key], before[key])) {
      out[key] = after[key];
    }
  }
  return out as AccreditationSettingsBody;
}

/**
 * Whether a setting `body` would write was changed by someone else since the form loaded `view`: `fresh` (read again
 * just before the PUT) holds another value there. A list goes whole, so writing it then would silently undo the other
 * change. Settings the body leaves alone do not count.
 */
export function changedElsewhere(put: AccreditationSettingsBody, view: AccreditationSettingsView, fresh: AccreditationSettingsView): boolean {
  const was = comparable(view);
  const now = comparable(fresh);
  for (const [key, value] of Object.entries(put)) {
    const subs = (NESTED as readonly string[]).includes(key) ? Object.keys(value as object) : [undefined];
    for (const sub of subs) {
      const at = (s: Stored): unknown => (sub === undefined ? s[key] : (s[key] as Stored | undefined)?.[sub]);
      if (!sameValue(at(now), at(was))) return true;
    }
  }
  return false;
}
