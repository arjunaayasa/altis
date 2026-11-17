import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { MasterListResponse } from '@altis/shared/api/catalog/masters';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type BaseSyntheticEvent, type ReactNode } from 'react';
import type { FieldValues, Path, UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CheckField, Notice } from '@/components/form-field';
import { DenseTable, ErrorState, InlinePanel, SkeletonTable } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useLocale, useT, type TKey } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { FORM_PARSE, ROOT_ERROR, fieldErrorKey } from '@/lib/form-errors';
import { useApiQuery } from '@/lib/me';

/**
 * The parts every tab of Data Induk shares (Phase 2 spec §13, §3.7; plan Task 27; the API of Task 12):
 *
 * - {@link MasterTab}: one master's list (`GET catalog/<kind>`, archived ones on request) as a dense table, with create
 *   and edit in a panel above the table (material types: on their own page) and archive after a confirmation. Writes answer only
 *   `{id, version}` (S15), so the tab reads the list again after each. Archiving sends the row's `{version}` in the
 *   DELETE body. A master that live records or items still use is refused with 409 CATALOG_IN_USE (Review Focus 2):
 *   the tab says how many use it. A problem body carries no `meta`, so the count is read from the bilingual `detail`
 *   (Task 12 writes it there), else the row's own `usage`. A stale version (CONFLICT_STALE) is shown and the list read
 *   again, so confirming again (or the dialog opened again) works on the row as it is now.
 * - {@link useMasterSave}: a panel form's save: the shared strict contract checks the body first (FORM_PARSE keys),
 *   the server's VALIDATION_FAILED lands on the fields, and a screen may give a field error its own message (the codes
 *   without a `form.error.*` text: `duplicate`, `not_allowed`, `invalid_parent`, ...).
 * - Without `catalog.masters.manage` everything is read only: no add or archive, and "Lihat" instead of "Ubah".
 */

/** The masters, by their API path segment (`catalog/<kind>`). */
export type MasterKind = 'material-types' | 'languages' | 'collection-types' | 'suppliers' | 'custom-fields';

/** The masters edited in a panel of their tab (a material type has its own page). */
export type DialogKind = Exclude<MasterKind, 'material-types'>;

/** The i18n segment of each master. */
export const MASTER_SEGMENT = {
  'material-types': 'material_types',
  languages: 'languages',
  'collection-types': 'collection_types',
  suppliers: 'suppliers',
  'custom-fields': 'custom_fields',
} as const satisfies Record<MasterKind, string>;

/** What every master row carries. */
export interface MasterRow {
  id: string;
  code: string;
  usage: number;
  archived: boolean;
  version: number;
}

/** The query key of a master list (`['catalog', kind, …]`: a write invalidates `['catalog', kind]`). */
export const masterKey = (kind: MasterKind, includeArchived: boolean) => ['catalog', kind, { includeArchived }] as const;

/** A master list, live rows only or archived ones too. */
export function useMasterList<T>(kind: MasterKind, includeArchived: boolean) {
  return useApiQuery<MasterListResponse<T>>({
    queryKey: masterKey(kind, includeArchived),
    path: includeArchived ? `catalog/${kind}?includeArchived=true` : `catalog/${kind}`,
  });
}

