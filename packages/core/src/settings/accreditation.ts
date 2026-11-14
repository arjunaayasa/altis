import type { DB } from '@altis/db';
import type { AccredGroup } from '@altis/shared';
import type { LibraryType, UsedUnit, WebsiteFeatures } from '@altis/shared/api/settings';
import type { Kysely } from 'kysely';
import type { SettingKey } from './registry.js';
import { readSettings } from './service.js';

// The settings the reports and the accreditation workspace read, in one typed object: the sixteen of group
// `accreditation`, the repeat window of member visits, and the library's type and time zone. Read afresh from the
// table (absent rows read as their defaults); none is a secret, so no keyring is needed.

/** What the accreditation code reads of the settings. */
export interface AccredSettings {
  /** The month a school year starts in, 1-12. */
  schoolYearStartMonth: number;
  /** How a title counts as fiction: by collection type code (upper case), call number prefix or DDC prefix. */
  fiction: { collectionTypeCodes: readonly string[]; callNumberPrefixes: readonly string[]; ddcPrefixes: readonly string[] };
  referenceCollectionTypeCodes: readonly string[];
  electronicMaterialTypeCodes: readonly string[];
  /** Collection use is counted per title or per copy. */
  usedUnit: UsedUnit;
  websiteFeatures: WebsiteFeatures;
  /** The day the library started working in ALTIS, or null. */
  liveFrom: string | null;
  /** The largest evidence file, in MB. */
  evidenceMaxMb: number;
  /** The size above which a component's evidence is flagged, in MB. */
  componentLimitMb: number;
  /** Empty: every non-reference title counts as enrichment. */
  textbookCollectionTypeCodes: readonly string[];
  /** The share of fully processed copies a collection needs, 50-100 %. */
  k7ThresholdPct: number;
  /** Above this share of undated copies (0-100 %) no suggestion is made. */
  undatedShareMaxPct: number;
  /** Imported and migrated visits are counted without repeats. */
  dedupeLegacy: boolean;
  /** The group of visits by members deleted in SLiMS (`'auto'` resolved: students in a school library, else null). */
  unknownMemberGroupDefault: AccredGroup | null;
  /** A member's check-in within this many minutes of an earlier one is a repeat; 0: the rule is off. */
  dedupeMinutes: number;
  libraryType: LibraryType | null;
  /** The IANA time zone of the library (`library.timezone`). */
  timezone: string;
}

const KEYS = [
  'accreditation.schoolYearStartMonth',
  'accreditation.fiction.collectionTypeCodes',
  'accreditation.fiction.callNumberPrefixes',
  'accreditation.fiction.ddcPrefixes',
  'accreditation.referenceCollectionTypeCodes',
  'accreditation.electronicMaterialTypeCodes',
  'accreditation.usedUnit',
  'accreditation.websiteFeatures',
  'accreditation.liveFrom',
  'accreditation.evidence.maxMb',
  'accreditation.evidence.componentLimitMb',
  'accreditation.textbookCollectionTypeCodes',
  'accreditation.k7.processedThresholdPct',
  'accreditation.undatedShareMaxPct',
  'accreditation.visits.dedupeLegacy',
  'accreditation.unknownMemberGroup.default',
  'visits.dedupeMinutes',
  'library.type',
  'library.timezone',
] as const satisfies readonly SettingKey[];

/**
 * The accreditation settings of `db` (a transaction is a Kysely too), with `accreditation.unknownMemberGroup.default = 'auto'` resolved: `student`
 * when `library.type` is `sekolah`, otherwise null. An explicit null stays null.
 */
export async function loadAccredSettings(db: Kysely<DB>): Promise<AccredSettings> {
  const s = await readSettings(db, KEYS, []);
  const libraryType = s['library.type'] as LibraryType | null;
  const unknown = s['accreditation.unknownMemberGroup.default'] as AccredGroup | 'auto' | null;
  return {
    schoolYearStartMonth: s['accreditation.schoolYearStartMonth'] as number,
    fiction: {
      collectionTypeCodes: s['accreditation.fiction.collectionTypeCodes'] as readonly string[],
      callNumberPrefixes: s['accreditation.fiction.callNumberPrefixes'] as readonly string[],
      ddcPrefixes: s['accreditation.fiction.ddcPrefixes'] as readonly string[],
    },
    referenceCollectionTypeCodes: s['accreditation.referenceCollectionTypeCodes'] as readonly string[],
    electronicMaterialTypeCodes: s['accreditation.electronicMaterialTypeCodes'] as readonly string[],
    usedUnit: s['accreditation.usedUnit'] as UsedUnit,
    websiteFeatures: s['accreditation.websiteFeatures'] as WebsiteFeatures,
    liveFrom: s['accreditation.liveFrom'] as string | null,
    evidenceMaxMb: s['accreditation.evidence.maxMb'] as number,
    componentLimitMb: s['accreditation.evidence.componentLimitMb'] as number,
    textbookCollectionTypeCodes: s['accreditation.textbookCollectionTypeCodes'] as readonly string[],
    k7ThresholdPct: s['accreditation.k7.processedThresholdPct'] as number,
    undatedShareMaxPct: s['accreditation.undatedShareMaxPct'] as number,
    dedupeLegacy: s['accreditation.visits.dedupeLegacy'] as boolean,
    unknownMemberGroupDefault: unknown === 'auto' ? (libraryType === 'sekolah' ? 'student' : null) : unknown,
    dedupeMinutes: s['visits.dedupeMinutes'] as number,
    libraryType,
    timezone: s['library.timezone'] as string,
  };
}
