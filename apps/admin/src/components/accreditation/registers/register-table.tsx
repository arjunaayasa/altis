import type { EvidenceEntity } from '@altis/shared';
import type { EvidenceListResponse, EvidenceView, RegisterKind } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useId, useMemo, useRef, useState, type BaseSyntheticEvent, type ComponentProps, type ReactNode } from 'react';
import type { FieldValues, UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import {
  EVIDENCE_ACCEPT,
  EVIDENCE_MAX_MB_DEFAULT,
  EvidenceFileError,
  EvidenceUpload,
  evidenceProblemText,
  uploadEvidenceFile,
  useEvidenceMaxMb,
} from '@/components/accreditation/evidence-upload';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { DataTable } from '@/components/data-table';
import { CheckField, Notice, SELECT_CLASS } from '@/components/form-field';
import { ErrorState, InlinePanel, MoreMenu, MoreMenuItem, MoreMenuRule, SkeletonTable } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useLocale, useT } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { FORM_PARSE, fieldErrorKey, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { isFieldProblem, isStale, putFieldErrors, serverIssues, zodIssues, type ErrorMessage, type FieldIssue } from '@/screens/catalog/masters/master-table';

/**
 * The parts the five registers of the Register tab share (spec §6, §10.6; the register API of `accreditation/<kind>`):
 *
 * - {@link RegisterSection}: one register's list (`GET accreditation/<kind>` → `{rows}`) as a table, "Tambah …", and a
 *   panel above the table for one row with its form and its attachments (opened from "Tambah …" or the row's ⋯ menu;
 *   Esc or Batal closes it); archive after a confirmation (`DELETE accreditation/<kind>/:id`, no body). Writes answer
 *   `{id, version}` only, so the list is read again after each. A new row's panel stays open on the row once it is
 *   saved, so its attachments (and a staff member's trainings) can be added at once.
 * - {@link useRegisterSave}: a form's save: the shared strict contract checks the body first (FORM_PARSE keys), a file
 *   chosen for the row goes up next (`accreditation.evidence`) and its upload id joins the body, the server's
 *   VALIDATION_FAILED lands on the fields. An edit sends `{version, …}` with only what changed.
 * - {@link RowEvidence}: the evidence files linked to a row (`GET accreditation/evidence?entity=&entityId=`), added
 *   through the evidence upload and removed after a confirmation (`DELETE accreditation/evidence/:id`).
 * - {@link RegisterFileField}: the one file a row holds itself (an agreement, a document, a certificate).
 *
 * The registers belong to the whole library and stay editable while a period is frozen. Without
 * `accreditation.workspace.manage` everything is read only.
 */

/** What every register row carries. */
export interface RegisterRow {
  id: string;
  version: number;
}

/** The query key of a register list (`['accreditation', 'registers', kind]`). */
export const registerKey = (kind: RegisterKind) => ['accreditation', 'registers', kind] as const;

/** A register's live rows. */
export function useRegisterList<T extends RegisterRow>(kind: RegisterKind) {
  return useApiQuery<{ rows: T[] }>({ queryKey: registerKey(kind), path: `accreditation/${kind}` });
}

/** Whether the signed-in user may change the registers. */
export function useCanManage(): boolean {
  return holds(useMe(), 'accreditation.workspace.manage');
}

// ---- values ----------------------------------------------------------------------------------------------------------

/** A one-line text input's value for an optional column: trimmed, null when blank. */
export const textOrNull = (s: string): string | null => (s.trim() === '' ? null : s.trim());

/** A multi-line text's value: as written, null when blank. */
export const longOrNull = (s: string): string | null => (s.trim() === '' ? null : s);

/** An optional date input's value: null when blank. */
export const dateOrNull = (s: string): string | null => (s === '' ? null : s);

/** A required date input's value: absent when blank, so the contract reports it as required. */
export const requiredDate = (s: string): string | undefined => (s === '' ? undefined : s);

/** A whole-number input's value: null when blank, a number for digits; anything else stays text, which the contract refuses. */
export function intOrText(s: string): number | string | null {
  const v = s.trim();
  if (v === '') return null;
  return /^\d{1,15}$/.test(v) ? Number(v) : v;
}

/** A select's value: absent for the empty choice (a required choice the contract reports as required). */
export const choiceOrAbsent = <T extends string>(s: T | ''): T | undefined => (s === '' ? undefined : s);

/** An optional select's value: null for the empty choice. */
export const choiceOrNull = <T extends string>(s: T | ''): T | null => (s === '' ? null : s);

/** A calendar date `YYYY-MM-DD` in the UI language (`12 Agu 2026`). */
export function useDateText(): (iso: string | null) => string {
  const locale = useLocale();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { dateStyle: 'medium', timeZone: 'UTC' });
    return (iso) => {
      const m = iso === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
      return m === null ? '—' : format.format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    };
  }, [locale]);
}

