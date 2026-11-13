import type { DB } from '@altis/db';
import { ACCRED_PROFILE_MAX_BYTES, type AccredProfile } from '@altis/shared/api/accreditation';
import type { Transaction } from 'kysely';
import { periodFieldErrors, type PeriodFieldError } from './errors.js';

// The institution's profile of a period (spec §10.6; `accred_periods.profile`, JSON of at most 16 000 bytes).
//
// - A new period starts from the profile of an earlier period (the one named, else the latest live one). The profile
//   photos are evidence files of their own period, so a copy starts without them. A first period starts from the
//   library's settings: only the street of `library.address` (the one setting that holds a profile field), made one
//   line and cut to 191 characters; phone, e-mail and website stay empty.
// - A profile in a request changes the fields it names: a field sent replaces the stored one (null clears it), a field
//   left out is kept. `photos` and `address` are fields like the others: sent, they replace the stored object whole.
// - Each photo slot names a file of an evidence row of the same period under the profile code `SCH-PROFIL`, and that
//   file is a JPEG (the evidence upload also takes PDF).

/** The indicator code of the profile's evidence (its photos). */
export const PROFILE_EVIDENCE_CODE = 'SCH-PROFIL';
/** The widest profile text field (`address.street`). */
const STREET_MAX = 191;

/** The stored profile JSON as an object (`{}` for anything else). */
export function readProfile(json: string): AccredProfile {
  const value: unknown = JSON.parse(json);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as AccredProfile) : {};
}

/** `text` on one line (every run of control characters and blanks one space), trimmed, at most `max` UTF-16 units. */
function oneLine(text: string, max: number): string | null {
  const flat = text.replace(/[\p{Cc}\s]+/gu, ' ').trim();
  let out = '';
  for (const ch of flat) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  out = out.trimEnd();
  return out === '' ? null : out;
}

/** The profile of a library's first period: the street from `library.address`; phone, e-mail and website empty. */
export function firstProfile(libraryAddress: string | null): AccredProfile {
  const street = libraryAddress === null ? null : oneLine(libraryAddress, STREET_MAX);
  return { address: street === null ? null : { street }, phone: null, email: null, website: null };
}

/** An earlier period's profile as a new period starts from it: without the photos of that period. */
export function copiedProfile(profile: AccredProfile): AccredProfile {
  return profile.photos === undefined ? { ...profile } : { ...profile, photos: null };
}

/** `base` with the fields `given` names replaced (a field left out of `given` is kept). */
export function mergeProfile(base: AccredProfile, given: AccredProfile | undefined): AccredProfile {
  if (given === undefined) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(given)) if (value !== undefined) out[key] = value;
  return out as AccredProfile;
}

/**
 * `profile` as the JSON it is stored as.
 *
 * @throws DomainError `VALIDATION_FAILED {path: 'profile', code: 'too_big'}` above 16 000 bytes
 */
export function profileJson(profile: AccredProfile): string {
  const json = JSON.stringify(profile);
  if (Buffer.byteLength(json, 'utf8') > ACCRED_PROFILE_MAX_BYTES) throw periodFieldErrors([{ path: 'profile', code: 'too_big' }]);
  return json;
}

/**
 * Checks the photo slots `photos` names: each must be the file of an evidence row of period `periodId` under
 * {@link PROFILE_EVIDENCE_CODE}, and a JPEG.
 *
 * @throws DomainError `VALIDATION_FAILED` `{path: 'profile.photos.<slot>', code: 'not_found'}` for a file that is not
 *   such evidence, `{…, code: 'invalid'}` for one that is not `image/jpeg`
 */
export async function assertProfilePhotos(trx: Transaction<DB>, periodId: string, photos: AccredProfile['photos']): Promise<void> {
  if (photos === undefined || photos === null) return;
  const named = Object.entries(photos).filter((e): e is [string, string] => typeof e[1] === 'string');
  if (named.length === 0) return;
  const rows = await trx
    .selectFrom('accred_evidence as e')
    .innerJoin('files as f', 'f.id', 'e.file_id')
    .select(['e.file_id', 'f.mime'])
    .where('e.period_id', '=', periodId)
    .where('e.indicator_code', '=', PROFILE_EVIDENCE_CODE)
    .where(
      'e.file_id',
      'in',
      named.map(([, id]) => id),
    )
    .execute();
  const mimeOf = new Map(rows.map((r) => [r.file_id, r.mime]));
  const errors: PeriodFieldError[] = [];
  for (const [slot, fileId] of named) {
    const mime = mimeOf.get(fileId);
    if (mime === undefined) errors.push({ path: `profile.photos.${slot}`, code: 'not_found' });
    else if (mime !== 'image/jpeg') errors.push({ path: `profile.photos.${slot}`, code: 'invalid' });
  }
  if (errors.length > 0) throw periodFieldErrors(errors);
}
