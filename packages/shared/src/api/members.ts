/**
 * The members API: member types, members (search, lookup by number, view, create, edit, suspend and reactivate,
 * extend, archive, history) and the CSV member import.
 *
 * - Every maximum equals its column width. Bodies are strict at every depth; a query reads text.
 * - Personal data never travels in a URL: searching (by number, name, identity number or e-mail) and the lookup by
 *   member number are POST reads (`mode: 'read'`, no idempotency), never a query string.
 * - A member number travels as typed or scanned; the server shows it normalised like an item barcode (strip CR, LF and
 *   TAB, trim, one space for each run of spaces, ASCII letters upper case; 1-64 characters of 0x20-0x7E) and compares
 *   it without any space, so `b 001`, ` B  001 `, `B 001` and `B001` are one number. A taken number is the field error
 *   `{path: 'memberNo', code: 'taken'}`.
 * - Suspending and reactivating are a `PATCH` of `status` (a suspension needs `statusNote`: `{path: 'statusNote', code:
 *   'required'}`); the member's history records `suspended` or `reactivated`.
 * - Every `store` route answers `StoreResponse` (`{id, version}`); screens read the view again with GET. A stale
 *   `version` is 409 CONFLICT_STALE.
 * - Member types are library-wide: `GET members/types` lists them for every reader of members; writing them needs
 *   `members.types.manage`. `loanLimit` null = no limit, 0 = may not borrow; `membershipDays` null = never expires.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/members`.
 */
import { z } from 'zod';
import { ACCRED_GROUPS, type AccredGroup } from '../accreditation-vocab.js';
import {
  GENDERS,
  MEMBER_IMPORT_FORMATS,
  MEMBER_IMPORT_MODES,
  MEMBER_STATUSES,
  MEMBER_STORED_STATUSES,
  type Gender,
  type MemberEventType,
  type MemberImportFormat,
  type MemberImportMode,
  type MemberImportRefusal,
  type MemberImportWarning,
  type MemberStatus,
  type MemberStoredStatus,
} from '../circulation-vocab.js';
import type { RunStatus } from '../catalog-vocab.js';
import { emailField, localeField, ulidField, versionField } from './common.js';
import { codeField, cursorQuery, customValuesField, dateField, longText, shortText, sortOrderField, type Paged } from './catalog/common.js';
// ---- Komunitas (staff screens' data) ----
import type { TypeLoanRule } from './circulation.js';

// ---- fields ----------------------------------------------------------------------------------------------------------

/** A member number as typed or scanned, before normalisation (bodies bound it at 200 characters, as a barcode). */
export const rawMemberNoField = z.string().min(1).max(200);

/** The most characters of a normalised member number (`member_no_display` is VARCHAR 64). */
export const MEMBER_NO_MAX = 64;

/** A non-negative whole number of a nullable SMALLINT column. */
const smallCountField = z.int().min(0).max(32_767);

/** The membership length in days (SMALLINT); null = never expires. */
export const membershipDaysField = z.int().min(1).max(32_767).nullable();

/**
 * The body of an archive (`DELETE members/:id`, `DELETE members/types/:id`, `DELETE circulation/policies/:id`): the
 * version the screen showed (a stale one is 409 CONFLICT_STALE).
 */
export const ArchiveBody = z.strictObject({ version: versionField });

export type ArchiveBody = z.infer<typeof ArchiveBody>;

// ---- member types --------------------------------------------------------------------------------------------------

const memberTypeFields = {
  code: codeField,
  nameId: shortText(191).min(1),
  nameEn: shortText(191).nullable(),
  accredGroup: z.enum(ACCRED_GROUPS),
  membershipDays: membershipDaysField,
  /** The most open loans a member of this type may hold: null = no limit, 0 = may not borrow. */
  loanLimit: smallCountField.nullable(),
  holdsAllowed: z.boolean(),
  holdsLimit: smallCountField,
  onlineRenewal: z.boolean(),
  sortOrder: sortOrderField,
};

