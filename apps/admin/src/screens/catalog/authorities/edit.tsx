import { AGENT_TYPES, SUBJECT_TYPES, isUlid } from '@altis/shared';
import { AgentBody, PublisherBody, SubjectBody, type AgentView, type AuthorityKind, type SubjectView } from '@altis/shared/api/catalog/authorities';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useForm, type FieldErrors, type Resolver } from 'react-hook-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Field, Notice, ProblemAlert, RefetchProblem, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type AdminKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, applyServerErrors, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import {
  AuthorityBadges,
  authorityHref,
  authorityKey,
  authorityKindKey,
  authorityName,
  authorityPath,
  orphansKey,
  typeLabel,
  useVersionChain,
  type AuthorityView,
  type AuthorityViewOf,
  type VersionChain,
} from './common';
import { MergeDialog } from './merge-dialog';
import { isAuthorityKind, type AuthorityTypeFilter } from './search';
import { ThesaurusEditor } from './thesaurus-editor';

/**
 * One authority (Phase 2 Task 26; spec §3.5, §13; `/admin/catalog/authorities/$kind/$id`, `$id` = `new` creates one).
 *
 * - The form of its kind: an agent's type, name, dates, source, reference and note; a subject's type, term,
 *   classification, source and scope note; a publisher's name and place. It validates with the shared create body
 *   (`AgentBody`, ...), creates with `POST catalog/<kind>` (201, or 200 when the server brought back an archived
 *   authority of the same key) and edits with `PATCH catalog/<kind>/:id`, sending the row's version and only what
 *   changed. The writes answer `{id, version}` only (S15), so the page reads the authority again afterwards.
 * - "Gabungkan ke otoritas lain…" opens the merge dialog (merge-dialog.tsx); a subject also has the thesaurus editor
 *   (thesaurus-editor.tsx); "Arsipkan" archives one that no live record uses (the server answers 409 CATALOG_IN_USE
 *   otherwise; the page says to merge it instead).
 * - A merged authority is read-only, with a link to its target. Without `catalog.authorities.manage` everything is
 *   read-only.
 *
 * Versions: every write sends the version it was based on, so a change by someone else meanwhile is refused
 * (CONFLICT_STALE, with "Muat ulang data"). The page's own writes chain: when one section saves (the form or the
 * thesaurus, which share the row's version), the other's next write sends the version that save answered rather than
 * the one it was loaded with ({@link useVersionChain}), so saving both in turn needs no reload.
 */

// ---- the form ----------------------------------------------------------------------------------------------------

type FieldName = 'type' | 'name' | 'dates' | 'authoritySource' | 'authorityRef' | 'note' | 'term' | 'classification' | 'scopeNote' | 'place';

/** The form's values: every field as the text in its control. */
type FormValues = Partial<Record<FieldName, string>>;

interface FieldSpec {
  name: FieldName;
  label: AdminKey;
  hint?: AdminKey;
  /** The column width (`maxLength`). */
  max?: number;
  /** A required text (the name or the term). */
  required?: boolean;
  /** Free text, kept as written (a TEXT column). */
  multiline?: boolean;
  /** The values of a select (the type). */
  options?: readonly AuthorityTypeFilter[];
}

const FIELDS: Readonly<Record<AuthorityKind, readonly FieldSpec[]>> = {
  agents: [
    { name: 'type', label: 'catalog.authorities.field.type', options: AGENT_TYPES },
    { name: 'name', label: 'catalog.authorities.field.name', hint: 'catalog.authorities.field.name_hint', max: 191, required: true },
    { name: 'dates', label: 'catalog.authorities.field.dates', hint: 'catalog.authorities.field.dates_hint', max: 64 },
    { name: 'authoritySource', label: 'catalog.authorities.field.authority_source', max: 64 },
    { name: 'authorityRef', label: 'catalog.authorities.field.authority_ref', max: 191 },
    { name: 'note', label: 'catalog.authorities.field.note', multiline: true },
  ],
  subjects: [
    { name: 'type', label: 'catalog.authorities.field.type', options: SUBJECT_TYPES },
    { name: 'term', label: 'catalog.authorities.field.term', max: 191, required: true },
    { name: 'classification', label: 'catalog.authorities.field.classification', max: 64 },
    { name: 'authoritySource', label: 'catalog.authorities.field.authority_source', max: 64 },
    { name: 'scopeNote', label: 'catalog.authorities.field.scope_note', multiline: true },
  ],
  publishers: [
    { name: 'name', label: 'catalog.authorities.field.name', max: 191, required: true },
    { name: 'place', label: 'catalog.authorities.field.place', max: 191 },
  ],
};

