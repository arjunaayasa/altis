import type { AreaAuditScript } from './catalog.js';
import { AUDIT as CHARGES } from './komunitas-charges.js';
import { AUDIT as CIRC_CORE } from './komunitas-circ-core.js';
import { AUDIT as CIRCULATION } from './komunitas-circulation.js';
import { AUDIT as HOLDS } from './komunitas-holds.js';
import { AUDIT as MEMBERS } from './komunitas-members.js';
// ---- Komunitas (member area) ----
import { AUDIT as MEMBER_AREA } from './komunitas-member-area.js';
// ---- Komunitas (notices) ----
import { AUDIT as NOTICES } from './komunitas-notices.js';
// ---- Komunitas (SLiMS members and circulation) ----
import { AUDIT as SLIMS_PEOPLE } from './komunitas-slims-people.js';
// ---- Komunitas K4 (stocktake) ----
import { AUDIT as STOCKTAKE } from './komunitas-stocktake.js';
// ---- Komunitas (OPAC home page) ----
import { AUDIT as OPAC_HOME } from './komunitas-opac-home.js';
import { AUDIT as SITE_IDENTITY } from './site-identity.js';

// The audit scripts of the members and circulation actions: one script per area, each in a file of its own that only
// its owning change fills. db/audit-coverage.test.ts runs them after the community's, on the same installation and in
// this order, with the same checks. A script left `null` lists its actions as pending (`it.todo`) while
// MEMBERS_CIRCULATION_PENDING_ALLOWED; the last change of the milestone sets it to false, and every action must then be
// covered.

/** Every members and circulation area's script, in the order audit-coverage.test.ts runs them. */
export const MEMBERS_CIRCULATION_AUDIT_SCRIPTS: Readonly<Record<string, AreaAuditScript>> = Object.freeze({
  members: MEMBERS,
  circulation: CIRCULATION,
  // ---- Komunitas (holds) ----
  holds: HOLDS,
  // ---- Komunitas (circulation core) ----
  'circ-core': CIRC_CORE,
  // ---- Komunitas (member area) ----
  'member-area': MEMBER_AREA,
  // ---- Komunitas (charges and payments) ----
  charges: CHARGES,
  // ---- Komunitas (notices) ----
  notices: NOTICES,
  // ---- Komunitas (SLiMS members and circulation): the cut-over checklist ----
  'slims-people': SLIMS_PEOPLE,
  // ---- Komunitas K4 (stocktake) ----
  stocktake: STOCKTAKE,
  // ---- Komunitas (OPAC home page) ----
  'opac-home': OPAC_HOME,
  // ---- Site identity ----
  'site-identity': SITE_IDENTITY,
});

/** While true, a script that is still null lists its actions as pending; both scripts are written, so every action is covered. */
export const MEMBERS_CIRCULATION_PENDING_ALLOWED: boolean = false;
