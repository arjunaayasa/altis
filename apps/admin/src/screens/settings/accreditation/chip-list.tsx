import { useId, useState, type KeyboardEvent } from 'react';
import { useController, type Control, type FieldErrors } from 'react-hook-form';
import { describedBy } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n';
import { FORM_PARSE, fieldErrorText } from '@/lib/form-errors';
import { cn } from '@/lib/utils';
import { LIST_SCHEMAS, listMax, type AccredFormInput, type AccredFormOutput, type ChipListName } from './form';

/**
 * A list setting of Pengaturan › Akreditasi as chips: the entries in order, each with its remove button, and a field
 * that adds one (Enter or "Tambah"). An entry is checked and normalised by the list's own entry schema (the shared one
 * the server applies: a code is trimmed and written in capitals), so the list holds what the server would store; a
 * duplicate or one past the list's limit is refused at the field. The error of the list itself, or of one of its
 * entries (a server's `fiction.ddcPrefixes.2`), is shown under it. Read-only: the field is disabled and no entry has a
 * remove button.
 */
export function ChipListField({
  control,
  errors,
  name,
  label,
  hint,
  readOnly,
  mono = true,
  suggestions,
}: {
  control: Control<AccredFormInput, unknown, AccredFormOutput>;
  errors: FieldErrors<AccredFormInput>;
  name: ChipListName;
  label: string;
  hint?: string;
  readOnly: boolean;
  /** Codes and prefixes in a fixed-width font; the social addresses not. */
  mono?: boolean;
  /** Values offered while typing (the masters' codes). */
  suggestions?: readonly string[];
}) {
  const t = useT();
  const id = useId();
  const { field } = useController({ control, name });
  const value = field.value as string[];
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const schema = LIST_SCHEMAS[name];
  const max = listMax(schema);
  /** The field's own refusal of an entry, else the list's error (the form's check, or the server's). */
  const error = problem ?? fieldErrorText(t, errorUnder(errors, name));
  const listId = `${id}-suggestions`;

  const add = (): void => {
    const parsed = schema.element.safeParse(draft, FORM_PARSE);
    if (!parsed.success) {
      setProblem(fieldErrorText(t, { message: parsed.error.issues[0]?.message ?? 'form.error.invalid' }));
      return;
    }
    const entry = parsed.data;
    if (value.includes(entry)) {
      setProblem(t('accreditation.settings.chips.duplicate', { value: entry }));
      return;
    }
    if (value.length >= max) {
      setProblem(t('accreditation.settings.chips.full', { max }));
      return;
    }
    setProblem(undefined);
    setDraft('');
    field.onChange([...value, entry]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter') return;
    // Enter adds the entry; it never submits the settings form.
    e.preventDefault();
    add();
  };

  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>{label}</Label>
      <ul aria-label={t('accreditation.settings.chips.list', { label })} className="flex flex-wrap gap-1.5">
        {value.map((entry, i) => (
          <li
            // A list stored by another client may hold an entry twice: the position keeps the keys apart.
            key={`${i}:${entry}`}
            data-chip={entry}
            className={cn('inline-flex max-w-full items-center gap-1.5 rounded border bg-layer px-2 py-0.5 text-sm break-all', mono && 'font-mono')}
          >
            {entry}
            {!readOnly && (
              <button
                type="button"
                aria-label={t('accreditation.settings.chips.remove', { value: entry, label })}
                className="rounded px-1 text-xs font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => {
                  setProblem(undefined);
                  field.onChange(value.filter((_, j) => j !== i));
                }}
              >
                {t('system.remove')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {value.length === 0 && <p className="text-sm text-muted-foreground">{t('accreditation.settings.chips.empty')}</p>}
      <div className="flex gap-2">
        <Input
          id={id}
          disabled={readOnly}
          className={cn(mono && 'font-mono')}
          autoComplete="off"
          spellCheck={false}
          list={suggestions === undefined || suggestions.length === 0 ? undefined : listId}
          value={draft}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy(id, { error, hint: hint !== undefined })}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem(undefined);
          }}
          onKeyDown={onKeyDown}
          onBlur={field.onBlur}
        />
        <Button type="button" variant="outline" disabled={readOnly} aria-label={t('accreditation.settings.chips.add_to', { label })} onClick={add}>
          {t('accreditation.settings.chips.add')}
        </Button>
        {suggestions !== undefined && suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
      {error !== undefined && (
        <p id={`${id}-error`} className="text-meta font-semibold text-bad">
          {error}
        </p>
      )}
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/** The error of the list at `path`, or the first error of one of its entries. */
function errorUnder(errors: FieldErrors<AccredFormInput>, path: string): { type?: string; message?: string } | undefined {
  let node: unknown = errors;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== 'object' || node === null) return undefined;
  const own = node as { type?: unknown; message?: unknown; root?: unknown };
  if (typeof own.type === 'string' || typeof own.message === 'string') return own as { type?: string; message?: string };
  if (typeof own.root === 'object' && own.root !== null) return own.root as { type?: string; message?: string };
  if (Array.isArray(node)) {
    const first = node.find((e): e is { type?: string; message?: string } => typeof e === 'object' && e !== null);
    if (first !== undefined) return first;
  }
  return undefined;
}
