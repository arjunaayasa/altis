import {
  SITE_ICON_CONTEXT,
  SITE_ICON_SIDES,
  SITE_IDENTITY_LIMITS,
  SITE_IMAGE_MAX_SIDE,
  SITE_LOGO_BOX,
  SITE_LOGO_CONTEXT,
  SiteIdentityPutBody,
  type SiteIdentityPutResponse,
  type SiteIdentityView,
} from '@altis/shared/api/site-identity';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, UploadIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { CheckField, Field, Notice } from '@/components/form-field';
import { Callout, Card, ErrorState, LoadingState, PageError, PageHeader, SaveBar, SettingRow, StatusText } from '@/components/layout';
import { SidebarBrand, type BrandProps } from '@/components/shell/brand';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { fieldErrorKey } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { SITE_IDENTITY_PUBLIC_KEY } from '@/lib/site-identity';
import { SITE_IMAGE_ACCEPT, SiteImageError, dataUrlOf, sitePngOf, type SiteImageKind } from '@/lib/site-image';
import { uploadFile } from '@/lib/upload';
import { cn } from '@/lib/utils';

/**
 * Situs / OPAC › Identitas situs (`/admin/opac/identitas`, permission `opac.pages.manage`): the library's own logo,
 * its logo for dark backgrounds, the site icon, the logo's alternative text, the site's name, the tagline in each
 * language and whether the name is written beside the logo. `GET site/identity` loads it with its revision; the form
 * edits one draft and `PUT site/identity` saves it all.
 *
 * - An image is chosen, turned into a PNG in the browser (lib/site-image.ts; an SVG is refused there with the advice to
 *   export it as PNG) and uploaded at once as `site.logo` or `site.icon`; the upload's id goes into the draft and is
 *   stored by the save. What the browser or the server refuses is said under the image, in words.
 * - Beside the form, five previews follow the unsaved draft: the site's header, its footer, the admin sidebar, the
 *   browser tab, and the site without a logo (the name as plain text; no monogram is made up).
 * - The bar at the bottom says whether something is unsaved. The outcome of a save stands under the page head: saved,
 *   the fields to check, a save another admin made first (409 CONFLICT_STALE, with the offer to reload), a failure.
 * - After a save the sidebar's own brand is read again.
 */

const SITE_IDENTITY_KEY = ['site', 'identity', 'edit'] as const;

/** An image of the draft: the upload it is, where the browser shows it from, and what is known of a fresh one. */
interface ImageDraft {
  fileId: string;
  url: string;
  fresh?: { name: string; width: number; height: number; bytes: number };
}

interface IdentityDraft {
  logo: ImageDraft | null;
  logoAlt: string;
  logoDark: ImageDraft | null;
  icon: ImageDraft | null;
  name: string;
  taglineId: string;
  taglineEn: string;
  showName: boolean;
}

type ImageSlot = 'logo' | 'logoDark' | 'icon';

const fileSrc = (fileId: string): string => `/files/${encodeURIComponent(fileId)}`;

/** The draft of what was loaded. Before the first save the logo is the one the home page held: it is simply the logo. */
function draftOf(view: SiteIdentityView): IdentityDraft {
  const { identity, urls } = view;
  return {
    logo: identity.logo === null ? null : { fileId: identity.logo.fileId, url: urls.logo ?? fileSrc(identity.logo.fileId) },
    logoAlt: identity.logo?.alt ?? '',
    logoDark: identity.logoDark === null ? null : { fileId: identity.logoDark.fileId, url: urls.logoDark ?? fileSrc(identity.logoDark.fileId) },
    icon: identity.icon === null ? null : { fileId: identity.icon.fileId, url: urls.icon['192'] },
    name: identity.name ?? '',
    taglineId: identity.tagline.id ?? '',
    taglineEn: identity.tagline.en ?? '',
    showName: identity.showNameBesideLogo,
  };
}

