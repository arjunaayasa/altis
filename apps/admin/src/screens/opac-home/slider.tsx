import { OPAC_HOME_HERO_SIZE, OPAC_HOME_INTERVALS, OPAC_HOME_LIMITS, opacHomeSlideShown, type OpacHomeInterval } from '@altis/shared/api/opac-home';
import { PencilIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SELECT_CLASS } from '@/components/form-field';
import { Card, CardBody, EmptyState, SettingRow, StatusText, Tag } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useLocale, useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { englishMissing, moved, newSlideDraft, slideErrorsAt, slidePath, textIn, type SlideDraft } from './draft';
import { RowActions, Segmented, Switch, fileSrc, useHomeEditor } from './parts';
import { SlideDrawer, targetName } from './slide-drawer';
import { SlidePreview } from './slide-preview';

/**
 * The tab "Slider hero": the hero's slides as a list (a thumbnail, the numbered title, when it shows, where its button
 * leads, a warning when its English text is missing, the switch that shows it, the buttons that move it, edit it and
 * take it out), how the slides advance, and beside the list a preview of one slide as the site draws it (the text on a
 * panel of the library colour, the photo beside it; on a phone the photo above the panel). A slide is edited in a
 * drawer; what is done there lands in the page's draft.
 */

/** Today's calendar date here (`YYYY-MM-DD`): what the list's schedule words are measured against. */
function today(): string {
  const now = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** A date of the draft as the list writes it ("20 Des 2026"); the text as typed when it is not a date. */
function dateText(value: string, locale: string): string {
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return value;
  return new Intl.DateTimeFormat(locale === 'id' ? 'id-ID' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(time);
}

export function SliderTab() {
  const t = useT();
  const locale = useLocale();
  const { draft, edit, errors, announce, saving } = useHomeEditor();
  const intervalId = useId();
  const autoplayId = useId();
  /** The slide in the drawer: a copy of one of the list (`index`), or a new one (`index` null). */
  const [editing, setEditing] = useState<{ slide: SlideDraft; index: number | null } | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [size, setSize] = useState<'wide' | 'phone'>('wide');
  const { slides } = draft;
  const day = today();
  const full = slides.length >= OPAC_HOME_LIMITS.slides;
  const shown = slides.filter((s) => opacHomeSlideShown({ active: s.active, from: s.from || null, until: s.until || null }, day)).length;

  const scheduleText = (s: SlideDraft): string => {
    if (s.until !== '' && day > s.until) return t('opacHome.slides.ended', { date: dateText(s.until, locale) });
    if (s.from !== '' && day < s.from) return t('opacHome.slides.not_started', { date: dateText(s.from, locale) });
    if (s.from !== '' && s.until !== '') return t('opacHome.slides.range', { from: dateText(s.from, locale), until: dateText(s.until, locale) });
    if (s.from !== '') return t('opacHome.slides.from', { date: dateText(s.from, locale) });
    if (s.until !== '') return t('opacHome.slides.until', { date: dateText(s.until, locale) });
    return t('opacHome.slides.always');
  };
  const targetText = (s: SlideDraft): string =>
    s.button ? t('opacHome.slides.button', { label: textIn(s.label, 'id') || t('opacHome.slides.no_label'), target: targetName(t, s.targetKind) }) : t('opacHome.slides.no_button');

  const previewIndex = (() => {
    const picked = slides.findIndex((s) => s.key === selected);
    if (picked !== -1) return picked;
    const first = slides.findIndex((s) => opacHomeSlideShown({ active: s.active, from: s.from || null, until: s.until || null }, day));
    return first === -1 ? 0 : first;
  })();
  const previewed = slides[previewIndex];
  const removingIndex = slides.findIndex((s) => s.key === removing);

  const apply = (slide: SlideDraft): void => {
    if (editing === null) return;
    const { index } = editing;
    if (index === null) edit((d) => ({ ...d, slides: [...d.slides, slide] }));
    else edit((d) => ({ ...d, slides: d.slides.map((s) => (s.key === slide.key ? slide : s)) }), [slidePath(index).slice(0, -1)]);
    setSelected(slide.key);
    setEditing(null);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
      <Card
        title={t('opacHome.slides.title')}
        description={t('opacHome.slides.description', { shown, max: OPAC_HOME_LIMITS.slides })}
        aside={
          <Button type="button" disabled={full || saving} aria-describedby={full ? `${intervalId}-full` : undefined} onClick={() => setEditing({ slide: newSlideDraft(slides), index: null })}>
            <PlusIcon aria-hidden="true" />
            {t('opacHome.slides.add')}
          </Button>
        }>
        {full && (
          <p id={`${intervalId}-full`} className="border-b px-4 py-2 text-meta text-muted-foreground">
            {t('opacHome.slides.full', { max: OPAC_HOME_LIMITS.slides })}
          </p>
        )}
        {slides.length === 0 ? (
          <EmptyState title={t('opacHome.slides.empty')}>
            <p>{t('opacHome.slides.empty_hint')}</p>
          </EmptyState>
        ) : (
          <ol aria-label={t('opacHome.slides.list')}>
            {slides.map((s, i) => {
              const n = i + 1;
              const title = textIn(s.title, 'id');
              const refused = Object.keys(errors).some((path) => path.startsWith(slidePath(i)));
              return (
                <li
                  key={s.key}
                  data-refused={refused ? '' : undefined}
                  className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-3 border-t px-4 py-2.5 first:border-t-0 sm:grid-cols-[96px_minmax(0,1fr)_auto]"
                  onFocus={() => setSelected(s.key)}>
                  <img src={fileSrc(s.fileId)} alt="" className={cn('h-[54px] w-24 rounded-sm bg-layer object-cover', !s.active && 'opacity-55')} style={{ objectPosition: `50% ${s.position}%` }} />
                  <div className="min-w-0">
                    <p className={cn('truncate font-semibold', !s.active && 'text-muted-foreground')}>{`${n}. ${title === '' ? t('opacHome.slides.untitled') : title}`}</p>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-muted-foreground">
                      <span>{scheduleText(s)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{targetText(s)}</span>
                      {!s.active && <Tag>{t('opacHome.slides.hidden')}</Tag>}
                      {englishMissing(s) && (
                        <Tag tone="warn">
                          <TriangleAlertIcon aria-hidden="true" />
                          {t('opacHome.slides.english_missing')}
                        </Tag>
                      )}
                      {refused && <StatusText tone="bad">{t('opacHome.tab.check')}</StatusText>}
                    </p>
                  </div>
                  <div className="col-span-2 flex items-center justify-between gap-3 sm:col-span-1">
                    <Switch
                      checked={s.active}
                      label={t('opacHome.slides.show', { n })}
                      disabled={saving}
                      onChange={(active) => edit((d) => ({ ...d, slides: d.slides.map((x) => (x.key === s.key ? { ...x, active } : x)) }))}
                    />
                    <RowActions
                      icons
                      index={i}
                      count={slides.length}
                      disabled={saving}
                      labels={{ up: t('opacHome.slides.up', { n }), down: t('opacHome.slides.down', { n }), remove: t('opacHome.slides.remove', { n }) }}
                      onMove={(to) => {
                        edit((d) => ({ ...d, slides: moved(d.slides, i, to) }), ['home.hero.slides']);
                        announce(t('opacHome.slides.moved', { from: n, to: to + 1 }));
                      }}
                      onRemove={() => setRemoving(s.key)}>
                      <Button type="button" variant="ghost" size="icon" data-edit="" disabled={saving} aria-label={t('opacHome.slides.edit', { n })} title={t('opacHome.slides.edit', { n })} onClick={() => setEditing({ slide: s, index: i })}>
                        <PencilIcon aria-hidden="true" />
                      </Button>
                    </RowActions>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <SettingRow title={t('opacHome.autoplay.title')} description={t('opacHome.autoplay.description')}>
          <label htmlFor={intervalId} className="sr-only">
            {t('opacHome.autoplay.interval')}
          </label>
          <select
            id={intervalId}
            className={cn(SELECT_CLASS, 'w-28')}
            value={draft.intervalSec}
            disabled={!draft.autoplay || saving}
            onChange={(e) => {
              const intervalSec = Number(e.target.value) as OpacHomeInterval;
              edit((d) => ({ ...d, intervalSec }));
            }}>
            {OPAC_HOME_INTERVALS.map((seconds) => (
              <option key={seconds} value={seconds}>
                {t('opacHome.autoplay.seconds', { seconds })}
              </option>
            ))}
          </select>
          <Switch id={autoplayId} checked={draft.autoplay} label={t('opacHome.autoplay.title')} disabled={saving} onChange={(autoplay) => edit((d) => ({ ...d, autoplay }))} />
        </SettingRow>
      </Card>

      <aside aria-label={t('opacHome.preview.title')} className="grid min-w-0 content-start gap-4">
        <Card
          title={t('opacHome.preview.title')}
          description={previewed === undefined ? t('opacHome.preview.none') : t('opacHome.preview.which', { n: previewIndex + 1, count: slides.length })}
          aside={
            <Segmented<'wide' | 'phone'>
              label={t('opacHome.preview.size')}
              value={size}
              onChange={setSize}
              options={[
                { id: 'wide', label: t('opacHome.preview.wide') },
                { id: 'phone', label: t('opacHome.preview.phone') },
              ]}
            />
          }>
          <CardBody className="grid gap-2">
            {previewed !== undefined && <SlidePreview slide={previewed} phone={size === 'phone'} />}
            <p className="text-xs text-muted-foreground">{t('opacHome.preview.hint')}</p>
          </CardBody>
        </Card>
        <Card title={t('opacHome.photo_advice.title')}>
          <CardBody>
            <p className="text-meta text-muted-foreground">{t('opacHome.photo_advice.text', { width: OPAC_HOME_HERO_SIZE.width, height: OPAC_HOME_HERO_SIZE.height })}</p>
          </CardBody>
        </Card>
      </aside>

      {editing !== null && (
        <SlideDrawer
          slide={editing.slide}
          number={editing.index === null ? slides.length + 1 : editing.index + 1}
          isNew={editing.index === null}
          refused={editing.index === null ? {} : slideErrorsAt(errors, editing.index)}
          onApply={apply}
          onCancel={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={removing !== null && removingIndex !== -1}
        destructive
        title={t('opacHome.slides.remove_title', { n: removingIndex + 1 })}
        description={t('opacHome.slides.remove_body')}
        confirmLabel={t('opacHome.slides.remove_confirm')}
        onConfirm={async () => {
          const n = removingIndex + 1;
          edit((d) => ({ ...d, slides: d.slides.filter((x) => x.key !== removing) }), ['home.hero.slides']);
          announce(t('opacHome.slides.removed', { n }));
        }}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
