import {
  OPAC_HOME_BLOCKS,
  OPAC_HOME_CONTACT_LIMITS,
  OPAC_HOME_HERO_SIZE,
  OPAC_HOME_LANGS,
  OPAC_HOME_LIMITS,
  OPAC_HOME_MIN_CONTRAST,
  OPAC_HOME_OVERLAY,
  OPAC_HOME_OVERLAY_RGB,
  OPAC_HOME_PHOTO_SIZE,
  OPAC_HOME_POSITION_STEP,
  OPAC_HOME_WEEKDAYS,
  brandRgb,
  contrastWithWhite,
  type OpacHomeLang,
  type OpacHomePutResponse,
  type OpacHomeView,
} from '@altis/shared/api/opac-home';
import type { OpacAccent } from '@altis/shared/api/settings';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { CheckField, Field, Notice, TEXTAREA_CLASS } from '@/components/form-field';
import { Callout, ErrorState, FORM_FULL, FormBar, FormSection, LoadingState, PageError, PageHead, SectionHead, StatusText } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FileInput } from '@/components/file-input';
import { useLocale, useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { fieldErrorKey } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { uploadFile } from '@/lib/upload';
import { cn } from '@/lib/utils';
import { PHOTO_SOURCE_MAX_BYTES, PHOTO_SOURCE_TYPES, PhotoCropPanel, fitLogo, jpegOf, photoSourceOf, type PhotoSource } from './crop';
import { bodyOf, comparable, draftOf, newRowKey, type HomeDraft, type PhotoDraft, type TextDraft } from './draft';

/**
 * OPAC › Halaman awal (`/admin/opac/beranda`, permission `opac.pages.manage`): the home page of the public site as the
 * library's profile. `GET opac/home` loads the content, both welcome texts and their revision; the form edits them in
 * one draft, one form section per part: the hero photo (uploaded as `opac.home_photo` after a 16:9 crop in a panel
 * under its control), its alternative text, position and the darkness of its overlay (never lighter than the floor
 * that keeps white text readable), the library colour of a hero without a photo (with the contrast white text keeps on
 * it), the heading and the lead sentence in each language, the library's logo (fitted whole onto a white tile, with its
 * alternative text) and the telephone number and e-mail address the site publishes, "about" (photo, paragraph in each
 * language, year founded, librarians), up to eight services, up to four facility photos (4:3), the opening hours with
 * the weekdays each row covers, and the blocks shown. A preview of the hero beside the form follows the unsaved draft,
 * in either language. The form's bar sticks to the bottom with a mark while something is unsaved, "Batalkan perubahan"
 * goes back to what was loaded, and `PUT opac/home` saves it all. The outcome of a save is said under the page head:
 * saved, the fields to check (the first refused one takes the focus), a save another admin made first (409
 * CONFLICT_STALE, which offers to reload), or the failure. The draft is checked with the server's schema before it is
 * sent, and the server's field errors land on the same fields.
 */

const OPAC_HOME_KEY = ['opac', 'home'] as const;

/** The hero's colour without a photo, per accent: the OPAC theme's header bar (a deep shade of the accent). */
const HERO_COLORS: Readonly<Record<OpacAccent, string>> = {
  teal: '#003732',
  blue: '#182e4b',
  green: '#14361d',
  purple: '#352546',
  red: '#4b1d1b',
  slate: '#272e38',
};

const fileSrc = (fileId: string): string => `/files/${encodeURIComponent(fileId)}`;

/** The text of `draft` a page in `lang` shows: its own, else the other language's (blank: none). */
function textIn(draft: TextDraft, lang: OpacHomeLang): string {
  const own = draft[lang];
  if (own.trim() !== '') return own;
  const other = draft[lang === 'id' ? 'en' : 'id'];
  return other.trim() === '' ? '' : other;
}

/** The colour the hero band takes without a photo: the draft's library colour when it is one, else the accent's. */
function bandColor(draft: HomeDraft, view: OpacHomeView): string {
  const typed = draft.brand.trim().toLowerCase();
  return brandRgb(typed) === null ? HERO_COLORS[view.accent] : typed;
}

/** The overlay's colour at `percent` darkness, as CSS. */
const overlayColor = (percent: number): string => `rgb(${OPAC_HOME_OVERLAY_RGB.join(' ')} / ${percent / 100})`;

/** The screen: its head, then the editor once the content is loaded. */
export function OpacHomeScreen() {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const canManage = me !== undefined && holds(me, 'opac.pages.manage');
  const query = useApiQuery<OpacHomeView>({
    queryKey: OPAC_HOME_KEY,
    path: 'opac/home',
    enabled: canManage,
    // The draft must not be replaced under the admin's hands: while the screen is open the content is read again only
    // after a save or a reload. Nothing is kept once it closes, so opening it again reads what the server holds now
    // (the welcome texts and the accent also change under Pengaturan › OPAC).
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped after every save and reload: the editor starts again from what the server holds. */
  const [generation, setGeneration] = useState(0);

  const reload = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: OPAC_HOME_KEY });
    setGeneration((g) => g + 1);
  };

  let body: ReactNode;
  if (me === undefined || (canManage && query.isPending)) {
    body = <LoadingState label={t('opacHome.loading')} lines={6} />;
  } else if (!canManage) {
    body = <Callout title={t('opacHome.no_permission')} />;
  } else if (query.isError || query.data === undefined) {
    body = <ErrorState title={t('opacHome.load_failed')} error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  } else {
    body = (
      <HomeEditor
        key={`${query.data.revision}:${generation}`}
        view={query.data}
        notice={notice}
        onEdited={() => setNotice(null)}
        onSaved={async () => {
          await reload();
          setNotice(t('opacHome.saved'));
        }}
        onReload={reload}
      />
    );
  }

  return (
    <div className="grid gap-6">
      <PageHead
        title={t('opacHome.title')}
        intro={t('opacHome.intro')}
        actions={
          <Button asChild variant="outline">
            <a href="/" target="_blank" rel="noopener">
              {t('opacHome.view_site')}
            </a>
          </Button>
        }
      />
      {body}
    </div>
  );
}

