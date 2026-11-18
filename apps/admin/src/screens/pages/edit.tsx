import {
  BODY_FORMATS,
  EVENT_PLACE_MAX,
  NEWS_CATEGORIES,
  PAGE_LOCALES,
  PAGE_STATUSES,
  type BodyFormat,
  type NewsCategory,
  type PageKind,
  type PageLocale,
  type PageStatus,
} from '@altis/shared';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import {
  PageBody,
  PagePatchBody,
  type PagePreviewResponse,
  type PageTranslationInput,
  type PageTranslationView,
  type PageView,
} from '@altis/shared/api/opac-pages';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useForm, useWatch, type FieldPath, type UseFormReturn } from 'react-hook-form';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CheckField, Field, Notice, ProblemAlert, RefetchProblem, RootError, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { BackLink, Callout, ErrorState, FORM_FULL, FormBar, FormSection, LAYER, LoadingState, PageHead } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger, WRAPPING_TABS } from '@/components/ui/tabs';
import { FileInput } from '@/components/file-input';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { FORM_PARSE, ROOT_ERROR, applyServerErrors, problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { uploadFile } from '@/lib/upload';
import { cn } from '@/lib/utils';
import { PAGES_KEY, fromLocalInput, kindOf, opacPath, pageHref, pagesListHref, pagesListTarget, slugify, toLocalInput } from './shared';

/**
 * Halaman & Berita, the editor (Phase 2 spec §9.5, §13; plan Task 20): a new page or news post (`POST opac/pages`,
 * `?kind=` from the list) and an existing one (`GET opac/pages/:id`, `PATCH opac/pages/:id`).
 *
 * - Publication: the address (slug, suggested from the Indonesian title until it is typed), the status, the
 *   publication time (empty: when it is saved as published; a future time schedules it), shown in the OPAC menu, the
 *   order. Content per language on two tabs: Indonesian (required) and English (optional, behind a check box: without
 *   it the OPAC shows the Indonesian text); each has a title, a summary, a body format and the body.
 * - Agenda (news only): the category (or none) and the event the post announces, its start and end (`datetime-local`,
 *   the browser's time zone, as the publication time) and its place. An end or a place needs a start and the end is
 *   not before it: said at the field before anything is sent.
 * - The body's preview is the server's own rendering (`POST opac/pages/preview`, sanitized exactly as the OPAC does),
 *   shown only in `<iframe sandbox="" srcDoc>`: no scripts, an opaque origin, never the admin's own DOM (S6).
 * - An image is uploaded as `opac.page_image` (lib/upload.ts) and inserted where the cursor was:
 *   `![alt](/files/<id>)` in Markdown, `<img>` in HTML. Saving the page makes it the page's (core opac-pages).
 * - The writes answer `{id, version}` only (S15): a create opens the new page's editor, which reads it with GET; an
 *   edit sends only what changed with the version it holds, and keeps the version the server answered for the next
 *   save. A stale version (409) offers to load the latest data. The body is checked with the shared contract first
 *   (the same field codes as the server's); the server's field errors land on their fields, on the tab that has them.
 * - An archived page is read only; without `opac.pages.manage` nothing is asked (every route needs it).
 */

interface TranslationValues {
  title: string;
  summary: string;
  bodyFormat: BodyFormat;
  body: string;
}

interface PageFormValues {
  slug: string;
  status: PageStatus;
  /** An `<input type="datetime-local">` value, '' for none. */
  publishedAt: string;
  showInNav: boolean;
  /** A number field's text. */
  sortOrder: string;
  /** News only: the category, '' for none. */
  category: NewsCategory | '';
  /** News only: `datetime-local` values of the event, '' for none. */
  eventStartsAt: string;
  eventEndsAt: string;
  eventPlace: string;
  /** Whether the English translation is kept (or added). */
  hasEnglish: boolean;
  translations: Record<PageLocale, TranslationValues>;
}

/** What the editor last saved (or loaded): the values the next edit is compared with, and the page's version. */
interface Baseline {
  values: PageFormValues;
  version: number;
}

const BLANK_TRANSLATION: TranslationValues = { title: '', summary: '', bodyFormat: 'markdown', body: '' };

function translationValues(t: PageTranslationView | null): TranslationValues {
  return t === null ? { ...BLANK_TRANSLATION } : { title: t.title, summary: t.summary ?? '', bodyFormat: t.bodyFormat, body: t.body };
}

function formValues(page: PageView | null): PageFormValues {
  if (page === null) {
    return {
      slug: '',
      status: 'draft',
      publishedAt: '',
      showInNav: false,
      sortOrder: '0',
      category: '',
      eventStartsAt: '',
      eventEndsAt: '',
      eventPlace: '',
      hasEnglish: false,
      translations: { id: { ...BLANK_TRANSLATION }, en: { ...BLANK_TRANSLATION } },
    };
  }
  return {
    slug: page.slug,
    status: page.status,
    publishedAt: toLocalInput(page.publishedAt),
    showInNav: page.showInNav,
    sortOrder: String(page.sortOrder),
    category: page.category ?? '',
    eventStartsAt: toLocalInput(page.eventStartsAt),
    eventEndsAt: toLocalInput(page.eventEndsAt),
    eventPlace: page.eventPlace ?? '',
    hasEnglish: page.translations.en !== null,
    translations: { id: translationValues(page.translations.id), en: translationValues(page.translations.en) },
  };
}

/** A translation as the API takes it: a blank summary left out (the server stores none). */
function translationInput(v: TranslationValues): PageTranslationInput {
  return { title: v.title, ...(v.summary.trim() === '' ? {} : { summary: v.summary }), bodyFormat: v.bodyFormat, body: v.body };
}

const sameTranslation = (a: TranslationValues, b: TranslationValues): boolean =>
  a.title === b.title && a.summary === b.summary && a.bodyFormat === b.bodyFormat && a.body === b.body;

/** The order as a number (an empty field is 0; anything else the contract checks). */
const sortOrderOf = (text: string): number => (text.trim() === '' ? 0 : Number(text));

/** The times of the form, read from their `datetime-local` fields. */
interface FormTimes {
  publishedAt: number | null;
  eventStartsAt: number | null;
  eventEndsAt: number | null;
}

/** The place as it is sent: trimmed, null for a blank one. */
const placeOf = (text: string): string | null => (text.trim() === '' ? null : text.trim());

function createBody(kind: PageKind, v: PageFormValues, times: FormTimes): unknown {
  const place = placeOf(v.eventPlace);
  return {
    kind,
    slug: v.slug,
    status: v.status,
    ...(times.publishedAt === null ? {} : { publishedAt: times.publishedAt }),
    showInNav: v.showInNav,
    sortOrder: sortOrderOf(v.sortOrder),
    // The agenda is a news post's: a page sends none of it.
    ...(kind !== 'news' || v.category === '' ? {} : { category: v.category }),
    ...(kind !== 'news' || times.eventStartsAt === null ? {} : { eventStartsAt: times.eventStartsAt }),
    ...(kind !== 'news' || times.eventEndsAt === null ? {} : { eventEndsAt: times.eventEndsAt }),
    ...(kind !== 'news' || place === null ? {} : { eventPlace: place }),
    translations: { id: translationInput(v.translations.id), ...(v.hasEnglish ? { en: translationInput(v.translations.en) } : {}) },
  };
}

/** The patch from `base` to `v`: the version and only what changed (a changed translation is sent whole). */
function patchBody(kind: PageKind, base: Baseline, v: PageFormValues, times: FormTimes): Record<string, unknown> {
  const before = base.values;
  const body: Record<string, unknown> = { version: base.version };
  if (v.slug !== before.slug) body['slug'] = v.slug;
  if (v.status !== before.status) body['status'] = v.status;
  if (v.publishedAt !== before.publishedAt) body['publishedAt'] = times.publishedAt;
  if (kind === 'news') {
    if (v.category !== before.category) body['category'] = v.category === '' ? null : v.category;
    if (v.eventStartsAt !== before.eventStartsAt) body['eventStartsAt'] = times.eventStartsAt;
    if (v.eventEndsAt !== before.eventEndsAt) body['eventEndsAt'] = times.eventEndsAt;
    if (placeOf(v.eventPlace) !== placeOf(before.eventPlace)) body['eventPlace'] = placeOf(v.eventPlace);
  }
  if (v.showInNav !== before.showInNav) body['showInNav'] = v.showInNav;
  if (sortOrderOf(v.sortOrder) !== sortOrderOf(before.sortOrder)) body['sortOrder'] = sortOrderOf(v.sortOrder);
  const translations: Record<string, unknown> = {};
  if (!sameTranslation(v.translations.id, before.translations.id)) translations['id'] = translationInput(v.translations.id);
  if (v.hasEnglish && (!before.hasEnglish || !sameTranslation(v.translations.en, before.translations.en))) {
    translations['en'] = translationInput(v.translations.en);
  }
  if (!v.hasEnglish && before.hasEnglish) translations['en'] = null;
  if (Object.keys(translations).length > 0) body['translations'] = translations;
  return body;
}

/** The tab that holds the field at `path`, if a translation's. */
function tabOf(path: string): PageLocale | null {
  if (path.startsWith('translations.id')) return 'id';
  if (path.startsWith('translations.en')) return 'en';
  return null;
}

/** The fields of the form, by the paths the contract and the server name them. */
const FIELDS: ReadonlySet<string> = new Set([
  'slug',
  'status',
  'publishedAt',
  'showInNav',
  'sortOrder',
  'category',
  'eventStartsAt',
  'eventEndsAt',
  'eventPlace',
  ...PAGE_LOCALES.flatMap((l) => ['title', 'summary', 'bodyFormat', 'body'].map((f) => `translations.${l}.${f}`)),
]);

/** Enter in a single-line field of a part runs `action`, never the page form's submit. */
function enterRuns(action: () => void) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (event.key !== 'Enter' || !(target instanceof HTMLInputElement) || target.type === 'file') return;
    event.preventDefault();
    action();
  };
}

