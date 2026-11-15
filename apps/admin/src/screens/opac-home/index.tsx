import {
  OPAC_HOME_BLOCKS,
  OPAC_HOME_HERO_SIZE,
  OPAC_HOME_LIMITS,
  OPAC_HOME_PHOTO_SIZE,
  OPAC_HOME_POSITION_STEP,
  type OpacHomePutResponse,
  type OpacHomeView,
} from '@altis/shared/api/opac-home';
import type { OpacAccent } from '@altis/shared/api/settings';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { Badge, CheckField, Field, Notice, ProblemAlert, TEXTAREA_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT, type TKey } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { fieldErrorKey } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { uploadFile } from '@/lib/upload';
import { PHOTO_SOURCE_MAX_BYTES, PHOTO_SOURCE_TYPES, PhotoCropDialog, photoSourceOf, type PhotoSource } from './crop';
import { bodyOf, comparable, draftOf, newRowKey, type HomeDraft, type PhotoDraft } from './draft';

/**
 * OPAC › Halaman awal (`/admin/opac/beranda`, permission `opac.pages.manage`): the home page of the public site as the
 * library's profile. `GET opac/home` loads the content, both welcome texts and their revision; the form edits them in
 * one draft: the hero photo (uploaded as `opac.home_photo` after a 16:9 crop in the browser), its alternative text and
 * position, the heading and the lead sentence in each language, "about" (photo, paragraph, year founded, librarians),
 * up to eight services, up to four facility photos (4:3), the opening hours and the eight blocks shown. A preview of
 * the hero beside the form follows the unsaved draft. The save bar sticks to the bottom with a mark while something
 * is unsaved, "Batalkan perubahan" goes back to what was loaded, and `PUT opac/home` saves it all; a save another admin
 * made first is a 409 CONFLICT_STALE, which offers to reload. The draft is checked with the server's schema before it is
 * sent, and the server's field errors land on the same fields.
 */

const OPAC_HOME_KEY = ['opac', 'home'] as const;

/** The hero's colour without a photo, per accent (the OPAC theme's). */
const HERO_COLORS: Readonly<Record<OpacAccent, string>> = {
  teal: '#0f766e',
  blue: '#1d4ed8',
  green: '#15803d',
  purple: '#7e22ce',
  red: '#b91c1c',
  slate: '#334155',
};

const fileSrc = (fileId: string): string => `/files/${encodeURIComponent(fileId)}`;

/** The screen: its header, then the editor once the content is loaded. */
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
    body = (
      <div className="grid gap-3" aria-busy="true">
        <p role="status" className="sr-only">
          {t('opacHome.loading')}
        </p>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        ))}
      </div>
    );
  } else if (!canManage) {
    body = <p className="text-sm text-muted-foreground">{t('opacHome.no_permission')}</p>;
  } else if (query.isError || query.data === undefined) {
    body = (
      <Notice
        kind="error"
        action={
          <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t('opacHome.retry')}
          </Button>
        }
      >
        {t('opacHome.load_failed')}
      </Notice>
    );
  } else {
    body = (
      <HomeEditor
        key={`${query.data.revision}:${generation}`}
        view={query.data}
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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{t('opacHome.title')}</h1>
          <p className="max-w-prose text-sm text-muted-foreground">{t('opacHome.intro')}</p>
        </div>
        <Button asChild variant="outline">
          <a href="/" target="_blank" rel="noopener">
            {t('opacHome.view_site')}
          </a>
        </Button>
      </header>
      {notice !== null && <Notice kind="success">{notice}</Notice>}
      {body}
    </div>
  );
}

/** One part of the form: a heading and description beside its fields. */
function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-4 border-b pb-6 md:grid-cols-[14rem_minmax(0,1fr)]">
      <div className="grid content-start gap-1">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="grid content-start gap-4">{children}</div>
    </section>
  );
}

/** "12/90" under a text field. */
function Counter({ value, max }: { value: string; max: number }) {
  const t = useT();
  return <p className="text-xs text-muted-foreground tabular-nums">{t('opacHome.counter', { count: [...value].length, max })}</p>;
}