/** "12/90" under a text field. */
function Counter({ value, max }: { value: string; max: number }) {
  const t = useT();
  return <p className="text-xs text-muted-foreground tabular-nums">{t('opacHome.counter', { count: [...value].length, max })}</p>;
}

/** Checks a chosen file before the browser decodes it: an image of an accepted type, at most 8 MB. */
function sourceProblem(file: File, t: ReturnType<typeof useT>): string | null {
  if (!PHOTO_SOURCE_TYPES.includes(file.type)) return t('opacHome.photo.not_image');
  if (file.size > PHOTO_SOURCE_MAX_BYTES) return t('opacHome.photo.too_large', { size: (file.size / (1024 * 1024)).toFixed(1) });
  return null;
}

/** A refusal under a control, in words. */
function ControlError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-meta">
      <StatusText tone="bad">{children}</StatusText>
    </p>
  );
}

/**
 * A file input that decodes the chosen image, opens the crop panel under it, uploads the JPEG as `opac.home_photo` and
 * hands the upload's id to `onUploaded`. A file that is not an image, too large or unreadable is refused before
 * anything is sent.
 */
function PhotoUpload({ label, size, onUploaded }: { label: string; size: { width: number; height: number }; onUploaded(fileId: string): void }) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<PhotoSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (input.current !== null) input.current.value = '';
    if (file === undefined) return;
    setError(null);
    const refused = sourceProblem(file, t);
    if (refused !== null) {
      setError(refused);
      return;
    }
    try {
      setSource(await photoSourceOf(file));
    } catch {
      setError(t('opacHome.photo.unreadable'));
    }
  };

  const save = async (jpeg: Blob): Promise<void> => {
    const { uploadId } = await uploadFile(jpeg, { context: 'opac.home_photo' });
    setSource(null);
    onUploaded(uploadId);
  };

  return (
    <div className={cn('grid gap-3', FORM_FULL)}>
      <div className="grid gap-1.5">
        <Label htmlFor={id} className="text-meta">
          {label}
        </Label>
        <FileInput
          ref={input}
          id={id}
          accept={PHOTO_SOURCE_TYPES.join(',')}
          aria-describedby={error === null ? undefined : `${id}-error`}
          onChange={(e) => void choose(e)}
        />
        {error !== null && <ControlError id={`${id}-error`}>{error}</ControlError>}
      </div>
      {source !== null && <PhotoCropPanel source={source} width={size.width} height={size.height} onCancel={() => setSource(null)} onSave={save} />}
    </div>
  );
}

/**
 * The logo's file input: the chosen image is decoded, fitted whole onto a white tile (crop.tsx `fitLogo`), encoded as a
 * JPEG of at most 500 KB and uploaded as `opac.home_photo`; the upload's id goes to `onUploaded`.
 */