/** The numbers of a problem's `detail`, read from its first (Indonesian) half: the counts of CATALOG_IN_USE. */
export function countsIn(detail: string | undefined): number[] {
  if (detail === undefined) return [];
  const own = detail.split(' / ', 1)[0] ?? '';
  return [...own.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

// ---- field errors --------------------------------------------------------------------------------------------------

/** A screen's own message for a field check: `(path, code)` → its i18n key, or undefined for `form.error.<code>`. */
export type ErrorMessage = (path: string, code: string) => TKey | undefined;

/** One field error: the `.`-joined path, the check that failed and the message key to show. */
export interface FieldIssue {
  path: string;
  code: string;
  message: TKey;
}

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** Whether the form's `values` hold the `.`-joined `path`. */
function hasField(values: unknown, path: string): boolean {
  let node: unknown = values;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null || !hasOwn(node, segment)) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return true;
}

/**
 * Puts `issues` on the form: each on the field at its path (`fieldOf` may name another one, such as a field array's
 * `root`), else on `root.server`; the first error of a field wins and the first field gets the focus.
 */
export function putFieldErrors<F extends FieldValues>(form: UseFormReturn<F>, issues: readonly FieldIssue[], fieldOf?: (path: string) => string | undefined): void {
  const values: unknown = form.getValues();
  const done = new Set<string>();
  let focused = false;
  for (const issue of issues) {
    const name = fieldOf?.(issue.path) ?? (issue.path !== '' && hasField(values, issue.path) ? issue.path : ROOT_ERROR);
    if (done.has(name)) continue;
    done.add(name);
    const shouldFocus: boolean = !focused && name !== ROOT_ERROR && !name.endsWith('.root');
    form.setError(name as Path<F>, { type: issue.code, message: issue.message }, { shouldFocus });
    focused ||= shouldFocus;
  }
}

/** The field errors of a VALIDATION_FAILED, each with the screen's message or `form.error.<code>`. */
export function serverIssues(e: ApiError, message?: ErrorMessage): FieldIssue[] {
  return (e.errors ?? []).map(({ path, code }) => ({ path, code, message: message?.(path, code) ?? fieldErrorKey(code) }));
}

/** The field errors of a failed check with the shared contract (parsed with FORM_PARSE): a custom check's `params.code`. */
export function zodIssues(issues: readonly z.core.$ZodIssue[], message?: ErrorMessage): FieldIssue[] {
  return issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    const own = issue.code === 'custom' ? (issue as { params?: Record<string, unknown> }).params?.['code'] : undefined;
    const code = typeof own === 'string' ? own : issue.code;
    const key = message?.(path, code) ?? (typeof own === 'string' ? fieldErrorKey(own) : (issue.message as TKey));
    return { path, code, message: key };
  });
}

/** True for a VALIDATION_FAILED that names fields. */
export const isFieldProblem = (e: unknown): e is ApiError => e instanceof ApiError && e.code === 'VALIDATION_FAILED' && (e.errors?.length ?? 0) > 0;

/**
 * True for CONFLICT_STALE: someone else changed the row since the screen read it. The screen then reads its list again,
 * so the next attempt (a dialog opened again, an archive confirmed again) starts from the row as it is now.
 */
export const isStale = (e: unknown): e is ApiError => e instanceof ApiError && e.code === 'CONFLICT_STALE';

// ---- values --------------------------------------------------------------------------------------------------------

/** A text input's value for an optional column: trimmed, null when blank. */
export const optionalText = (s: string): string | null => (s.trim() === '' ? null : s.trim());

/** An order field's value: a whole number (blank → 0); anything else stays text, which the contract refuses. */
export const orderValue = (s: string): number | string => {
  const v = s.trim();
  if (v === '') return 0;
  return /^\d{1,10}$/.test(v) ? Number(v) : v;
};

/** The fields of `next` whose value differs from `before` (compared as JSON). */
export function changedFields<T extends Record<string, unknown>>(next: T, before: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (JSON.stringify(next[key]) !== JSON.stringify(before[key])) out[key] = next[key];
  }
  return out;
}

// ---- a panel form's save -------------------------------------------------------------------------------------------

/**
 * Saves a panel form of `kind`: `POST catalog/<kind>` for a new row, else `PATCH catalog/<kind>/:id` with the row's
 * version and only the changed fields (`body` answers them; nothing changed → `onUnchanged`). The body is checked with
 * the contract first; field errors land on the fields, any other problem is `problem` (the form's alert).
 */
export function useMasterSave<F extends FieldValues>(o: {
  kind: DialogKind;
  form: UseFormReturn<F>;
  row: MasterRow | null;
  /** A new row's body, or a patch's changed fields (without `version`). */
  body(values: F): Record<string, unknown>;
  schema: { create: z.ZodType; patch: z.ZodType };
  message?: ErrorMessage;
  fieldOf?: (path: string) => string | undefined;
  onSaved(code: string): Promise<void>;
  onUnchanged(): void;
}): { submit(e?: BaseSyntheticEvent): Promise<void>; problem: unknown } {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<unknown>(null);
  const save = o.form.handleSubmit(async (values) => {
    setProblem(null);
    const fields = o.body(values);
    if (o.row !== null && Object.keys(fields).length === 0) {
      o.onUnchanged();
      return;
    }
    const parsed = (o.row === null ? o.schema.create : o.schema.patch).safeParse(o.row === null ? fields : { version: o.row.version, ...fields }, FORM_PARSE);
    if (!parsed.success) {
      putFieldErrors(o.form, zodIssues(parsed.error.issues, o.message), o.fieldOf);
      return;
    }
    const sent = parsed.data as Record<string, unknown>;
    try {
      if (o.row === null) await api<StoreResponse>('POST', `catalog/${o.kind}`, sent);
      else await api<StoreResponse>('PATCH', `catalog/${o.kind}/${encodeURIComponent(o.row.id)}`, sent);
    } catch (e) {
      if (isFieldProblem(e)) putFieldErrors(o.form, serverIssues(e, o.message), o.fieldOf);
      else setProblem(e);
      if (isStale(e)) await queryClient.invalidateQueries({ queryKey: ['catalog', o.kind] });
      return;
    }
    o.form.reset(values);
    await o.onSaved(typeof sent['code'] === 'string' ? sent['code'] : (o.row?.code ?? ''));
  });
  // An error set on a path no input registers (an option list, a template code) would hold the form invalid for good:
  // every submission starts clean.
  const submit = (e?: BaseSyntheticEvent): Promise<void> => {
    o.form.clearErrors();
    return save(e);
  };
  return { submit, problem };
}

