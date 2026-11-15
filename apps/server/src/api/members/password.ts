import { checkMemberPasswordPolicy, setMemberPassword } from '@altis/core';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { ulidField } from '@altis/shared/api/common';
import { MemberPasswordBody } from '@altis/shared/api/member-area';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// Komunitas (member area): staff set or remove a member's OPAC password.
//
//   PUT members/:id/password   members.records.manage, reauth   MemberPasswordBody → StoreResponse   members.member.password_set
//
// The policy is checked and the password hashed outside any transaction (`tx: 'self'`); the transaction locks the
// member's row first, writes the hash (or null) with `must_reset_password`, ends every session and reset token of the
// member, and audits. The body holds a password: no idempotency store.

const IdParams = z.strictObject({ id: ulidField });

const memberPasswordSet = route({
  id: 'members.password.set',
  method: 'PUT',
  path: '/api/v1/members/:id/password',
  permission: 'members.records.manage',
  reauth: true,
  idempotency: 'none',
  audit: 'members.member.password_set',
  tx: 'self',
  params: IdParams,
  body: MemberPasswordBody,
  handler: async (rc) => {
    let hash: string | null = null;
    if (rc.body.password !== null) {
      checkMemberPasswordPolicy(rc.body.password, await rc.services.settings.get<number>(rc.db.db, 'members.password.minLength'));
      hash = await rc.services.hasher.hash(rc.body.password);
    }
    const body: StoreResponse = await rc.withTx((tx) => setMemberPassword(tx, rc.params.id, { passwordHash: hash, mustReset: rc.body.mustReset }));
    return { body };
  },
});

export const MEMBER_PASSWORD_ROUTES: RouteDecl[] = [memberPasswordSet];