/** A span of dates: "from s.d. to", "sejak from" when open, or the one date. */
export function useSpanText(): (from: string | null, to: string | null, open?: boolean) => string {
  const t = useT();
  const date = useDateText();
  return (from, to, open = false) => {
    if (to !== null) return t('accreditation.registers.dates', { from: date(from), to: date(to) });
    return open ? t('accreditation.registers.since', { from: date(from) }) : date(from);
  };
}

/** Bytes as B, KiB or MiB in the UI language. */
export function useBytes(): (bytes: number) => string {
  const locale = useLocale();
  return (bytes) => {
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID', { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value)} ${units[unit]}`;
  };
}

/** A link to a stored file (`/files/:id`, opened in a new tab), or a dash. */
export function FileLink({ id, name }: { id: string | null; name: string | null }) {
  if (id === null) return <span className="text-muted-foreground">—</span>;
  return (
    <a href={`/files/${encodeURIComponent(id)}`} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline-offset-4 hover:underline">
      {name ?? id}
    </a>
  );
}

/** A native select over a vocabulary (`vocab.<list>.<value>`), with an empty first choice. */
export function VocabSelect<V extends string>({
  values,
  label,
  empty,
  ...select
}: Omit<ComponentProps<'select'>, 'children'> & { values: readonly V[]; label(value: V): string; empty: string }) {
  return (
    <select {...select} className={SELECT_CLASS}>
      <option value="">{empty}</option>
      {values.map((v) => (
        <option key={v} value={v}>
          {label(v)}
        </option>
      ))}
    </select>
  );
}

// ---- the file a row holds ----------------------------------------------------------------------------------------------

/** What a form does with a row's own file: keep it, detach it, or upload a new one when the form is saved. */
export type FileChoice = { kind: 'keep' } | { kind: 'remove' } | { kind: 'new'; file: File };

export const KEEP_FILE: FileChoice = { kind: 'keep' };

/**
 * The file a row holds itself, in its form: the current one (a link) with "Lepas berkas ini", and a chooser for a new
 * one, which goes up when the form is saved. `error` is a translated sentence.
 */