/** The create body of each kind: what the form validates with (the server's own schema, D35). */
const SCHEMAS = { agents: AgentBody, subjects: SubjectBody, publishers: PublisherBody } as const;

/**
 * The fields whose change re-indexes the records that use the authority (spec §3.5), as the server decides it: an
 * agent's type, name or dates; a subject's type, term or classification; a publisher's name or place (C08: the
 * documents hold the classification and the place). Each name belongs to the kinds that have it, so one set serves all.
 */
const REINDEXED: ReadonlySet<FieldName> = new Set(['type', 'name', 'dates', 'term', 'classification', 'place']);

function emptyValues(kind: AuthorityKind): FormValues {
  const values: FormValues = {};
  for (const f of FIELDS[kind]) values[f.name] = f.options?.[0] ?? '';
  return values;
}

function valuesOf(kind: AuthorityKind, view: AuthorityView): FormValues {
  const source = view as unknown as Readonly<Record<FieldName, string | null | undefined>>;
  const values: FormValues = {};
  for (const f of FIELDS[kind]) values[f.name] = source[f.name] ?? '';
  return values;
}

/** A value as it is stored: single-line text trimmed, free text kept as written unless it is blank. */
function normalized(f: FieldSpec, value: string | undefined): string {
  const v = value ?? '';
  if (f.multiline === true) return v.trim() === '' ? '' : v;
  return v.trim();
}

/** The create body: the type and the required text always, an optional field only when filled in. */
function createBody(kind: AuthorityKind, values: FormValues): Record<string, string> {
  const body: Record<string, string> = {};
  for (const f of FIELDS[kind]) {
    const v = normalized(f, values[f.name]);
    if (f.options !== undefined || f.required === true || v !== '') body[f.name] = v;
  }
  return body;
}

/** The patch body: the version, then each field that changed (a cleared optional one as null). */
function patchBody(kind: AuthorityKind, values: FormValues, before: FormValues, version: number): { body: Record<string, unknown>; changed: FieldName[] } {
  const body: Record<string, unknown> = { version };
  const changed: FieldName[] = [];
  for (const f of FIELDS[kind]) {
    const now = normalized(f, values[f.name]);
    if (now === normalized(f, before[f.name])) continue;
    changed.push(f.name);
    body[f.name] = now === '' && f.options === undefined && f.required !== true ? null : now;
  }
  return { body, changed };
}

/** Validates the form as the create body of `kind` (FORM_PARSE: each message is its `form.error.<code>` key). */
function resolverOf(kind: AuthorityKind): Resolver<FormValues> {
  return (values) => {
    const parsed = SCHEMAS[kind].safeParse(createBody(kind, values), FORM_PARSE);
    if (parsed.success) return { values, errors: {} };
    const errors: FieldErrors<FormValues> = {};
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0] ?? '') as FieldName;
      if (name === ('' as FieldName) || errors[name] !== undefined) continue;
      errors[name] = { type: issue.code, message: issue.message };
    }
    return { values: {}, errors };
  };
}

