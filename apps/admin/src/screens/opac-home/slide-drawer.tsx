import { OPAC_HOME_HERO_SIZE, OPAC_HOME_LIMITS, OPAC_HOME_POSITION_STEP, OPAC_HOME_TARGET_KINDS, type OpacHomeLang, type OpacHomeTargetKind } from '@altis/shared/api/opac-home';
import { useEffect, useId, useState } from 'react';
import { Field, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { EditorDrawer } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT, type TKey } from '@/i18n';
import { fieldErrorKey } from '@/lib/form-errors';
import { slideErrors, type SlideDraft, type TextDraft } from './draft';
import { Counter, PhotoPreview, PhotoUpload, Segmented, Switch } from './parts';
import { SlidePreview } from './slide-preview';

/**
 * The drawer that edits one slide of the hero: on the left its photo (uploaded after a 16:9 crop, the part kept when
 * the site cuts it, its alternative text) and a small preview, on the right its texts in the language picked (title,
 * subtitle, the short line above the title), its button (the label and where it leads: a kind and, for a news post or a
 * path of this site, a reference; never a free address) and the days it shows. "Selesai" checks the slide with the
 * server's schema and puts it in the page's draft; "Batal", Esc and the close button leave the draft as it was.
 */

const TARGET_NAMES: Readonly<Record<OpacHomeTargetKind, TKey>> = {
  catalog: 'opacHome.target.catalog',
  profile: 'opacHome.target.profile',
  news: 'opacHome.target.news',
  path: 'opacHome.target.path',
};

/** The name of a kind of place a slide's button leads to. */
export const targetName = (t: ReturnType<typeof useT>, kind: OpacHomeTargetKind): string => t(TARGET_NAMES[kind]);

/** The words for a refused field of the slide. */
function errorKey(path: string, code: string, slide: SlideDraft): TKey {
  if (path === 'fileId') return code === 'duplicate' ? 'opacHome.photo.duplicate' : 'opacHome.slide.photo_required';
  if (path === 'until') return 'opacHome.slide.until_before';
  if (path === 'cta.target.ref') return slide.targetKind === 'path' ? 'opacHome.slide.path_invalid' : 'opacHome.slide.slug_invalid';
  if (path === 'cta.label') return 'form.error.required';
  return fieldErrorKey(code);
}

