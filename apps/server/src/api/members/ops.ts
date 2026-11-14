import {
  anonymizeMember,
  buildMemberCardsPdf,
  bulkMembers,
  cardMembers,
  exportMemberData,
  libraryToday,
  localStorageDriver,
  readSettings,
  restoreMember,
  setMemberPhoto,
  storedPicture,
} from '@altis/core';
import { DomainError, isLocale, type Locale } from '@altis/shared';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { ulidField } from '@altis/shared/api/common';
import {
  MEMBER_CARDS_MAX,
  MemberAnonymizeBody,
  MemberBulkBody,
  MemberCardsBody,
  MemberPhotoBody,
  MemberRestoreBody,
  type CardProfile,
  type MemberBulkResponse,
} from '@altis/shared/api/member-ops';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';

// The member tools beyond the record itself (library-wide):
//
//   POST members/bulk                     members.records.manage   MemberBulkBody → MemberBulkResponse       members.member.bulk_update
//   POST members/cards                    members.records.read     MemberCardsBody → application/pdf          members.card.print   read, tx self
//   POST members/:id/restore              members.records.manage   MemberRestoreBody → StoreResponse          members.member.restore
//   PUT  members/:id/photo                members.records.manage   MemberPhotoBody → StoreResponse            members.member.photo_set
//   POST members/:id/privacy/export       members.privacy.manage   (no body) → application/json download      members.privacy.export     reauth, system
//   POST members/:id/privacy/anonymize    members.privacy.manage   MemberAnonymizeBody → StoreResponse        members.privacy.anonymize  reauth, system
//
// A replaced or removed photo, and an anonymised member's photo, lose their `files` row in the transaction and their
// stored content after the COMMIT. A card sheet is a read (only its audit entry is written), at most 200 members; the
// admin splits a longer queue. The personal-data export and the anonymisation need a fresh password confirmation and
// are `system` routes: an edition never locks them.

const API = '/api/v1/members';
const IdParams = z.strictObject({ id: ulidField });

/** Removes stored file contents after the commit; a failure is logged (the row is gone, the sweep may retry). */
function deleteAfterCommit(rc: RouteContext<unknown, unknown, unknown>, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const driver = localStorageDriver(rc.services.dataDir);
  rc.afterCommit(async () => {
    for (const id of ids) {
      try {
        await driver.delete(id);
      } catch (error) {
        rc.log.warn('members: a removed photo could not be deleted from storage', { fileId: id, err: String(error) });
      }
    }
  });
}

const membersBulk = route({
  id: 'members.bulk',
  method: 'POST',
  path: `${API}/bulk`,
  permission: 'members.records.manage',
  idempotency: 'store',
  audit: 'members.member.bulk_update',
  body: MemberBulkBody,
  handler: async (rc) => {
    const body: MemberBulkResponse = await bulkMembers(rc.tx(), rc.body);
    return { body };
  },
});

const membersCards = route({
  id: 'members.cards',
  method: 'POST',
  path: `${API}/cards`,
  permission: 'members.records.read',
  mode: 'read',
  idempotency: 'none',
  audit: 'members.card.print',
  tx: 'self',
  body: MemberCardsBody,
  handler: async (rc) => {
    if (rc.body.memberIds.length > MEMBER_CARDS_MAX) {
      throw new DomainError('MEMBER_CARD_LIMIT', { detail: `Paling banyak ${MEMBER_CARDS_MAX} kartu / At most ${MEMBER_CARDS_MAX} cards`, meta: { max: MEMBER_CARDS_MAX } });
    }
    const db = rc.db.db;
    const settings = await readSettings(db, ['members.card.profile', 'library.name', 'library.locale'], rc.config.keyring);
    const rawLocale = String(settings['library.locale']);
    const locale: Locale = isLocale(rawLocale) ? rawLocale : 'id';
    const members = await cardMembers(db, rc.body.memberIds, locale);
    const pdf = await buildMemberCardsPdf({
      profile: settings['members.card.profile'] as CardProfile,
      members,
      startAt: rc.body.startAt,
      locale,
      libraryName: settings['library.name'] as string,
      today: await libraryToday(db, rc.now),
      picture: storedPicture(localStorageDriver(rc.services.dataDir)),
    });
    await rc.audit({ entity: 'members', entityId: null, meta: { count: members.length } });
    return new Response(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="kartu-anggota.pdf"',
        'Content-Length': String(pdf.byteLength),
        'Cache-Control': 'private, no-store',
      },
    });
  },
});

const membersRestore = route({
  id: 'members.restore',
  method: 'POST',
  path: `${API}/:id/restore`,
  permission: 'members.records.manage',
  idempotency: 'store',
  audit: 'members.member.restore',
  params: IdParams,
  body: MemberRestoreBody,
  handler: async (rc) => {
    const body: StoreResponse = await restoreMember(rc.tx(), rc.params.id, rc.body.version);
    return { body };
  },
});

const membersPhoto = route({
  id: 'members.photo',
  method: 'PUT',
  path: `${API}/:id/photo`,
  permission: 'members.records.manage',
  idempotency: 'store',
  audit: 'members.member.photo_set',
  params: IdParams,
  body: MemberPhotoBody,
  handler: async (rc) => {
    const r = await setMemberPhoto(rc.tx(), rc.params.id, rc.body.fileId, rc.body.version);
    deleteAfterCommit(rc as RouteContext<unknown, unknown, unknown>, r.deleteFiles);
    const body: StoreResponse = { id: r.id, version: r.version };
    return { body };
  },
});

const membersPrivacyExport = route({
  id: 'members.privacy.export',
  method: 'POST',
  path: `${API}/:id/privacy/export`,
  permission: 'members.privacy.manage',
  reauth: true,
  mode: 'system',
  idempotency: 'none',
  audit: 'members.privacy.export',
  tx: 'self',
  params: IdParams,
  handler: async (rc) => {
    const doc = await rc.withTx(async (tx) => {
      const data = await exportMemberData(tx.trx, rc.params.id, rc.now);
      await tx.audit({ action: 'members.privacy.export', entity: 'members', entityId: rc.params.id, meta: { sections: Object.keys(data.sections).sort() } });
      return data;
    });
    const text = JSON.stringify(doc, null, 2);
    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="data-anggota-${rc.params.id}.json"`,
        'Cache-Control': 'private, no-store',
      },
    });
  },
});

const membersAnonymize = route({
  id: 'members.privacy.anonymize',
  method: 'POST',
  path: `${API}/:id/privacy/anonymize`,
  permission: 'members.privacy.manage',
  reauth: true,
  mode: 'system',
  idempotency: 'store',
  audit: 'members.privacy.anonymize',
  params: IdParams,
  body: MemberAnonymizeBody,
  handler: async (rc) => {
    const r = await anonymizeMember(rc.tx(), rc.params.id, { version: rc.body.version, confirmMemberNo: rc.body.confirmMemberNo });
    deleteAfterCommit(rc as RouteContext<unknown, unknown, unknown>, r.deleteFiles);
    const body: StoreResponse = { id: r.id, version: r.version };
    return { body };
  },
});

/** Before `members/:id` (literal paths first). */
export const MEMBER_OPS_ROUTES: RouteDecl[] = [membersBulk, membersCards];

/** After the member routes (paths under `members/:id/`). */
export const MEMBER_OPS_ID_ROUTES: RouteDecl[] = [membersRestore, membersPhoto, membersPrivacyExport, membersAnonymize];