const orNull = (text: string): string | null => (text.trim() === '' ? null : text.trim());

/** The identity of `draft`, as the server stores it (not yet checked). */
function identityOf(draft: IdentityDraft) {
  return {
    logo: draft.logo === null ? null : { fileId: draft.logo.fileId, alt: draft.logoAlt.trim() },
    logoDark: draft.logoDark === null ? null : { fileId: draft.logoDark.fileId },
    icon: draft.icon === null ? null : { fileId: draft.icon.fileId },
    name: orNull(draft.name),
    tagline: { id: orNull(draft.taglineId), en: orNull(draft.taglineEn) },
    showNameBesideLogo: draft.showName,
  };
}

/** What makes two drafts the same save. An alternative text without a logo is not sent, so it does not count. */
const comparable = (draft: IdentityDraft): string => JSON.stringify(identityOf(draft));

/** The PUT body of `draft` loaded at `revision`, or the field errors that keep it from being sent (path → code). */
function bodyOf(draft: IdentityDraft, revision: string): { body: SiteIdentityPutBody } | { errors: Record<string, string> } {
  const parsed = SiteIdentityPutBody.safeParse({ revision, identity: identityOf(draft) });
  if (parsed.success) return { body: parsed.data };
  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.map((p) => String(p)).join('.');
    if (!(path in errors)) errors[path] = issue.code ?? 'invalid';
  }
  return { errors };
}

/** The words for a chosen image that was refused, by the browser (lib/site-image.ts) or by the server. */
export function imageRefusalText(t: ReturnType<typeof useT>, error: unknown, kind: SiteImageKind, file: Blob): string {
  const minSide = kind === 'icon' ? SITE_ICON_SIDES.min : SITE_LOGO_BOX.minSide;
  if (error instanceof SiteImageError) {
    switch (error.refusal) {
      case 'svg':
        return t('siteIdentity.image.svg');
      case 'not_image':
        return t('siteIdentity.image.not_image');
      case 'source_too_large':
        return t('siteIdentity.image.source_too_large', { size: (file.size / (1024 * 1024)).toFixed(1) });
      case 'too_small':
        return t('siteIdentity.image.too_small', { min: error.minSide ?? minSide });
      case 'too_large':
        return t('siteIdentity.image.too_large');
      default:
        return t('siteIdentity.image.unreadable');
    }
  }
  if (error instanceof ApiError && error.code === 'UPLOAD_TOO_LARGE') return t('siteIdentity.image.too_large');
  if (error instanceof ApiError && error.code === 'UPLOAD_TYPE_REFUSED') {
    switch (error.reason) {
      case 'damaged':
        return t('siteIdentity.image.damaged');
      case 'interlaced':
        return t('siteIdentity.image.interlaced');
      case 'dimensions':
        return t('siteIdentity.image.dimensions', { max: SITE_IMAGE_MAX_SIDE });
      case 'too_small':
        return t('siteIdentity.image.too_small', { min: minSide });
      default:
        return t('siteIdentity.image.type_refused');
    }
  }
  return t('siteIdentity.image.upload_failed');
}