/** `"&<>` escaped for an HTML attribute value. */
const attribute = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The image `fileId` as the body's format writes it, with `alt` on one line (and escaped). */
function imageSnippet(format: BodyFormat, fileId: string, alt: string): string {
  const flat = alt.replace(/\s+/g, ' ').trim();
  if (format === 'html') return `<p><img src="/files/${fileId}" alt="${attribute(flat)}"></p>`;
  return `![${flat.replace(/[\\[\]]/g, (c) => `\\${c}`)}](/files/${fileId})`;
}

/** `snippet` put between `text[0, start)` and `text[end, …)` as a block of its own (blank lines around it). */
function insertBlock(text: string, start: number, end: number, snippet: string): string {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after.startsWith('\n') ? '' : '\n';
  return `${before}${lead}${snippet}${trail}${after}`;
}

/** Upload an image and insert it into the body of one language. */
function ImageInsert({ format, onInsert, disabled }: { format: BodyFormat; onInsert(snippet: string): void; disabled: boolean }) {
  const t = useT();
  const ids = { file: useId(), alt: useId() };
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState('');
  const [errors, setErrors] = useState<{ file?: string; alt?: string }>({});
  const [progress, setProgress] = useState<{ phase: 'hashing' | 'uploading'; percent: number } | null>(null);
  const [outcome, setOutcome] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const insert = async (): Promise<void> => {
    if (progress !== null) return;
    setOutcome(null);
    const found: { file?: string; alt?: string } = {};
    if (file === null) found.file = 'pages.image.file_required';
    if (alt.trim() === '') found.alt = 'pages.image.alt_required';
    setErrors(found);
    if (file === null || found.alt !== undefined) return;
    const percent = (done: number, total: number): number => (total === 0 ? 100 : Math.floor((done / total) * 100));
    setProgress({ phase: 'hashing', percent: 0 });
    try {
      const { uploadId } = await uploadFile(file, {
        context: 'opac.page_image',
        onHashProgress: (done, total) => setProgress({ phase: 'hashing', percent: percent(done, total) }),
        onProgress: (done, total) => setProgress({ phase: 'uploading', percent: percent(done, total) }),
      });
      onInsert(imageSnippet(format, uploadId, alt));
      setFile(null);
      setAlt('');
      if (fileInput.current !== null) fileInput.current.value = '';
      setOutcome({ kind: 'success', text: t('pages.image.inserted') });
    } catch (e) {
      setOutcome({ kind: 'error', text: problemText(t, e) });
    } finally {
      setProgress(null);
    }
  };

  const busy = disabled || progress !== null;
  return (
    <div role="group" aria-label={t('pages.image.title')} className={cn('grid gap-x-5 gap-y-4 rounded-lg border p-4 sm:grid-cols-2', LAYER)} onKeyDown={enterRuns(() => void insert())}>
      <h3 className="text-sm font-bold sm:col-span-2">{t('pages.image.title')}</h3>
      <Field id={ids.file} label={t('pages.image.file')} hint={t('pages.image.file_hint')} error={errors.file}>
        {(c) => (
          <FileInput
            {...c}
            ref={fileInput}
            chosen={file?.name ?? null}
            accept="image/jpeg,image/png,image/webp,image/gif"
            disabled={busy}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setErrors((x) => ({ ...x, file: undefined }));
            }}
          />
        )}
      </Field>
      <Field id={ids.alt} label={t('pages.image.alt')} hint={t('pages.image.alt_hint')} error={errors.alt}>
        {(c) => <Input {...c} maxLength={191} autoComplete="off" disabled={busy} value={alt} onChange={(e) => setAlt(e.target.value)} />}
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void insert()}>
          {t('pages.image.insert')}
        </Button>
        {progress !== null && (
          <span role="status" className="text-meta text-muted-foreground tabular-nums">
            {t(progress.phase === 'hashing' ? 'pages.image.hashing' : 'pages.image.uploading', { percent: progress.percent })}
          </span>
        )}
      </div>
      {outcome !== null && (
        <div className="sm:col-span-2">
          <Notice kind={outcome.kind}>{outcome.text}</Notice>
        </div>
      )}
    </div>
  );
}