// ---- the table -----------------------------------------------------------------------------------------------------

/** One column of a master table. */
export interface MasterColumn<T> {
  id: string;
  header: ReactNode;
  cell(row: T): ReactNode;
  className?: string;
  /** The header's own classes (alignment). */
  headClassName?: string;
}

/**
 * A table of master rows with a screen-reader caption (its accessible name) and a row for "nothing here": the layout's
 * dense table, keyed by the rows' ids.
 */
export function MasterTable<T extends { id: string }>({ caption, columns, rows, empty }: { caption: string; columns: readonly MasterColumn<T>[]; rows: readonly T[]; empty: string }) {
  return <DenseTable caption={caption} columns={columns} rows={rows} rowKey={(row) => row.id} empty={empty} />;
}

/** A count in the UI language's digits. */
export function useCount(): (n: number) => string {
  const locale = useLocale();
  const format = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID');
  return (n) => format.format(n);
}

// ---- one master's tab ----------------------------------------------------------------------------------------------

/** What a panel form of a master gets. */
export interface MasterFormProps<T> {
  /** Null: a new row. */
  row: T | null;
  canManage: boolean;
  /** After a save: the row's code (the tab reads the list again, says so and closes the panel). */
  onSaved(code: string): Promise<void>;
  onCancel(): void;
}

/** The buttons that end a panel form: Save (for a manager), then Cancel (or Close, read only). */
export function MasterFormButtons({ canManage, busy, onCancel }: { canManage: boolean; busy: boolean; onCancel(): void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-2">
      {canManage && (
        <Button type="submit" size="sm" disabled={busy}>
          {t(busy ? 'form.saving' : 'form.save')}
        </Button>
      )}
      <Button type="button" size="sm" variant="outline" className="bg-background" onClick={onCancel}>
        {t(canManage ? 'form.cancel' : 'catalog.masters.close')}
      </Button>
    </div>
  );
}

/** The sentence of a CATALOG_IN_USE refusal (`{code}`, `{count}`); null for a master that is never in use. */
function inUseKey(kind: MasterKind): TKey | null {
  switch (kind) {
    case 'material-types':
    case 'languages':
      return 'catalog.masters.in_use.records';
    case 'collection-types':
      return 'catalog.masters.in_use.collection_types';
    case 'suppliers':
      return 'catalog.masters.in_use.suppliers';
    default:
      return null;
  }
}

type TabNotice = { tone: 'success' | 'error'; text: string };

/**
 * One master: its intro, "Tambah …", the archived switch, the form panel (above the table), the table with each row's
 * actions and the archive confirmation. Without a `form` (material types) a row opens its own page instead.
 */