export function RegisterFileField({
  label,
  current,
  choice,
  onChoice,
  error,
  disabled,
}: {
  label: string;
  current: { id: string; name: string | null } | null;
  choice: FileChoice;
  onChoice(choice: FileChoice): void;
  error: string | null;
  disabled: boolean;
}) {
  const t = useT();
  const id = useId();
  const maxMb = useEvidenceMaxMb() ?? EVIDENCE_MAX_MB_DEFAULT;
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="grid content-start gap-2">
      {disabled ? (
        <span className="text-sm leading-none font-medium">{label}</span>
      ) : (
        <label htmlFor={id} className="text-sm leading-none font-medium select-none">
          {label}
        </label>
      )}
      {current === null ? (
        <p className="text-sm text-muted-foreground">{t('accreditation.registers.file.none')}</p>
      ) : (
        <p className="flex flex-wrap items-center gap-1 text-sm">
          <span className="text-muted-foreground">{t('accreditation.registers.file.current')}</span>
          <FileLink id={current.id} name={current.name} />
        </p>
      )}
      {!disabled && current !== null && (
        <CheckField
          label={t('accreditation.registers.file.remove')}
          checked={choice.kind === 'remove'}
          onChange={(e) => {
            if (input.current !== null) input.current.value = '';
            onChoice(e.target.checked ? { kind: 'remove' } : KEEP_FILE);
          }}
        />
      )}
      {!disabled && (
        <>
          <input
            ref={input}
            id={id}
            type="file"
            accept={EVIDENCE_ACCEPT}
            aria-invalid={error === null ? undefined : true}
            aria-describedby={`${id}-hint${error === null ? '' : ` ${id}-error`}`}
            className="text-sm file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1"
            onChange={(e) => {
              const file = e.target.files?.[0];
              onChoice(file === undefined ? KEEP_FILE : { kind: 'new', file });
            }}
          />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {t('accreditation.registers.file.hint', { mb: maxMb })}
          </p>
        </>
      )}
      {error !== null && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

// ---- a form's save -----------------------------------------------------------------------------------------------------

/**
 * Saves a register form: `POST create.path` for a new row, else `PATCH update(id)` with the row's version and only the
 * changed fields (`body` answers them; nothing changed and no file change → `onUnchanged`). `check` may refuse values
 * first (an amount that is not one). The body is checked with the contract, then the chosen file goes up and its
 * upload id joins the body under `file.key`. Field errors land on the fields (a file error under the file field), any
 * other problem is `problem` (the form's alert). The version sent is the one the form opened with, whatever the list
 * read since; a stale refusal reads `invalidate` again, so the row opened again shows what is stored now.
 */
export function useRegisterSave<F extends FieldValues>(o: {
  form: UseFormReturn<F>;
  row: RegisterRow | null;
  create: { path: string; schema: z.ZodType };
  update: { path(id: string): string; schema: z.ZodType };
  body(values: F): Record<string, unknown>;
  check?(values: F): FieldIssue[];
  file?: { key: string; choice: FileChoice };
  message?: ErrorMessage;
  invalidate: QueryKey;
  onSaved(id: string, created: boolean): Promise<void>;
  onUnchanged(): void;
}): { submit(e?: BaseSyntheticEvent): Promise<void>; problem: unknown; fileError: string | null } {
  const t = useT();
  const queryClient = useQueryClient();
  const maxMb = useEvidenceMaxMb() ?? EVIDENCE_MAX_MB_DEFAULT;
  const [problem, setProblem] = useState<unknown>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  // A file that already went up for this form (a later field error must not upload it again): the file and its id.
  const uploaded = useRef<{ file: File; uploadId: string } | null>(null);
  // The version the values on screen were read at: the row's when the form opened (its own save moves it). The list is
  // read again in the background (another librarian's save, a return to the window) and hands the form a newer row,
  // but a save still names this version, so the server refuses it as stale instead of storing these values over the
  // newer ones; the form says so, and opening the row again shows what is stored now (master tables do the same).
  const [edited, setEdited] = useState(() => ({ id: o.row?.id ?? null, version: o.row?.version ?? 0 }));
  if (o.row !== null && o.row.id !== edited.id) setEdited({ id: o.row.id, version: o.row.version });

  const save = o.form.handleSubmit(async (values) => {
    setProblem(null);
    setFileError(null);
    const refused = o.check?.(values) ?? [];
    if (refused.length > 0) {
      putFieldErrors(o.form, refused);
      return;
    }
    const fields = o.body(values);
    const fileChange = o.file !== undefined && o.file.choice.kind !== 'keep';
    if (o.row !== null && Object.keys(fields).length === 0 && !fileChange) {
      o.onUnchanged();
      return;
    }
    const schema = o.row === null ? o.create.schema : o.update.schema;
    const parsed = schema.safeParse(o.row === null ? fields : { version: edited.version, ...fields }, FORM_PARSE);
    if (!parsed.success) {
      putFieldErrors(o.form, zodIssues(parsed.error.issues, o.message));
      return;
    }
    const sent = { ...(parsed.data as Record<string, unknown>) };
    if (o.file !== undefined && o.file.choice.kind !== 'keep') {
      const choice = o.file.choice;
      if (choice.kind === 'remove') {
        sent[o.file.key] = null;
      } else {
        try {
          const done = uploaded.current;
          const uploadId = done !== null && done.file === choice.file ? done.uploadId : await uploadEvidenceFile(choice.file, { maxMb });
          uploaded.current = { file: choice.file, uploadId };
          sent[o.file.key] = uploadId;
        } catch (e) {
          if (e instanceof EvidenceFileError) setFileError(evidenceProblemText(t, e.problem, maxMb));
          else setProblem(e);
          return;
        }
      }
    }
    let answer: StoreResponse;
    try {
      answer =
        o.row === null
          ? await api<StoreResponse>('POST', o.create.path, sent)
          : await api<StoreResponse>('PATCH', o.update.path(o.row.id), sent);
    } catch (e) {
      if (isFieldProblem(e)) {
        const issues = serverIssues(e, o.message);
        const onFile = o.file === undefined ? undefined : issues.find((i) => i.path === o.file!.key);
        if (onFile !== undefined) {
          setFileError(t(fieldErrorKey(onFile.code)));
          // A file the server did not take is not offered again.
          uploaded.current = null;
        }
        putFieldErrors(
          o.form,
          issues.filter((i) => i !== onFile),
        );
      } else {
        setProblem(e);
      }
      if (isStale(e)) await queryClient.invalidateQueries({ queryKey: o.invalidate });
      return;
    }
    setEdited({ id: answer.id, version: answer.version });
    o.form.reset(values);
    await o.onSaved(answer.id, o.row === null);
  });
  // An error set on a path no input registers would hold the form invalid for good: every submission starts clean.
  const submit = (e?: BaseSyntheticEvent): Promise<void> => {
    o.form.clearErrors();
    return save(e);
  };
  return { submit, problem, fileError };
}

/** Save, then Cancel (or Close, read only). */
export function FormButtons({ canManage, busy, onCancel, saveLabel }: { canManage: boolean; busy: boolean; onCancel(): void; saveLabel?: string }) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-2">
      {canManage && (
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? t('form.saving') : (saveLabel ?? t('form.save'))}
        </Button>
      )}
      <Button type="button" size="sm" variant="outline" onClick={onCancel}>
        {t(canManage ? 'form.cancel' : 'accreditation.registers.close')}
      </Button>
    </div>
  );
}