/**
 * A file input that decodes the chosen image, opens the crop dialog, uploads the JPEG as `opac.home_photo` and hands
 * the upload's id to `onUploaded`. A file that is not an image, too large or unreadable is refused before anything is
 * sent.
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
    if (!PHOTO_SOURCE_TYPES.includes(file.type)) {
      setError(t('opacHome.photo.not_image'));
      return;
    }
    if (file.size > PHOTO_SOURCE_MAX_BYTES) {
      setError(t('opacHome.photo.too_large', { size: (file.size / (1024 * 1024)).toFixed(1) }));
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
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <input
        ref={input}
        id={id}
        type="file"
        accept={PHOTO_SOURCE_TYPES.join(',')}
        className="text-xs"
        aria-describedby={error === null ? undefined : `${id}-error`}
        onChange={(e) => void choose(e)}
      />
      {error !== null && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {source !== null && <PhotoCropDialog source={source} width={size.width} height={size.height} onCancel={() => setSource(null)} onSave={save} />}
    </div>
  );
}

/** The hero preview: the photo (or the library colour), the overlay, the heading, the lead and the search box. */
function HeroPreview({ draft, view }: { draft: HomeDraft; view: OpacHomeView }) {
  const t = useT();
  const title = draft.title.trim() === '' ? view.libraryName : draft.title;
  const lead = draft.lead.id.trim() !== '' ? draft.lead.id : draft.lead.en;
  return (
    <div className="relative flex aspect-video items-end overflow-hidden rounded-lg p-4 text-white" style={{ backgroundColor: HERO_COLORS[view.accent] }}>
      {draft.hero !== null && (
        <>
          <img src={fileSrc(draft.hero.fileId)} alt="" className="absolute inset-0 size-full object-cover" style={{ objectPosition: `50% ${draft.hero.position}%` }} />
          <div aria-hidden="true" className="absolute inset-0" style={{ backgroundColor: 'rgb(8 12 20 / 0.64)' }} />
        </>
      )}
      <div className="relative grid gap-1.5">
        <p className="text-lg leading-tight font-bold text-balance">{title}</p>
        {lead.trim() !== '' && <p className="line-clamp-3 text-xs whitespace-pre-line">{lead}</p>}
        <span className="mt-1 w-max rounded bg-background px-2 py-1 text-[11px] text-muted-foreground">{t('opacHome.preview.search')}</span>
      </div>
    </div>
  );
}