/** The fields of `kind`, registered on `form`. */
function AuthorityFields({ kind, form, disabled }: { kind: AuthorityKind; form: ReturnType<typeof useForm<FormValues>>; disabled: boolean }) {
  const t = useT();
  const { errors } = form.formState;
  return (
    <>
      {FIELDS[kind].map((f) => (
        <Field
          key={f.name}
          label={t(f.label)}
          {...(f.hint === undefined ? {} : { hint: t(f.hint) })}
          error={errors[f.name]}
          className={f.multiline === true || f.required === true ? 'sm:col-span-2' : undefined}
        >
          {(c) =>
            f.options !== undefined ? (
              <select {...c} className={SELECT_CLASS} disabled={disabled} {...form.register(f.name)}>
                {f.options.map((value) => (
                  <option key={value} value={value}>
                    {typeLabel(t, value)}
                  </option>
                ))}
              </select>
            ) : f.multiline === true ? (
              <textarea {...c} className={TEXTAREA_CLASS} disabled={disabled} {...form.register(f.name)} />
            ) : (
              <Input {...c} autoComplete="off" maxLength={f.max} disabled={disabled} {...form.register(f.name)} />
            )
          }
        </Field>
      ))}
    </>
  );
}

function BackLink({ kind }: { kind: AuthorityKind }) {
  const t = useT();
  return (
    <Link
      to="/admin/catalog/authorities"
      search={kind === 'agents' ? {} : { kind }}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeftIcon className="size-4" aria-hidden="true" />
      {t('catalog.authorities.back')}
    </Link>
  );
}

/** The edit form of an authority; `onSaved` gets the outcome line. */
function EditForm({
  kind,
  view,
  canEdit,
  versions,
  reload,
  onSaved,
}: {
  kind: AuthorityKind;
  view: AuthorityView;
  canEdit: boolean;
  versions: VersionChain;
  reload(): Promise<AuthorityView | undefined>;
  onSaved(outcome: ReactNode): void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const resolver = useMemo(() => resolverOf(kind), [kind]);
  const form = useForm<FormValues>({ resolver, defaultValues: valuesOf(kind, view) });
  const { isDirty, isSubmitting } = form.formState;
  /** The version the form's values were loaded with. */
  const [base, setBase] = useState(view.version);
  const [problem, setProblem] = useState<unknown>(null);
  useDirtyGuard(isDirty);

  // A newer read of the authority (after a save, a merge, a refetch) refreshes a form nobody is typing in.
  useEffect(() => {
    if (form.formState.isDirty) return;
    form.reset(valuesOf(kind, view));
    setBase(view.version);
  }, [form, kind, view]);

  const reloadData = async (): Promise<void> => {
    const latest = await reload();
    if (latest === undefined) return;
    form.reset(valuesOf(kind, latest));
    setBase(latest.version);
    setProblem(null);
  };

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    const before = form.formState.defaultValues ?? {};
    const sent = versions.advance(base);
    const { body, changed } = patchBody(kind, values, before, sent);
    try {
      if (changed.length > 0) {
        const saved = await api<StoreResponse>('PATCH', authorityPath(kind, view.id), body);
        versions.record(sent, saved.version);
        // Clean first: the authority read again below then refreshes the form (the server's values and version).
        form.reset(values);
        await queryClient.invalidateQueries({ queryKey: authorityKindKey(kind) });
      } else {
        form.reset(values);
      }
      const reindexed = view.usage > 0 && changed.some((name) => REINDEXED.has(name));
      onSaved(
        <>
          <span>{t('form.saved')}</span>
          {reindexed && <span> {t('catalog.authorities.reindex_note')}</span>}
        </>,
      );
    } catch (e) {
      if (e instanceof ApiError) applyServerErrors(form, e);
      setProblem(e);
    }
  });

  const stale = problem instanceof ApiError && problem.code === 'CONFLICT_STALE';
  return (
    <section aria-labelledby={`${view.id}-data`} className="flex flex-col gap-3">
      <h2 id={`${view.id}-data`} className="text-base font-semibold">
        {t('catalog.authorities.section.data')}
      </h2>
      {problem !== null && (
        <Notice
          kind="error"
          action={
            stale ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void reloadData()}>
                {t('form.reload_data')}
              </Button>
            ) : undefined
          }
        >
          {problemText(t, problem)}
        </Notice>
      )}
      <form noValidate onSubmit={(e) => void submit(e)}>
        <fieldset disabled={!canEdit} className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
          <AuthorityFields kind={kind} form={form} disabled={!canEdit} />
          {canEdit && (
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" disabled={isSubmitting}>
                {t(isSubmitting ? 'form.saving' : 'form.save')}
              </Button>
            </div>
          )}
        </fieldset>
      </form>
    </section>
  );
}

