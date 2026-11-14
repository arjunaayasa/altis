import { archiveCalendarRule, createCalendarRule, listCalendar, updateCalendarRule } from '@altis/core';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { CalendarBody, CalendarPatchBody, CalendarQuery, type CalendarResponse } from '@altis/shared/api/circulation';
import { ulidField } from '@altis/shared/api/common';
import { ArchiveBody } from '@altis/shared/api/members';
import { z } from 'zod';
import { route, type RouteDecl } from '../../http/route.js';

// The library calendar (closed days; library-wide in this edition):
//
//   GET    circulation/calendar       CalendarQuery → CalendarResponse   desk at any branch, or the rules permission
//   POST   circulation/calendar       CalendarBody → 201 StoreResponse        circulation.calendar.create
//   PATCH  circulation/calendar/:id   CalendarPatchBody → StoreResponse      circulation.calendar.update
//   DELETE circulation/calendar/:id   ArchiveBody → StoreResponse            circulation.calendar.archive
//
// Reading it is open to the desk (it shows why a due date moved) and to whoever manages the rules: the route asks for a
// session and decides in its handler, since a declaration names one permission. Writing it is the rules permission.

const API = '/api/v1/circulation/calendar';
const IdParams = z.strictObject({ id: ulidField });

const calendarGet = route({
  id: 'circulation.calendar.get',
  method: 'GET',
  path: API,
  public: true,
  session: 'required',
  idempotency: 'none',
  audit: null,
  query: CalendarQuery,
  handler: async (rc) => {
    const grants = rc.auth?.grants;
    const allowed =
      grants !== undefined &&
      (grants.superAdmin ||
        grants.global.has('circulation.policies.manage') ||
        grants.global.has('circulation.desk.use') ||
        [...grants.branches.values()].some((held) => held.has('circulation.desk.use')));
    if (!allowed) throw await rc.authzDenied('circulation.policies.manage');
    const body: CalendarResponse = await listCalendar(rc.db.db, rc.query);
    return { body };
  },
});

const calendarCreate = route({
  id: 'circulation.calendar.create',
  method: 'POST',
  path: API,
  permission: 'circulation.policies.manage',
  idempotency: 'store',
  audit: 'circulation.calendar.create',
  body: CalendarBody,
  handler: async (rc) => {
    const body: StoreResponse = await createCalendarRule(rc.tx(), rc.body);
    return { status: 201, body };
  },
});

const calendarUpdate = route({
  id: 'circulation.calendar.update',
  method: 'PATCH',
  path: `${API}/:id`,
  permission: 'circulation.policies.manage',
  idempotency: 'store',
  audit: 'circulation.calendar.update',
  params: IdParams,
  body: CalendarPatchBody,
  handler: async (rc) => {
    const body: StoreResponse = await updateCalendarRule(rc.tx(), rc.params.id, rc.body);
    return { body };
  },
});

const calendarArchive = route({
  id: 'circulation.calendar.archive',
  method: 'DELETE',
  path: `${API}/:id`,
  permission: 'circulation.policies.manage',
  idempotency: 'store',
  audit: 'circulation.calendar.archive',
  params: IdParams,
  body: ArchiveBody,
  handler: async (rc) => {
    const body: StoreResponse = await archiveCalendarRule(rc.tx(), rc.params.id, rc.body.version);
    return { body };
  },
});

export const CALENDAR_ROUTES: RouteDecl[] = [calendarGet, calendarCreate, calendarUpdate, calendarArchive];