/** The screen: its head, then the editor once the identity is loaded. */
export function SiteIdentityScreen() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const canManage = me !== undefined && holds(me, 'opac.pages.manage');
  const query = useApiQuery<SiteIdentityView>({
    queryKey: SITE_IDENTITY_KEY,
    path: 'site/identity',
    enabled: canManage,
    // The draft must not be replaced under the admin's hands: while the screen is open the identity is read again
    // only after a save or a reload, and nothing is kept once it closes.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped after every save and reload: the editor starts again from what the server holds. */
  const [generation, setGeneration] = useState(0);

  const reload = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: SITE_IDENTITY_KEY });
    setGeneration((g) => g + 1);
  };

  let body: ReactNode;
  if (me === undefined || (canManage && query.isPending)) {
    body = <LoadingState label={t('siteIdentity.loading')} lines={6} />;
  } else if (!canManage) {
    body = <Callout title={t('siteIdentity.no_permission')} />;
  } else if (query.isError || query.data === undefined) {
    body = <ErrorState title={t('siteIdentity.load_failed')} error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  } else {
    body = (
      <IdentityEditor
        key={`${query.data.revision}:${generation}`}
        view={query.data}
        notice={notice}
        onEdited={() => setNotice(null)}
        onSaved={async () => {
          await reload();
          // The sidebar and the sign-in page draw the brand from the public identity.
          void queryClient.invalidateQueries({ queryKey: SITE_IDENTITY_PUBLIC_KEY });
          setNotice(t('siteIdentity.saved'));
        }}
        onReload={reload}
      />
    );
  }

  return (
    <div className="grid gap-4">
      <PageHeader
        title={t('siteIdentity.title')}
        description={t('siteIdentity.intro')}
        actions={
          <a href="/" target="_blank" rel="noopener" className={buttonVariants({ variant: 'outline' })}>
            {t('siteIdentity.view_site')}
            <ExternalLinkIcon aria-hidden="true" />
          </a>
        }
      />
      {body}
    </div>
  );
}

/** The tile an image is shown on: white for the main logo, charcoal for the dark one, square for the icon. */
const TILE = 'grid h-[72px] flex-none place-items-center overflow-hidden rounded-md border';

/**
 * One image of the identity: its tile, what is known of it, the button that uploads or replaces it and the one that
 * removes it. The chosen file is made a PNG and uploaded here; a refusal is said under the buttons and named by the
 * file field.
 */
