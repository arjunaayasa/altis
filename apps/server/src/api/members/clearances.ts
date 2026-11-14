import {
  assertLiveMember,
  buildClearancePdf,
  checkClearances,
  clearanceLetter,
  ensureClearanceLockRow,
  issueClearances,
  libraryToday,
  listClearances,
  readSettings,
  voidClearance,
} from '@altis/core';
import type { Locale } from '@altis/shared';
import {
  ClearanceCheckBody,
  ClearanceIssueBody,
  ClearanceListQuery,
  ClearancePdfQuery,
  ClearanceVoidBody,
  type ClearanceCheckResponse,
  type ClearanceListResponse,
  type ClearancePaper,
} from '@altis/shared/api/circulation';
import { ulidField } from '@altis/shared/api/common';
import type { ClearanceProfile } from '@altis/shared/api/settings';
import { z } from 'zod';
import { route, type RouteContext, type RouteDecl } from '../../http/route.js';

// Numbered clearance letters (`members.records.manage`, library-wide):
//
//   POST members/clearances/check                        ClearanceCheckBody → ClearanceCheckResponse  read, tx self
//   POST members/clearances                              ClearanceIssueBody → application/pdf          members.clearance.issue
//   GET  members/clearances                              ClearanceListQuery → ClearanceListResponse
//   GET  members/:id/clearances/:clearanceId/pdf         ClearancePdfQuery → application/pdf (the same number again)
//   POST members/:id/clearances/:clearanceId/void        ClearanceVoidBody → {id}                       members.clearance.void
//
// Issuing answers the PDF at once (one letter per member who passes, then the members refused) with
// `X-Altis-Clearance-Issued` and `X-Altis-Clearance-Refused`. It is `tx: 'self'`: the lock row of the year is made in a
// short transaction of its own, the numbers in a second one (the lock taken first), and the PDF is built after the
// COMMIT. `idempotency: none`: a repeat issues new numbers for members who pass again, as a second print would; the
// lock keeps the numbers without gaps or repeats either way. The letters are in the library's language
// (`library.locale`); the profile is `members.clearance.profile`. These literal paths come before `members/:id`.

const API = '/api/v1/members';
const LetterParams = z.strictObject({ id: ulidField, clearanceId: ulidField });

/** The library's name, address and language, and the letter profile, as the PDF needs them. */
async function letterSettings(rc: RouteContext<unknown, unknown, unknown>): Promise<{ library: { name: string; address: string | null }; locale: Locale; profile: ClearanceProfile }> {
  const s = await readSettings(rc.db.db, ['library.name', 'library.address', 'library.locale', 'members.clearance.profile'], []);
  return {
    library: { name: s['library.name'] as string, address: s['library.address'] as string | null },
    locale: (s['library.locale'] as string) === 'en' ? 'en' : 'id',
    profile: s['members.clearance.profile'] as ClearanceProfile,
  };
}

/** A PDF response. */
function pdfResponse(pdf: Uint8Array, filename: string, headers: Record<string, string> = {}): Response {
  return new Response(pdf, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Content-Length': String(pdf.byteLength),
      'Cache-Control': 'private, no-store',
      ...headers,
    },
  });
}

const clearancesCheck = route({
  id: 'members.clearances.check',
  method: 'POST',
  path: `${API}/clearances/check`,
  permission: 'members.records.manage',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: ClearanceCheckBody,
  handler: async (rc) => {
    const body: ClearanceCheckResponse = await checkClearances(rc.db.db, rc.body.memberIds);
    return { body };
  },
});

const clearancesIssue = route({
  id: 'members.clearances.issue',
  method: 'POST',
  path: `${API}/clearances`,
  permission: 'members.records.manage',
  idempotency: 'none',
  audit: 'members.clearance.issue',
  tx: 'self',
  body: ClearanceIssueBody,
  handler: async (rc) => {
    const b = rc.body;
    const issuedOn = b.issuedOn ?? (await libraryToday(rc.db.db, rc.now));
    await ensureClearanceLockRow(rc.db, Number(issuedOn.slice(0, 4)));
    const issued = await rc.withTx((tx) => issueClearances(tx, { memberIds: b.memberIds, purpose: b.purpose, issuedOn }));
    const s = await letterSettings(rc);
    const paper: ClearancePaper = b.paper ?? s.profile.paper;
    const pdf = buildClearancePdf({ letters: issued.letters, refused: issued.refused, paper, profile: s.profile, library: s.library, locale: s.locale });
    return pdfResponse(pdf, 'surat-bebas-pustaka.pdf', {
      'X-Altis-Clearance-Issued': String(issued.letters.length),
      'X-Altis-Clearance-Refused': String(issued.refused.length),
    });
  },
});

const clearancesList = route({
  id: 'members.clearances.list',
  method: 'GET',
  path: `${API}/clearances`,
  permission: 'members.records.manage',
  idempotency: 'none',
  audit: null,
  query: ClearanceListQuery,
  handler: async (rc) => {
    const body: ClearanceListResponse = await listClearances(rc.db.db, rc.query);
    return { body };
  },
});

const clearancePdf = route({
  id: 'members.clearances.pdf',
  method: 'GET',
  path: `${API}/:id/clearances/:clearanceId/pdf`,
  permission: 'members.records.manage',
  idempotency: 'none',
  audit: null,
  params: LetterParams,
  query: ClearancePdfQuery,
  handler: async (rc) => {
    await assertLiveMember(rc.db.db, rc.params.id);
    const letter = await clearanceLetter(rc.db.db, rc.params.id, rc.params.clearanceId);
    const s = await letterSettings(rc);
    const pdf = buildClearancePdf({ letters: [letter], refused: [], paper: rc.query.paper ?? s.profile.paper, profile: s.profile, library: s.library, locale: s.locale });
    return pdfResponse(pdf, 'surat-bebas-pustaka.pdf');
  },
});

const clearanceVoid = route({
  id: 'members.clearances.void',
  method: 'POST',
  path: `${API}/:id/clearances/:clearanceId/void`,
  permission: 'members.records.manage',
  idempotency: 'store',
  audit: 'members.clearance.void',
  params: LetterParams,
  body: ClearanceVoidBody,
  handler: async (rc) => {
    const body = await voidClearance(rc.tx(), { memberId: rc.params.id, clearanceId: rc.params.clearanceId, reason: rc.body.reason });
    return { body };
  },
});

export const MEMBER_CLEARANCE_ROUTES: RouteDecl[] = [clearancesCheck, clearancesIssue, clearancesList, clearancePdf, clearanceVoid];