export function MasterTab<T extends MasterRow>({
  kind,
  canManage,
  columns,
  form: Form,
}: {
  kind: MasterKind;
  canManage: boolean;
  columns: readonly MasterColumn<T>[];
  /** The panel form; absent for material types, edited on their own page. */
  form?: (props: MasterFormProps<T>) => ReactNode;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const segment = MASTER_SEGMENT[kind];
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<{ row: T | null } | null>(null);
  const [archiving, setArchiving] = useState<T | null>(null);
  const [notice, setNotice] = useState<TabNotice | null>(null);
  const list = useMasterList<T>(kind, showArchived);

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['catalog', kind] });

  const archive = async (row: T): Promise<void> => {
    setNotice(null);
    // The row as last read: after a stale refusal the list is read again, and confirming again sends its new version.
    const current = list.data?.items.find((r) => r.id === row.id) ?? row;
    try {
      await api<StoreResponse>('DELETE', `catalog/${kind}/${encodeURIComponent(row.id)}`, { version: current.version });
    } catch (e) {
      const key = inUseKey(kind);
      if (e instanceof ApiError && e.code === 'CATALOG_IN_USE' && key !== null) {
        const count = countsIn(e.detail)[0] ?? current.usage;
        setNotice({ tone: 'error', text: t(key, { code: row.code, count }) });
        await refresh();
        return;
      }
      if (isStale(e)) await refresh();
      throw e;
    }
    setNotice({ tone: 'success', text: t('catalog.masters.done.archived', { code: row.code }) });
    await refresh();
  };

  const editPage = Form === undefined;
  const actions: MasterColumn<T> = {
    id: 'actions',
    header: <span className="sr-only">{t('catalog.masters.col.actions')}</span>,
    className: 'w-px py-1.5 text-right whitespace-nowrap',
    cell: (row) => (
      <>
        {editPage ? (
          <Button asChild variant="ghost" size="sm">
            <Link
              to={`/admin/catalog/masters/material-types/${encodeURIComponent(row.id)}`}
              aria-label={t(canManage ? 'catalog.masters.action.edit_named' : 'catalog.masters.action.view_named', { code: row.code })}>
              {t(canManage ? 'catalog.masters.action.edit' : 'catalog.masters.action.view')}
            </Link>
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t(canManage ? 'catalog.masters.action.edit_named' : 'catalog.masters.action.view_named', { code: row.code })}
            onClick={() => {
              setNotice(null);
              setDialog({ row });
            }}>
            {t(canManage ? 'catalog.masters.action.edit' : 'catalog.masters.action.view')}
          </Button>
        )}
        {canManage && !row.archived && (
          <Button variant="ghost" size="sm" aria-label={t('catalog.masters.action.archive_named', { code: row.code })} onClick={() => setArchiving(row)}>
            {t('catalog.masters.action.archive')}
          </Button>
        )}
      </>
    ),
  };

  const title = (row: T | null): string => {
    if (kind === 'material-types') return '';
    if (row === null) return t(`catalog.masters.add.${MASTER_SEGMENT[kind]}`);
    return canManage ? t(`catalog.masters.edit.${MASTER_SEGMENT[kind]}`) : t(`catalog.masters.view.${MASTER_SEGMENT[kind]}`, { code: row.code });
  };

  return (
    <section className="grid gap-5 pt-5">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <p className="max-w-[75ch] text-sm text-muted-foreground">{t(`catalog.masters.intro.${segment}`)}</p>
        {canManage &&
          (editPage ? (
            <Button asChild>
              <Link to="/admin/catalog/masters/material-types/new">{t(`catalog.masters.add.${segment}`)}</Link>
            </Button>
          ) : (
            <Button
              aria-expanded={dialog !== null && dialog.row === null}
              onClick={() => {
                setNotice(null);
                setDialog({ row: null });
              }}>
              {t(`catalog.masters.add.${segment}`)}
            </Button>
          ))}
      </div>
      {notice !== null && <Notice kind={notice.tone}>{notice.text}</Notice>}
      {Form !== undefined && dialog !== null && (
        <InlinePanel key={dialog.row?.id ?? 'new'} title={title(dialog.row)} onCancel={() => setDialog(null)}>
          <Form
            row={dialog.row}
            canManage={canManage}
            onCancel={() => setDialog(null)}
            onSaved={async (code) => {
              await refresh();
              setNotice({ tone: 'success', text: t(`catalog.masters.done.saved.${segment}`, { code }) });
              setDialog(null);
            }}
          />
        </InlinePanel>
      )}
      <div className="grid gap-3">
        <CheckField label={t('catalog.masters.show_archived')} checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        {list.data === undefined ? (
          list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
          ) : (
            <SkeletonTable label={t('shell.loading')} columns={columns.length + 1} rows={4} />
          )
        ) : (
          <MasterTable caption={t(`catalog.masters.caption.${segment}`)} columns={[...columns, actions]} rows={list.data.items} empty={t('catalog.masters.empty')} />
        )}
      </div>
      {archiving !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('catalog.masters.confirm.archive.title', { code: archiving.code })}
          description={t(kind === 'custom-fields' ? 'catalog.masters.confirm.archive.body_custom' : 'catalog.masters.confirm.archive.body')}
          confirmLabel={t('catalog.masters.action.archive')}
          onConfirm={() => archive(archiving)}
          onClose={() => setArchiving(null)}
        />
      )}
    </section>
  );
}
