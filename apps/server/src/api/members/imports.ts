import { MemberImportBody } from '@altis/shared/api/members';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';
import { notImplemented } from '../not-implemented.js';

// The CSV member import (a run of `catalog_runs` with kind `member_import`; the file is a completed upload of the staged
// context `members.import`):
//
//   POST members/imports              members.import.run   MemberImportBody → 202 MemberImportStartResponse   members.import.start
//   GET  members/imports/:id          members.import.run   → MemberImportView
//   GET  members/imports/:id/report   members.import.run   → text/csv (line, member number, reason code)    mode system
//
// The import writes `members.import.finish` when it ends: in its job, or in this request when it runs here
// (`alsoAudits`). Declared before `members/:id`. The report is a download, so the edition never locks it (`system`).

const API = '/api/v1/members/imports';
const IdParams = z.strictObject({ id: ulidField });

const importsCreate = route({
  id: 'members.imports.create',
  method: 'POST',
  path: API,
  permission: 'members.import.run',
  idempotency: 'store',
  audit: 'members.import.start',
  alsoAudits: ['members.import.finish'],
  body: MemberImportBody,
  handler: notImplemented,
});

const importsGet = route({
  id: 'members.imports.get',
  method: 'GET',
  path: `${API}/:id`,
  permission: 'members.import.run',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: notImplemented,
});

const importsReport = route({
  id: 'members.imports.report',
  method: 'GET',
  path: `${API}/:id/report`,
  permission: 'members.import.run',
  mode: 'system',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: notImplemented,
});

export const MEMBER_IMPORT_ROUTES: RouteDecl[] = [importsCreate, importsGet, importsReport];
