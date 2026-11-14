/**
 * The members API beyond the member record itself: restoring an archived member, the bulk actions of the member list,
 * the photo, the card sheet and its profile, and the personal-data actions (a member's own data exported by staff, and
 * anonymisation).
 *
 * - Bulk actions take at most 500 member ids (the class promotion takes at most 100 class pairs instead) and answer
 *   per member what was refused, with a reason code (MEMBER_BULK_REFUSALS); the rest is done. One audit entry
 *   `members.member.bulk_update` with the count.
 * - The photo is an upload of the context `members.photo` (a JPEG the admin cropped in the browser to 300 × 400, at
 *   most 500 KB). Replacing or removing it deletes the old file.
 * - A card sheet is a PDF of at most 200 members; the barcode and the QR code hold the member number only.
 * - Exporting a member's data and anonymising a member need a fresh password confirmation; anonymising also needs the
 *   member number typed again, and cannot be undone.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/member-ops`.
 */
import { z } from 'zod';
import { MEMBER_STORED_STATUSES } from '../circulation-vocab.js';
import { CARD_FIELDS, CARD_SHEETS, MEMBER_BULK_ACTIONS, type MemberBulkAction, type MemberBulkRefusal } from '../visits-vocab.js';
import { ulidField, versionField } from './common.js';
import { dateField, shortText } from './catalog/common.js';
import { rawMemberNoField } from './members.js';

// ---- bulk actions ----------------------------------------------------------------------------------------------------

/** The most members of one bulk action, and of one card sheet request. */
export const MEMBER_BULK_MAX = 500;
/** The most class pairs of one class promotion. */
export const MEMBER_CLASS_MAP_MAX = 100;
/** The most members one class promotion may move. */
export const MEMBER_CLASS_MOVE_MAX = 5000;

const memberIds = z.array(ulidField).min(1).max(MEMBER_BULK_MAX);

/**
 * `POST members/bulk` → `MemberBulkResponse`:
 *
 * - `set`: the fields it sends, for every member (`memberTypeId` a live type, `homeBranchId` a live branch or null,
 *   `className` or null, `status` with `statusNote` for a suspension); a change of type never changes the dates;
 * - `promote`: every live member whose class is a pair's `from` gets its `to` (null: no class), all pairs read before
 *   any is applied, so `VII-A → VIII-A` and `VIII-A → IX-A` in one request move each class one step;
 * - `extend`: as `POST members/:id/extend` for each member (`from` `today`, `expiry` or a date; `days` default the
 *   type's membership days);
 * - `archive` / `restore`: as the single actions (an archive is refused per member with open loans).
 */
export const MemberBulkBody = z
  .strictObject({
    action: z.enum(MEMBER_BULK_ACTIONS),
    ids: memberIds.optional(),
    set: z
      .strictObject({
        memberTypeId: ulidField.optional(),
        className: shortText(64).nullable().optional(),
        homeBranchId: ulidField.nullable().optional(),
        status: z.enum(MEMBER_STORED_STATUSES).optional(),
        statusNote: shortText(191).min(1).nullable().optional(),
      })
      .optional(),
    classMap: z
      .array(z.strictObject({ from: shortText(64).min(1), to: shortText(64).nullable() }))
      .min(1)
      .max(MEMBER_CLASS_MAP_MAX)
      .optional(),
    from: z.union([z.literal('today'), z.literal('expiry'), dateField]).optional(),
    days: z.int().min(0).max(32_767).optional(),
  })
  .check((ctx) => {
    const b = ctx.value;
    // What each action needs (`required`) and takes (anything else is `not_allowed`).
    const needs: Record<MemberBulkAction, readonly string[]> = {
      set: ['ids', 'set'],
      promote: ['classMap'],
      extend: ['ids', 'from'],
      archive: ['ids'],
      restore: ['ids'],
    };
    const takes: Record<MemberBulkAction, readonly string[]> = { ...needs, extend: ['ids', 'from', 'days'] };
    for (const key of needs[b.action]) {
      if (b[key as keyof typeof b] === undefined) ctx.issues.push({ code: 'custom', path: [key], params: { code: 'required' }, message: 'required', input: b });
    }
    for (const key of ['ids', 'set', 'classMap', 'from', 'days'] as const) {
      if (b[key] !== undefined && !takes[b.action].includes(key)) {
        ctx.issues.push({ code: 'custom', path: [key], params: { code: 'not_allowed' }, message: 'not_allowed', input: b });
      }
    }
  });

export type MemberBulkBody = z.infer<typeof MemberBulkBody>;

/** One member a bulk action left as it was. */
export interface MemberBulkRefused {
  id: string;
  reason: MemberBulkRefusal;
}

/** `POST members/bulk`: how many members changed, and who was refused (at most 500 entries). */
export interface MemberBulkResponse {
  done: number;
  refused: MemberBulkRefused[];
}

// ---- restore, photo --------------------------------------------------------------------------------------------------