/**
 * `POST members/types` → 201 `StoreResponse`. A taken code is `{path: 'code', code: 'taken'}`. `holdsAllowed`,
 * `holdsLimit` and `onlineRenewal` are stored for the later holds and OPAC work (defaults: true, 2, true).
 */
export const MemberTypeBody = z.strictObject({
  ...memberTypeFields,
  nameEn: memberTypeFields.nameEn.optional(),
  holdsAllowed: memberTypeFields.holdsAllowed.default(true),
  holdsLimit: memberTypeFields.holdsLimit.default(2),
  onlineRenewal: memberTypeFields.onlineRenewal.default(true),
  sortOrder: memberTypeFields.sortOrder.default(0),
});

export type MemberTypeBody = z.infer<typeof MemberTypeBody>;

/** `PATCH members/types/:id` → `StoreResponse`. Changing a type never changes its members' dates. */
export const MemberTypePatchBody = z.strictObject({ version: versionField, ...partialShape(memberTypeFields) });

export type MemberTypePatchBody = z.infer<typeof MemberTypePatchBody>;

/** `GET members/types`: live types by `sort_order` then code; `includeArchived=true` adds the archived ones. */
export const MemberTypeListQuery = z.strictObject({ includeArchived: z.stringbool().optional() });

export type MemberTypeListQuery = z.infer<typeof MemberTypeListQuery>;

export interface MemberTypeView {
  id: string;
  code: string;
  nameId: string;
  nameEn: string | null;
  accredGroup: AccredGroup;
  membershipDays: number | null;
  loanLimit: number | null;
  holdsAllowed: boolean;
  holdsLimit: number;
  onlineRenewal: boolean;
  sortOrder: number;
  /** Live (not archived) members of this type. */
  memberCount: number;
  archived: boolean;
  version: number;
  // ---- Komunitas (staff screens' data) ----
  /** The loan period and renewals of the type's general loan rule (read-only here); null when no rule covers it. */
  loanRule?: TypeLoanRule | null;
}

/** `GET members/types` (at most a few hundred rows). */
export interface MemberTypeListResponse {
  items: MemberTypeView[];
}

// ---- members ---------------------------------------------------------------------------------------------------------

const memberFields = {
  /** Required on create; renaming a member's number is allowed (a taken one is `taken`). */
  memberNo: rawMemberNoField,
  memberTypeId: ulidField,
  name: shortText(191).min(1),
  homeBranchId: ulidField.nullable(),
  gender: z.enum(GENDERS).nullable(),
  /** Not after today (the server checks it in the library's time zone: `{path: 'birthDate', code: 'future'}`). */
  birthDate: dateField.nullable(),
  identityNo: shortText(64).nullable(),
  institution: shortText(191).nullable(),
  className: shortText(64).nullable(),
  email: emailField.nullable(),
  phone: shortText(64).nullable(),
  address: longText.nullable(),
  postalCode: shortText(16).nullable(),
  mailingAddress: longText.nullable(),
  notes: longText.nullable(),
  locale: localeField,
};

/**
 * `POST members` → 201 `StoreResponse`. `joinedOn` (default today in the library's time zone) is also `valid_from`;
 * `expiresOn` defaults to `joinedOn + membershipDays` of the type (null when the type never expires); a date the staff
 * typed is kept as typed. The new member is `active`.
 */
export const MemberBody = z.strictObject({
  memberNo: memberFields.memberNo,
  memberTypeId: memberFields.memberTypeId,
  name: memberFields.name,
  homeBranchId: memberFields.homeBranchId.optional(),
  gender: memberFields.gender.optional(),
  birthDate: memberFields.birthDate.optional(),
  identityNo: memberFields.identityNo.optional(),
  institution: memberFields.institution.optional(),
  className: memberFields.className.optional(),
  email: memberFields.email.optional(),
  phone: memberFields.phone.optional(),
  address: memberFields.address.optional(),
  postalCode: memberFields.postalCode.optional(),
  mailingAddress: memberFields.mailingAddress.optional(),
  notes: memberFields.notes.optional(),
  locale: memberFields.locale.default('id'),
  joinedOn: dateField.optional(),
  expiresOn: dateField.nullable().optional(),
  // ---- Komunitas K2 (members extended) ----
  /** The member's custom fields (`{<code>: value}`, null clears one), checked against the live `members` definitions. */
  custom: customValuesField.optional(),
});