function ImageField({
  slot,
  image,
  fallback,
  disabled,
  onBusy,
  onChange,
}: {
  slot: ImageSlot;
  image: ImageDraft | null;
  /** The main logo, which the dark tile shows on a white plate while there is no dark logo. */
  fallback?: ImageDraft | null;
  disabled: boolean;
  onBusy(busy: boolean): void;
  onChange(image: ImageDraft | null): void;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind: SiteImageKind = slot === 'icon' ? 'icon' : 'logo';
  const prefix = slot === 'logo' ? 'siteIdentity.logo' : slot === 'logoDark' ? 'siteIdentity.logo_dark' : 'siteIdentity.icon';
  const key = (name: string): TKey => `${prefix}.${name}` as TKey;

  const choose = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (input.current !== null) input.current.value = '';
    if (file === undefined) return;
    setError(null);
    setBusy(true);
    onBusy(true);
    try {
      const png = await sitePngOf(file, kind);
      const { uploadId } = await uploadFile(png.blob, { context: kind === 'icon' ? SITE_ICON_CONTEXT : SITE_LOGO_CONTEXT });
      // Shown from the PNG itself until it is saved (a `data:` address, which the page's content policy allows).
      const url = await dataUrlOf(png.blob).catch(() => fileSrc(uploadId));
      onChange({ fileId: uploadId, url, fresh: { name: file.name, width: png.width, height: png.height, bytes: png.blob.size } });
    } catch (problem) {
      setError(imageRefusalText(t, problem, kind, file));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };

  const dark = slot === 'logoDark';
  const imageClass = slot === 'icon' ? 'size-12 rounded-md object-contain' : 'h-10 w-auto max-w-[176px] object-contain';
  return (
    <div className="grid w-full gap-2">
      <div className="flex flex-wrap items-center gap-4">
        <span
          data-slot="image-tile"
          className={cn(
            TILE,
            slot === 'icon' ? 'w-[72px]' : 'w-[200px] max-w-full',
            image === null && !(dark && fallback) ? 'border-dashed bg-layer-2' : dark ? 'border-side bg-side' : 'bg-white',
          )}>
          {image !== null ? (
            <img src={image.url} alt={t(key('preview_alt'))} className={imageClass} />
          ) : dark && fallback ? (
            <span className="inline-flex items-center rounded-md bg-white px-1.5 py-1">
              <img src={fallback.url} alt="" className="h-8 w-auto max-w-[160px] object-contain" />
            </span>
          ) : null}
        </span>
        <div className="grid min-w-0 gap-1.5 text-meta text-muted-foreground">
          <p className="break-words">
            {image === null
              ? t(key('empty'))
              : image.fresh === undefined
                ? t('siteIdentity.image.stored')
                : t('siteIdentity.image.fresh', { name: image.fresh.name, width: image.fresh.width, height: image.fresh.height, size: Math.max(1, Math.round(image.fresh.bytes / 1024)) })}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                buttonVariants({ variant: 'outline', size: 'sm' }),
                'relative overflow-hidden has-[input:disabled]:opacity-50 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring',
              )}>
              <UploadIcon aria-hidden="true" />
              <span aria-hidden="true">{t(busy ? 'siteIdentity.image.uploading' : image === null ? 'siteIdentity.image.upload' : 'siteIdentity.image.replace')}</span>
              <input
                ref={input}
                id={id}
                type="file"
                accept={SITE_IMAGE_ACCEPT}
                disabled={disabled || busy}
                aria-label={t(key(image === null ? 'upload' : 'replace'))}
                aria-invalid={error === null ? undefined : true}
                aria-describedby={cn(error !== null && `${id}-error`, slot === 'icon' && `${id}-hint`) || undefined}
                className="absolute inset-0 size-full cursor-pointer opacity-0 file:cursor-pointer disabled:cursor-not-allowed"
                onChange={(e) => void choose(e)}
              />
            </span>
            {image !== null && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || busy}
                aria-label={t(key('remove'))}
                onClick={() => {
                  setError(null);
                  onChange(null);
                }}>
                {t('siteIdentity.image.remove')}
              </Button>
            )}
            {busy && (
              <span role="status" className="sr-only">
                {t('siteIdentity.image.uploading')}
              </span>
            )}
          </div>
        </div>
      </div>
      {error !== null && (
        <p id={`${id}-error`} role="alert" className="text-meta">
          <StatusText tone="bad">{error}</StatusText>
        </p>
      )}
      {slot === 'icon' && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {t('siteIdentity.icon.hint')}
        </p>
      )}
    </div>
  );
}

/** One preview: what it shows, said above it. */
function Preview({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <figure aria-labelledby={id} className="border-t px-4 py-3.5 [[data-slot=card-head]+&]:border-t-0">
      <figcaption id={id} className="mb-2 text-fine text-muted-foreground">
        {label}
      </figcaption>
      {children}
    </figure>
  );
}

/** The strip a preview draws the site's or the admin's head in. */
const STRIP = 'flex h-13 items-center gap-4 overflow-hidden rounded-md border px-3.5 text-xs whitespace-nowrap';

