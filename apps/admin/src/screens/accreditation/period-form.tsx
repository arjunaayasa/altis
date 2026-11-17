import type { PeriodPatchBody, PeriodView } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { useCallback, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Field, NoticeAlert, ProblemAlert, SELECT_CLASS } from '@/components/form-field';
import { Callout, FormBar, FormSection as LayoutFormSection } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { fieldErrorKey } from '@/lib/form-errors';
import { periodPath, useRefreshPeriods } from './data';

/**
 * The forms of a period's own data (Profil, Populasi & Sarana): each keeps its values as the inputs show them (text),
 * sends only the fields that differ from the period it was read from, with that period's version, and reads the period
 * again once stored. A field the server refuses shows its error on that field; any other refusal (a frozen period, a
 * newer version) is the form's alert.
 *
 * A form keeps the version it was opened or last saved with, as the register forms do ({@link usePeriodValues}):
 * - its own save shows the values as stored at once (a name typed with a trailing space, a number typed `0400`), so
 *   nothing typed in another form than the stored one stays "changed" after the save;
 * - a newer version made on this page (a profile photo named, taken out or deleted below the form) keeps what was
 *   typed and moves the form to that version: nothing else changed in it;
 * - a newer version made anywhere else, while something is typed, leaves the form on its version: Simpan is refused as
 *   stale (`CONFLICT_STALE`) instead of storing these values over that change, the form says so, and "Muat ulang"
 *   shows what is stored now. With nothing typed the form simply shows the newer version.
 */

/** The fields of a period PATCH beyond its version. */
export type PeriodPatch = Omit<PeriodPatchBody, 'version'>;

/** What the last save did. */
export type SaveOutcome = 'saved' | 'unchanged' | null;

/**
 * The save of a period form: `save(base, patch, toField, onStored)` sends `patch` with the version of `base`, the
 * period the form's values came from (nothing to send says so), and maps refused paths. It also keeps the writes this
 * page made to a period (`wrote`, `madeHere`), so that a form tells a version made here from one made elsewhere.
 */
export function usePeriodSave() {
  const refresh = useRefreshPeriods();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [serverErrors, setServerErrors] = useState<Readonly<Record<string, string>>>({});
  // The period versions this page made, by `<period id>:<version it was made on>`. Only ever added to.
  const writes = useRef(new Map<string, number>());

  /** This page changed period `periodId` from version `from`, which made version `to`. */
  const wrote = useCallback((periodId: string, from: number, to: number): void => {
    writes.current.set(`${periodId}:${from}`, to);
  }, []);

  /** Whether this page's own writes alone lead from version `from` of period `periodId` to version `to`. */
  const madeHere = (periodId: string, from: number, to: number): boolean => {
    let version = from;
    while (version < to) {
      const next = writes.current.get(`${periodId}:${version}`);
      if (next === undefined) return false;
      version = next;
    }
    return version === to;
  };

  /** Clears the outcome and the refusals of the last save. */
  const clear = useCallback((): void => {
    setProblem(null);
    setOutcome(null);
    setServerErrors({});
  }, []);

  /**
   * Sends `patch` with the version of `base`; `toField` names the form field of a refused body path (null: the form's
   * alert); `onStored(version)` runs once it is stored, before the period is read again.
   */
  const save = async (base: PeriodView, patch: PeriodPatch, toField: (path: string) => string | null, onStored: (version: number) => void): Promise<void> => {
    clear();
    if (Object.keys(patch).length === 0) {
      setOutcome('unchanged');
      return;
    }
    setBusy(true);
    try {
      const answer = await api<StoreResponse>('PATCH', periodPath(base.id), { version: base.version, ...patch });
      wrote(base.id, base.version, answer.version);
      onStored(answer.version);
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
      // Refused as stale: the page reads the newer version, and the form offers to show it.
      if (e instanceof ApiError && e.code === 'CONFLICT_STALE') void refresh();
    } finally {
      setBusy(false);
    }
  };

  return { save, busy, problem, outcome, serverErrors, wrote, madeHere, clear };
}

/** The save state of a period form, kept above the form so that its outcome outlives the form's reset after a save. */
export type PeriodSaving = ReturnType<typeof usePeriodSave>;

/** How a period form reads its values from a period, what they would send, and how typed values go over a newer one. */
export interface PeriodFormModel<V> {
  valuesOf(period: PeriodView): V;
  /** The fields refused before anything is sent, and the patch of the fields that differ from `base`. */
  pending(values: V, base: PeriodView): { found: Record<string, string>; patch: PeriodPatch };
  /** `values` over `after`: what was typed (differs from `before`) stays, every other field takes its value in `after`. */
  rebased(values: V, before: V, after: V): V;
}