export type MemberBody = z.infer<typeof MemberBody>;

/**
 * `PATCH members/:id` → `StoreResponse`: only what it sends changes (null clears an optional field). `status` suspends
 * (`suspended`, with `statusNote`) or reactivates (`active`; the note is cleared) a member. Changing the type never
 * changes the dates; extending is `POST members/:id/extend`. `expiresOn` may be corrected directly.
 */
export const MemberPatchBody = z.strictObject({
  version: versionField,
  ...partialShape(memberFields),
  status: z.enum(MEMBER_STORED_STATUSES).optional(),
  statusNote: shortText(191).min(1).nullable().optional(),
  expiresOn: dateField.nullable().optional(),
  // ---- Komunitas K2 (members extended) ----
  custom: customValuesField.optional(),
});

export type MemberPatchBody = z.infer<typeof MemberPatchBody>;

/**
 * `POST members/:id/extend` → `StoreResponse`. The new period starts on `from`: `today`, `expiry` (the current
 * `expires_on` while it has not passed, else today) or a date; `expires_on = start + (days ?? membershipDays of the
 * type)`, `valid_from = start`; `joined_on` never changes. A type that never expires and no `days`:
 * `{path: 'days', code: 'required'}`. The history records `extended` with the old and new expiry.
 */
export const MemberExtendBody = z.strictObject({
  version: versionField,
  from: z.union([z.literal('today'), z.literal('expiry'), dateField]),
  days: z.int().min(0).max(32_767).optional(),
});

export type MemberExtendBody = z.infer<typeof MemberExtendBody>;

/**
 * `POST members/search` (a POST read: `q` never goes in a URL) → `MemberSearchResponse`. `q` matches the member number
 * (normalised, from its start), the name (`name_key`, every word), the identity number and the e-mail. `status` is the
 * shown status (MEMBER_STATUSES; default: every status but `archived` and `anonymized`). Ordered by name, then id.
 */
export const MemberSearchBody = z.strictObject({
  q: shortText(191).optional(),
  typeId: ulidField.optional(),
  status: z.enum(MEMBER_STATUSES).optional(),
  className: shortText(64).optional(),
  homeBranchId: ulidField.optional(),
  cursor: cursorQuery.cursor,
  limit: z.int().min(1).max(200).default(50),
});

export type MemberSearchBody = z.infer<typeof MemberSearchBody>;

/** `GET members/classes` (`members.records.read`): the classes of the live members, by name (at most a few thousand). */
export interface MemberClassesResponse {
  items: string[];
}

/** `POST members/lookup` (a POST read) → `MemberView`; 404 NOT_FOUND when no live member has the number. */
export const MemberLookupBody = z.strictObject({ no: rawMemberNoField });

export type MemberLookupBody = z.infer<typeof MemberLookupBody>;

/** `GET members/:id/events`: newest first, keyset paged. */
export const MemberEventsQuery = z.strictObject({ ...cursorQuery });

export type MemberEventsQuery = z.infer<typeof MemberEventsQuery>;

/** The member type as a member's views show it. */
export interface MemberTypeRef {
  id: string;
  code: string;
  nameId: string;
  nameEn: string | null;
  /** The type's open-loan limit (null = no limit, 0 = may not borrow). */
  loanLimit: number | null;
}

/** One row of a member search. */
export interface MemberListItem {
  id: string;
  memberNo: string;
  name: string;
  type: MemberTypeRef;
  className: string | null;
  status: MemberStatus;
  expiresOn: string | null;
  photoFileId: string | null;
  // ---- Komunitas (staff screens' data) ----
  /** The member's open loans now, and how many of them are past due (each by its own branch's today). */
  openLoans?: number;
  overdueLoans?: number;
}

/** `POST members/search`. */
export type MemberSearchResponse = Paged<MemberListItem>;