/** `POST members/:id/restore` → `StoreResponse`: the version the screen showed. A member never archived is 404. */
export const MemberRestoreBody = z.strictObject({ version: versionField });

export type MemberRestoreBody = z.infer<typeof MemberRestoreBody>;

/**
 * `PUT members/:id/photo` → `StoreResponse`: `fileId` a completed upload of the context `members.photo` that no one
 * else owns (`{path: 'fileId', code: 'not_found' | 'invalid'}` otherwise), or null to remove the photo.
 */
export const MemberPhotoBody = z.strictObject({ version: versionField, fileId: ulidField.nullable() });

export type MemberPhotoBody = z.infer<typeof MemberPhotoBody>;

/** The photo's pixel size the admin crops to, and its largest file size. */
export const MEMBER_PHOTO_WIDTH = 300;
export const MEMBER_PHOTO_HEIGHT = 400;
export const MEMBER_PHOTO_MAX_BYTES = 500 * 1024;

// ---- cards -----------------------------------------------------------------------------------------------------------

/** The most members of one card PDF. */
export const MEMBER_CARDS_MAX = 200;

/** A colour as `#rrggbb`. */
export const hexColorField = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * `members.card.profile`: how cards are printed. The barcode and the QR code hold the member number only; pictures
 * (photo, logo, signature, stamp) are JPEG files (`members.card_asset` for the logo, signature and stamp).
 */
export const CardProfile = z.strictObject({
  sheet: z.enum(CARD_SHEETS),
  front: z.strictObject({
    title: z.string().max(60),
    subtitle: z.string().max(80),
    showPhoto: z.boolean(),
    fields: z.array(z.enum(CARD_FIELDS)).max(CARD_FIELDS.length),
    bandColor: hexColorField,
    textColor: hexColorField,
  }),
  back: z.strictObject({
    enabled: z.boolean(),
    rulesText: z.string().max(1000),
    city: z.string().max(60),
    signerTitle: z.string().max(60),
    signerName: z.string().max(80),
    signatureFileId: ulidField.nullable(),
    stampFileId: ulidField.nullable(),
  }),
  logoFileId: ulidField.nullable(),
  symbology: z.enum(['code128', 'code39']),
  qr: z.boolean(),
});

export type CardProfile = z.infer<typeof CardProfile>;

/** The profile an install starts with. */
export const DEFAULT_CARD_PROFILE: CardProfile = Object.freeze({
  sheet: 'A4',
  front: Object.freeze({
    title: 'KARTU ANGGOTA PERPUSTAKAAN',
    subtitle: '',
    showPhoto: true,
    fields: ['memberNo', 'name', 'type', 'className', 'expiresOn'],
    bandColor: '#1f4e79',
    textColor: '#ffffff',
  }),
  back: Object.freeze({
    enabled: false,
    rulesText: '',
    city: '',
    signerTitle: 'Kepala Perpustakaan',
    signerName: '',
    signatureFileId: null,
    stampFileId: null,
  }),
  logoFileId: null,
  symbology: 'code128',
  qr: true,
}) as CardProfile;

/**
 * `POST members/cards` (a read: nothing changes but the audit entry) → `application/pdf`. Ten ID-1 cards (85.6 ×
 * 54 mm) per page, 2 × 5, starting at position `startAt` (1-10) of the first sheet; with the profile's back enabled,
 * every page of fronts is followed by its backs, mirrored per row for duplex printing. More than 200 members is 422
 * MEMBER_CARD_LIMIT `{max}`; the admin splits a longer queue into several PDFs.
 */
export const MemberCardsBody = z.strictObject({
  memberIds: z.array(ulidField).min(1).max(MEMBER_BULK_MAX),
  startAt: z.int().min(1).max(10).default(1),
});

export type MemberCardsBody = z.infer<typeof MemberCardsBody>;

// ---- personal data ---------------------------------------------------------------------------------------------------

/**
 * `POST members/:id/privacy/anonymize` → `StoreResponse`. Needs a fresh password confirmation and the member number
 * typed again (`{path: 'confirmMemberNo', code: 'mismatch'}` otherwise). Refused while the member has open loans or a
 * balance (409 MEMBER_IN_USE). Cannot be undone.
 */
export const MemberAnonymizeBody = z.strictObject({ version: versionField, confirmMemberNo: rawMemberNoField });

export type MemberAnonymizeBody = z.infer<typeof MemberAnonymizeBody>;

/**
 * `POST members/:id/privacy/export` → a JSON download of everything stored about the member: the profile (every
 * personal field and the custom fields), the history, the loans, the visits and whatever later modules add (holds,
 * fines and payments, bookmarks). The photo is a separate download (`GET files/:id` for staff).
 */
export interface MemberDataExport {
  format: 'altis-member-data';
  version: 1;
  exportedAt: number;
  member: Record<string, unknown>;
  custom: Record<string, unknown>;
  photoFileId: string | null;
  sections: Record<string, unknown[]>;
}
