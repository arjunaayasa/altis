import { archiveMemberType, createMemberType, listMemberTypes, updateMemberType } from '@altis/core';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { ArchiveBody, MemberTypeBody, MemberTypeListQuery, MemberTypePatchBody, type MemberTypeListResponse } from '@altis/shared/api/members';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// Member types (library-wide):
//
//   GET    members/types       members.records.read    MemberTypeListQuery → MemberTypeListResponse
//   POST   members/types       members.types.manage    MemberTypeBody → 201 StoreResponse        members.type.create
//   PATCH  members/types/:id   members.types.manage    MemberTypePatchBody → StoreResponse      members.type.update
//   DELETE members/types/:id   members.types.manage    ArchiveBody → StoreResponse              members.type.archive
//
// Declared before `members/:id` (the literal `types` must not reach the member routes). A taken code is the field error
// `{path: 'code', code: 'taken'}`; archiving a type live members have is 409 MEMBER_TYPE_IN_USE `{count}`.

const API = '/api/v1/members/types';
const IdParams = z.strictObject({ id: ulidField });

const typesList = route({
  id: 'members.types.list',
  method: 'GET',
  path: API,
  permission: 'members.records.read',
  idempotency: 'none',
  audit: null,
  query: MemberTypeListQuery,
  handler: async (rc) => {
    const body: MemberTypeListResponse = { items: await listMemberTypes(rc.db.db, rc.query) };
    return { body };
  },
});

const typesCreate = route({
  id: 'members.types.create',
  method: 'POST',
  path: API,
  permission: 'members.types.manage',
  idempotency: 'store',
  audit: 'members.type.create',
  body: MemberTypeBody,
  handler: async (rc) => {
    const body: StoreResponse = await createMemberType(rc.tx(), rc.body);
    return { status: 201, body };
  },
});

const typesUpdate = route({
  id: 'members.types.update',
  method: 'PATCH',
  path: `${API}/:id`,
  permission: 'members.types.manage',
  idempotency: 'store',
  audit: 'members.type.update',
  params: IdParams,
  body: MemberTypePatchBody,
  handler: async (rc) => {
    const body: StoreResponse = await updateMemberType(rc.tx(), rc.params.id, rc.body);
    return { body };
  },
});

const typesArchive = route({
  id: 'members.types.archive',
  method: 'DELETE',
  path: `${API}/:id`,
  permission: 'members.types.manage',
  idempotency: 'store',
  audit: 'members.type.archive',
  params: IdParams,
  body: ArchiveBody,
  handler: async (rc) => {
    const body: StoreResponse = await archiveMemberType(rc.tx(), rc.params.id, rc.body.version);
    return { body };
  },
});

export const MEMBER_TYPE_ROUTES: RouteDecl[] = [typesList, typesCreate, typesUpdate, typesArchive];
