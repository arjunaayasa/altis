import type { AreaAuditScript } from './catalog.js';

// The audit script of members, member types and the CSV member import. Not written yet: the routes' handlers come
// first. Its actions are listed as pending while MEMBERS_CIRCULATION_PENDING_ALLOWED (audit/members-circulation.ts).

export const AUDIT: AreaAuditScript = {
  actions: [
    'members.member.create',
    'members.member.update',
    'members.member.archive',
    'members.member.extend',
    'members.type.create',
    'members.type.update',
    'members.type.archive',
    'members.import.start',
    'members.import.finish',
  ],
  run: null,
};