function LogoUpload({ label, onUploaded }: { label: string; onUploaded(fileId: string): void }) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (input.current !== null) input.current.value = '';
    if (file === undefined) return;
    setError(null);
    const refused = sourceProblem(file, t);
    if (refused !== null) {
      setError(refused);
      return;
    }
    let source: PhotoSource;
    try {
      source = await photoSourceOf(file);
    } catch {
      setError(t('opacHome.photo.unreadable'));
      return;
    }
    setBusy(true);
    try {
      const jpeg = await jpegOf(fitLogo(source));
      if (jpeg === null) {
        setError(t('opacHome.logo.too_large'));
        return;
      }
      const { uploadId } = await uploadFile(jpeg, { context: 'opac.home_photo' });
      onUploaded(uploadId);
    } catch {
      setError(t('opacHome.photo.upload_failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-meta">
        {label}
      </Label>
      <FileInput
        ref={input}
        id={id}
        accept={PHOTO_SOURCE_TYPES.join(',')}
        disabled={busy}
        aria-describedby={error === null ? undefined : `${id}-error`}
        onChange={(e) => void choose(e)}
      />
      {busy && (
        <p role="status" className="text-meta text-muted-foreground">
          {t('opacHome.logo.uploading')}
        </p>
      )}
      {error !== null && <ControlError id={`${id}-error`}>{error}</ControlError>}
    </div>
  );
}

/**
 * The proportions of the site's hero band, which are not the photo's 16:9: on a wide screen the band is 30 rem high
 * under a laptop's width (about 3:1, so the photo's top and bottom are cut and its position picks the part shown), on a
 * phone 24 rem or more under a phone's width (about 4:5, so its sides are cut).
 */
const HERO_FRAMES = Object.freeze({ wide: '3 / 1', phone: '4 / 5' });

/** One frame of the hero preview: the photo at its position (or the library colour) and the overlay, then `children`. */
function HeroFrame({ draft, view, ratio, label, className, children }: { draft: HomeDraft; view: OpacHomeView; ratio: string; label: string; className?: string; children?: ReactNode }) {
  const id = useId();
  return (
    <figure aria-labelledby={id} className={cn('grid gap-1', className)}>
      <div className="relative flex items-end overflow-hidden rounded-lg text-white" style={{ aspectRatio: ratio, backgroundColor: bandColor(draft, view) }}>
        {draft.hero !== null && (
          <>
            <img src={fileSrc(draft.hero.fileId)} alt="" className="absolute inset-0 size-full object-cover" style={{ objectPosition: `50% ${draft.hero.position}%` }} />
            <div aria-hidden="true" data-overlay={draft.hero.overlay} className="absolute inset-0" style={{ backgroundColor: overlayColor(draft.hero.overlay) }} />
          </>
        )}
        {children}
      </div>
      <figcaption id={id} className="text-xs text-muted-foreground">
        {label}
      </figcaption>
    </figure>
  );
}

/**
 * The hero preview in the band's proportions (see {@link HERO_FRAMES}): on a wide screen with the logo and name, the
 * heading, the lead and the search box, on a phone the photo alone.
 */
function HeroPreview({ draft, view }: { draft: HomeDraft; view: OpacHomeView }) {
  const t = useT();
  const [lang, setLang] = useState<OpacHomeLang>('id');
  const title = textIn(draft.title, lang) || view.libraryName;
  const lead = textIn(draft.lead, lang);
  return (
    <div className="grid gap-3">
      <div role="group" aria-label={t('opacHome.preview.lang')} className="flex flex-wrap gap-1">
        {OPAC_HOME_LANGS.map((l) => (
          <Button key={l} type="button" size="sm" variant={l === lang ? 'secondary' : 'ghost'} aria-pressed={l === lang} onClick={() => setLang(l)}>
            {t(l === 'id' ? 'opacHome.preview.lang_id' : 'opacHome.preview.lang_en')}
          </Button>
        ))}
      </div>
      <HeroFrame draft={draft} view={view} ratio={HERO_FRAMES.wide} label={t('opacHome.preview.wide')}>
        <div className="relative grid w-full gap-1 self-stretch p-3" lang={lang}>
          <p className="flex items-center gap-1.5 self-start text-[10px] font-bold">
            {draft.logo !== null && <img src={fileSrc(draft.logo.fileId)} alt="" className="h-4 w-auto rounded-sm bg-white" />}
            <span>{view.libraryName}</span>
          </p>
          <div className="grid gap-1 self-end">
            <p className="line-clamp-2 text-sm leading-tight font-bold text-balance">{title}</p>
            {lead.trim() !== '' && <p className="line-clamp-2 text-[11px] leading-snug whitespace-pre-line">{lead}</p>}
            <span className="w-max rounded bg-background px-2 py-0.5 text-[10px] text-muted-foreground">{t('opacHome.preview.search')}</span>
          </div>
        </div>
      </HeroFrame>
      <div className="flex items-start gap-3">
        <HeroFrame draft={draft} view={view} ratio={HERO_FRAMES.phone} label={t('opacHome.preview.phone')} className="w-24 shrink-0" />
        <div className="grid gap-2 text-xs text-muted-foreground">
          <p>{t('opacHome.preview.crop')}</p>
          <p>{t('opacHome.preview.hint')}</p>
        </div>
      </div>
    </div>
  );
}

/** A photo of the draft, or the box that says there is none. */
function PhotoPreview({ fileId, alt, ratio, className }: { fileId: string | null; alt: string; ratio: 'aspect-video' | 'aspect-[4/3]'; className: string }) {
  const t = useT();
  if (fileId === null) {
    return <div className={cn('grid place-items-center rounded-md border border-dashed bg-layer text-sm text-muted-foreground', ratio, className)}>{t('opacHome.photo.none')}</div>;
  }
  return <img src={fileSrc(fileId)} alt={alt === '' ? t('opacHome.photo.preview_alt') : alt} className={cn('w-full rounded-md border object-cover', ratio, className)} />;
}

/**
 * The editor of one loaded revision (see the top of this file). The outcome of a save is said under the page head and
 * brought into sight; once saved (`notice`), the save button, which the editor of the new revision draws again, takes
 * the focus back.
 */
function HomeEditor({
  view,
  notice,
  onEdited,
  onSaved,
  onReload,
}: {
  view: OpacHomeView;
  notice: string | null;
  onEdited(): void;
  onSaved(): Promise<void>;
  onReload(): Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const baseline = useMemo(() => draftOf(view), [view]);
  const [draft, setDraft] = useState<HomeDraft>(baseline);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Bumped when a check refuses fields: the first refused field then takes the focus. */
  const [refusals, setRefusals] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const outcomeBox = useRef<HTMLDivElement>(null);
  const dirty = comparable(draft) !== comparable(baseline);
  useDirtyGuard(dirty);

  useEffect(() => {
    if (refusals > 0) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [refusals]);
  useEffect(() => {
    if (notice !== null) saveButton.current?.focus({ preventScroll: true });
  }, [notice]);
  // A conflict, a failure or the save itself is said above the form: it comes into sight (the bar keeps the focus).
  useEffect(() => {
    if (conflict || problem !== null || notice !== null) outcomeBox.current?.scrollIntoView?.({ block: 'nearest' });
  }, [conflict, problem, notice]);

  const edit = (change: (d: HomeDraft) => HomeDraft): void => {
    setDraft(change);
    onEdited();
  };
  /** Edits the library colour; its refusal goes with the value it was about (the contrast hint speaks for the new one). */
  const editBrand = (value: string): void => {
    setErrors((e) => (e['home.brand'] === undefined ? e : Object.fromEntries(Object.entries(e).filter(([path]) => path !== 'home.brand'))));
    edit((d) => ({ ...d, brand: value }));
  };
  /** The message of the field at `path`, if the last check refused it. */
  const errorAt = (path: string): string | undefined => {
    const code = errors[path];
    if (code === undefined) return undefined;
    if (code === 'low_contrast') return 'opacHome.brand.low_contrast';
    if (code === 'personal_email') return 'opacHome.contact.personal_email';
    return fieldErrorKey(code);
  };
  /** White text's contrast on the typed library colour, or null while it is not a colour. */
  const brandContrast = (() => {
    const rgb = brandRgb(draft.brand.trim().toLowerCase());
    return rgb === null ? null : contrastWithWhite(rgb);
  })();
  const ratioText = (ratio: number): string => new Intl.NumberFormat(locale === 'id' ? 'id-ID' : 'en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.floor(ratio * 10) / 10);
  /** A text field per language side by side, the whole width of the section (`path` names the body's object of both). */
  const perLanguage = (path: string, label: (lang: OpacHomeLang) => TKey, value: TextDraft, set: (next: TextDraft) => void, max: number, rows: number | null) => (
    <div className={cn('grid gap-x-5 gap-y-4 sm:grid-cols-2', FORM_FULL)}>
      {OPAC_HOME_LANGS.map((lang) => (
      <Field key={lang} label={t(label(lang))} error={errorAt(`${path}.${lang}`)}>
        {(c) => (
          <>
            {rows === null ? (
              <Input {...c} lang={lang} value={value[lang]} maxLength={max} onChange={(e) => set({ ...value, [lang]: e.target.value })} />
            ) : (
              <textarea {...c} className={TEXTAREA_CLASS} rows={rows} lang={lang} value={value[lang]} maxLength={max} onChange={(e) => set({ ...value, [lang]: e.target.value })} />
            )}
            <Counter value={value[lang]} max={max} />
          </>
        )}
      </Field>
      ))}
    </div>
  );

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
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
      await api<OpacHomePutResponse>('PUT', 'opac/home', built.body);
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

  const photoFields = (photo: PhotoDraft, path: string, set: (next: PhotoDraft) => void) => (
    <>
      <Field label={t('opacHome.photo.alt')} hint={t('opacHome.photo.alt_hint')} error={errorAt(`${path}.alt`)}>
        {(c) => <Input {...c} required value={photo.alt} maxLength={OPAC_HOME_LIMITS.alt} onChange={(e) => set({ ...photo, alt: e.target.value })} />}
      </Field>
      <Field label={t('opacHome.photo.caption')} error={errorAt(`${path}.caption`)}>
        {(c) => <Input {...c} value={photo.caption} maxLength={OPAC_HOME_LIMITS.caption} onChange={(e) => set({ ...photo, caption: e.target.value })} />}
      </Field>
    </>
  );

  const hasErrors = Object.keys(errors).length > 0;
  const outcome = conflict ? (
    <PageError
      title={t('opacHome.conflict')}
      action={
        <Button type="button" size="sm" variant="outline" className="bg-background" onClick={() => void onReload()}>
          {t('opacHome.reload')}
        </Button>
      }
    />
  ) : hasErrors ? (
    <PageError title={t('opacHome.fix_fields')} />
  ) : problem !== null ? (
    <PageError title={t('opacHome.save_failed')} error={problem} />
  ) : notice !== null ? (
    <Notice kind="success">{notice}</Notice>
  ) : null;

  return (
    <>
      {outcome !== null && (
        <div ref={outcomeBox} className="scroll-mt-28">
          {outcome}
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
        <aside aria-label={t('opacHome.preview.title')} className="grid content-start gap-3 xl:sticky xl:top-[107px] xl:order-2">
          <SectionHead title={t('opacHome.preview.title')} />
          <HeroPreview draft={draft} view={view} />
        </aside>
        <form ref={form} noValidate className="grid min-w-0 xl:order-1" onSubmit={(e) => void save(e)}>
          <FormSection title={t('opacHome.hero.title')} intro={t('opacHome.hero.description')}>
            <div className={cn('grid gap-3', FORM_FULL)}>
              <PhotoPreview fileId={draft.hero?.fileId ?? null} alt={draft.hero?.alt ?? ''} ratio="aspect-video" className="max-w-md" />
              <div className="flex flex-wrap items-end gap-3">
                <PhotoUpload
                  label={t(draft.hero === null ? 'opacHome.photo.upload' : 'opacHome.photo.replace')}
                  size={OPAC_HOME_HERO_SIZE}
                  onUploaded={(fileId) => edit((d) => ({ ...d, hero: { fileId, alt: '', position: d.hero?.position ?? 50, overlay: d.hero?.overlay ?? OPAC_HOME_OVERLAY.default } }))}
                />
                {draft.hero !== null && (
                  <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => ({ ...d, hero: null }))}>
                    {t('opacHome.photo.remove')}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('opacHome.hero.hint')}</p>
            </div>
            {draft.hero !== null && (
              <>
                <Field label={t('opacHome.photo.alt')} hint={t('opacHome.photo.alt_hint')} error={errorAt('home.hero.alt')} className={FORM_FULL}>
                  {(c) => (
                    <Input
                      {...c}
                      required
                      value={draft.hero?.alt ?? ''}
                      maxLength={OPAC_HOME_LIMITS.alt}
                      onChange={(e) => edit((d) => (d.hero === null ? d : { ...d, hero: { ...d.hero, alt: e.target.value } }))}
                    />
                  )}
                </Field>
                <Field label={t('opacHome.hero.position')} hint={t('opacHome.hero.position_hint', { value: draft.hero.position })}>
                  {(c) => (
                    <input
                      {...c}
                      type="range"
                      min={0}
                      max={100}
                      step={OPAC_HOME_POSITION_STEP}
                      value={draft.hero?.position ?? 50}
                      onChange={(e) => edit((d) => (d.hero === null ? d : { ...d, hero: { ...d.hero, position: Number(e.target.value) } }))}
                    />
                  )}
                </Field>
                <Field label={t('opacHome.hero.overlay')} hint={t('opacHome.hero.overlay_hint', { value: draft.hero.overlay, min: OPAC_HOME_OVERLAY.min })} error={errorAt('home.hero.overlay')}>
                  {(c) => (
                    <input
                      {...c}
                      type="range"
                      min={OPAC_HOME_OVERLAY.min}
                      max={OPAC_HOME_OVERLAY.max}
                      step={OPAC_HOME_OVERLAY.step}
                      value={draft.hero?.overlay ?? OPAC_HOME_OVERLAY.default}
                      aria-valuetext={`${draft.hero?.overlay ?? OPAC_HOME_OVERLAY.default}%`}
                      onChange={(e) => edit((d) => (d.hero === null ? d : { ...d, hero: { ...d.hero, overlay: Number(e.target.value) } }))}
                    />
                  )}
                </Field>
              </>
            )}
            <Field
              label={t('opacHome.brand.label')}
              hint={
                brandContrast === null
                  ? t('opacHome.brand.hint', { accent: HERO_COLORS[view.accent] })
                  : t(brandContrast >= OPAC_HOME_MIN_CONTRAST ? 'opacHome.brand.contrast_ok' : 'opacHome.brand.contrast_low', {
                      ratio: ratioText(brandContrast),
                      min: ratioText(OPAC_HOME_MIN_CONTRAST),
                    })
              }
              error={errorAt('home.brand')}
              className={FORM_FULL}
            >
              {(c) => (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="color"
                    aria-label={t('opacHome.brand.picker')}
                    className="h-[34px] w-12 shrink-0 cursor-pointer rounded-md border bg-background p-1"
                    value={bandColor(draft, view)}
                    onChange={(e) => editBrand(e.target.value)}
                  />
                  <Input
                    {...c}
                    className="w-32"
                    value={draft.brand}
                    maxLength={7}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={HERO_COLORS[view.accent]}
                    onChange={(e) => editBrand(e.target.value)}
                  />
                  {draft.brand !== '' && (
                    <Button type="button" variant="outline" size="sm" onClick={() => editBrand('')}>
                      {t('opacHome.brand.reset')}
                    </Button>
                  )}
                </div>
              )}
            </Field>
          </FormSection>

          <FormSection title={t('opacHome.text.title')} intro={t('opacHome.text.description')}>
            <p className={cn('text-meta text-muted-foreground', FORM_FULL)}>{t('opacHome.text.languages_hint', { library: view.libraryName })}</p>
            {perLanguage(
              'home.title',
              (lang) => (lang === 'id' ? 'opacHome.text.heading_id' : 'opacHome.text.heading_en'),
              draft.title,
              (title) => edit((d) => ({ ...d, title })),
              OPAC_HOME_LIMITS.title,
              null,
            )}
            {perLanguage(
              'welcome',
              (lang) => (lang === 'id' ? 'opacHome.text.lead_id' : 'opacHome.text.lead_en'),
              draft.lead,
              (lead) => edit((d) => ({ ...d, lead })),
              OPAC_HOME_LIMITS.welcome,
              3,
            )}
          </FormSection>

          <FormSection title={t('opacHome.identity.title')} intro={t('opacHome.identity.description')}>
            <div className={cn('grid gap-3', FORM_FULL)}>
              <p className="text-meta font-semibold">{t('opacHome.logo.label')}</p>
              {draft.logo === null ? (
                <p className="text-sm text-muted-foreground">{t('opacHome.logo.none')}</p>
              ) : (
                <div className="flex w-fit max-w-full items-center gap-3 rounded-lg px-4 py-3 text-white" style={{ backgroundColor: bandColor(draft, view) }}>
                  <img src={fileSrc(draft.logo.fileId)} alt={draft.logo.alt === '' ? t('opacHome.logo.preview_alt') : draft.logo.alt} className="h-10 w-auto max-w-40 rounded-sm bg-white" />
                  <span className="text-sm font-bold">{view.libraryName}</span>
                </div>
              )}
              <div className="flex flex-wrap items-end gap-3">
                <LogoUpload
                  label={t(draft.logo === null ? 'opacHome.logo.upload' : 'opacHome.logo.replace')}
                  onUploaded={(fileId) => edit((d) => ({ ...d, logo: { fileId, alt: '' } }))}
                />
                {draft.logo !== null && (
                  <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => ({ ...d, logo: null }))}>
                    {t('opacHome.logo.remove')}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('opacHome.logo.hint')}</p>
            </div>
            {draft.logo !== null && (
              <Field label={t('opacHome.logo.alt')} hint={t('opacHome.logo.alt_hint')} error={errorAt('home.logo.alt')} className={FORM_FULL}>
                {(c) => (
                  <Input
                    {...c}
                    required
                    value={draft.logo?.alt ?? ''}
                    maxLength={OPAC_HOME_LIMITS.alt}
                    onChange={(e) => edit((d) => (d.logo === null ? d : { ...d, logo: { ...d.logo, alt: e.target.value } }))}
                  />
                )}
              </Field>
            )}
            <div className={cn('grid gap-x-5 gap-y-4 sm:grid-cols-2', FORM_FULL)}>
              <Field label={t('opacHome.contact.phone')} hint={t('opacHome.contact.phone_hint')} error={errorAt('home.contact.phone')}>
                {(c) => (
                  <Input {...c} type="tel" autoComplete="off" value={draft.phone} maxLength={OPAC_HOME_CONTACT_LIMITS.phone} onChange={(e) => edit((d) => ({ ...d, phone: e.target.value }))} />
                )}
              </Field>
              <Field label={t('opacHome.contact.email')} hint={t('opacHome.contact.email_hint')} error={errorAt('home.contact.email')}>
                {(c) => (
                  <Input {...c} type="email" autoComplete="off" value={draft.email} maxLength={OPAC_HOME_CONTACT_LIMITS.email} onChange={(e) => edit((d) => ({ ...d, email: e.target.value }))} />
                )}
              </Field>
            </div>
          </FormSection>

          <FormSection title={t('opacHome.about.title')} intro={t('opacHome.about.description')}>
            <div className={cn('grid gap-3', FORM_FULL)}>
              {draft.about.photo !== null && <PhotoPreview fileId={draft.about.photo.fileId} alt={draft.about.photo.alt} ratio="aspect-[4/3]" className="max-w-xs" />}
              <div className="flex flex-wrap items-end gap-3">
                <PhotoUpload
                  label={t(draft.about.photo === null ? 'opacHome.photo.upload' : 'opacHome.photo.replace')}
                  size={OPAC_HOME_PHOTO_SIZE}
                  onUploaded={(fileId) => edit((d) => ({ ...d, about: { ...d.about, photo: { fileId, alt: '', caption: d.about.photo?.caption ?? '' } } }))}
                />
                {draft.about.photo !== null && (
                  <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => ({ ...d, about: { ...d.about, photo: null } }))}>
                    {t('opacHome.photo.remove')}
                  </Button>
                )}
              </div>
            </div>
            {draft.about.photo !== null && photoFields(draft.about.photo, 'home.about.photo', (photo) => edit((d) => ({ ...d, about: { ...d.about, photo } })))}
            {perLanguage(
              'home.about.text',
              (lang) => (lang === 'id' ? 'opacHome.about.text_id' : 'opacHome.about.text_en'),
              draft.about.text,
              (text) => edit((d) => ({ ...d, about: { ...d.about, text } })),
              OPAC_HOME_LIMITS.aboutText,
              5,
            )}
            <Field label={t('opacHome.about.founded')} error={errorAt('home.about.founded')}>
              {(c) => <Input {...c} inputMode="numeric" maxLength={4} className="w-28" value={draft.about.founded} onChange={(e) => edit((d) => ({ ...d, about: { ...d.about, founded: e.target.value } }))} />}
            </Field>
            <Field label={t('opacHome.about.librarians')} error={errorAt('home.about.librarians')}>
              {(c) => (
                <Input {...c} inputMode="numeric" maxLength={3} className="w-28" value={draft.about.librarians} onChange={(e) => edit((d) => ({ ...d, about: { ...d.about, librarians: e.target.value } }))} />
              )}
            </Field>
          </FormSection>

          <FormSection
            title={t('opacHome.services.title')}
            intro={t('opacHome.services.description', { services: OPAC_HOME_LIMITS.services, photos: OPAC_HOME_LIMITS.facilities })}
          >
            <fieldset className={cn('grid gap-2', FORM_FULL)}>
              <legend className="mb-2 text-meta font-semibold">{t('opacHome.services.list')}</legend>
              {draft.services.length === 0 && <p className="text-sm text-muted-foreground">{t('opacHome.services.empty')}</p>}
              {draft.services.map((s, i) => {
                const n = i + 1;
                const move = (to: number): void =>
                  edit((d) => {
                    const list = [...d.services];
                    const [row] = list.splice(i, 1);
                    list.splice(to, 0, row!);
                    return { ...d, services: list };
                  });
                return (
                  <div key={s.key} className="grid gap-3 rounded-md border bg-layer p-3">
                    <div className="flex flex-wrap items-start gap-2">
                      <Field label={t('opacHome.services.name', { n })} error={errorAt(`home.services.${i}.title`)} className="min-w-48 flex-1">
                        {(c) => (
                          <Input
                            {...c}
                            value={s.title}
                            maxLength={OPAC_HOME_LIMITS.serviceTitle}
                            onChange={(e) => edit((d) => ({ ...d, services: d.services.map((x) => (x.key === s.key ? { ...x, title: e.target.value } : x)) }))}
                          />
                        )}
                      </Field>
                      <div className="flex gap-2 self-end">
                        <Button type="button" size="sm" variant="outline" className="bg-background" disabled={i === 0} aria-label={t('opacHome.services.up_label', { n })} onClick={() => move(i - 1)}>
                          {t('opacHome.services.up')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="bg-background"
                          disabled={i === draft.services.length - 1}
                          aria-label={t('opacHome.services.down_label', { n })}
                          onClick={() => move(i + 1)}
                        >
                          {t('opacHome.services.down')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="bg-background"
                          aria-label={t('opacHome.services.remove_label', { n })}
                          onClick={() => edit((d) => ({ ...d, services: d.services.filter((x) => x.key !== s.key) }))}
                        >
                          {t('opacHome.services.remove')}
                        </Button>
                      </div>
                    </div>
                    <Field label={t('opacHome.services.text', { n })} error={errorAt(`home.services.${i}.text`)}>
                      {(c) => (
                        <Input
                          {...c}
                          value={s.text}
                          maxLength={OPAC_HOME_LIMITS.serviceText}
                          onChange={(e) => edit((d) => ({ ...d, services: d.services.map((x) => (x.key === s.key ? { ...x, text: e.target.value } : x)) }))}
                        />
                      )}
                    </Field>
                  </div>
                );
              })}
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={draft.services.length >= OPAC_HOME_LIMITS.services}
                  onClick={() => edit((d) => ({ ...d, services: [...d.services, { key: newRowKey(), title: '', text: '' }] }))}
                >
                  {t('opacHome.services.add')}
                </Button>
              </div>
            </fieldset>
            <fieldset className={cn('grid gap-3', FORM_FULL)}>
              <legend className="mb-2 text-meta font-semibold">{t('opacHome.facilities.list')}</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {draft.facilities.map((f, i) => (
                  <div key={f.key} role="group" aria-label={t('opacHome.facilities.photo', { n: i + 1 })} className="grid content-start gap-3 rounded-md border p-3">
                    <PhotoPreview fileId={f.fileId} alt={f.alt} ratio="aspect-[4/3]" className="" />
                    {photoFields(f, `home.facilities.${i}`, (photo) => edit((d) => ({ ...d, facilities: d.facilities.map((x) => (x.key === f.key ? { ...x, ...photo } : x)) })))}
                    <div>
                      <Button type="button" size="sm" variant="outline" onClick={() => edit((d) => ({ ...d, facilities: d.facilities.filter((x) => x.key !== f.key) }))}>
                        {t('opacHome.photo.remove')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {draft.facilities.length < OPAC_HOME_LIMITS.facilities && (
                <PhotoUpload
                  label={t('opacHome.facilities.add')}
                  size={OPAC_HOME_PHOTO_SIZE}
                  onUploaded={(fileId) => edit((d) => ({ ...d, facilities: [...d.facilities, { key: newRowKey(), fileId, alt: '', caption: '' }] }))}
                />
              )}
            </fieldset>
          </FormSection>

          <FormSection title={t('opacHome.hours.title')} intro={t('opacHome.hours.description')}>
            <div className={cn('grid gap-3', FORM_FULL)}>
              {draft.hours.map((h, i) => {
                const n = i + 1;
                const toggle = (day: number, on: boolean): void =>
                  edit((d) => ({
                    ...d,
                    hours: d.hours.map((x) => (x.key === h.key ? { ...x, weekdays: OPAC_HOME_WEEKDAYS.filter((w) => (w === day ? on : x.weekdays.includes(w))) } : x)),
                  }));
                const weekdaysError = errorAt(`home.hours.${i}.weekdays`);
                return (
                  <div key={h.key} className="grid gap-3 rounded-md border bg-layer p-3">
                    <div className="flex flex-wrap items-end gap-2">
                      <Field label={t('opacHome.hours.days', { n })} error={errorAt(`home.hours.${i}.days`)} className="min-w-40 flex-1">
                        {(c) => (
                          <Input
                            {...c}
                            value={h.days}
                            maxLength={OPAC_HOME_LIMITS.hoursDays}
                            placeholder={t('opacHome.hours.days_placeholder')}
                            onChange={(e) => edit((d) => ({ ...d, hours: d.hours.map((x) => (x.key === h.key ? { ...x, days: e.target.value } : x)) }))}
                          />
                        )}
                      </Field>
                      <Field label={t('opacHome.hours.time', { n })} error={errorAt(`home.hours.${i}.time`)} className="min-w-32 flex-1">
                        {(c) => (
                          <Input
                            {...c}
                            value={h.time}
                            maxLength={OPAC_HOME_LIMITS.hoursTime}
                            placeholder={t('opacHome.hours.time_placeholder')}
                            onChange={(e) => edit((d) => ({ ...d, hours: d.hours.map((x) => (x.key === h.key ? { ...x, time: e.target.value } : x)) }))}
                          />
                        )}
                      </Field>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="bg-background"
                        aria-label={t('opacHome.hours.remove_label', { n })}
                        onClick={() => edit((d) => ({ ...d, hours: d.hours.filter((x) => x.key !== h.key) }))}
                      >
                        {t('opacHome.services.remove')}
                      </Button>
                    </div>
                    <fieldset aria-describedby={weekdaysError === undefined ? undefined : `hours-${h.key}-weekdays-error`}>
                      <legend className="mb-1 text-meta font-semibold">{t('opacHome.hours.weekdays', { n })}</legend>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {OPAC_HOME_WEEKDAYS.map((day) => (
                          <CheckField
                            key={day}
                            label={t(`opacHome.hours.weekday.${day}` as TKey)}
                            checked={h.weekdays.includes(day)}
                            onChange={(e) => {
                              const on = e.target.checked;
                              toggle(day, on);
                            }}
                          />
                        ))}
                      </div>
                      {weekdaysError !== undefined && <ControlError id={`hours-${h.key}-weekdays-error`}>{t(weekdaysError as TKey)}</ControlError>}
                    </fieldset>
                  </div>
                );
              })}
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={draft.hours.length >= OPAC_HOME_LIMITS.hours}
                  onClick={() => edit((d) => ({ ...d, hours: [...d.hours, { key: newRowKey(), days: '', time: '', weekdays: [] }] }))}
                >
                  {t('opacHome.hours.add')}
                </Button>
              </div>
            </div>
          </FormSection>

          <FormSection title={t('opacHome.blocks.title')} intro={t('opacHome.blocks.description')}>
            <div className={cn('grid gap-2 sm:grid-cols-2', FORM_FULL)}>
              {OPAC_HOME_BLOCKS.map((block) => (
                <CheckField
                  key={block}
                  label={t(`opacHome.blocks.${block}` as TKey)}
                  checked={draft.blocks[block]}
                  onChange={(e) => {
                    const on = e.target.checked;
                    edit((d) => ({ ...d, blocks: { ...d.blocks, [block]: on } }));
                  }}
                />
              ))}
            </div>
          </FormSection>

          <FormBar className="sticky bottom-0 z-10 bg-background pb-4">
            <Button ref={saveButton} type="submit" disabled={saving}>
              {t('opacHome.save')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!dirty || saving}
              onClick={() => {
                setErrors({});
                edit(() => baseline);
              }}
            >
              {t('opacHome.discard')}
            </Button>
            {dirty && <StatusText tone="warn">{t('opacHome.dirty')}</StatusText>}
          </FormBar>
        </form>
      </div>
    </>
  );
}
