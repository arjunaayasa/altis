import { OPAC_HOME_LIMITS, OPAC_HOME_PHOTO_SIZE } from '@altis/shared/api/opac-home';
import { Field } from '@/components/form-field';
import { Card, FORM_FULL, FormSection } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { newRowKey } from './draft';
import { EditableList, PhotoPreview, PhotoUpload, useHomeEditor } from './parts';

/** The tab "Layanan": up to eight services (a name and a short explanation each) and up to four facility photos (4:3). */
export function ServicesTab() {
  const t = useT();
  const { draft, edit, errorAt, saving } = useHomeEditor();
  return (
    <Card>
      <FormSection title={t('opacHome.services.list')} intro={t('opacHome.services.description', { services: OPAC_HOME_LIMITS.services })}>
        <EditableList
          className={FORM_FULL}
          legend={t('opacHome.services.list')}
          rows={draft.services}
          max={OPAC_HOME_LIMITS.services}
          empty={t('opacHome.services.empty')}
          addLabel={t('opacHome.services.add')}
          labels={(n) => ({ up: t('opacHome.services.up_label', { n }), down: t('opacHome.services.down_label', { n }), remove: t('opacHome.services.remove_label', { n }) })}
          create={() => ({ key: newRowKey(), title: '', text: '' })}
          update={(change, places) => edit((d) => ({ ...d, services: change(d.services) }), places ? ['home.services'] : undefined)}>
          {(row, i, set) => (
            <div className="grid gap-x-5 gap-y-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <Field label={t('opacHome.services.name', { n: i + 1 })} error={errorAt(`home.services.${i}.title`)}>
                {(c) => <Input {...c} value={row.title} maxLength={OPAC_HOME_LIMITS.serviceTitle} onChange={(e) => set({ title: e.target.value })} />}
              </Field>
              <Field label={t('opacHome.services.text', { n: i + 1 })} error={errorAt(`home.services.${i}.text`)}>
                {(c) => <Input {...c} value={row.text} maxLength={OPAC_HOME_LIMITS.serviceText} onChange={(e) => set({ text: e.target.value })} />}
              </Field>
            </div>
          )}
        </EditableList>
      </FormSection>

      <FormSection title={t('opacHome.facilities.list')} intro={t('opacHome.facilities.description', { photos: OPAC_HOME_LIMITS.facilities })}>
        <div className={cn('grid gap-3', FORM_FULL)}>
          {draft.facilities.length === 0 && <p className="text-sm text-muted-foreground">{t('opacHome.facilities.empty')}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {draft.facilities.map((f, i) => {
              const set = (patch: Partial<typeof f>): void => edit((d) => ({ ...d, facilities: d.facilities.map((x) => (x.key === f.key ? { ...x, ...patch } : x)) }));
              return (
                <div key={f.key} role="group" aria-label={t('opacHome.facilities.photo', { n: i + 1 })} className="grid content-start gap-3 rounded-md border p-3">
                  <PhotoPreview fileId={f.fileId} alt={f.alt} ratio="aspect-[4/3]" />
                  <Field label={t('opacHome.photo.alt')} hint={t('opacHome.photo.alt_hint')} error={errorAt(`home.facilities.${i}.alt`) ?? errorAt(`home.facilities.${i}.fileId`)}>
                    {(c) => <Input {...c} required value={f.alt} maxLength={OPAC_HOME_LIMITS.alt} onChange={(e) => set({ alt: e.target.value })} />}
                  </Field>
                  <Field label={t('opacHome.photo.caption')} error={errorAt(`home.facilities.${i}.caption`)}>
                    {(c) => <Input {...c} value={f.caption} maxLength={OPAC_HOME_LIMITS.caption} onChange={(e) => set({ caption: e.target.value })} />}
                  </Field>
                  <div>
                    <Button type="button" size="sm" variant="outline" disabled={saving} aria-label={t('opacHome.facilities.remove', { n: i + 1 })} onClick={() => edit((d) => ({ ...d, facilities: d.facilities.filter((x) => x.key !== f.key) }), ['home.facilities'])}>
                      {t('opacHome.photo.remove')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          {draft.facilities.length < OPAC_HOME_LIMITS.facilities ? (
            <PhotoUpload label={t('opacHome.facilities.add')} size={OPAC_HOME_PHOTO_SIZE} onUploaded={(fileId) => edit((d) => ({ ...d, facilities: [...d.facilities, { key: newRowKey(), fileId, alt: '', caption: '' }] }))} />
          ) : (
            <p className="text-xs text-muted-foreground">{t('opacHome.row.full', { max: OPAC_HOME_LIMITS.facilities })}</p>
          )}
        </div>
      </FormSection>
    </Card>
  );
}
