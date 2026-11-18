import { useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { textIn, type SlideDraft } from './draft';
import { fileSrc, libraryColor, useHomeEditor } from './parts';

/** One slide as the site draws it, small: the text panel and the photo. */
export function SlidePreview({ slide, phone = false }: { slide: SlideDraft; phone?: boolean }) {
  const t = useT();
  const { draft, view } = useHomeEditor();
  const color = libraryColor(draft, view);
  const title = textIn(slide.title, 'id') || textIn(draft.title, 'id') || view.libraryName;
  const subtitle = textIn(slide.subtitle, 'id') || textIn(draft.lead, 'id');
  const note = textIn(slide.note, 'id');
  const label = slide.button ? textIn(slide.label, 'id') : '';
  return (
    <div data-slot="slide-preview" className={cn('grid overflow-hidden rounded-md border', phone ? 'mx-auto w-[220px] max-w-full' : 'h-44 grid-cols-[46%_minmax(0,1fr)]')}>
      {/* The library colour is a value of the content, so it is set as a style, which the page's policy allows. */}
      <div className={cn('flex min-w-0 flex-col justify-center gap-1.5 p-4 text-white', phone && 'order-2')} style={{ backgroundColor: color }}>
        {note !== '' && <p className="text-[10px] leading-snug">{note}</p>}
        <p className="line-clamp-3 text-[15px] leading-tight font-bold">{title}</p>
        {subtitle !== '' && <p className="line-clamp-3 text-[10.5px] leading-snug whitespace-pre-line">{subtitle}</p>}
        {label !== '' && (
          <span className="mt-0.5 self-start rounded-sm bg-white px-[7px] py-[3px] text-[10px] font-semibold" style={{ color }}>
            {label}
          </span>
        )}
      </div>
      {slide.fileId === '' ? (
        <div className={cn('grid place-items-center bg-layer text-xs text-muted-foreground', phone && 'aspect-[16/10]')}>{t('opacHome.photo.none')}</div>
      ) : (
        <img src={fileSrc(slide.fileId)} alt="" className={cn('size-full object-cover', phone && 'aspect-[16/10]')} style={{ objectPosition: `50% ${slide.position}%` }} />
      )}
    </div>
  );
}