/**
 * The fields of one language: title, summary, body format and body, with the preview and the image insert. `onTitle`
 * hears each change of the title (a new page's address follows the Indonesian one).
 */
function TranslationFields({
  form,
  locale,
  disabled,
  onTitle,
}: {
  form: UseFormReturn<PageFormValues>;
  locale: PageLocale;
  disabled: boolean;
  onTitle?(title: string): void;
}) {
  const t = useT();
  const errors = form.formState.errors.translations?.[locale];
  const format = useWatch({ control: form.control, name: `translations.${locale}.bodyFormat` });
  const bodyField = `translations.${locale}.body` as const;
  const body = form.register(bodyField);
  /** Where the cursor was when the body last lost the focus (an image goes there); null: at the end. */
  const caret = useRef<{ start: number; end: number } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);

  const showPreview = async (): Promise<void> => {
    setPreviewBusy(true);
    setPreviewProblem(null);
    try {
      const { bodyFormat, body: text } = form.getValues(`translations.${locale}`);
      const answer = await api<PagePreviewResponse>('POST', 'opac/pages/preview', { bodyFormat, body: text });
      setPreview(answer.html);
    } catch (e) {
      setPreviewProblem(problemText(t, e));
    } finally {
      setPreviewBusy(false);
    }
  };

  const insertImage = (snippet: string): void => {
    const text = form.getValues(bodyField);
    const at = caret.current ?? { start: text.length, end: text.length };
    const next = insertBlock(text, Math.min(at.start, text.length), Math.min(at.end, text.length), snippet);
    form.setValue(bodyField, next, { shouldDirty: true });
    caret.current = null;
  };

  return (
    <div className="grid gap-4">
      <Field label={t('pages.field.title')} error={errors?.title}>
        {(c) => (
          <Input
            {...c}
            maxLength={191}
            autoComplete="off"
            {...form.register(`translations.${locale}.title`, { onChange: (e: { target: { value: string } }) => onTitle?.(e.target.value) })}
          />
        )}
      </Field>
      <Field label={t('pages.field.summary')} hint={t('pages.field.summary_hint')} error={errors?.summary}>
        {(c) => <textarea {...c} className={TEXTAREA_CLASS} rows={2} {...form.register(`translations.${locale}.summary`)} />}
      </Field>
      <Field label={t('pages.field.body_format')} error={errors?.bodyFormat} className="sm:max-w-xs">
        {(c) => (
          <select {...c} className={SELECT_CLASS} {...form.register(`translations.${locale}.bodyFormat`)}>
            {BODY_FORMATS.map((f) => (
              <option key={f} value={f}>
                {t(`vocab.body_format.${f}`)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={t('pages.field.body')} hint={t(format === 'html' ? 'pages.field.body_hint.html' : 'pages.field.body_hint.markdown')} error={errors?.body}>
        {(c) => (
          <textarea
            {...c}
            className={`${TEXTAREA_CLASS} min-h-72 font-mono`}
            spellCheck
            {...body}
            onBlur={(e) => {
              caret.current = { start: e.target.selectionStart, end: e.target.selectionEnd };
              void body.onBlur(e);
            }}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={previewBusy} onClick={() => void showPreview()}>
          {t('pages.preview.button')}
        </Button>
        {previewBusy && (
          <span role="status" className="text-meta text-muted-foreground">
            {t('pages.preview.loading')}
          </span>
        )}
      </div>
      {previewProblem !== null && <Notice kind="error">{previewProblem}</Notice>}
      {preview !== null && (
        <div className="grid gap-1">
          <p className="text-xs text-muted-foreground">{t('pages.preview.hint')}</p>
          {/* S6: the server's sanitized HTML, in a sandbox without scripts or the admin's origin; never injected. */}
          <iframe sandbox="" srcDoc={preview} title={t('pages.preview.title')} className="h-80 w-full rounded-md border bg-white" />
        </div>
      )}
      <ImageInsert format={format} onInsert={insertImage} disabled={disabled} />
    </div>
  );
}

function PagesBackLink({ kind }: { kind: PageKind }) {
  const t = useT();
  return <BackLink {...pagesListTarget(kind)}>{t('pages.back')}</BackLink>;
}

/** The editor of a new page (`page` null) or of an existing one. */
function PageEditor({ page, kind, onReload }: { page: PageView | null; kind: PageKind; onReload?(): Promise<void> }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const readOnly = page?.archived === true;
  const [baseline, setBaseline] = useState<Baseline>(() => ({ values: formValues(page), version: page?.version ?? 0 }));
  const form = useForm<PageFormValues>({ defaultValues: formValues(page) });
  const { errors, isDirty, isSubmitting } = form.formState;
  useDirtyGuard(isDirty);
  const [tab, setTab] = useState<PageLocale>('id');
  const [problem, setProblem] = useState<{ text: string; stale: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  const [archiving, setArchiving] = useState(false);
  /** The address follows the Indonesian title of a new page until it is typed (an emptied one follows again). */
  const slugTyped = useRef(page !== null);
  const followTitle =
    page === null
      ? (title: string): void => {
          if (!slugTyped.current) form.setValue('slug', slugify(title), { shouldDirty: true });
        }
      : undefined;
  const [slug, hasEnglish] = useWatch({ control: form.control, name: ['slug', 'hasEnglish'] });

  /** Puts field errors (`{path, code, message}`) on their fields and opens the tab of the first. */
  const placeErrors = (issues: readonly { path: string; code: string; message: string }[]): void => {
    let first: string | null = null;
    for (const { path, code, message } of issues) {
      const name = FIELDS.has(path) ? path : ROOT_ERROR;
      first ??= name;
      form.setError(name as FieldPath<PageFormValues>, { type: code, message }, { shouldFocus: name === first && tabOf(name) === null });
    }
    const opened = first === null ? null : tabOf(first);
    if (opened !== null) setTab(opened);
  };

  const submit = form.handleSubmit(async (values) => {
    setProblem(null);
    setSaved(false);
    const publishedAt = fromLocalInput(values.publishedAt);
    const eventStartsAt = kind === 'news' ? fromLocalInput(values.eventStartsAt) : null;
    const eventEndsAt = kind === 'news' ? fromLocalInput(values.eventEndsAt) : null;
    const found: { path: string; code: string; message: string }[] = [];
    for (const [path, value] of [
      ['publishedAt', publishedAt],
      ['eventStartsAt', eventStartsAt],
      ['eventEndsAt', eventEndsAt],
    ] as const) {
      if (value === 'invalid') found.push({ path, code: 'invalid_format', message: 'form.error.invalid_format' });
    }
    if (publishedAt === 'invalid' || eventStartsAt === 'invalid' || eventEndsAt === 'invalid') {
      placeErrors(found);
      return;
    }
    // The rules of an event (the contract's, with a sentence of their own): an end or a place needs a start, and the
    // end is not before it.
    if (kind === 'news') {
      if (eventStartsAt === null && (eventEndsAt !== null || placeOf(values.eventPlace) !== null)) {
        found.push({ path: 'eventStartsAt', code: 'required', message: 'pages.event.start_required' });
      } else if (eventStartsAt !== null && eventEndsAt !== null && eventEndsAt < eventStartsAt) {
        found.push({ path: 'eventEndsAt', code: 'invalid', message: 'pages.event.end_before_start' });
      }
      if (found.length > 0) {
        placeErrors(found);
        return;
      }
    }
    const times: FormTimes = { publishedAt, eventStartsAt, eventEndsAt };
    const raw = page === null ? createBody(kind, values, times) : patchBody(kind, baseline, values, times);
    // Nothing changed since the last save: nothing to send.
    if (page !== null && Object.keys(raw as object).length === 1) return;
    const parsed = page === null ? PageBody.safeParse(raw, FORM_PARSE) : PagePatchBody.safeParse(raw, FORM_PARSE);
    if (!parsed.success) {
      placeErrors(parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code, message: issue.message })));
      return;
    }
    try {
      if (page === null) {
        const created = await api<StoreResponse>('POST', 'opac/pages', parsed.data);
        form.reset(values);
        await queryClient.invalidateQueries({ queryKey: PAGES_KEY });
        await navigate({ href: pageHref(created.id), replace: true });
        return;
      }
      const updated = await api<StoreResponse>('PATCH', `opac/pages/${encodeURIComponent(page.id)}`, parsed.data);
      setBaseline({ values, version: updated.version });
      form.reset(values);
      setSaved(true);
      // The list and the title above read again; the form keeps what it holds (and the version just answered).
      void queryClient.invalidateQueries({ queryKey: PAGES_KEY });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && (e.errors?.length ?? 0) > 0) {
        applyServerErrors(form, e);
        const opened = tabOf(e.errors?.find((x) => FIELDS.has(x.path))?.path ?? '');
        if (opened !== null) setTab(opened);
      }
      setProblem({ text: problemText(t, e), stale: e instanceof ApiError && e.code === 'CONFLICT_STALE' });
    }
  });

  const savedPublished = page !== null && baseline.values.status === 'published';
  return (
    <>
      {saved && <Notice kind="success">{t('pages.saved')}</Notice>}
      {problem !== null && (
        <Notice
          kind="error"
          action={
            problem.stale && onReload !== undefined ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void onReload()}>
                {t('form.reload_data')}
              </Button>
            ) : undefined
          }>
          {problem.text}
        </Notice>
      )}
      <form noValidate onSubmit={(e) => void submit(e)}>
        <fieldset disabled={readOnly || isSubmitting} className="grid min-w-0 content-start gap-y-2">
          <FormSection title={t('pages.settings')} className="xl:[&>fieldset]:grid-cols-2">
            <Field label={t('pages.field.slug')} hint={t('pages.field.slug_hint', { path: opacPath(kind, slug === '' ? '…' : slug) })} error={errors.slug}>
              {(c) => (
                <Input
                  {...c}
                  maxLength={191}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  {...form.register('slug', {
                    onChange: (e: { target: { value: string } }) => {
                      slugTyped.current = e.target.value !== '';
                    },
                  })}
                />
              )}
            </Field>
            <Field label={t('pages.field.status')} error={errors.status}>
              {(c) => (
                <select {...c} className={SELECT_CLASS} {...form.register('status')}>
                  {PAGE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`vocab.page_status.${s}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('pages.field.published_at')} hint={t('pages.field.published_at_hint')} error={errors.publishedAt}>
              {(c) => <Input {...c} type="datetime-local" {...form.register('publishedAt')} />}
            </Field>
            <Field label={t('pages.field.sort_order')} hint={t('pages.field.sort_order_hint')} error={errors.sortOrder}>
              {(c) => <Input {...c} type="number" inputMode="numeric" min={0} step={1} {...form.register('sortOrder')} />}
            </Field>
            <CheckField className={FORM_FULL} label={t('pages.field.show_in_nav')} hint={t('pages.field.show_in_nav_hint')} {...form.register('showInNav')} />
          </FormSection>

          {kind === 'news' && (
            <FormSection title={t('pages.agenda')} intro={t('pages.agenda.intro')} className="xl:[&>fieldset]:grid-cols-2">
              <Field label={t('pages.field.category')} hint={t('pages.field.category_hint')} error={errors.category}>
                {(c) => (
                  <select {...c} className={SELECT_CLASS} {...form.register('category')}>
                    <option value="">{t('pages.category.none')}</option>
                    {NEWS_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {t(`pages.category.${category}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={t('pages.field.event_place')} hint={t('pages.field.event_place_hint')} error={errors.eventPlace}>
                {(c) => <Input {...c} maxLength={EVENT_PLACE_MAX} autoComplete="off" {...form.register('eventPlace')} />}
              </Field>
              <Field label={t('pages.field.event_starts_at')} hint={t('pages.field.event_starts_at_hint')} error={errors.eventStartsAt}>
                {(c) => <Input {...c} type="datetime-local" {...form.register('eventStartsAt')} />}
              </Field>
              <Field label={t('pages.field.event_ends_at')} hint={t('pages.field.event_ends_at_hint')} error={errors.eventEndsAt}>
                {(c) => <Input {...c} type="datetime-local" {...form.register('eventEndsAt')} />}
              </Field>
            </FormSection>
          )}

          <FormSection title={t('pages.translations')}>
            <Tabs value={tab} onValueChange={(value) => setTab(value as PageLocale)} className={cn('min-w-0', FORM_FULL)}>
              <TabsList aria-label={t('pages.translations')} className={WRAPPING_TABS.list}>
                {PAGE_LOCALES.map((locale) => (
                  <TabsTrigger key={locale} value={locale} className={WRAPPING_TABS.trigger}>
                    {t(`vocab.page_locale.${locale}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="id" className="pt-2">
                <TranslationFields form={form} locale="id" disabled={readOnly} {...(followTitle === undefined ? {} : { onTitle: followTitle })} />
              </TabsContent>
              <TabsContent value="en" className="flex flex-col gap-4 pt-2">
                <CheckField label={t('pages.english.include')} hint={t('pages.english.hint')} {...form.register('hasEnglish')} />
                {hasEnglish && <TranslationFields form={form} locale="en" disabled={readOnly} />}
              </TabsContent>
            </Tabs>
          </FormSection>
          <RootError message={errors.root?.server?.message} />
          {!readOnly && (
            <FormBar>
              <Button type="submit" disabled={isSubmitting}>
                {t(isSubmitting ? 'form.saving' : 'form.save')}
              </Button>
              <Button asChild variant="outline">
                <Link {...pagesListTarget(kind)}>{t('form.cancel')}</Link>
              </Button>
              {savedPublished && (
                <Button asChild variant="outline">
                  <a href={opacPath(kind, baseline.values.slug)} target="_blank" rel="noopener noreferrer">
                    {t('pages.action.view')}
                  </a>
                </Button>
              )}
              {page !== null && (
                <Button type="button" variant="outline" className="sm:ml-auto" onClick={() => setArchiving(true)}>
                  {t('pages.action.archive')}
                </Button>
              )}
            </FormBar>
          )}
        </fieldset>
      </form>
      {page !== null && (
        <ConfirmDialog
          open={archiving}
          destructive
          title={t('pages.archive.title', { title: baseline.values.translations.id.title })}
          description={t('pages.archive.body')}
          confirmLabel={t('pages.action.archive')}
          onConfirm={async () => {
            await api('DELETE', `opac/pages/${encodeURIComponent(page.id)}`, { version: baseline.version });
            form.reset(form.getValues());
            await queryClient.invalidateQueries({ queryKey: PAGES_KEY });
            await navigate({ href: pagesListHref(kind) });
          }}
          onClose={() => setArchiving(false)}
        />
      )}
    </>
  );
}

export function PageCreateScreen() {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'opac.pages.manage');
  const kind = kindOf(useSearch({ strict: false }));
  return (
    <div className="grid max-w-5xl gap-6">
      <PagesBackLink kind={kind} />
      <PageHead title={t(`pages.new.${kind}`)} />
      {/* Every route of the area needs the permission: say so before anything is typed. */}
      {canManage ? <PageEditor key={kind} page={null} kind={kind} /> : <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />}
    </div>
  );
}

export function PageEditScreen() {
  const t = useT();
  const me = useMe();
  const canManage = holds(me, 'opac.pages.manage');
  const { pageId = '' } = useParams({ strict: false }) as { pageId?: string };
  const page = useApiQuery<PageView>({ queryKey: [...PAGES_KEY, 'page', pageId], path: `opac/pages/${encodeURIComponent(pageId)}`, enabled: canManage });
  /** Bumped to start the editor again from the latest data (after a stale save). */
  const [generation, setGeneration] = useState(0);

  const reload = async (): Promise<void> => {
    await page.refetch();
    setGeneration((g) => g + 1);
  };

  if (!canManage) {
    return (
      <div className="grid max-w-5xl gap-6">
        <PagesBackLink kind="page" />
        <ProblemAlert error={new ApiError(403, 'AUTHZ_DENIED')} />
      </div>
    );
  }
  const data = page.data;
  return (
    <div className="grid max-w-5xl gap-6">
      <PagesBackLink kind={data?.kind ?? 'page'} />
      {/* The data wins over an error: a failed background refetch keeps the form and what was typed. */}
      {data === undefined ? (
        page.isError ? (
          <ErrorState error={page.error} onRetry={() => void page.refetch()} retrying={page.isFetching} />
        ) : (
          <LoadingState />
        )
      ) : (
        <>
          <PageHead title={<span className="break-words">{data.translations.id.title === '' ? t('pages.untitled') : data.translations.id.title}</span>} />
          <RefetchProblem query={page} />
          {data.archived && <Callout title={t('pages.archived_notice')} />}
          <PageEditor key={`${data.id}:${generation}`} page={data} kind={data.kind} onReload={reload} />
        </>
      )}
    </div>
  );
}