/** The five previews, from the unsaved draft. The pictures say nothing by themselves: the names beside them do. */
function Previews({ draft, view }: { draft: IdentityDraft; view: SiteIdentityView }) {
  const t = useT();
  const name = draft.name.trim() === '' ? view.libraryName : draft.name.trim();
  const tagline = draft.taglineId.trim() === '' ? draft.taglineEn.trim() : draft.taglineId.trim();
  const words = (['nav_home', 'nav_catalog', 'nav_profile', 'nav_news'] as const).map((k) => <span key={k}>{t(`siteIdentity.preview.${k}`)}</span>);
  const plain = <span className="text-[1.0625rem] font-bold">{name}</span>;
  const beside = draft.showName && <span className="text-sm font-bold">{name}</span>;
  const brand: BrandProps = {
    name,
    ...(draft.logo === null ? {} : { logoUrl: draft.logo.url }),
    ...(draft.logoDark === null ? {} : { logoDarkUrl: draft.logoDark.url }),
    showName: draft.showName,
  };
  // The built-in icon answers at the same address as a stored one, so it stands in only while none was ever stored.
  const iconUrl = draft.icon !== null ? draft.icon.url : view.identity.icon === null ? view.urls.icon['192'] : null;
  return (
    <Card title={t('siteIdentity.preview.title')} description={t('siteIdentity.preview.description')}>
      <Preview label={t('siteIdentity.preview.header')}>
        <div data-preview="header" className={cn(STRIP, 'bg-white text-black')}>
          {draft.logo === null ? (
            plain
          ) : (
            <>
              <img src={draft.logo.url} alt="" className="h-7.5 w-auto" />
              {beside}
            </>
          )}
          {words}
        </div>
      </Preview>
      <Preview label={t('siteIdentity.preview.footer')}>
        <div data-preview="footer" className={cn(STRIP, 'border-side bg-side text-side-fg')}>
          {draft.logoDark !== null ? (
            <img src={draft.logoDark.url} alt="" className="h-7.5 w-auto" />
          ) : draft.logo !== null ? (
            <span data-slot="logo-plate" className="inline-flex h-7.5 shrink-0 items-center rounded-md bg-white px-1">
              <img src={draft.logo.url} alt="" className="h-6.5 w-auto" />
            </span>
          ) : (
            <span className="text-[1.0625rem] font-bold text-side-strong">{name}</span>
          )}
          {draft.showName && (draft.logo !== null || draft.logoDark !== null) && <span className="text-sm font-bold text-side-strong">{name}</span>}
          {tagline !== '' && <span className="truncate">{tagline}</span>}
        </div>
      </Preview>
      <Preview label={t('siteIdentity.preview.sidebar')}>
        <div data-preview="sidebar" className={cn(STRIP, 'gap-2 border-side bg-side text-side-fg')}>
          <SidebarBrand {...brand} />
        </div>
      </Preview>
      <Preview label={t('siteIdentity.preview.tab')}>
        <div data-preview="tab" className="flex items-end gap-3 border-b">
          <div className="flex h-8.5 max-w-[260px] min-w-0 items-center gap-2 rounded-t-md border border-b-0 bg-layer-2 px-3 text-fine">
            {iconUrl !== null && <img src={iconUrl} alt="" className="size-4 rounded-[3px]" />}
            <span className="truncate">{t('siteIdentity.preview.tab_title', { name })}</span>
          </div>
          {iconUrl !== null && <img src={iconUrl} alt="" className="mb-1 size-8 rounded-md" />}
        </div>
      </Preview>
      <Preview label={t('siteIdentity.preview.no_logo')}>
        <div data-preview="no-logo" className={cn(STRIP, 'bg-white text-black')}>
          {plain}
          {words}
        </div>
      </Preview>
    </Card>
  );
}

