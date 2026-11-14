import { upsert } from '@altis/db';
import { AnswerPutBody } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { TxCtx } from '../../context.js';
import { instrumentById } from '../instruments/index.js';
import { periodFieldErrors, periodNotFound, parsePeriodBody } from './errors.js';
import { catalogueCodes } from './instruments-view.js';
import { lockOpenPeriod } from './lock.js';

// The answers of a period's indicators (spec §10.3, §10.6): a `manual` answer where ALTIS suggests none (or where the
// librarian answers an indicator ALTIS computes without overriding it: stored as given), an `override` of ALTIS's
// suggestion with its note. The final answer of an indicator is its stored answer, else the suggestion. An answer is
// part of the period's data, so its write takes the period lock first and a frozen period refuses it. It does not
// touch the period row: answers are read directly where they count, never through the period's last change.

/**
 * Stores, replaces or removes the answer of indicator `code` (a catalogue code of the period's instrument, `SCH-K1`):
 * `answer: null` with `mode: 'manual'` removes it. Audited `accreditation.answer.update` with `{code, mode, answer,
 * hasNote}` (never the note). Answers `{id: periodId, version}` with the period's version, which an answer leaves as
 * it is.
 *
 * @throws DomainError `NOT_FOUND`, `ACCRED_PERIOD_FROZEN` (from the lock); `VALIDATION_FAILED` `{path: 'note', code:
 *   'required'}` for an override without a note, `{path: 'answer', code: 'required'}` for an override without an
 *   answer, `{path: 'code', code: 'invalid'}` for a code that is not one of the instrument's indicators
 */
export async function putAnswer(tx: TxCtx, periodId: string, code: string, body: AnswerPutBody, now: number): Promise<StoreResponse> {
  const input = parsePeriodBody(AnswerPutBody, body);
  if (input.answer === null && input.mode === 'override') throw periodFieldErrors([{ path: 'answer', code: 'required' }]);
  const { trx } = tx;
  await lockOpenPeriod(trx, periodId);
  const period = await trx.selectFrom('accred_periods').select(['instrument_id', 'version']).where('id', '=', periodId).executeTakeFirst();
  if (period === undefined) throw periodNotFound();
  const instrument = instrumentById(period.instrument_id);
  if (instrument === null || !catalogueCodes(instrument).includes(code)) throw periodFieldErrors([{ path: 'code', code: 'invalid' }]);

  const note = input.note === null || input.note.trim() === '' ? null : input.note;
  if (input.answer === null) {
    await trx.deleteFrom('accred_answers').where('period_id', '=', periodId).where('indicator_code', '=', code).execute();
  } else {
    const values = { answer: input.answer, mode: input.mode, note, updated_at: now, updated_by: tx.actor.id };
    await upsert(trx, 'accred_answers', { period_id: periodId, indicator_code: code }, values, values);
  }
  await tx.audit({
    action: 'accreditation.answer.update',
    entity: 'accred_periods',
    entityId: periodId,
    meta: { code, mode: input.mode, answer: input.answer, hasNote: input.answer !== null && note !== null },
  });
  return { id: periodId, version: Number(period.version) };
}
