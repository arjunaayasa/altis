import type { DB } from '@altis/db';
import type { EvidenceComponent } from '@altis/shared/api/accreditation';
import type { Kysely } from 'kysely';
import { instrumentById } from '../instruments/index.js';
import { catalogueCode } from '../scoring/score.js';
import type { AccredInstrument } from '../types.js';

// The evidence checklist of a period's indicators (spec §10.3, §10.6): per indicator (by its catalogue code, `SCH-K1`),
// each item of its evidence list, in the instrument's order, present or missing, with the files linked to it. An item
// ALTIS generates itself (a report) is always present; any other item is present when at least one evidence row of the
// period names that indicator and that item. Also here: which indicators and items a period's evidence may name, and
// the component an evidence row counts towards.

/** The catalogue code of the institution's profile (its four photos). */
export const PROFILE_CODE = 'SCH-PROFIL';
/** The catalogue code of the registration prerequisites. */
export const PREREQUISITES_CODE = 'SCH-PRASYARAT';

/** The profile's four photo items, and the slot of `profile.photos` each fills. */
export const PROFILE_PHOTO_SLOTS = Object.freeze({
  photo_front: 'front',
  photo_collection: 'collection',
  photo_staff: 'staff',
  photo_reading_room: 'readingRoom',
} as const);

/** One item of an indicator's checklist: present or not, and its files. */
export interface EvidenceChecklistItem {
  code: string;
  present: boolean;
  files: { id: string; name: string; caption: string }[];
}

/**
 * The evidence item codes an evidence row of a period with instrument `instrumentId` may name under `indicatorCode`:
 * the indicator's own list for one of the instrument's indicators, the four photos for the profile, none for the
 * prerequisites (a row there names no item); null when the code is neither.
 */
export function evidenceItemsOf(instrumentId: string, indicatorCode: string): readonly string[] | null {
  if (indicatorCode === PROFILE_CODE) return Object.keys(PROFILE_PHOTO_SLOTS);
  if (indicatorCode === PREREQUISITES_CODE) return [];
  const instrument = instrumentById(instrumentId);
  if (instrument === null) return null;
  for (const component of instrument.components) {
    for (const indicator of component.indicators) {
      if (catalogueCode(indicator) === indicatorCode) return indicator.evidence.map((e) => e.code);
    }
  }
  return null;
}

const COMPONENT_OF_CODE = /^SCH-(K|SP|L|T|F|G)\d+$/;

/** The component whose evidence a row under `indicatorCode` counts towards (the profile is its own), or null. */
export function evidenceComponentOf(indicatorCode: string | null): EvidenceComponent | null {
  if (indicatorCode === null) return null;
  if (indicatorCode === PROFILE_CODE) return 'profil';
  const m = COMPONENT_OF_CODE.exec(indicatorCode);
  return m === null ? null : (m[1] as EvidenceComponent);
}

/** Every evidence component at 0 bytes. */
export function emptyComponentBytes(): Record<EvidenceComponent, number> {
  return { K: 0, SP: 0, L: 0, T: 0, F: 0, G: 0, profil: 0 };
}

/**
 * Per indicator catalogue code of `instrument` (`SCH-K1`), its checklist items in the instrument's order, from the
 * evidence of period `periodId`; files in their sort order, then oldest first.
 */
export async function evidenceChecklist(db: Kysely<DB>, periodId: string, instrument: AccredInstrument): Promise<Map<string, EvidenceChecklistItem[]>> {
  const rows = await db
    .selectFrom('accred_evidence as e')
    .innerJoin('files as f', 'f.id', 'e.file_id')
    .select(['e.id', 'e.indicator_code', 'e.evidence_code', 'e.file_id', 'e.caption', 'e.sort_order', 'e.created_at', 'f.original_name'])
    .where('e.period_id', '=', periodId)
    .execute();
  rows.sort((a, b) => Number(a.sort_order) - Number(b.sort_order) || Number(a.created_at) - Number(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const filesOf = new Map<string, EvidenceChecklistItem['files']>();
  for (const r of rows) {
    if (r.indicator_code === null || r.evidence_code === null) continue;
    const key = `${r.indicator_code} ${r.evidence_code}`;
    const list = filesOf.get(key) ?? [];
    list.push({ id: r.file_id, name: r.original_name, caption: r.caption });
    filesOf.set(key, list);
  }
  const out = new Map<string, EvidenceChecklistItem[]>();
  for (const component of instrument.components) {
    for (const indicator of component.indicators) {
      const code = catalogueCode(indicator);
      out.set(
        code,
        indicator.evidence.map((item) => {
          const files = filesOf.get(`${code} ${item.code}`) ?? [];
          return { code: item.code, present: item.kind === 'generated' || files.length > 0, files };
        }),
      );
    }
  }
  return out;
}