// ---- the attachments of a row -----------------------------------------------------------------------------------------

/** The query key of a row's attachments (under `['accreditation', 'evidence']`, which the evidence upload reads again). */
export const rowEvidenceKey = (entity: EvidenceEntity, entityId: string) => ['accreditation', 'evidence', { entity, entityId }] as const;

/** The evidence files linked to a register row: listed, added through the evidence upload, removed after a confirmation. */
export function RowEvidence({ entity, entityId, canManage }: { entity: EvidenceEntity; entityId: string; canManage: boolean }) {
  const t = useT();
  const queryClient = useQueryClient();
  const bytes = useBytes();
  const headingId = useId();
  const [removing, setRemoving] = useState<EvidenceView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useApiQuery<EvidenceListResponse>({
    queryKey: rowEvidenceKey(entity, entityId),
    path: `accreditation/evidence?entity=${encodeURIComponent(entity)}&entityId=${encodeURIComponent(entityId)}`,
  });

  const remove = async (evidence: EvidenceView): Promise<void> => {
    setNotice(null);
    await api<StoreResponse>('DELETE', `accreditation/evidence/${encodeURIComponent(evidence.id)}`);
    setNotice(t('accreditation.registers.evidence.done.removed', { name: evidence.fileName }));
    await queryClient.invalidateQueries({ queryKey: ['accreditation', 'evidence'] });
  };

  const files = list.data?.evidence ?? [];
  return (
    <section aria-labelledby={headingId} className="grid gap-3 border-t pt-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-1">
          <h3 id={headingId} className="text-sm font-bold">
            {t('accreditation.registers.evidence.title')}
          </h3>
          <p className="text-sm text-muted-foreground">{t('accreditation.registers.evidence.intro')}</p>
        </div>
        {canManage && <EvidenceUpload entity={entity} entityId={entityId} label={t('accreditation.registers.evidence.add')} onDone={() => setNotice(null)} />}
      </div>
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {list.data === undefined ? (
        list.isError ? (
          <Notice kind="error">{problemText(t, list.error)}</Notice>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )
      ) : files.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('accreditation.registers.evidence.empty')}</p>
      ) : (
        <ul className="grid border-t">
          {files.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm">
              <span className="grid gap-0.5">
                <FileLink id={e.fileId} name={e.fileName} />
                {e.caption !== '' && <span>{e.caption}</span>}
                <span className="text-xs text-muted-foreground">{bytes(e.size)}</span>
              </span>
              {canManage && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('accreditation.registers.evidence.remove_named', { name: e.fileName })}
                  onClick={() => setRemoving(e)}>
                  {t('accreditation.registers.evidence.remove')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {removing !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('accreditation.registers.evidence.confirm.title', { name: removing.fileName })}
          description={t('accreditation.registers.evidence.confirm.body')}
          confirmLabel={t('accreditation.registers.evidence.remove')}
          onConfirm={() => remove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

// ---- one register -----------------------------------------------------------------------------------------------------

/** One column of a register table. */
export interface RegisterColumn<T> {
  id: string;
  header: ReactNode;
  cell(row: T): ReactNode;
}

/** What a register's row form gets. */
export interface RegisterFormProps<T> {
  /** Null: a new row. */
  row: T | null;
  canManage: boolean;
  /** After a save: the row's id and whether it was created (the section reads the list again). */
  onSaved(id: string, created: boolean): Promise<void>;
  onCancel(): void;
}

const features = tableFeatures({});
const NO_ROWS: never[] = [];

/** The rows of a register as a DataTable, with the row actions. */
function RowsTable<T extends RegisterRow>({ kind, rows, columns }: { kind: RegisterKind; rows: T[]; columns: readonly RegisterColumn<T>[] }) {
  const t = useT();
  const defs = useMemo(() => {
    const helper = createColumnHelper<typeof features, T>();
    return helper.columns(columns.map((c) => helper.display({ id: c.id, header: () => c.header, cell: (info) => c.cell(info.row.original) })));
  }, [columns]);
  const table = useTable({ features, columns: defs, data: rows, getRowId: (row) => row.id });
  return <DataTable table={table} caption={t(`accreditation.registers.${kind}.caption`)} empty={t(`accreditation.registers.${kind}.empty`)} />;
}

/**
 * One register: its intro, "Tambah …", the table with each row's actions, the row panel (the form, `extra` for a saved
 * row, its attachments) and the archive confirmation.
 */
export function RegisterSection<T extends RegisterRow>({
  kind,
  entity,
  columns,
  nameOf,
  form: Form,
  extra,
}: {
  kind: RegisterKind;
  /** The table the attachments of a row name. */
  entity: EvidenceEntity;
  columns: readonly RegisterColumn<T>[];
  /** How a row is named in the actions, the notices and the confirmation. */
  nameOf(row: T): string;
  form: (props: RegisterFormProps<T>) => ReactNode;
  /** What a saved row's panel shows between its form and its attachments (a staff member's trainings). */
  extra?: (row: T, canManage: boolean) => ReactNode;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const canManage = useCanManage();
  const list = useRegisterList<T>(kind);
  const [dialog, setDialog] = useState<{ id: string | null; created: boolean } | null>(null);
  const [archiving, setArchiving] = useState<T | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const rows = list.data?.rows ?? (NO_ROWS as T[]);

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: registerKey(kind) });

  const archive = async (row: T): Promise<void> => {
    setNotice(null);
    try {
      await api<StoreResponse>('DELETE', `accreditation/${kind}/${encodeURIComponent(row.id)}`);
    } catch (e) {
      if (isStale(e)) await refresh();
      throw e;
    }
    setNotice(t('accreditation.registers.done.archived', { name: nameOf(row) }));
    await refresh();
  };

  const onSaved = async (id: string, created: boolean): Promise<void> => {
    await refresh();
    const saved = queryClient.getQueryData<{ rows: T[] }>(registerKey(kind))?.rows.find((r) => r.id === id);
    if (created && saved !== undefined) {
      setDialog({ id, created: true });
      return;
    }
    setDialog(null);
    setNotice(saved === undefined ? t('form.saved') : t('accreditation.registers.done.saved', { name: nameOf(saved) }));
  };

  const actions: RegisterColumn<T> = {
    id: 'actions',
    header: <span className="sr-only">{t('accreditation.registers.col.actions')}</span>,
    cell: (row) => (
      <MoreMenu small label={t('accreditation.registers.action.more_named', { name: nameOf(row) })}>
        <MoreMenuItem
          aria-label={t(canManage ? 'accreditation.registers.action.edit_named' : 'accreditation.registers.action.view_named', { name: nameOf(row) })}
          onSelect={() => {
            setNotice(null);
            setDialog({ id: row.id, created: false });
          }}>
          {t(canManage ? 'accreditation.registers.action.edit' : 'accreditation.registers.action.view')}
        </MoreMenuItem>
        {canManage && (
          <>
            <MoreMenuRule />
            <MoreMenuItem danger aria-label={t('accreditation.registers.action.archive_named', { name: nameOf(row) })} onSelect={() => setArchiving(row)}>
              {t('accreditation.registers.action.archive')}
            </MoreMenuItem>
          </>
        )}
      </MoreMenu>
    ),
  };

  const row = dialog === null || dialog.id === null ? null : (rows.find((r) => r.id === dialog.id) ?? null);
  const title = (): string => {
    if (dialog?.id === null) return t(`accreditation.registers.${kind}.add`);
    return t(canManage ? `accreditation.registers.${kind}.edit` : `accreditation.registers.${kind}.view`);
  };

  return (
    <section className="grid min-w-0 gap-4 pt-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-[75ch] text-sm text-muted-foreground">{t(`accreditation.registers.${kind}.intro`)}</p>
        {canManage && (
          <Button
            type="button"
            aria-expanded={dialog !== null && dialog.id === null}
            onClick={() => {
              setNotice(null);
              setDialog({ id: null, created: false });
            }}>
            {t(`accreditation.registers.${kind}.add`)}
          </Button>
        )}
      </div>
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {dialog !== null && (
        <InlinePanel title={title()} onCancel={() => setDialog(null)} className="max-w-4xl">
          <p className="text-sm text-muted-foreground">{t(`accreditation.registers.${kind}.intro`)}</p>
          {dialog.created && row !== null && <Notice kind="success">{t('accreditation.registers.done.created', { name: nameOf(row) })}</Notice>}
          {/* Esc in a confirmation opened from the panel closes that confirmation only, not the panel. */}
          <div
            className="grid gap-3.5"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !e.currentTarget.contains(e.target as Node)) e.stopPropagation();
            }}>
            {dialog.id !== null && row === null ? (
              <p role="status" className="text-sm text-muted-foreground">
                {list.isFetching ? t('shell.loading') : t('form.error.not_found')}
              </p>
            ) : (
              <Form key={row?.id ?? 'new'} row={row} canManage={canManage} onSaved={onSaved} onCancel={() => setDialog(null)} />
            )}
            {row !== null && extra?.(row, canManage)}
            {row !== null && <RowEvidence entity={entity} entityId={row.id} canManage={canManage} />}
          </div>
        </InlinePanel>
      )}
      {list.data === undefined ? (
        list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (
          <SkeletonTable label={t('shell.loading')} rows={3} />
        )
      ) : (
        <RowsTable kind={kind} rows={rows} columns={[...columns, actions]} />
      )}
      {archiving !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('accreditation.registers.confirm.archive.title', { name: nameOf(archiving) })}
          description={t('accreditation.registers.confirm.archive.body')}
          confirmLabel={t('accreditation.registers.action.archive')}
          onConfirm={() => archive(archiving)}
          onClose={() => setArchiving(null)}
        />
      )}
    </section>
  );
}

