import {
  ArchiveBody,
  MemberBody,
  MemberEventsQuery,
  MemberExtendBody,
  MemberLookupBody,
  MemberPatchBody,
  MemberSearchBody,
} from '@altis/shared/api/members';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';
import { notImplemented } from '../not-implemented.js';

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
  handler: notImplemented,
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
  handler: notImplemented,
});

const membersCreate = route({
  id: 'members.create',
  method: 'POST',
  path: API,
  permission: 'members.records.manage',
  idempotency: 'store',
  audit: 'members.member.create',
  body: MemberBody,
  handler: notImplemented,
});

const membersGet = route({
  id: 'members.get',
  method: 'GET',
  path: `${API}/:id`,
  permission: 'members.records.read',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: notImplemented,
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
  handler: notImplemented,
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
  handler: notImplemented,
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
  handler: notImplemented,
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
  handler: notImplemented,
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