/** `GET members/:id`, `POST members/lookup`: every field of the member (staff only; never on a public page). */
export interface MemberView {
  id: string;
  memberNo: string;
  type: MemberTypeRef;
  homeBranchId: string | null;
  /** What `members.status` stores. */
  storedStatus: MemberStoredStatus;
  /** The status shown (MEMBER_STATUSES), read from the stored one and the dates. */
  status: MemberStatus;
  statusNote: string | null;
  name: string;
  gender: Gender | null;
  birthDate: string | null;
  identityNo: string | null;
  institution: string | null;
  className: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postalCode: string | null;
  mailingAddress: string | null;
  notes: string | null;
  photoFileId: string | null;
  locale: 'id' | 'en';
  joinedOn: string;
  validFrom: string;
  expiresOn: string | null;
  /** The member's open loans now (a count; the loans themselves are `GET circulation/loans?memberId=`). */
  openLoans: number;
  /** How many of those are past due, each by its own branch's today. */
  overdueLoans?: number;
  /** `manual`, `import:<runId>` or `slims:<id>`. */
  source: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  version: number;
  // ---- Komunitas K2 (members extended) ----
  /** The values of the member's custom fields by code (live definitions only). */
  custom?: Record<string, unknown>;
}

/** One entry of a member's history. `meta` holds field names, and for `extended` `{from, to}`: never a personal value. */
export interface MemberEventView {
  id: string;
  at: number;
  type: MemberEventType;
  actorType: string;
  actorId: string | null;
  /** The staff user's display name, when the actor is one. */
  actorName: string | null;
  meta: Record<string, unknown>;
}

/** `GET members/:id/events`. */
export type MemberEventsResponse = Paged<MemberEventView>;

// ---- the CSV member import -------------------------------------------------------------------------------------------

/** The fields an import column can feed, as the `csv-members` header names them, in the template's order. */
export const MEMBER_IMPORT_COLUMNS = Object.freeze([
  'member_no',
  'name',
  'member_type',
  'class_name',
  'identity_no',
  'gender',
  'birth_date',
  'email',
  'phone',
  'address',
  'postal_code',
  'mailing_address',
  'institution',
  'joined_on',
  'expires_on',
  'home_branch',
  'notes',
  'locale',
] as const);

export type MemberImportColumn = (typeof MEMBER_IMPORT_COLUMNS)[number];

/** The fields every import must fill. */
export const MEMBER_IMPORT_REQUIRED_COLUMNS: readonly MemberImportColumn[] = Object.freeze(['member_no', 'name', 'member_type'] as const);

/** The most columns an import mapping may name. */
export const MEMBER_IMPORT_COLUMNS_MAX = 200;

/**
 * The columns of a SLiMS member export, in their fixed order, and the field each feeds by default (null: ignored).
 * The type column holds the type's name; the gender (a number there), the PIN, the photo and the fax are not taken.
 */
export const SLIMS_MEMBER_EXPORT_COLUMNS: readonly (readonly [string, MemberImportColumn | null])[] = Object.freeze([
  ['member_id', 'member_no'],
  ['member_name', 'name'],
  ['gender', null],
  ['member_type_name', 'member_type'],
  ['member_email', 'email'],
  ['member_address', 'address'],
  ['postal_code', 'postal_code'],
  ['inst_name', 'institution'],
  ['is_new', null],
  ['member_image', null],
  ['pin', null],
  ['member_phone', 'phone'],
  ['member_fax', null],
  ['member_since_date', 'joined_on'],
  ['register_date', null],
  ['expire_date', 'expires_on'],
  ['birth_date', 'birth_date'],
  ['member_notes', 'notes'],
] as const);

