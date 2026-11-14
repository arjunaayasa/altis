import { ATTACHMENT_ACCESS, type AttachmentAccess } from '@altis/shared';
import { AttachmentPatchBody, type AttachmentCreateBody, type AttachmentListResponse, type AttachmentView } from '@altis/shared/api/catalog/attachments';
import { isHttpUrl } from '@altis/shared/api/catalog/common';
import { issueCode } from '@altis/shared/api/common';
import { useQueryClient } from '@tanstack/react-query';
import { ArchiveIcon, ExternalLinkIcon, FileIcon, LinkIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge, Field, Notice, RefetchProblem, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { fieldErrorKey, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { uploadFile, type UploadOptions } from '@/lib/upload';
// ---- Komunitas (member area) ----
import { useMemberTypes, useTypeName } from '@/screens/circulation/common';

/**
 * The attachments of a record in the record editor (Phase 2 spec §8, §13; plan Task 18): the list
 * (`GET catalog/records/:id/attachments`), upload a file (`uploadFile`, context `catalog.attachment`) or add a link
 * (`POST catalog/records/:id/attachments`), edit the title, description and access of one
 * (`PATCH catalog/attachments/:id`), archive one (`DELETE catalog/attachments/:id`, after a confirmation).
 *
 * - The write routes answer `{id, version}` only (S15): after each write the panel reads the list again.
 * - A link is written into an `href` only when it is http(s) (S4: the renderers re-check the scheme); any other is
 *   shown as text. A file opens from `/files/<id>` (the server decides what a browser shows inline).
 * - The panel renders no `<form>`: the editor may hold it inside its own form. Its parts are `role="form"` regions
 *   whose buttons are `type="button"`, and Enter in one of their text fields runs the part's own action, never the
 *   editor's submit.
 * - Without `catalog.records.manage` it only lists.
 */
export interface AttachmentsPanelProps {
  recordId: string;
}

/** `uploadFile`'s options for an attachment. */
const uploadContext: Pick<UploadOptions, 'context'> = { context: 'catalog.attachment' };

/** The query key of a record's attachments. */
const attachmentsKey = (recordId: string) => ['catalog', 'attachments', recordId] as const;

/** Field errors by field name: the `code` of the check (the server's `{path, code}`, or the same code found here). */
type FieldErrors = Partial<Record<'file' | 'url' | 'title' | 'description' | 'access', string>>;

/** A field's error for {@link Field}: the panel's own text for a link that is not http(s), else `form.error.<code>`. */
function fieldError(code: string | undefined): { type: string; message: string } | undefined {
  if (code === undefined) return undefined;
  if (code === 'invalid_url') return { type: code, message: 'catalog.attachments.url_invalid' };
  if (code === 'file_required') return { type: code, message: 'catalog.attachments.file_required' };
  return { type: code, message: fieldErrorKey(code) };
}

/** The checks of the title, description and access (the contract's own, through the patch body: same widths). */
function commonErrors(o: { title: string; description: string; access: AttachmentAccess }): FieldErrors {
  const parsed = AttachmentPatchBody.safeParse({ version: 0, title: o.title, description: o.description === '' ? null : o.description, access: o.access });
  const errors: FieldErrors = {};
  if (o.title.trim() === '') errors.title = 'required';
  if (parsed.success) return errors;
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if ((field === 'title' || field === 'description' || field === 'access') && errors[field] === undefined) errors[field] = issueCode(issue);
  }
  return errors;
}

/** The server's VALIDATION_FAILED as field errors; null when it names a path the panel has no field for. */
function serverErrors(e: unknown, fields: readonly (keyof FieldErrors)[]): FieldErrors | null {
  if (!(e instanceof ApiError) || e.code !== 'VALIDATION_FAILED' || (e.errors?.length ?? 0) === 0) return null;
  const errors: FieldErrors = {};
  for (const { path, code } of e.errors ?? []) {
    const field = (path === 'fileId' ? 'file' : path) as keyof FieldErrors;
    if (!fields.includes(field)) return null;
    errors[field] ??= code;
  }
  return errors;
}

/** Enter in a single-line field runs `action` (and never submits a form around the panel). */
function enterRuns(action: () => void) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (event.key !== 'Enter' || !(target instanceof HTMLInputElement) || target.type === 'file' || target.type === 'radio') return;
    event.preventDefault();
    action();
  };
}