export function SlideDrawer({
  slide: given,
  number,
  isNew,
  refused,
  onApply,
  onCancel,
}: {
  slide: SlideDraft;
  /** The slide's place in the list, from 1. */
  number: number;
  isNew: boolean;
  /** What the page's last check refused of this slide, by the slide's own paths. */
  refused: Readonly<Record<string, string>>;
  onApply(slide: SlideDraft): void;
  onCancel(): void;
}) {
  const t = useT();
  const ids = useId();
  const [slide, setSlide] = useState<SlideDraft>(given);
  const [errors, setErrors] = useState<Record<string, string>>({ ...refused });
  const [lang, setLang] = useState<OpacHomeLang>(() => (Object.keys(refused).some((p) => p.endsWith('.en')) && !Object.keys(refused).some((p) => p.endsWith('.id')) ? 'en' : 'id'));
  /** Bumped when "Selesai" refuses fields: the first refused field then takes the focus. */
  const [refusals, setRefusals] = useState(0);

  useEffect(() => {
    if (refusals > 0) document.querySelector<HTMLElement>('[data-slot="editor-drawer"] [aria-invalid="true"]')?.focus();
  }, [refusals]);

  /** Changes the slide; the refusals of the `paths` touched no longer hold. */
  const change = (patch: Partial<SlideDraft>, ...paths: string[]): void => {
    setSlide((s) => ({ ...s, ...patch }));
    setErrors((e) => (paths.some((p) => p in e) ? Object.fromEntries(Object.entries(e).filter(([p]) => !paths.includes(p))) : e));
  };
  const errorAt = (path: string): TKey | undefined => {
    const code = errors[path];
    return code === undefined ? undefined : errorKey(path, code, slide);
  };
  const setText = (name: 'title' | 'subtitle' | 'note' | 'label', value: string): void => {
    const next: TextDraft = { ...slide[name], [lang]: value };
    const path = name === 'label' ? 'cta.label' : name;
    change({ [name]: next }, `${path}.${lang}`, path);
  };

  const submit = (): void => {
    const found = slideErrors(slide);
    const paths = Object.keys(found);
    if (paths.length === 0) {
      onApply(slide);
      return;
    }
    setErrors(found);
    // A refused text of the other language is brought on screen.
    const other: OpacHomeLang = lang === 'id' ? 'en' : 'id';
    if (paths.some((p) => p.endsWith(`.${other}`)) && !paths.some((p) => p.endsWith(`.${lang}`))) setLang(other);
    setRefusals((n) => n + 1);
  };

  const langName = t(lang === 'id' ? 'opacHome.lang.id' : 'opacHome.lang.en');
  const labelled = (key: TKey): string => `${t(key)} (${langName})`;
  const photoError = errorAt('fileId');
  const refError = errorAt('cta.target.ref');
  const target = slide.button ? slide.targetKind : 'none';

  return (
    <EditorDrawer
      open
      title={isNew ? t('opacHome.slide.new') : t('opacHome.slides.edit', { n: number })}
      description={t('opacHome.slide.description')}
      closeLabel={t('opacHome.slide.close')}
      onSubmit={submit}
      onClose={onCancel}
      footer={
        <>
          <span className="flex items-center gap-2">
            <Switch id={`${ids}-active`} checked={slide.active} onChange={(active) => change({ active })} />
            <label htmlFor={`${ids}-active`}>{t('opacHome.slide.active')}</label>
          </span>
          <Button type="button" variant="ghost" className="ml-auto" onClick={onCancel}>
            {t('form.cancel')}
          </Button>
          <Button type="submit">{t('opacHome.slide.done')}</Button>
        </>
      }>
      <div className="grid min-w-0 content-start gap-4">
        <PhotoPreview fileId={slide.fileId} alt={slide.alt} ratio="aspect-video" position={slide.position} />
        <PhotoUpload
          label={t(slide.fileId === '' ? 'opacHome.photo.upload' : 'opacHome.photo.replace')}
          size={OPAC_HOME_HERO_SIZE}
          error={photoError === undefined ? undefined : t(photoError)}
          onUploaded={(fileId) => change({ fileId, alt: '' }, 'fileId')}
        />
        <Field label={t('opacHome.slide.position')} hint={t('opacHome.slide.position_hint', { value: slide.position })}>
          {(c) => <input {...c} type="range" min={0} max={100} step={OPAC_HOME_POSITION_STEP} value={slide.position} onChange={(e) => change({ position: Number(e.target.value) })} />}
        </Field>
        <Field label={t('opacHome.slide.alt')} hint={t('opacHome.slide.alt_hint')} error={errorAt('alt')}>
          {(c) => <Input {...c} required aria-required="true" value={slide.alt} maxLength={OPAC_HOME_LIMITS.alt} onChange={(e) => change({ alt: e.target.value }, 'alt')} />}
        </Field>
        <figure aria-labelledby={`${ids}-preview`} className="grid gap-1.5">
          <figcaption id={`${ids}-preview`} className="text-meta font-semibold">
            {t('opacHome.slide.preview')}
          </figcaption>
          <SlidePreview slide={slide} />
        </figure>
      </div>

      <div className="grid min-w-0 content-start gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">{t('opacHome.slide.texts')}</p>
          <span className="ml-auto">
            <Segmented<OpacHomeLang>
              label={t('opacHome.slide.language')}
              value={lang}
              onChange={setLang}
              options={[
                { id: 'id', label: t('opacHome.lang.id') },
                { id: 'en', label: t('opacHome.lang.en') },
              ]}
            />
          </span>
        </div>
        <Field key={`title-${lang}`} label={labelled('opacHome.slide.title')} error={errorAt(`title.${lang}`)}>
          {(c) => (
            <>
              <Input {...c} lang={lang} value={slide.title[lang]} maxLength={OPAC_HOME_LIMITS.slideTitle} onChange={(e) => setText('title', e.target.value)} />
              <p className="text-xs text-muted-foreground tabular-nums">{t('opacHome.slide.title_count', { count: [...slide.title[lang]].length, max: OPAC_HOME_LIMITS.slideTitle })}</p>
            </>
          )}
        </Field>
        <Field key={`subtitle-${lang}`} label={labelled('opacHome.slide.subtitle')} error={errorAt(`subtitle.${lang}`)}>
          {(c) => (
            <>
              <textarea {...c} className={TEXTAREA_CLASS} rows={3} lang={lang} value={slide.subtitle[lang]} maxLength={OPAC_HOME_LIMITS.slideSubtitle} onChange={(e) => setText('subtitle', e.target.value)} />
              <Counter value={slide.subtitle[lang]} max={OPAC_HOME_LIMITS.slideSubtitle} />
            </>
          )}
        </Field>
        <Field key={`note-${lang}`} label={labelled('opacHome.slide.note')} hint={t('opacHome.slide.note_hint')} error={errorAt(`note.${lang}`)}>
          {(c) => <Input {...c} lang={lang} value={slide.note[lang]} maxLength={OPAC_HOME_LIMITS.slideNote} onChange={(e) => setText('note', e.target.value)} />}
        </Field>

        <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
          <Field label={t('opacHome.slide.target')}>
            {(c) => (
              <select
                {...c}
                className={SELECT_CLASS}
                value={target}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next === 'none') change({ button: false }, 'cta.label', 'cta.label.id', 'cta.label.en', 'cta.target.ref');
                  else change({ button: true, targetKind: next as OpacHomeTargetKind, targetRef: '' }, 'cta.target.ref');
                }}>
                <option value="none">{t('opacHome.target.none')}</option>
                {OPAC_HOME_TARGET_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {targetName(t, kind)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {slide.button && (
            <Field key={`label-${lang}`} label={labelled('opacHome.slide.label')} error={errorAt(`cta.label.${lang}`) ?? (lang === 'id' ? errorAt('cta.label') : undefined)}>
              {(c) => <Input {...c} lang={lang} value={slide.label[lang]} maxLength={OPAC_HOME_LIMITS.ctaLabel} onChange={(e) => setText('label', e.target.value)} />}
            </Field>
          )}
        </div>
        {slide.button && slide.targetKind === 'news' && (
          <Field label={t('opacHome.slide.news_ref')} hint={t('opacHome.slide.news_ref_hint')} error={refError}>
            {(c) => <Input {...c} value={slide.targetRef} maxLength={191} spellCheck={false} autoComplete="off" onChange={(e) => change({ targetRef: e.target.value }, 'cta.target.ref')} />}
          </Field>
        )}
        {slide.button && slide.targetKind === 'path' && (
          <Field label={t('opacHome.slide.path_ref')} hint={t('opacHome.slide.path_ref_hint')} error={refError}>
            {(c) => (
              <Input
                {...c}
                required
                aria-required="true"
                value={slide.targetRef}
                maxLength={OPAC_HOME_LIMITS.targetPath}
                spellCheck={false}
                autoComplete="off"
                placeholder="/halaman/tata-tertib"
                onChange={(e) => change({ targetRef: e.target.value }, 'cta.target.ref')}
              />
            )}
          </Field>
        )}

        <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
          <Field label={t('opacHome.slide.from')} hint={t('opacHome.slide.from_hint')} error={errorAt('from')}>
            {(c) => <Input {...c} type="date" value={slide.from} onChange={(e) => change({ from: e.target.value }, 'from', 'until')} />}
          </Field>
          <Field label={t('opacHome.slide.until')} hint={t('opacHome.slide.until_hint')} error={errorAt('until')}>
            {(c) => <Input {...c} type="date" value={slide.until} min={slide.from === '' ? undefined : slide.from} onChange={(e) => change({ until: e.target.value }, 'until')} />}
          </Field>
        </div>
      </div>
    </EditorDrawer>
  );
}