/** The merge and archive actions of a live, unmerged authority. */
function Actions({
  kind,
  view,
  versions,
  onDone,
}: {
  kind: AuthorityKind;
  view: AuthorityView;
  versions: VersionChain;
  onDone(outcome: ReactNode): void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const headingId = useId();
  const [merging, setMerging] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const name = authorityName(view);
  const inUse = view.usage > 0;

  const archive = async (): Promise<void> => {
    const sent = versions.advance(view.version);
    const saved = await api<StoreResponse>('DELETE', authorityPath(kind, view.id), { version: sent });
    versions.record(sent, saved.version);
    onDone(t('catalog.authorities.archived_done', { name }));
    await Promise.all([queryClient.invalidateQueries({ queryKey: authorityKindKey(kind) }), queryClient.invalidateQueries({ queryKey: orphansKey(kind) })]);
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <h2 id={headingId} className="text-base font-semibold">
        {t('catalog.authorities.section.actions')}
      </h2>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => setMerging(true)}>
          {t('catalog.authorities.merge.open')}
        </Button>
        {!view.archived && (
          <Button variant="outline" disabled={inUse} onClick={() => setArchiving(true)}>
            {t('catalog.authorities.archive')}
          </Button>
        )}
      </div>
      {!view.archived && inUse && <p className="text-sm text-muted-foreground">{t('catalog.authorities.archive_in_use', { count: view.usage })}</p>}
      <MergeDialog
        kind={kind}
        source={view}
        open={merging}
        onOpenChange={setMerging}
        version={() => versions.advance(view.version)}
        onMerged={(sent, saved, target) => {
          versions.record(sent, saved.version);
          setMerging(false);
          onDone(t('catalog.authorities.merge.done', { target: authorityName(target) }));
          void Promise.all([queryClient.invalidateQueries({ queryKey: authorityKindKey(kind) }), queryClient.invalidateQueries({ queryKey: orphansKey(kind) })]);
        }}
      />
      {archiving && (
        <ConfirmDialog
          open
          destructive
          title={t('catalog.authorities.confirm_archive.title', { name })}
          description={t('catalog.authorities.confirm_archive.body')}
          confirmLabel={t('catalog.authorities.archive')}
          onConfirm={archive}
          onClose={() => setArchiving(false)}
        />
      )}
    </section>
  );
}

/** An existing authority's page. */
function AuthorityPage({ kind, id }: { kind: AuthorityKind; id: string }) {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'catalog.authorities.manage');
  const versions = useVersionChain();
  const query = useApiQuery<AuthorityViewOf[typeof kind]>({ queryKey: authorityKey(kind, id), path: authorityPath(kind, id) });
  const created = useRouterState({ select: (s) => s.location.state.created === true });
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const { refetch } = query;
  const reload = useCallback(async (): Promise<AuthorityView | undefined> => (await refetch()).data, [refetch]);

  const view = query.data;
  if (view === undefined) {
    return query.isError ? (
      <Notice kind="error">{problemText(t, query.error)}</Notice>
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        {t('shell.loading')}
      </p>
    );
  }

  const merged = view.mergedInto !== null;
  const canEdit = canManage && !merged;
  const type = 'type' in view ? typeLabel(t, view.type) : null;
  const subject = kind === 'subjects' ? (view as SubjectView) : null;

  return (
    <>
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{authorityName(view)}</h1>
          <AuthorityBadges view={view} />
        </div>
        <p className="text-sm text-muted-foreground">
          {t(`catalog.authorities.kind.${kind}`)}
          {type !== null && ` · ${type}`}
          {kind === 'agents' && (view as AgentView).dates !== null && ` · ${(view as AgentView).dates}`}
        </p>
        <p className="text-sm">{t('catalog.authorities.usage', { count: view.usage })}</p>
      </header>
      <RefetchProblem query={query} />
      {created && outcome === null && <Notice kind="success">{t('catalog.authorities.saved')}</Notice>}
      {outcome !== null && <Notice kind="success">{outcome}</Notice>}
      {merged ? (
        <p className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm">
          <span>{t('catalog.authorities.merged_notice')}</span>
          <Link to={authorityHref(kind, view.mergedInto!)} className="font-medium text-primary underline-offset-4 hover:underline">
            {t('catalog.authorities.merged_open')}
          </Link>
        </p>
      ) : (
        view.archived && <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">{t('catalog.authorities.archived_notice')}</p>
      )}
      {!canManage && <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">{t('catalog.authorities.read_only')}</p>}
      <EditForm kind={kind} view={view} canEdit={canEdit} versions={versions} reload={reload} onSaved={setOutcome} />
      {subject !== null && <ThesaurusEditor subject={subject} canEdit={canEdit} versions={versions} reload={reload as () => Promise<SubjectView | undefined>} />}
      {canEdit && <Actions kind={kind} view={view} versions={versions} onDone={setOutcome} />}
    </>
  );
}