/** `base` once the server stored `patch` over it as `version` (a profile changes the fields it names). */
export function appliedPatch(base: PeriodView, patch: PeriodPatch, version: number): PeriodView {
  const { profile, ...rest } = patch;
  return { ...base, ...rest, profile: profile === undefined ? base.profile : { ...base.profile, ...profile }, version } as PeriodView;
}

/** The values of a period form over the period `live` as this page reads it now: see the top of this file. */
export interface PeriodValues<V> {
  /** The period the values were read from: its version is the one a save names. */
  base: PeriodView;
  values: V;
  setValues: Dispatch<SetStateAction<V>>;
  /** What a save would send now. */
  pending: { found: Record<string, string>; patch: PeriodPatch };
  /** Something typed is not stored (or is refused). */
  dirty: boolean;
  /** The period was changed elsewhere while something is typed: a save is refused until the form is read again. */
  stale: boolean;
  /** Shows what is stored now; what was typed is dropped. */
  reload(): void;
  /** The form's own save of `patch` over `sent` is stored as `version`: show the stored values. */
  stored(sent: PeriodView, patch: PeriodPatch, version: number): void;
}

/** The values of a period form and the period they were read from, pinned as the top of this file says. */
export function usePeriodValues<V>(live: PeriodView, saving: PeriodSaving, model: PeriodFormModel<V>): PeriodValues<V> {
  const [base, setBase] = useState(live);
  const [values, setValues] = useState<V>(() => model.valuesOf(live));
  const pending = model.pending(values, base);
  const dirty = Object.keys(pending.found).length > 0 || Object.keys(pending.patch).length > 0;
  // A read older than the base (one made before this form's own save came back) is left alone.
  if (live !== base && live.version >= base.version) {
    if (!dirty) {
      setBase(live);
      setValues(model.valuesOf(live));
    } else if (live.version === base.version || saving.madeHere(live.id, base.version, live.version)) {
      setBase(live);
      setValues(model.rebased(values, model.valuesOf(base), model.valuesOf(live)));
    }
  }
  return {
    base,
    values,
    setValues,
    pending,
    dirty,
    stale: dirty && live.version > base.version,
    reload: () => {
      setBase(live);
      setValues(model.valuesOf(live));
      saving.clear();
    },
    stored: (sent, patch, version) => {
      const next = appliedPatch(sent, patch, version);
      setBase(next);
      setValues(model.valuesOf(next));
    },
  };
}

/** The note of a form whose period was changed elsewhere while something is typed, with the way to read it again. */
export function StaleNote({ values }: { values: Pick<PeriodValues<unknown>, 'stale' | 'reload'> }) {
  const t = useT();
  if (!values.stale) return null;
  return (
    <Callout
      role="status"
      tone="warn"
      title={t('accreditation.workspace.form.stale')}
      action={
        <Button type="button" variant="outline" size="sm" className="bg-background" onClick={values.reload}>
          {t('accreditation.workspace.form.reload')}
        </Button>
      }
    />
  );
}

/** The bottom of a period form: its alert, the outcome, and the save button for a user who may change the period. */
export function PeriodFormFooter({ canEdit, busy, problem, outcome }: { canEdit: boolean; busy: boolean; problem: unknown; outcome: SaveOutcome }) {
  const t = useT();
  return (
    <>
      <ProblemAlert error={problem} />
      {outcome === 'saved' && <NoticeAlert tone="success">{t('form.saved')}</NoticeAlert>}
      {outcome === 'unchanged' && <NoticeAlert>{t('settings.unchanged')}</NoticeAlert>}
      {canEdit && (
        <FormBar>
          <Button type="submit" disabled={busy}>
            {t(busy ? 'form.saving' : 'form.save')}
          </Button>
        </FormBar>
      )}
    </>
  );
}

/** A titled group of a period form: the layout's form section (title and hint left, fields right). */
export function FormSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <LayoutFormSection title={title} {...(hint === undefined ? {} : { intro: hint })}>
      {children}
    </LayoutFormSection>
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
  className,
  onChange,
}: {
  label: string;
  hint?: string;
  className?: string;
  value: string;
  error: string | undefined;
  disabled: boolean;
  type?: 'text' | 'number' | 'date' | 'month' | 'url' | 'email' | 'tel';
  maxLength?: number;
  onChange(value: string): void;
}) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
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
  hint,
  value,
  error,
  disabled,
  options,
  className,
  onChange,
}: {
  label: string;
  hint?: string;
  className?: string;
  value: string;
  error: string | undefined;
  disabled: boolean;
  options: readonly (readonly [string, string])[];
  onChange(value: string): void;
}) {
  return (
    <Field label={label} hint={hint} error={error} className={className}>
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