/**
 * `POST members/imports` → 202 `MemberImportStartResponse`. The file is a completed upload of the staged context
 * `members.import` (`uploadId`; text or CSV, at most 50 MB, at most 50 000 rows). The reader accepts `,` or `;` as the
 * separator and UTF-8 or Windows-1252 (an Excel file saved as CSV in Indonesia), quoted fields with line breaks,
 * and a header row naming the columns in any order:
 *
 *   member_no*, name*, member_type* (a type code), class_name, identity_no, gender (`L`/`P`, `M`/`F`, `male`/`female`,
 *   `laki-laki`/`perempuan`; anything else is left empty with the warning `gender_unknown`), birth_date, email, phone,
 *   address, postal_code, mailing_address, institution, joined_on, expires_on, home_branch (a branch code), notes, locale
 *
 * A row with an unknown member type is refused (`unknown_member_type`), never creates the type; a second row with the
 * same member number is refused (`duplicate_in_file`); `create_only` refuses a number that exists (`exists`), `upsert`
 * updates that member (an empty cell keeps the stored value). `dryRun` (default true) reads and checks everything and
 * writes nothing. A file that cannot be read at all is 422 MEMBER_IMPORT_FORMAT `{reason}`.
 */
export const MemberImportBody = z.strictObject({
  uploadId: ulidField,
  format: z.enum(MEMBER_IMPORT_FORMATS).default('csv-members'),
  mode: z.enum(MEMBER_IMPORT_MODES).default('create_only'),
  dryRun: z.boolean().default(true),
  // ---- Komunitas (staff screens' data) ----
  /**
   * The field each column of the file feeds, by position (null: the column is ignored), in place of the header's
   * names (`csv-members`) or the fixed order (`slims-members`). Each field once (`duplicate`), the required ones
   * present (`required`).
   */
  columns: z
    .array(z.enum(MEMBER_IMPORT_COLUMNS).nullable())
    .min(1)
    .max(MEMBER_IMPORT_COLUMNS_MAX)
    .superRefine((list, ctx) => {
      const named = list.filter((c): c is MemberImportColumn => c !== null);
      if (new Set(named).size !== named.length) ctx.addIssue({ code: 'custom', message: 'duplicate', params: { code: 'duplicate' } });
      if (MEMBER_IMPORT_REQUIRED_COLUMNS.some((c) => !named.includes(c))) ctx.addIssue({ code: 'custom', message: 'required', params: { code: 'required' } });
    })
    .optional(),
});

export type MemberImportBody = z.infer<typeof MemberImportBody>;

/** `POST members/imports`: the import run to follow with `GET members/imports/:id`. */
export interface MemberImportStartResponse {
  id: string;
  status: RunStatus;
}

/** The counts of an import, refused rows per reason. */
export interface MemberImportCounts {
  rows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  refused: number;
  refusedBy: Partial<Record<MemberImportRefusal, number>>;
  warnings: Partial<Record<MemberImportWarning, number>>;
}

/**
 * One of the first 20 rows as the import maps it (dry runs only, read again from the staged file when asked: never
 * stored): its line number, its member number and name, the type code, and why it is refused, if it is.
 */
export interface MemberImportSampleRow {
  line: number;
  memberNo: string;
  name: string;
  memberType: string;
  className: string | null;
  refusal: MemberImportRefusal | null;
  warnings: MemberImportWarning[];
}

/**
 * `GET members/imports/:id` (the run's own creator, or any holder of `members.import.run`). `status` follows the run
 * (`queued` → `running` → `succeeded` | `failed` | `cancelled`); the screen polls until it is terminal. `counts` is null
 * until the run has read the file. `reportAvailable`: the refused rows can be downloaded as CSV
 * (`GET members/imports/:id/report`: line number, member number, reason code; kept 90 days).
 */
export interface MemberImportView {
  id: string;
  status: RunStatus;
  format: MemberImportFormat;
  mode: MemberImportMode;
  dryRun: boolean;
  counts: MemberImportCounts | null;
  sample: MemberImportSampleRow[];
  /** The error code of a failed run (MEMBER_IMPORT_FORMAT, ...). */
  errorCode: string | null;
  reportAvailable: boolean;
  createdAt: number;
  createdBy: string | null;
  finishedAt: number | null;
}

// ---- helpers ---------------------------------------------------------------------------------------------------------

/** The fields of a create shape, each optional: a patch changes only what it sends (written out, so no default is inherited). */
function partialShape<S extends Record<string, z.ZodType>>(shape: S): { [K in keyof S]: z.ZodOptional<S[K]> } {
  const out: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries(shape)) out[key] = schema.optional();
  return out as { [K in keyof S]: z.ZodOptional<S[K]> };
}
