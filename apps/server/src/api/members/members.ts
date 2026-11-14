import { archiveMember, createMember, extendMember, getMember, listMemberEvents, lookupMember, searchMembers, updateMember } from '@altis/core';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import {
  ArchiveBody,
  MemberBody,
  MemberEventsQuery,
  MemberExtendBody,
  MemberLookupBody,
  MemberPatchBody,
  MemberSearchBody,
  type MemberEventsResponse,
  type MemberSearchResponse,
  type MemberView,
} from '@altis/shared/api/members';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// Members (library-wide):
//
//   POST   members/search       members.records.read     MemberSearchBody → MemberSearchResponse     read, tx self
//   POST   members/lookup       members.records.read     MemberLookupBody → MemberView              read, tx self
//   POST   members              members.records.manage   MemberBody → 201 StoreResponse             members.member.create
//   GET    members/:id          members.records.read     → MemberView
//   PATCH  members/:id          members.records.manage   MemberPatchBody → StoreResponse          members.member.update
//   DELETE members/:id          members.records.manage   ArchiveBody → StoreResponse              members.member.archive
//   POST   members/:id/extend   members.records.manage   MemberExtendBody → StoreResponse         members.member.extend
//   GET    members/:id/events   members.records.read     MemberEventsQuery → MemberEventsResponse
//
// Search and lookup are POST reads: a name or a member number never goes in a URL. Suspending and reactivating are a
// PATCH of `status` (audited as an update; the history says `suspended` or `reactivated`). Archive, suspend and every
// status change lock the member's row with their first statement; archiving a member with open loans is 409
// MEMBER_IN_USE `{openLoans, balanceMinor}`.

const API = '/api/v1/members';
const IdParams = z.strictObject({ id: ulidField });

const membersSearch = route({
  id: 'members.search',
  method: 'POST',
  path: `${API}/search`,
  permission: 'members.records.read',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: MemberSearchBody,
  handler: async (rc) => {
    const body: MemberSearchResponse = await searchMembers(rc.db.db, rc.body, rc.now);
    return { body };
  },
});

const membersLookup = route({
  id: 'members.lookup',
  method: 'POST',
  path: `${API}/lookup`,
  permission: 'members.records.read',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: MemberLookupBody,
  handler: async (rc) => {
    const body: MemberView = await lookupMember(rc.db.db, rc.body.no, rc.now);
    return { body };
  },
});

const membersCreate = route({
  id: 'members.create',
  method: 'POST',
  path: API,
  permission: 'members.records.manage',
  idempotency: 'store',
  audit: 'members.member.create',
  body: MemberBody,
  handler: async (rc) => {
    const body: StoreResponse = await createMember(rc.tx(), rc.body);
    return { status: 201, body };
  },
});

const membersGet = route({
  id: 'members.get',
  method: 'GET',
  path: `${API}/:id`,
  permission: 'members.records.read',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => {
    const body: MemberView = await getMember(rc.db.db, rc.params.id, rc.now);
    return { body };
  },
});

const membersUpdate = route({
  id: 'members.update',
  method: 'PATCH',
  path: `${API}/:id`,
  permission: 'members.records.manage',
  idempotency: 'store',
  audit: 'members.member.update',
  params: IdParams,
  body: MemberPatchBody,
  handler: async (rc) => {
    const body: StoreResponse = await updateMember(rc.tx(), rc.params.id, rc.body);
    return { body };
  },
});

const membersArchive = route({
  id: 'members.archive',
  method: 'DELETE',
  path: `${API}/:id`,
  permission: 'members.records.manage',
  idempotency: 'store',
  audit: 'members.member.archive',
  params: IdParams,
  body: ArchiveBody,
  handler: async (rc) => {
    const body: StoreResponse = await archiveMember(rc.tx(), rc.params.id, rc.body.version);
    return { body };
  },
});

const membersExtend = route({
  id: 'members.extend',
  method: 'POST',
  path: `${API}/:id/extend`,
  permission: 'members.records.manage',
  idempotency: 'store',
  audit: 'members.member.extend',
  params: IdParams,
  body: MemberExtendBody,
  handler: async (rc) => {
    const body: StoreResponse = await extendMember(rc.tx(), rc.params.id, rc.body);
    return { body };
  },
});

const membersEvents = route({
  id: 'members.events',
  method: 'GET',
  path: `${API}/:id/events`,
  permission: 'members.records.read',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  query: MemberEventsQuery,
  handler: async (rc) => {
    const body: MemberEventsResponse = await listMemberEvents(rc.db.db, rc.params.id, rc.query);
    return { body };
  },
});

export const MEMBER_ROUTES: RouteDecl[] = [
  membersSearch,
  membersLookup,
  membersCreate,
  membersGet,
  membersUpdate,
  membersArchive,
  membersExtend,
  membersEvents,
];