/** The form over one draft of the loaded identity, with the previews beside it. */
function IdentityEditor({
  view,
  notice,
  onEdited,
  onSaved,
  onReload,
}: {
  view: SiteIdentityView;
  notice: string | null;
  onEdited(): void;
  onSaved(): Promise<void>;
  onReload(): Promise<void>;
}) {
  const t = useT();
  const [baseline] = useState(() => draftOf(view));
  const [draft, setDraft] = useState<IdentityDraft>(baseline);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  /** How many images are on their way to the server: the save waits for them. */
  const [uploads, setUploads] = useState(0);
  /** Bumped when a check refuses fields: the first refused field then takes the focus. */
  const [refusals, setRefusals] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const outcomeBox = useRef<HTMLDivElement>(null);
  const dirty = comparable(draft) !== comparable(baseline);
  useDirtyGuard(dirty);

  useEffect(() => {
    if (refusals > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([type=file])')?.focus();
  }, [refusals]);
  useEffect(() => {
    if (notice !== null) saveButton.current?.focus({ preventScroll: true });
  }, [notice]);
  // A conflict, a failure or the save itself is said above the form: it comes into sight (the bar keeps the focus).
  useEffect(() => {
    if (conflict || problem !== null || notice !== null) outcomeBox.current?.scrollIntoView?.({ block: 'nearest' });
  }, [conflict, problem, notice]);

  const edit = (change: (d: IdentityDraft) => IdentityDraft): void => {
    setDraft(change);
    onEdited();
  };
  const onBusy = (busy: boolean): void => setUploads((n) => Math.max(0, n + (busy ? 1 : -1)));
  /** The message of the field at `path`, if the last check refused it. */
  const errorAt = (path: string): string | undefined => {
    const code = errors[path];
    return code === undefined ? undefined : fieldErrorKey(code);
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (uploads > 0) return;
    setProblem(null);
    setConflict(false);
    const built = bodyOf(draft, view.revision);
    if ('errors' in built) {
      setErrors(built.errors);
      setRefusals((n) => n + 1);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await api<SiteIdentityPutResponse>('PUT', 'site/identity', built.body);
      await onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CONFLICT_STALE') setConflict(true);
      else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && e.errors !== undefined && e.errors.length > 0) {
        setErrors(Object.fromEntries(e.errors.map((x) => [x.path, x.code])));
        setRefusals((n) => n + 1);
      } else setProblem(e);
      setSaving(false);
    }
  };

  const hasErrors = Object.keys(errors).length > 0;
  const outcome = conflict ? (
    <PageError
      title={t('siteIdentity.conflict')}
      action={
        <Button type="button" size="sm" variant="outline" className="bg-background" onClick={() => void onReload()}>
          {t('siteIdentity.reload')}
        </Button>
      }
    />
  ) : hasErrors ? (
    <PageError title={t('siteIdentity.fix_fields')} />
  ) : problem !== null ? (
    <PageError title={t('siteIdentity.save_failed')} error={problem} />
  ) : notice !== null ? (
    <Notice kind="success">{notice}</Notice>
  ) : null;

  const siteName = draft.name.trim() === '' ? view.libraryName : draft.name.trim();
  /** A row of the form: the name and a sentence in a 200 px column, the control taking the rest. */
  const ROW = 'items-start gap-x-5 py-4 lg:grid-cols-[200px_minmax(0,1fr)]';
  const imageRow = (slot: ImageSlot, title: TKey, description: TKey) => (
    <SettingRow title={t(title)} description={t(description)} className={ROW}>
      <ImageField
        slot={slot}
        image={draft[slot]}
        fallback={slot === 'logoDark' ? draft.logo : undefined}
        disabled={saving}
        onBusy={onBusy}
        onChange={(image) => edit((d) => ({ ...d, [slot]: image }))}
      />
    </SettingRow>
  );

  return (
    <form ref={form} noValidate aria-label={t('siteIdentity.title')} className="grid gap-4" onSubmit={(e) => void save(e)}>
      {outcome !== null && (
        <div ref={outcomeBox} className="scroll-mt-28">
          {outcome}
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px] xl:items-start">
        <div className="grid min-w-0 gap-4">
          <Card title={t('siteIdentity.images.title')} description={t('siteIdentity.images.description')}>
            {imageRow('logo', 'siteIdentity.logo.title', 'siteIdentity.logo.description')}
            {imageRow('logoDark', 'siteIdentity.logo_dark.title', 'siteIdentity.logo_dark.description')}
            {imageRow('icon', 'siteIdentity.icon.title', 'siteIdentity.icon.description')}
            <SettingRow title={t('siteIdentity.alt.title')} description={t('siteIdentity.alt.description')} className={ROW}>
              {(c) => (
                <FieldBody id={c.id} error={errorAt('identity.logo.alt')}>
                  {(invalid, errorId) => (
                    <Input
                      id={c.id}
                      aria-describedby={cn(errorId, c['aria-describedby']) || undefined}
                      aria-invalid={invalid}
                      value={draft.logoAlt}
                      placeholder={siteName}
                      disabled={draft.logo === null}
                      maxLength={SITE_IDENTITY_LIMITS.alt}
                      onChange={(e) => edit((d) => ({ ...d, logoAlt: e.target.value }))}
                    />
                  )}
                </FieldBody>
              )}
            </SettingRow>
          </Card>
          <Card title={t('siteIdentity.text.title')}>
            <SettingRow title={t('siteIdentity.name.title')} description={t('siteIdentity.name.description')} className={ROW}>
              {(c) => (
                <FieldBody id={c.id} error={errorAt('identity.name')} hint={t('siteIdentity.name.hint', { name: view.libraryName })}>
                  {(invalid, describedBy) => (
                    <Input
                      id={c.id}
                      aria-describedby={cn(describedBy, c['aria-describedby']) || undefined}
                      aria-invalid={invalid}
                      value={draft.name}
                      placeholder={view.libraryName}
                      maxLength={SITE_IDENTITY_LIMITS.name}
                      onChange={(e) => edit((d) => ({ ...d, name: e.target.value }))}
                    />
                  )}
                </FieldBody>
              )}
            </SettingRow>
            <SettingRow title={t('siteIdentity.tagline.title')} description={t('siteIdentity.tagline.description')} className={ROW}>
              <div className="grid w-full gap-3">
                <Field label={t('siteIdentity.tagline.id')} error={errorAt('identity.tagline.id')}>
                  {(c) => <Input {...c} lang="id" value={draft.taglineId} maxLength={SITE_IDENTITY_LIMITS.tagline} onChange={(e) => edit((d) => ({ ...d, taglineId: e.target.value }))} />}
                </Field>
                <Field label={t('siteIdentity.tagline.en')} error={errorAt('identity.tagline.en')}>
                  {(c) => <Input {...c} lang="en" value={draft.taglineEn} maxLength={SITE_IDENTITY_LIMITS.tagline} onChange={(e) => edit((d) => ({ ...d, taglineEn: e.target.value }))} />}
                </Field>
              </div>
            </SettingRow>
            <SettingRow title={t('siteIdentity.show_name.title')} description={t('siteIdentity.show_name.description')} className={ROW}>
              <CheckField
                asSwitch
                className="w-full"
                label={t('siteIdentity.show_name.label')}
                checked={draft.showName}
                onChange={(e) => {
                  const on = e.target.checked;
                  edit((d) => ({ ...d, showName: on }));
                }}
              />
            </SettingRow>
          </Card>
        </div>
        <aside aria-label={t('siteIdentity.preview.title')} className="min-w-0">
          <Previews draft={draft} view={view} />
        </aside>
      </div>
      <SaveBar message={uploads > 0 ? t('siteIdentity.uploading_wait') : t(dirty ? 'siteIdentity.dirty' : 'siteIdentity.clean')}>
        <Button
          type="button"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => {
            setErrors({});
            edit(() => baseline);
          }}>
          {t('siteIdentity.discard')}
        </Button>
        <Button ref={saveButton} type="submit" disabled={(!dirty && view.saved) || saving || uploads > 0}>
          {t(saving ? 'form.saving' : 'siteIdentity.save')}
        </Button>
      </SaveBar>
    </form>
  );
}

/**
 * The control of a row with its error and hint under it: `children` gets whether it is invalid and the ids that
 * describe it.
 */
function FieldBody({ id, error, hint, children }: { id: string; error?: string; hint?: string; children(invalid: true | undefined, describedBy: string): ReactNode }) {
  const t = useT();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <div className="grid w-full gap-1.5">
      {children(error === undefined ? undefined : true, cn(error !== undefined && errorId, hint !== undefined && hintId))}
      {error !== undefined && (
        <p id={errorId} className="text-meta font-semibold text-bad">
          {t(error as TKey)}
        </p>
      )}
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
