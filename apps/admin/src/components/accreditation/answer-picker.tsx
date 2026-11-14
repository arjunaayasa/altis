import { vocabKey } from '@altis/shared';
import { ANSWER_LETTERS, type AnswerLetter, type AnswerPutBody, type IndicatorResultView, type IndicatorView } from '@altis/shared/api/accreditation';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type JSX } from 'react';
import { Field, NoticeAlert, ProblemAlert, TEXTAREA_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { accreditationKeys, keyText, periodPath } from '@/screens/accreditation/data';

type Mode = AnswerPutBody['mode'];

/**
 * The answer of one indicator: ALTIS's suggestion (or that it gives none), the stored answer with how it was given and
 * its note, the final answer, and the form that changes it.
 *
 * - The four letters, each with its option text when the indicator has one (an indicator answered by hand or by a rule).
 * - An indicator ALTIS computes offers the two ways to answer: an own answer, or one that replaces ALTIS's suggestion
 *   (the default when there is a suggestion). Replacing the suggestion needs a note; the form says so before sending.
 * - "Hapus jawaban" removes the stored answer, so the suggestion counts again.
 * - `disabled` (a reader, or a frozen period) shows everything and changes nothing.
 *
 * After a write, the period's results are read again (the answer, the final answer and the score change).
 */
export function AnswerPicker({
  periodId,
  indicator,
  result,
  disabled,
}: {
  periodId: string;
  indicator: IndicatorView;
  result: IndicatorResultView | undefined;
  disabled: boolean;
}): JSX.Element {
  const t = useT();
  const queryClient = useQueryClient();
  const name = useId();
  const stored = result?.answer ?? null;
  const suggestion = result?.suggestion ?? null;
  const computed = !indicator.manual;
  const defaultMode: Mode = computed && suggestion !== null ? 'override' : 'manual';
  const [letter, setLetter] = useState<AnswerLetter | null>(stored?.answer ?? null);
  const [mode, setMode] = useState<Mode>(stored?.mode ?? defaultMode);
  const [note, setNote] = useState(stored?.note ?? '');
  // A stored answer that changed (this write, or another user's read again) starts the form over from it.
  const storedAt = stored?.updatedAt ?? null;
  const [shown, setShown] = useState(storedAt);
  if (shown !== storedAt) {
    setShown(storedAt);
    setLetter(stored?.answer ?? null);
    setMode(stored?.mode ?? defaultMode);
    setNote(stored?.note ?? '');
  }
  const [noteError, setNoteError] = useState<string | undefined>(undefined);
  const [pickError, setPickError] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const send = async (body: AnswerPutBody): Promise<void> => {
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await api('PUT', periodPath(periodId, `/answers/${encodeURIComponent(indicator.code)}`), body);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: accreditationKeys.results(periodId) });
    } catch (e) {
      const noteField = e instanceof ApiError && e.code === 'VALIDATION_FAILED' ? e.errors?.find((x) => x.path === 'note') : undefined;
      if (noteField === undefined) setProblem(e);
      else setNoteError(`form.error.${noteField.code}`);
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    setNoteError(undefined);
    setPickError(false);
    if (letter === null) {
      setPickError(true);
      return;
    }
    const text = note.trim();
    if (mode === 'override' && text === '') {
      setNoteError('form.error.required');
      return;
    }
    void send({ answer: letter, mode, note: text === '' ? null : text });
  };

  /** Nothing can change: a reader, a frozen period, or a write under way. */
  const off = disabled || busy;

  const optionText = (l: AnswerLetter): string => {
    const key = indicator.optionKeys?.[ANSWER_LETTERS.indexOf(l)];
    return key === undefined ? l : t('accreditation.workspace.answer.option', { letter: l, text: keyText(t, key) });
  };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1 text-sm">
        {result !== undefined && (
          <p>{suggestion === null ? t('accreditation.workspace.suggestion_none') : t('accreditation.workspace.suggestion', { answer: suggestion })}</p>
        )}
        {stored !== null && stored.answer !== null && (
          <p>{t('accreditation.workspace.stored', { answer: stored.answer, mode: t(vocabKey('answer_mode', stored.mode)) })}</p>
        )}
        {stored !== null && stored.note !== null && <p className="text-muted-foreground">{t('accreditation.workspace.stored_note', { note: stored.note })}</p>}
        {result !== undefined && (
          <p className="font-medium">
            {result.final === null ? t('accreditation.workspace.final_none') : t('accreditation.workspace.final', { answer: result.final })}
          </p>
        )}
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('accreditation.workspace.answer.legend')}</legend>
        <div className="grid gap-1">
          {ANSWER_LETTERS.map((l) => (
            <label key={l} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${name}-letter`}
                value={l}
                checked={letter === l}
                disabled={off}
                onChange={() => setLetter(l)}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span>{optionText(l)}</span>
            </label>
          ))}
        </div>
        {pickError && (
          <p role="alert" className="text-sm text-destructive">
            {t('accreditation.workspace.answer.pick')}
          </p>
        )}
        {computed && (
          <div role="radiogroup" aria-label={t('accreditation.workspace.answer.mode')} className="flex flex-wrap gap-x-4 gap-y-1">
            {(['manual', 'override'] as const).map((m) => (
              <label key={m} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${name}-mode`}
                  value={m}
                  checked={mode === m}
                  disabled={off}
                  onChange={() => setMode(m)}
                  className="size-4 shrink-0 accent-primary"
                />
                <span>{t(vocabKey('answer_mode', m))}</span>
              </label>
            ))}
          </div>
        )}
        <Field label={t('accreditation.workspace.answer.note')} hint={t('accreditation.workspace.answer.note_hint')} error={noteError}>
          {(control) => (
            <textarea
              {...control}
              className={TEXTAREA_CLASS}
              rows={2}
              disabled={off}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setNoteError(undefined);
              }}
            />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={off} onClick={save}>
            {t('accreditation.workspace.answer.save')}
          </Button>
          {stored !== null && (
            <Button type="button" size="sm" variant="outline" disabled={off} onClick={() => void send({ answer: null, mode: 'manual', note: null })}>
              {t('accreditation.workspace.answer.remove')}
            </Button>
          )}
        </div>
      </fieldset>
      <ProblemAlert error={problem} />
      {saved && <NoticeAlert tone="success">{t('accreditation.workspace.answer.saved')}</NoticeAlert>}
    </div>
  );
}
