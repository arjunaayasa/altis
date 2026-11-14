import type { PeriodPatchBody, PeriodView } from '@altis/shared/api/accreditation';
import { useState, type ReactNode } from 'react';
import { Field, NoticeAlert, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { fieldErrorKey } from '@/lib/form-errors';
import { periodPath, useRefreshPeriods } from './data';

/**
 * The forms of a period's own data (Profil, Populasi & Sarana): each keeps its values as the inputs show them (text),
 * sends only the fields that differ from the period as loaded, with the period's version, and reads the period again
 * once stored. A field the server refuses shows its error on that field; any other refusal (a frozen period, a newer
 * version) is the form's alert.
 */

/** The fields of a period PATCH beyond its version. */
export type PeriodPatch = Omit<PeriodPatchBody, 'version'>;

/** What the last save did. */
export type SaveOutcome = 'saved' | 'unchanged' | null;

/** The save of a period form: `save(patch, toField)` sends `patch` (nothing to send says so) and maps refused paths. */
export function usePeriodSave(period: PeriodView) {
  const refresh = useRefreshPeriods();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [serverErrors, setServerErrors] = useState<Readonly<Record<string, string>>>({});

  /** Sends `patch`; `toField` names the form field of a refused body path (null: the form's alert). */
  const save = async (patch: PeriodPatch, toField: (path: string) => string | null): Promise<void> => {
    setProblem(null);
    setOutcome(null);
    setServerErrors({});
    if (Object.keys(patch).length === 0) {
      setOutcome('unchanged');
      return;
    }
    setBusy(true);
    try {
      await api('PATCH', periodPath(period.id), { version: period.version, ...patch });
      setOutcome('saved');
      await refresh();
    } catch (e) {
      const fields: Record<string, string> = {};
      let unplaced = false;
      if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') {
        for (const { path, code } of e.errors ?? []) {
          const field = toField(path);
          if (field === null) unplaced = true;
          else fields[field] ??= fieldErrorKey(code);
        }
      }
      setServerErrors(fields);
      if (Object.keys(fields).length === 0 || unplaced) setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  return { save, busy, problem, outcome, serverErrors };
}

/** The save state of a period form, kept above the form so that its outcome outlives the form's reset after a save. */
export type PeriodSaving = ReturnType<typeof usePeriodSave>;

/** The bottom of a period form: its alert, the outcome, and the save button for a user who may change the period. */
export function PeriodFormFooter({ canEdit, busy, problem, outcome }: { canEdit: boolean; busy: boolean; problem: unknown; outcome: SaveOutcome }) {
  const t = useT();
  return (
    <>
      <ProblemAlert error={problem} />
      {outcome === 'saved' && <NoticeAlert tone="success">{t('form.saved')}</NoticeAlert>}
      {outcome === 'unchanged' && <NoticeAlert>{t('settings.unchanged')}</NoticeAlert>}
      {canEdit && (
        <div>
          <Button type="submit" disabled={busy}>
            {t(busy ? 'form.saving' : 'form.save')}
          </Button>
        </div>
      )}
    </>
  );
}

/** A titled group of a period form. */
export function FormSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-4 rounded-lg border bg-card p-4 text-card-foreground">
      <legend className="px-1 text-base font-semibold">{title}</legend>
      {hint !== undefined && <p className="-mt-2 text-sm text-muted-foreground">{hint}</p>}
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/** A text, number, date, month or URL input of a period form. */
export function TextField({
  label,
  hint,
  value,
  error,
  disabled,
  type = 'text',
  maxLength,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  error: string | undefined;
  disabled: boolean;
  type?: 'text' | 'number' | 'date' | 'month' | 'url' | 'email' | 'tel';
  maxLength?: number;
  onChange(value: string): void;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <Input
          {...control}
          type={type}
          value={value}
          disabled={disabled}
          maxLength={maxLength}
          min={type === 'number' ? 0 : undefined}
          step={type === 'number' ? 1 : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/** A select of a period form; `options` are `[value, label]`, the empty value meaning none. */
export function SelectField({
  label,
  value,
  error,
  disabled,
  options,
  onChange,
}: {
  label: string;
  value: string;
  error: string | undefined;
  disabled: boolean;
  options: readonly (readonly [string, string])[];
  onChange(value: string): void;
}) {
  return (
    <Field label={label} error={error}>
      {(control) => (
        <select {...control} className={SELECT_CLASS} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {options.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** A text as the API takes it: trimmed, null when empty. */
export function textOrNull(value: string): string | null {
  const v = value.trim();
  return v === '' ? null : v;
}

/** A whole number input: null when empty, the number, or `invalid` when it is not a whole number from `min` to `max`. */
export function wholeOrNull(value: string, min = 0, max = 2_147_483_647): number | null | 'invalid' {
  const v = value.trim();
  if (v === '') return null;
  if (!/^\d+$/.test(v)) return 'invalid';
  const n = Number(v);
  return n >= min && n <= max ? n : 'invalid';
}

/** A stored number as an input shows it. */
export const numberText = (n: number | null | undefined): string => (n === null || n === undefined ? '' : String(n));