/** `…/<kind>/new`: the empty form; a save opens the new authority's page. */
function AuthorityCreate({ kind }: { kind: AuthorityKind }) {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'catalog.authorities.manage');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const resolver = useMemo(() => resolverOf(kind), [kind]);
  const form = useForm<FormValues>({ resolver, defaultValues: emptyValues(kind) });
  const { isDirty, isSubmitting } = form.formState;
  const [problem, setProblem] = useState<unknown>(null);
  useDirtyGuard(isDirty);

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    try {
      const saved = await api<StoreResponse>('POST', authorityPath(kind), createBody(kind, values));
      // A new authority is used by no record yet: it is an orphan until one does.
      await Promise.all([queryClient.invalidateQueries({ queryKey: authorityKindKey(kind) }), queryClient.invalidateQueries({ queryKey: orphansKey(kind) })]);
      form.reset(values);
      await navigate({ href: authorityHref(kind, saved.id), state: { created: true } });
    } catch (e) {
      if (e instanceof ApiError) applyServerErrors(form, e);
      setProblem(e);
    }
  });

  return (
    <>
      <h1 className="text-2xl font-semibold">{t(`catalog.authorities.new.${kind}`)}</h1>
      <p className="text-sm text-muted-foreground">{t('catalog.authorities.new.revive_hint')}</p>
      {/* The server would refuse (and record the refusal): say so before anything is typed. */}
      {!canManage && <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />}
      {problem !== null && <Notice kind="error">{problemText(t, problem)}</Notice>}
      <form noValidate onSubmit={(e) => void submit(e)}>
        <fieldset disabled={!canManage} className="grid min-w-0 gap-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
          <AuthorityFields kind={kind} form={form} disabled={!canManage} />
          {canManage && (
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" disabled={isSubmitting}>
                {t(isSubmitting ? 'form.saving' : 'form.save')}
              </Button>
              <Button asChild variant="outline">
                <Link to="/admin/catalog/authorities" search={kind === 'agents' ? {} : { kind }}>
                  {t('form.cancel')}
                </Link>
              </Button>
            </div>
          )}
        </fieldset>
      </form>
    </>
  );
}

export function AuthorityEditScreen() {
  const t = useT();
  const { kind = '', id = '' } = useParams({ strict: false }) as { kind?: string; id?: string };
  // `$id` is `new` or a ULID as `ulidField` takes it; anything else would only be refused by the server.
  const valid = isAuthorityKind(kind) && (id === 'new' || isUlid(id));
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <BackLink kind={isAuthorityKind(kind) ? kind : 'agents'} />
      {!valid ? (
        <Notice kind="error">{t('error.NOT_FOUND')}</Notice>
      ) : id === 'new' ? (
        <AuthorityCreate key={kind} kind={kind} />
      ) : (
        <AuthorityPage key={`${kind}/${id}`} kind={kind} id={id} />
      )}
    </div>
  );
}
