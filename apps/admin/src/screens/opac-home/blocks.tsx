import { OPAC_HOME_BLOCKS, OPAC_HOME_MIN_CONTRAST, brandRgb, contrastWithWhite } from '@altis/shared/api/opac-home';
import { Card, SettingRow, StatusText } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT, type TKey } from '@/i18n';
import { cn } from '@/lib/utils';
import { ACCENT_COLORS, Switch, libraryColor, useHomeEditor } from './parts';

/**
 * The tab "Susunan blok": which blocks of the home page show (a block without content is hidden whatever its switch
 * says), and the library colour (the site's header bar and the panel of a slide's text), with the contrast white text
 * keeps on it.
 */
export function BlocksTab() {
  const t = useT();
  const locale = useLocale();
  const { draft, view, edit, errorAt, saving } = useHomeEditor();
  const editBrand = (brand: string): void => edit((d) => ({ ...d, brand }), ['home.brand']);
  /** White text's contrast on the typed library colour, or null while it is not a colour. */
  const contrast = (() => {
    const rgb = brandRgb(draft.brand.trim().toLowerCase());
    return rgb === null ? null : contrastWithWhite(rgb);
  })();
  const ratioText = (ratio: number): string => new Intl.NumberFormat(locale === 'id' ? 'id-ID' : 'en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.floor(ratio * 10) / 10);
  const brandError = errorAt('home.brand');

  return (
    <>
      <Card title={t('opacHome.blocks.title')} description={t('opacHome.blocks.description')}>
        {OPAC_HOME_BLOCKS.map((block) => (
          <SettingRow key={block} title={t(`opacHome.blocks.${block}` as TKey)} description={t(`opacHome.blocks.${block}_hint` as TKey)}>
            {(c) => <Switch id={c.id} describedBy={c['aria-describedby']} checked={draft.blocks[block]} disabled={saving} onChange={(on) => edit((d) => ({ ...d, blocks: { ...d.blocks, [block]: on } }))} />}
          </SettingRow>
        ))}
      </Card>
      <Card title={t('opacHome.brand.title')}>
        <SettingRow title={t('opacHome.brand.label')} description={t('opacHome.brand.hint', { accent: ACCENT_COLORS[view.accent] })} className="items-start">
          {(c) => (
            <div className="grid w-full gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <input type="color" aria-label={t('opacHome.brand.picker')} className="h-8.5 w-12 shrink-0 cursor-pointer rounded-md border bg-background p-1" value={libraryColor(draft, view)} onChange={(e) => editBrand(e.target.value)} />
                <Input
                  id={c.id}
                  aria-describedby={cn(brandError !== undefined && `${c.id}-error`, contrast !== null && `${c.id}-contrast`, c['aria-describedby']) || undefined}
                  aria-invalid={brandError === undefined ? undefined : true}
                  className="w-32"
                  value={draft.brand}
                  maxLength={7}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={ACCENT_COLORS[view.accent]}
                  onChange={(e) => editBrand(e.target.value)}
                />
                {draft.brand !== '' && (
                  <Button type="button" variant="outline" size="sm" onClick={() => editBrand('')}>
                    {t('opacHome.brand.reset')}
                  </Button>
                )}
              </div>
              {brandError !== undefined && (
                <p id={`${c.id}-error`} className="text-meta font-semibold text-bad">
                  {t(brandError)}
                </p>
              )}
              {contrast !== null && (
                <p id={`${c.id}-contrast`} className="text-xs text-muted-foreground">
                  {contrast >= OPAC_HOME_MIN_CONTRAST ? (
                    t('opacHome.brand.contrast_ok', { ratio: ratioText(contrast), min: ratioText(OPAC_HOME_MIN_CONTRAST) })
                  ) : (
                    <StatusText tone="bad">{t('opacHome.brand.contrast_low', { ratio: ratioText(contrast), min: ratioText(OPAC_HOME_MIN_CONTRAST) })}</StatusText>
                  )}
                </p>
              )}
            </div>
          )}
        </SettingRow>
      </Card>
    </>
  );
}
