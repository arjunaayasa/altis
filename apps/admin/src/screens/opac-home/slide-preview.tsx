import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { textIn, type SlideDraft } from './draft';
import { fileSrc, libraryColor, useHomeEditor } from './parts';

/** Miniature preview of one hero slide: full-bleed photograph with a directional contrast scrim and overlaid white text. */
export function SlidePreview({ slide, phone = false }: { slide: SlideDraft; phone?: boolean }) {
  const t = useT();
  const { draft, view } = useHomeEditor();
  const color = libraryColor(draft, view);
  const title = textIn(slide.title, 'id') || textIn(draft.title, 'id') || view.libraryName;
  const subtitle = textIn(slide.subtitle, 'id') || textIn(draft.lead, 'id');
  const note = textIn(slide.note, 'id');
  const label = slide.button ? textIn(slide.label, 'id') : '';
  const hasPhoto = slide.fileId !== '';

  return (
    <div
      data-slot="slide-preview"
      className={cn('relative grid overflow-hidden rounded-md border text-white', phone ? 'mx-auto aspect-[4/5] w-[220px] max-w-full' : 'aspect-video w-full')}
      style={hasPhoto ? undefined : { backgroundColor: color }}>
      {hasPhoto ? (
        <>
          <img src={fileSrc(slide.fileId)} alt="" className="col-start-1 row-start-1 size-full object-cover" style={{ objectPosition: `50% ${slide.position}%` }} />
          <div
            aria-hidden="true"
            className="pointer-events-none col-start-1 row-start-1"
            style={{
              background: phone
                ? 'linear-gradient(180deg, rgb(12 16 15 / 0.24) 0%, rgb(12 16 15 / 0.74) 42%, rgb(12 16 15 / 0.9) 100%)'
                : 'linear-gradient(98deg, rgb(12 16 15 / 0.88) 0%, rgb(12 16 15 / 0.76) 56%, rgb(12 16 15 / 0.26) 100%)',
            }}
          />
        </>
      ) : (
        <div className="col-start-1 row-start-1 flex items-start justify-end p-2.5 text-[10px] text-white/75">{t('opacHome.photo.none')}</div>
      )}
      <div className={cn('relative z-10 col-start-1 row-start-1 flex min-w-0 flex-col justify-end gap-1 p-4', !phone && 'max-w-[72%]')}>
        {note !== '' && <p className="text-[10px] font-semibold text-white/90">{note}</p>}
        <p className="line-clamp-3 text-[15px] leading-tight font-bold">{title}</p>
        {subtitle !== '' && <p className="line-clamp-2 text-[10.5px] leading-snug whitespace-pre-line text-white/90">{subtitle}</p>}
        {label !== '' && <span className="mt-1 self-start rounded-sm bg-white px-[8px] py-[3.5px] text-[10px] font-semibold text-[#141817]">{label}</span>}
      </div>
    </div>
  );
}