/** The editor of one loaded revision (see the top of this file). */
function HomeEditor({ view, onEdited, onSaved, onReload }: { view: OpacHomeView; onEdited(): void; onSaved(): Promise<void>; onReload(): Promise<void> }) {
  const t = useT();
  const baseline = useMemo(() => draftOf(view), [view]);
  const [draft, setDraft] = useState<HomeDraft>(baseline);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<unknown>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = comparable(draft) !== comparable(baseline);
  useDirtyGuard(dirty);

  const edit = (change: (d: HomeDraft) => HomeDraft): void => {
    setDraft(change);
    onEdited();
  };
  /** The message of the field at `path`, if the last check refused it. */
  const errorAt = (path: string): string | undefined => (errors[path] === undefined ? undefined : fieldErrorKey(errors[path]));

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setProblem(null);
    setConflict(false);
    const built = bodyOf(draft, view.revision);
    if ('errors' in built) {
      setErrors(built.errors);
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
      } else setProblem(e);
      setSaving(false);
    }
  };

  const photoFields = (photo: PhotoDraft, path: string, set: (next: PhotoDraft) => void, withCaption: boolean) => (
    <>
      <Field label={t('opacHome.photo.alt')} hint={t('opacHome.photo.alt_hint')} error={errorAt(`${path}.alt`)}>
        {(c) => <Input {...c} required value={photo.alt} maxLength={OPAC_HOME_LIMITS.alt} onChange={(e) => set({ ...photo, alt: e.target.value })} />}
      </Field>
      {withCaption && (
        <Field label={t('opacHome.photo.caption')} error={errorAt(`${path}.caption`)}>
          {(c) => <Input {...c} value={photo.caption} maxLength={OPAC_HOME_LIMITS.caption} onChange={(e) => set({ ...photo, caption: e.target.value })} />}
        </Field>
      )}
    </>
  );

  const hasErrors = Object.keys(errors).length > 0;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start">
      <aside aria-label={t('opacHome.preview.title')} className="grid gap-2 xl:sticky xl:top-4 xl:order-2">
        <h2 className="text-sm font-semibold">{t('opacHome.preview.title')}</h2>
        <HeroPreview draft={draft} view={view} />
        <p className="text-xs text-muted-foreground">{t('opacHome.preview.hint')}</p>
      </aside>
      <form noValidate className="grid gap-6 xl:order-1" onSubmit={(e) => void save(e)}>
        {conflict && (
          <Notice
            kind="error"
            action={
              <Button type="button" size="sm" variant="outline" onClick={() => void onReload()}>
                {t('opacHome.reload')}
              </Button>
            }
          >
            {t('opacHome.conflict')}
          </Notice>
        )}
        {hasErrors && (
          <p role="alert" className="text-sm text-destructive">
            {t('opacHome.fix_fields')}
          </p>
        )}
        <ProblemAlert error={problem} />

        <Section title={t('opacHome.hero.title')} description={t('opacHome.hero.description')}>
          {draft.hero === null ? (
            <div className="grid aspect-video max-w-md place-items-center rounded-md border border-dashed bg-muted text-sm text-muted-foreground">{t('opacHome.photo.none')}</div>
          ) : (
            <img src={fileSrc(draft.hero.fileId)} alt={draft.hero.alt === '' ? t('opacHome.photo.preview_alt') : draft.hero.alt} className="aspect-video w-full max-w-md rounded-md border object-cover" />
          )}
          <div className="flex flex-wrap items-end gap-3">
            <PhotoUpload
              label={t(draft.hero === null ? 'opacHome.photo.upload' : 'opacHome.photo.replace')}
              size={OPAC_HOME_HERO_SIZE}
              onUploaded={(fileId) => edit((d) => ({ ...d, hero: { fileId, alt: '', position: d.hero?.position ?? 50 } }))}
            />
            {draft.hero !== null && (
              <Button type="button" variant="ghost" size="sm" onClick={() => edit((d) => ({ ...d, hero: null }))}>
                {t('opacHome.photo.remove')}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('opacHome.hero.hint')}</p>
          {draft.hero !== null && (
            <>
              <Field label={t('opacHome.photo.alt')} hint={t('opacHome.photo.alt_hint')} error={errorAt('home.hero.alt')}>
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
            </>
          )}
        </Section>

        <Section title={t('opacHome.text.title')} description={t('opacHome.text.description')}>
          <Field label={t('opacHome.text.heading')} hint={t('opacHome.text.heading_hint')} error={errorAt('home.title')}>
            {(c) => (
              <>
                <Input {...c} value={draft.title} maxLength={OPAC_HOME_LIMITS.title} placeholder={view.libraryName} onChange={(e) => edit((d) => ({ ...d, title: e.target.value }))} />
                <Counter value={draft.title} max={OPAC_HOME_LIMITS.title} />
              </>
            )}
          </Field>
          {(['id', 'en'] as const).map((locale) => (
            <Field key={locale} label={t(locale === 'id' ? 'opacHome.text.lead_id' : 'opacHome.text.lead_en')} error={errorAt(`welcome.${locale}`)}>
              {(c) => (
                <>
                  <textarea
                    {...c}
                    className={TEXTAREA_CLASS}
                    rows={3}
                    lang={locale}
                    value={draft.lead[locale]}
                    maxLength={OPAC_HOME_LIMITS.welcome}
                    onChange={(e) => edit((d) => ({ ...d, lead: { ...d.lead, [locale]: e.target.value } }))}
                  />
                  <Counter value={draft.lead[locale]} max={OPAC_HOME_LIMITS.welcome} />
                </>
              )}
            </Field>
          ))}
        </Section>

        <Section title={t('opacHome.about.title')} description={t('opacHome.about.description')}>
          {draft.about.photo !== null && (
            <img
              src={fileSrc(draft.about.photo.fileId)}
              alt={draft.about.photo.alt === '' ? t('opacHome.photo.preview_alt') : draft.about.photo.alt}
              className="aspect-[4/3] w-full max-w-xs rounded-md border object-cover"
            />
          )}
          <div className="flex flex-wrap items-end gap-3">
            <PhotoUpload
              label={t(draft.about.photo === null ? 'opacHome.photo.upload' : 'opacHome.photo.replace')}
              size={OPAC_HOME_PHOTO_SIZE}
              onUploaded={(fileId) => edit((d) => ({ ...d, about: { ...d.about, photo: { fileId, alt: '', caption: d.about.photo?.caption ?? '' } } }))}
            />
            {draft.about.photo !== null && (
              <Button type="button" variant="ghost" size="sm" onClick={() => edit((d) => ({ ...d, about: { ...d.about, photo: null } }))}>
                {t('opacHome.photo.remove')}
              </Button>
            )}
          </div>
          {draft.about.photo !== null &&
            photoFields(draft.about.photo, 'home.about.photo', (photo) => edit((d) => ({ ...d, about: { ...d.about, photo } })), true)}
          <Field label={t('opacHome.about.text')} error={errorAt('home.about.text')}>
            {(c) => (
              <>
                <textarea
                  {...c}
                  className={TEXTAREA_CLASS}
                  rows={5}
                  value={draft.about.text}
                  maxLength={OPAC_HOME_LIMITS.aboutText}
                  onChange={(e) => edit((d) => ({ ...d, about: { ...d.about, text: e.target.value } }))}
                />
                <Counter value={draft.about.text} max={OPAC_HOME_LIMITS.aboutText} />
              </>
            )}
          </Field>
          <div className="flex flex-wrap gap-4">
            <Field label={t('opacHome.about.founded')} error={errorAt('home.about.founded')} className="w-36">
              {(c) => <Input {...c} inputMode="numeric" maxLength={4} value={draft.about.founded} onChange={(e) => edit((d) => ({ ...d, about: { ...d.about, founded: e.target.value } }))} />}
            </Field>
            <Field label={t('opacHome.about.librarians')} error={errorAt('home.about.librarians')} className="w-36">
              {(c) => (
                <Input {...c} inputMode="numeric" maxLength={3} value={draft.about.librarians} onChange={(e) => edit((d) => ({ ...d, about: { ...d.about, librarians: e.target.value } }))} />
              )}
            </Field>
          </div>
        </Section>

        <Section
          title={t('opacHome.services.title')}
          description={t('opacHome.services.description', { services: OPAC_HOME_LIMITS.services, photos: OPAC_HOME_LIMITS.facilities })}
        >
          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">{t('opacHome.services.list')}</legend>
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
                <div key={s.key} className="grid gap-2 rounded-md border bg-muted/40 p-2">
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
                    <div className="flex gap-1 self-end">
                      <Button type="button" size="sm" variant="ghost" disabled={i === 0} aria-label={t('opacHome.services.up_label', { n })} onClick={() => move(i - 1)}>
                        {t('opacHome.services.up')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={i === draft.services.length - 1}
                        aria-label={t('opacHome.services.down_label', { n })}
                        onClick={() => move(i + 1)}
                      >
                        {t('opacHome.services.down')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
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
          <fieldset className="grid gap-3">
            <legend className="mb-2 text-sm font-medium">{t('opacHome.facilities.list')}</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {draft.facilities.map((f, i) => (
                <div key={f.key} role="group" aria-label={t('opacHome.facilities.photo', { n: i + 1 })} className="grid content-start gap-2 rounded-md border p-2">
                  <img src={fileSrc(f.fileId)} alt={f.alt === '' ? t('opacHome.photo.preview_alt') : f.alt} className="aspect-[4/3] w-full rounded object-cover" />
                  {photoFields(
                    f,
                    `home.facilities.${i}`,
                    (photo) => edit((d) => ({ ...d, facilities: d.facilities.map((x) => (x.key === f.key ? { ...x, ...photo } : x)) })),
                    true,
                  )}
                  <div>
                    <Button type="button" size="sm" variant="ghost" onClick={() => edit((d) => ({ ...d, facilities: d.facilities.filter((x) => x.key !== f.key) }))}>
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
        </Section>

        <Section title={t('opacHome.hours.title')} description={t('opacHome.hours.description')}>
          {draft.hours.map((h, i) => {
            const n = i + 1;
            return (
              <div key={h.key} className="flex flex-wrap items-end gap-2">
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
                  variant="ghost"
                  aria-label={t('opacHome.hours.remove_label', { n })}
                  onClick={() => edit((d) => ({ ...d, hours: d.hours.filter((x) => x.key !== h.key) }))}
                >
                  {t('opacHome.services.remove')}
                </Button>
              </div>
            );
          })}
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={draft.hours.length >= OPAC_HOME_LIMITS.hours}
              onClick={() => edit((d) => ({ ...d, hours: [...d.hours, { key: newRowKey(), days: '', time: '' }] }))}
            >
              {t('opacHome.hours.add')}
            </Button>
          </div>
        </Section>

        <Section title={t('opacHome.blocks.title')} description={t('opacHome.blocks.description')}>
          <div className="grid gap-2 sm:grid-cols-2">
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
        </Section>

        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t bg-background/95 px-4 py-3 md:-mx-6 md:px-6">
          <Button type="submit" disabled={saving}>
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
          {dirty && <Badge tone="warning">{t('opacHome.dirty')}</Badge>}
        </div>
      </form>
    </div>
  );
}
