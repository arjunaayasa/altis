import { archivePeriod, createPeriod, getPeriod, listInstruments, listPeriods, loadAccredSettings, putAnswer, updatePeriod, type AccredSettings } from '@altis/core';
import { AnswerPutBody, PeriodCreateBody, PeriodPatchBody } from '@altis/shared/api/accreditation';
import { ulidField } from '@altis/shared/api/common';
import { z } from 'zod';
import type { RouteDecl } from '../../http/route.js';
import { route } from '../../http/route.js';

// The routes of the instruments, the accreditation periods and the answers (spec §5.2, §10.5, §10.6, §10.10):
// `GET accreditation/instruments`, `GET accreditation/periods[/:id]`, `POST accreditation/periods`, `PATCH|DELETE
// accreditation/periods/:id` and `PUT accreditation/periods/:id/answers/:code`. Reading needs
// `accreditation.workspace.read`, writing `accreditation.workspace.manage`; accreditation is library-wide in this
// edition, so no route has a branch.
//
// - The instruments come with the accreditation settings the workspace needs (its users need no settings permission).
// - The writes are `store` routes that answer `{id, version}`; a create answers 201. The services audit once in the
//   handler's transaction.
// - Every write of a period's data takes the period lock as the first statement of its transaction (a frozen period
//   answers 409 ACCRED_PERIOD_FROZEN): the settings a create or an update needs are read in `prepare`, outside the
//   transaction, so that nothing is read in it before the lock.

const API = '/api/v1/accreditation';
const PERIODS = `${API}/periods`;
const IdParams = z.strictObject({ id: ulidField });
/** The answer's indicator: any text here; the service refuses a code that is not one of the instrument's. */
const AnswerParams = z.strictObject({ id: ulidField, code: z.string().min(1).max(64) });

/** The accreditation settings, read outside the handler's transaction. */
const settingsOf = (rc: { db: { db: Parameters<typeof loadAccredSettings>[0] } }): Promise<AccredSettings> => loadAccredSettings(rc.db.db);

const instrumentsList = route({
  id: 'accreditation.instruments.list',
  method: 'GET',
  path: `${API}/instruments`,
  permission: 'accreditation.workspace.read',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => ({ body: listInstruments(rc.db.db, await settingsOf(rc)) }),
});

const periodsList = route({
  id: 'accreditation.periods.list',
  method: 'GET',
  path: PERIODS,
  permission: 'accreditation.workspace.read',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => ({ body: await listPeriods(rc.db.db) }),
});

const periodsGet = route({
  id: 'accreditation.periods.get',
  method: 'GET',
  path: `${PERIODS}/:id`,
  permission: 'accreditation.workspace.read',
  idempotency: 'none',
  audit: null,
  params: IdParams,
  handler: async (rc) => ({ body: await getPeriod(rc.db.db, rc.params.id, rc.now) }),
});

const periodsCreate = route({
  id: 'accreditation.periods.create',
  method: 'POST',
  path: PERIODS,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.period.create',
  body: PeriodCreateBody,
  prepare: settingsOf,
  handler: async (rc) => ({ status: 201, body: await createPeriod(rc.tx(), rc.body, rc.prepared as AccredSettings, rc.now) }),
});

const periodsUpdate = route({
  id: 'accreditation.periods.update',
  method: 'PATCH',
  path: `${PERIODS}/:id`,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.period.update',
  params: IdParams,
  body: PeriodPatchBody,
  prepare: settingsOf,
  handler: async (rc) => ({ body: await updatePeriod(rc.tx(), rc.params.id, rc.body, rc.prepared as AccredSettings, rc.now) }),
});

const periodsArchive = route({
  id: 'accreditation.periods.archive',
  method: 'DELETE',
  path: `${PERIODS}/:id`,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.period.archive',
  params: IdParams,
  handler: async (rc) => ({ body: await archivePeriod(rc.tx(), rc.params.id, rc.now) }),
});

const answersPut = route({
  id: 'accreditation.answers.put',
  method: 'PUT',
  path: `${PERIODS}/:id/answers/:code`,
  permission: 'accreditation.workspace.manage',
  idempotency: 'store',
  audit: 'accreditation.answer.update',
  params: AnswerParams,
  body: AnswerPutBody,
  handler: async (rc) => ({ body: await putAnswer(rc.tx(), rc.params.id, rc.params.code, rc.body, rc.now) }),
});

export const PERIOD_ROUTES: RouteDecl[] = [instrumentsList, periodsList, periodsGet, periodsCreate, periodsUpdate, periodsArchive, answersPut];
