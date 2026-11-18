import { OPAC_HOME_LIMITS, OPAC_HOME_PHOTO_SIZE } from '@altis/shared/api/opac-home';
import { Field } from '@/components/form-field';
import { Card, FORM_FULL, FormSection } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { newRowKey } from './draft';
import { EditableList, LangFields, PhotoPreview, PhotoUpload, useHomeEditor } from './parts';

/**
 * The tab "Profil singkat": the page's heading and lead sentence, the "about" block (photo, paragraph, year founded,
 * librarians), and the library's profile: its history and timeline, its vision and mission, and the people who run it
 * (names and roles typed in for publication, never read from member or user records).
 */
export function ProfileTab() {
  const t = useT();
  const { draft, view, edit, errorAt } = useHomeEditor();
  const inLang = (id: Parameters<typeof t>[0], en: Parameters<typeof t>[0], params?: Record<string, string | number>) => (lang: 'id' | 'en') => t(lang === 'id' ? id : en, params);
  const photo = draft.about.photo;

  return (
    <Card>
      <FormSection title={t('opacHome.text.title')} intro={t('opacHome.text.description')}>
        <p className={cn('text-meta text-muted-foreground', FORM_FULL)}>{t('opacHome.text.languages_hint', { library: view.libraryName })}</p>
        <LangFields className={FORM_FULL} path="home.title" label={inLang('opacHome.text.heading_id', 'opacHome.text.heading_en')} value={draft.title} max={OPAC_HOME_LIMITS.title} error={errorAt} onChange={(title) => edit((d) => ({ ...d, title }))} />
        <LangFields className={FORM_FULL} path="welcome" label={inLang('opacHome.text.lead_id', 'opacHome.text.lead_en')} value={draft.lead} max={OPAC_HOME_LIMITS.welcome} rows={3} error={errorAt} onChange={(lead) => edit((d) => ({ ...d, lead }))} />
      </FormSection>

      <FormSection title={t('opacHome.about.title')} intro={t('opacHome.about.description')}>
        <div className={cn('grid gap-3', FORM_FULL)}>
          {photo !== null && <PhotoPreview fileId={photo.fileId} alt={photo.alt} ratio="aspect-[4/3]" className="max-w-xs" />}
          <div className="flex flex-wrap items-end gap-3">
            <PhotoUpload
              className="min-w-0 flex-1"
              label={t(photo === null ? 'opacHome.photo.upload' : 'opacHome.photo.replace')}
              size={OPAC_HOME_PHOTO_SIZE}
              onUploaded={(fileId) => edit((d) => ({ ...d, about: { ...d.about, photo: { fileId, alt: '', caption: d.about.photo?.caption ?? '' } } }), ['home.about.photo'])}
            />
            {photo !== null && (
              <Button type="button" variant="outline" size="sm" onClick={() => edit((d) => ({ ...d, about: { ...d.about, photo: null } }), ['home.about.photo'])}>
                {t('opacHome.photo.remove')}
              </Button>
            )}
          </div>
        </div>
        {photo !== null && (
          <>
            <Field label={t('opacHome.photo.alt')} hint={t('opacHome.photo.alt_hint')} error={errorAt('home.about.photo.alt')}>
              {(c) => <Input {...c} required value={photo.alt} maxLength={OPAC_HOME_LIMITS.alt} onChange={(e) => edit((d) => ({ ...d, about: { ...d.about, photo: { ...photo, alt: e.target.value } } }))} />}
            </Field>
            <Field label={t('opacHome.photo.caption')} error={errorAt('home.about.photo.caption')}>
              {(c) => <Input {...c} value={photo.caption} maxLength={OPAC_HOME_LIMITS.caption} onChange={(e) => edit((d) => ({ ...d, about: { ...d.about, photo: { ...photo, caption: e.target.value } } }))} />}
            </Field>
          </>
        )}
        <LangFields
          className={FORM_FULL}
          path="home.about.text"
          label={inLang('opacHome.about.text_id', 'opacHome.about.text_en')}
          value={draft.about.text}
          max={OPAC_HOME_LIMITS.aboutText}
          rows={5}
          error={errorAt}
          onChange={(text) => edit((d) => ({ ...d, about: { ...d.about, text } }))}
        />
        <Field label={t('opacHome.about.founded')} error={errorAt('home.about.founded')}>
          {(c) => <Input {...c} inputMode="numeric" maxLength={4} className="w-28" value={draft.about.founded} onChange={(e) => edit((d) => ({ ...d, about: { ...d.about, founded: e.target.value } }))} />}
        </Field>
        <Field label={t('opacHome.about.librarians')} error={errorAt('home.about.librarians')}>
          {(c) => <Input {...c} inputMode="numeric" maxLength={3} className="w-28" value={draft.about.librarians} onChange={(e) => edit((d) => ({ ...d, about: { ...d.about, librarians: e.target.value } }))} />}
        </Field>
      </FormSection>

      <FormSection title={t('opacHome.history.title')} intro={t('opacHome.history.description')}>
        <LangFields
          className={FORM_FULL}
          path="home.about.history"
          label={inLang('opacHome.history.text_id', 'opacHome.history.text_en')}
          hint={t('opacHome.history.text_hint')}
          value={draft.about.history}
          max={OPAC_HOME_LIMITS.history}
          rows={8}
          error={errorAt}
          onChange={(history) => edit((d) => ({ ...d, about: { ...d.about, history } }))}
        />
        <EditableList
          className={FORM_FULL}
          legend={t('opacHome.timeline.list')}
          rows={draft.timeline}
          max={OPAC_HOME_LIMITS.timeline}
          empty={t('opacHome.timeline.empty')}
          addLabel={t('opacHome.timeline.add')}
          labels={(n) => ({ up: t('opacHome.timeline.up', { n }), down: t('opacHome.timeline.down', { n }), remove: t('opacHome.timeline.remove', { n }) })}
          create={() => ({ key: newRowKey(), year: '', text: { id: '', en: '' } })}
          update={(change, places) => edit((d) => ({ ...d, timeline: change(d.timeline) }), places ? ['home.timeline'] : undefined)}>
          {(row, i, set) => (
            <div className="grid gap-x-5 gap-y-3 sm:grid-cols-[7rem_minmax(0,1fr)]">
              <Field label={t('opacHome.timeline.year', { n: i + 1 })} error={errorAt(`home.timeline.${i}.year`)}>
                {(c) => <Input {...c} inputMode="numeric" maxLength={4} value={row.year} onChange={(e) => set({ year: e.target.value })} />}
              </Field>
              <LangFields
                path={`home.timeline.${i}.text`}
                label={inLang('opacHome.timeline.text_id', 'opacHome.timeline.text_en', { n: i + 1 })}
                value={row.text}
                max={OPAC_HOME_LIMITS.timelineText}
                error={errorAt}
                onChange={(text) => set({ text })}
              />
            </div>
          )}
        </EditableList>
      </FormSection>

      <FormSection title={t('opacHome.vision.title')} intro={t('opacHome.vision.description')}>
        <LangFields className={FORM_FULL} path="home.vision" label={inLang('opacHome.vision.text_id', 'opacHome.vision.text_en')} value={draft.vision} max={OPAC_HOME_LIMITS.vision} rows={3} error={errorAt} onChange={(vision) => edit((d) => ({ ...d, vision }))} />
        <EditableList
          className={FORM_FULL}
          legend={t('opacHome.mission.list')}
          rows={draft.mission}
          max={OPAC_HOME_LIMITS.mission}
          empty={t('opacHome.mission.empty')}
          addLabel={t('opacHome.mission.add')}
          labels={(n) => ({ up: t('opacHome.mission.up', { n }), down: t('opacHome.mission.down', { n }), remove: t('opacHome.mission.remove', { n }) })}
          create={() => ({ key: newRowKey(), text: { id: '', en: '' } })}
          update={(change, places) => edit((d) => ({ ...d, mission: change(d.mission) }), places ? ['home.mission'] : undefined)}>
          {(row, i, set) => (
            <LangFields path={`home.mission.${i}`} label={inLang('opacHome.mission.text_id', 'opacHome.mission.text_en', { n: i + 1 })} value={row.text} max={OPAC_HOME_LIMITS.missionText} error={errorAt} onChange={(text) => set({ text })} />
          )}
        </EditableList>
      </FormSection>

      <FormSection title={t('opacHome.staff.title')} intro={t('opacHome.staff.description')}>
        <EditableList
          className={FORM_FULL}
          legend={t('opacHome.staff.list')}
          hint={t('opacHome.staff.hint')}
          rows={draft.staff}
          max={OPAC_HOME_LIMITS.staff}
          empty={t('opacHome.staff.empty')}
          addLabel={t('opacHome.staff.add')}
          labels={(n) => ({ up: t('opacHome.staff.up', { n }), down: t('opacHome.staff.down', { n }), remove: t('opacHome.staff.remove', { n }) })}
          create={() => ({ key: newRowKey(), name: '', role: { id: '', en: '' } })}
          update={(change, places) => edit((d) => ({ ...d, staff: change(d.staff) }), places ? ['home.staff'] : undefined)}>
          {(row, i, set) => (
            <div className="grid gap-x-5 gap-y-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <Field label={t('opacHome.staff.name', { n: i + 1 })} error={errorAt(`home.staff.${i}.name`)}>
                {(c) => <Input {...c} autoComplete="off" value={row.name} maxLength={OPAC_HOME_LIMITS.staffName} onChange={(e) => set({ name: e.target.value })} />}
              </Field>
              <LangFields path={`home.staff.${i}.role`} label={inLang('opacHome.staff.role_id', 'opacHome.staff.role_en', { n: i + 1 })} value={row.role} max={OPAC_HOME_LIMITS.staffRole} error={errorAt} onChange={(role) => set({ role })} />
            </div>
          )}
        </EditableList>
      </FormSection>
    </Card>
  );
}