/** Bytes as B, KiB, MiB or GiB in the UI language. */
function useBytes(): (bytes: number) => string {
  const locale = useLocale();
  return useCallback(
    (bytes: number) => {
      const units = ['B', 'KiB', 'MiB', 'GiB'];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      const n = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID', { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
      return `${n} ${units[unit]}`;
    },
    [locale],
  );
}

/** The access choice, labelled with the shared vocabulary. */
function AccessSelect({ id, value, onChange, invalid, describedBy }: { id: string; value: AttachmentAccess; onChange(v: AttachmentAccess): void; invalid: boolean; describedBy?: string | undefined }) {
  const t = useT();
  return (
    <select
      id={id}
      className={SELECT_CLASS}
      value={value}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value as AttachmentAccess)}>
      {ATTACHMENT_ACCESS.map((access) => (
        <option key={access} value={access}>
          {t(`vocab.attachment_access.${access}`)}
        </option>
      ))}
    </select>
  );
}

// ---- Komunitas (member area) ----
/** The member types an attachment for signed-in members lists (none ticked: every signed-in member). */
function MemberTypesPicker({ value, onChange }: { value: readonly string[]; onChange(v: string[]): void }) {
  const t = useT();
  const typeName = useTypeName();
  const types = useMemberTypes();
  const legend = useId();
  if (types.isError) return <p className="text-sm text-muted-foreground sm:col-span-2">{t('catalog.attachments.member_types_unreadable')}</p>;
  return (
    <fieldset className="grid gap-1 sm:col-span-2" aria-describedby={`${legend}-hint`}>
      <legend className="mb-1 text-sm font-medium">{t('catalog.attachments.field.member_types')}</legend>
      <p id={`${legend}-hint`} className="text-xs text-muted-foreground">
        {t('catalog.attachments.member_types_hint')}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {(types.data?.items ?? []).map((mt) => (
          <label key={mt.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={value.includes(mt.id)}
              onChange={(e) => onChange(e.target.checked ? [...value, mt.id] : value.filter((id) => id !== mt.id))}
            />
            {typeName(mt)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Whether two lists hold the same ids. */
const sameIds = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id) => b.includes(id));

/** Where an attachment opens, or null for a link that is not http(s) (S4). */
function hrefOf(a: AttachmentView): string | null {
  if (a.kind === 'file') return a.fileId === null ? null : `/files/${encodeURIComponent(a.fileId)}`;
  return a.url !== null && isHttpUrl(a.url) ? a.url : null;
}

function AttachmentRow({
  attachment: a,
  canManage,
  onEdit,
  onArchive,
}: {
  attachment: AttachmentView;
  canManage: boolean;
  onEdit(): void;
  onArchive(): void;
}) {
  const t = useT();
  const bytes = useBytes();
  const href = hrefOf(a);
  const facts: string[] = [];
  if (a.kind === 'file') {
    if (a.mime !== null) facts.push(a.mime);
    if (a.size !== null) facts.push(bytes(a.size));
  }
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {a.kind === 'file' ? <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <LinkIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="font-medium break-words">{a.title}</span>
          <Badge tone={a.access === 'public' ? 'info' : 'neutral'}>{t(`vocab.attachment_access.${a.access}`)}</Badge>
        </div>
        {a.kind === 'url' && a.url !== null && <span className="text-xs break-all text-muted-foreground">{a.url}</span>}
        {facts.length > 0 && <span className="text-xs text-muted-foreground">{facts.join(' · ')}</span>}
        {a.description !== null && <p className="text-sm break-words whitespace-pre-line">{a.description}</p>}
        <span className="text-xs text-muted-foreground">{t('catalog.attachments.read_count', { count: a.readCount })}</span>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {href !== null && (
          <Button asChild variant="outline" size="sm">
            <a href={href} target="_blank" rel="noopener noreferrer" aria-label={t('catalog.attachments.open_label', { title: a.title })}>
              <ExternalLinkIcon aria-hidden="true" />
              {t('catalog.attachments.open')}
            </a>
          </Button>
        )}
        {canManage && (
          <>
            <Button type="button" variant="outline" size="sm" aria-label={t('catalog.attachments.edit_label', { title: a.title })} onClick={onEdit}>
              <PencilIcon aria-hidden="true" />
              {t('catalog.attachments.edit')}
            </Button>
            <Button type="button" variant="outline" size="sm" aria-label={t('catalog.attachments.archive_label', { title: a.title })} onClick={onArchive}>
              <ArchiveIcon aria-hidden="true" />
              {t('catalog.attachments.archive')}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/** The problem of a part that no field shows; nothing for null. */
function PartProblem({ text }: { text: string | null }): ReactNode {
  return text === null ? null : <Notice kind="error">{text}</Notice>;
}

/** Title, description and access of an attachment: sends only what changed, with the attachment's version. */
function EditAttachment({ attachment: a, onDone, onCancel }: { attachment: AttachmentView; onDone(): Promise<void>; onCancel(): void }) {
  const t = useT();
  const ids = { title: useId(), description: useId(), access: useId() };
  const [title, setTitle] = useState(a.title);
  const [description, setDescription] = useState(a.description ?? '');
  const [access, setAccess] = useState<AttachmentAccess>(a.access);
  const [memberTypeIds, setMemberTypeIds] = useState<string[]>(a.memberTypeIds ?? []);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (busy) return;
    setProblem(null);
    const found = commonErrors({ title, description, access });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body: AttachmentPatchBody = { version: a.version };
    if (title !== a.title) body.title = title;
    if ((description === '' ? null : description) !== a.description) body.description = description === '' ? null : description;
    if (access !== a.access) body.access = access;
    if (access === 'members' && (access !== a.access || !sameIds(memberTypeIds, a.memberTypeIds ?? []))) body.memberTypeIds = memberTypeIds;
    setBusy(true);
    try {
      if (Object.keys(body).length > 1) await api('PATCH', `catalog/attachments/${encodeURIComponent(a.id)}`, body);
      setBusy(false);
      await onDone();
    } catch (e) {
      setBusy(false);
      const placed = serverErrors(e, ['title', 'description', 'access']);
      if (placed === null) setProblem(problemText(t, e));
      else setErrors(placed);
    }
  };

  return (
    <li className="py-3">
      <div role="form" aria-label={t('catalog.attachments.edit_form', { title: a.title })} className="grid gap-3 sm:grid-cols-2" onKeyDown={enterRuns(() => void save())}>
        <PartProblem text={problem} />
        <Field id={ids.title} label={t('catalog.attachments.field.title')} error={fieldError(errors.title)}>
          {(c) => <Input {...c} maxLength={191} autoComplete="off" value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field id={ids.access} label={t('catalog.attachments.field.access')} error={fieldError(errors.access)}>
          {(c) => <AccessSelect id={c.id} value={access} onChange={setAccess} invalid={c['aria-invalid'] === true} describedBy={c['aria-describedby']} />}
        </Field>
        {access === 'members' && <MemberTypesPicker value={memberTypeIds} onChange={setMemberTypeIds} />}
        <Field id={ids.description} label={t('catalog.attachments.field.description')} error={fieldError(errors.description)} className="sm:col-span-2">
          {(c) => <textarea {...c} className={TEXTAREA_CLASS} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="button" disabled={busy} onClick={() => void save()}>
            {t(busy ? 'form.saving' : 'form.save')}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            {t('form.cancel')}
          </Button>
        </div>
      </div>
    </li>
  );
}

/** Upload a file or add a link. */
function AddAttachment({ recordId, onAdded }: { recordId: string; onAdded(): Promise<void> }) {
  const t = useT();
  const kindName = useId();
  const ids = { file: useId(), url: useId(), title: useId(), description: useId(), access: useId() };
  const fileInput = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<'file' | 'url'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [access, setAccess] = useState<AttachmentAccess>('public');
  const [memberTypeIds, setMemberTypeIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ phase: 'hashing' | 'uploading'; percent: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = (): void => {
    setFile(null);
    setUrl('');
    setTitle('');
    setDescription('');
    setAccess('public');
    setErrors({});
    if (fileInput.current !== null) fileInput.current.value = '';
  };

  const add = async (): Promise<void> => {
    if (busy) return;
    setProblem(null);
    const found = commonErrors({ title, description, access });
    if (kind === 'file' && file === null) found.file = 'file_required';
    if (kind === 'url' && !isHttpUrl(url.trim())) found.url = url.trim() === '' ? 'required' : 'invalid_url';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const common = { title, ...(description === '' ? {} : { description }), access, ...(access === 'members' ? { memberTypeIds } : {}) };
    setBusy(true);
    try {
      let body: AttachmentCreateBody;
      if (kind === 'file' && file !== null) {
        setProgress({ phase: 'hashing', percent: 0 });
        const percent = (done: number, total: number): number => (total === 0 ? 100 : Math.floor((done / total) * 100));
        const { uploadId } = await uploadFile(file, {
          ...uploadContext,
          onHashProgress: (done, total) => setProgress({ phase: 'hashing', percent: percent(done, total) }),
          onProgress: (done, total) => setProgress({ phase: 'uploading', percent: percent(done, total) }),
        });
        body = { kind: 'file', fileId: uploadId, ...common };
      } else {
        body = { kind: 'url', url: url.trim(), ...common };
      }
      await api('POST', `catalog/records/${encodeURIComponent(recordId)}/attachments`, body);
      setBusy(false);
      setProgress(null);
      reset();
      await onAdded();
    } catch (e) {
      setBusy(false);
      setProgress(null);
      const placed = serverErrors(e, ['file', 'url', 'title', 'description', 'access']);
      if (placed === null) setProblem(problemText(t, e));
      else setErrors(placed);
    }
  };

  const chooseFile = (chosen: File | null): void => {
    setFile(chosen);
    setErrors((e) => ({ ...e, file: undefined }));
    // The file's name is the title until the librarian types one.
    if (chosen !== null && title.trim() === '') setTitle(chosen.name.slice(0, 191));
  };

  return (
    <div role="form" aria-label={t('catalog.attachments.add_title')} className="grid gap-3 border-t pt-4 sm:grid-cols-2" onKeyDown={enterRuns(() => void add())}>
      <h3 className="text-sm font-semibold sm:col-span-2">{t('catalog.attachments.add_title')}</h3>
      <PartProblem text={problem} />
      <fieldset className="flex flex-wrap gap-4 sm:col-span-2" disabled={busy}>
        <legend className="mb-1 text-sm font-medium">{t('catalog.attachments.kind')}</legend>
        {(['file', 'url'] as const).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input type="radio" name={kindName} value={k} checked={kind === k} onChange={() => setKind(k)} className="size-4 accent-primary" />
            {t(`vocab.attachment_kind.${k}`)}
          </label>
        ))}
      </fieldset>
      {kind === 'file' ? (
        <Field id={ids.file} label={t('catalog.attachments.field.file')} hint={t('catalog.attachments.field.file_hint')} error={fieldError(errors.file)} className="sm:col-span-2">
          {(c) => <Input {...c} ref={fileInput} type="file" disabled={busy} onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} />}
        </Field>
      ) : (
        <Field id={ids.url} label={t('catalog.attachments.field.url')} hint={t('catalog.attachments.field.url_hint')} error={fieldError(errors.url)} className="sm:col-span-2">
          {(c) => <Input {...c} type="url" inputMode="url" maxLength={2000} autoComplete="off" spellCheck={false} disabled={busy} value={url} onChange={(e) => setUrl(e.target.value)} />}
        </Field>
      )}
      <Field id={ids.title} label={t('catalog.attachments.field.title')} error={fieldError(errors.title)}>
        {(c) => <Input {...c} maxLength={191} autoComplete="off" disabled={busy} value={title} onChange={(e) => setTitle(e.target.value)} />}
      </Field>
      <Field id={ids.access} label={t('catalog.attachments.field.access')} error={fieldError(errors.access)}>
        {(c) => <AccessSelect id={c.id} value={access} onChange={setAccess} invalid={c['aria-invalid'] === true} describedBy={c['aria-describedby']} />}
      </Field>
      {access === 'members' && <MemberTypesPicker value={memberTypeIds} onChange={setMemberTypeIds} />}
      <Field id={ids.description} label={t('catalog.attachments.field.description')} error={fieldError(errors.description)} className="sm:col-span-2">
        {(c) => <textarea {...c} className={TEXTAREA_CLASS} disabled={busy} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="button" disabled={busy} onClick={() => void add()}>
          <PlusIcon aria-hidden="true" />
          {t(busy ? 'catalog.attachments.adding' : 'catalog.attachments.add')}
        </Button>
        {progress !== null && (
          <span role="status" className="text-sm text-muted-foreground tabular-nums">
            {t(progress.phase === 'hashing' ? 'catalog.attachments.hashing' : 'catalog.attachments.uploading', { percent: progress.percent })}
          </span>
        )}
      </div>
    </div>
  );
}

/** The outcome line after a write (`role="status"`). */
function useOutcome(t: Translate) {
  const [outcome, setOutcome] = useState<'added' | 'saved' | 'archived' | null>(null);
  const node = outcome === null ? null : <Notice kind="success">{t(`catalog.attachments.${outcome}`)}</Notice>;
  return { node, setOutcome };
}

export function AttachmentsPanel({ recordId }: AttachmentsPanelProps) {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'catalog.records.manage');
  const queryClient = useQueryClient();
  const titleId = useId();
  const key = attachmentsKey(recordId);
  const list = useApiQuery<AttachmentListResponse>({ queryKey: key, path: `catalog/records/${encodeURIComponent(recordId)}/attachments` });
  const [editing, setEditing] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<AttachmentView | null>(null);
  const { node: outcome, setOutcome } = useOutcome(t);

  const reload = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key });

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h2 id={titleId} className="text-base font-semibold">
          {t('catalog.attachments.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('catalog.attachments.description')}</p>
      </div>
      {outcome}
      {list.data === undefined ? (
        list.isError ? (
          <Notice kind="error">{problemText(t, list.error)}</Notice>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )
      ) : (
        <>
          <RefetchProblem query={list} />
          {list.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('catalog.attachments.empty')}</p>
          ) : (
            <ul className="divide-y">
              {list.data.items.map((a) =>
                editing === a.id && canManage ? (
                  <EditAttachment
                    key={a.id}
                    attachment={a}
                    onCancel={() => setEditing(null)}
                    onDone={async () => {
                      setEditing(null);
                      setOutcome('saved');
                      await reload();
                    }}
                  />
                ) : (
                  <AttachmentRow
                    key={a.id}
                    attachment={a}
                    canManage={canManage}
                    onEdit={() => {
                      setOutcome(null);
                      setEditing(a.id);
                    }}
                    onArchive={() => {
                      setOutcome(null);
                      setArchiving(a);
                    }}
                  />
                ),
              )}
            </ul>
          )}
        </>
      )}
      {canManage && (
        <AddAttachment
          recordId={recordId}
          onAdded={async () => {
            setOutcome('added');
            await reload();
          }}
        />
      )}
      <ConfirmDialog
        open={archiving !== null}
        title={t('catalog.attachments.archive_title')}
        description={t('catalog.attachments.archive_body', { title: archiving?.title ?? '' })}
        confirmLabel={t('catalog.attachments.archive')}
        destructive
        onConfirm={async () => {
          if (archiving === null) return;
          await api('DELETE', `catalog/attachments/${encodeURIComponent(archiving.id)}`, { version: archiving.version });
          setOutcome('archived');
          await reload();
        }}
        onClose={() => setArchiving(null)}
      />
    </section>
  );
}
