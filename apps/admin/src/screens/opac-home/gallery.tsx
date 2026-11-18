import { OPAC_HOME_LIMITS, OPAC_HOME_PHOTO_SIZE } from '@altis/shared/api/opac-home';
import { useRef } from 'react';
import { Field } from '@/components/form-field';
import { Card, CardBody, EmptyState } from '@/components/layout';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { moved, newRowKey } from './draft';
import { LangFields, PhotoPreview, PhotoUpload, RowActions, useHomeEditor } from './parts';

/**
 * The tab "Galeri": up to eight photos of the library (4:3, cropped in the browser like the facility photos), each
 * with its alternative text (required) and a caption per language, in the order the site shows them.
 */
export function GalleryTab() {
  const t = useT();
  const { draft, edit, errorAt, announce, saving } = useHomeEditor();
  const upload = useRef<HTMLInputElement>(null);
  const { gallery } = draft;
  const full = gallery.length >= OPAC_HOME_LIMITS.gallery;
  return (
    <Card title={t('opacHome.gallery.title')} description={t('opacHome.gallery.description', { count: gallery.length, max: OPAC_HOME_LIMITS.gallery })}>
      {gallery.length === 0 ? (
        <EmptyState title={t('opacHome.gallery.empty')}>
          <p>{t('opacHome.gallery.empty_hint')}</p>
        </EmptyState>
      ) : (
        <CardBody>
          <ol aria-label={t('opacHome.gallery.list')} className="grid gap-3 md:grid-cols-2">
            {gallery.map((g, i) => {
              const n = i + 1;
              const set = (patch: Partial<typeof g>): void => edit((d) => ({ ...d, gallery: d.gallery.map((x) => (x.key === g.key ? { ...x, ...patch } : x)) }));
              return (
                <li key={g.key} aria-label={t('opacHome.gallery.photo', { n })} className="grid content-start gap-3 rounded-md border p-3">
                  <PhotoPreview fileId={g.fileId} alt={g.alt} ratio="aspect-[4/3]" />
                  <Field label={t('opacHome.gallery.alt', { n })} hint={t('opacHome.photo.alt_hint')} error={errorAt(`home.gallery.${i}.alt`) ?? errorAt(`home.gallery.${i}.fileId`)}>
                    {(c) => <Input {...c} required aria-required="true" value={g.alt} maxLength={OPAC_HOME_LIMITS.alt} onChange={(e) => set({ alt: e.target.value })} />}
                  </Field>
                  <LangFields
                    path={`home.gallery.${i}.caption`}
                    label={(lang) => t(lang === 'id' ? 'opacHome.gallery.caption_id' : 'opacHome.gallery.caption_en', { n })}
                    value={g.caption}
                    max={OPAC_HOME_LIMITS.caption}
                    error={errorAt}
                    onChange={(caption) => set({ caption })}
                  />
                  <RowActions
                    index={i}
                    count={gallery.length}
                    disabled={saving}
                    labels={{ up: t('opacHome.gallery.up', { n }), down: t('opacHome.gallery.down', { n }), remove: t('opacHome.gallery.remove', { n }) }}
                    onMove={(to) => {
                      edit((d) => ({ ...d, gallery: moved(d.gallery, i, to) }), ['home.gallery']);
                      announce(t('opacHome.gallery.moved', { from: n, to: to + 1 }));
                    }}
                    onRemove={() => {
                      edit((d) => ({ ...d, gallery: d.gallery.filter((x) => x.key !== g.key) }), ['home.gallery']);
                      announce(t('opacHome.gallery.removed', { n }));
                      setTimeout(() => upload.current?.focus());
                    }}
                  />
                </li>
              );
            })}
          </ol>
        </CardBody>
      )}
      <CardBody className="border-t">
        {full ? (
          <p className="text-meta text-muted-foreground">{t('opacHome.gallery.full', { max: OPAC_HOME_LIMITS.gallery })}</p>
        ) : (
          <PhotoUpload
            inputRef={upload}
            label={t('opacHome.gallery.add')}
            size={OPAC_HOME_PHOTO_SIZE}
            onUploaded={(fileId) => edit((d) => ({ ...d, gallery: [...d.gallery, { key: newRowKey(), fileId, alt: '', caption: { id: '', en: '' } }] }))}
          />
        )}
      </CardBody>
    </Card>
  );
}
