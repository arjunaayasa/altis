import { BARCODE_SYMBOLOGIES, LABEL_KINDS, LABEL_PAGE_MM, LabelProfile, LabelProfileList, type CatalogSettings, type LabelPageName } from '@altis/shared/api/settings';
import { ChevronDownIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useFieldArray, useWatch, type UseFormReturn } from 'react-hook-form';
import { CheckField, Field, SELECT_CLASS } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLocale, useT } from '@/i18n';
import { cn } from '@/lib/utils';
import { ListError } from './barcode-patterns';
import { errorAt, errorText, freeCode, listMax, ownError, type CatalogFormValues, type PageChoice, type ProfileValues } from './form';

/**
 * The label profile editor of Pengaturan › Katalog (Phase 2 spec §7, §12.6; plan Task 28): every field of a sheet
 * profile, and beside it a schematic preview of the page with its margins and its grid of labels (a label outside the
 * page is drawn in red). At least one profile stays, a 21st is refused at once with the shared schema's limit (M1), and
 * a grid that does not fit its page is refused on save with the schema's own check (`does_not_fit`). A saved profile's
 * code is read-only: Cetak Label names it.
 */

/** The most profiles the settings hold (M1). */
export const PROFILES_MAX = listMax(LabelProfileList);

const PAGE_NAMES = Object.keys(LABEL_PAGE_MM) as LabelPageName[];

/** The schema's bounds of the grid, so a number typed past them never draws thousands of cells. */
const COLS_MAX = LabelProfile.shape.cols.maxValue ?? 10;
const ROWS_MAX = LabelProfile.shape.rows.maxValue ?? 40;

/** A new profile: an A4 sheet of 3 × 8 spine labels that fits (10 + 3 × 60 + 2 × 5 + 10 = 210; 10 + 8 × 30 + 7 × 5 + 10 = 295). */
function newProfile(id: string): ProfileValues {
  return {
    id,
    name: '',
    kind: 'spine',
    page: { name: 'A4', wMm: LABEL_PAGE_MM.A4.w, hMm: LABEL_PAGE_MM.A4.h },
    marginMm: { t: 10, r: 10, b: 10, l: 10 },
    cols: 3,
    rows: 8,
    labelWMm: 60,
    labelHMm: 30,
    gapXMm: 5,
    gapYMm: 5,
    fontPt: 9,
    header: '',
    showLibraryName: false,
    symbology: null,
    titleMaxChars: 0,
    border: true,
    locked: false,
  };
}

/** A finite number, or `fallback`. */
const num = (n: unknown, fallback = 0): number => (typeof n === 'number' && Number.isFinite(n) ? n : fallback);

/**
 * The schematic page of a profile: the paper, the margins (dashed) and one rectangle per label, to scale. A label that
 * reaches past the paper is drawn in the destructive colour, so a grid that does not fit shows where.
 */
export function SheetPreview({ profile, label }: { profile: ProfileValues | undefined; label: string }) {
  if (profile === undefined) return null;
  const named = profile.page.name !== 'custom' ? LABEL_PAGE_MM[profile.page.name] : null;
  const w = Math.max(1, named?.w ?? num(profile.page.wMm, 1));
  const h = Math.max(1, named?.h ?? num(profile.page.hMm, 1));
  const m = { t: num(profile.marginMm.t), r: num(profile.marginMm.r), b: num(profile.marginMm.b), l: num(profile.marginMm.l) };
  const cols = Math.min(Math.max(0, Math.trunc(num(profile.cols))), COLS_MAX);
  const rows = Math.min(Math.max(0, Math.trunc(num(profile.rows))), ROWS_MAX);
  const lw = Math.max(0, num(profile.labelWMm));
  const lh = Math.max(0, num(profile.labelHMm));
  const gx = Math.max(0, num(profile.gapXMm));
  const gy = Math.max(0, num(profile.gapYMm));
  const cells: { x: number; y: number; out: boolean }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = m.l + c * (lw + gx);
      const y = m.t + r * (lh + gy);
      cells.push({ x, y, out: x + lw > w + 1e-6 || y + lh > h + 1e-6 });
    }
  }
  const stroke = Math.max(w, h) / 300;
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" className="h-56 w-full max-w-44 overflow-visible">
      <rect x={0} y={0} width={w} height={h} className="fill-background stroke-border" strokeWidth={stroke * 2} />
      <rect
        x={m.l}
        y={m.t}
        width={Math.max(0, w - m.l - m.r)}
        height={Math.max(0, h - m.t - m.b)}
        className="fill-none stroke-muted-foreground"
        strokeWidth={stroke}
        strokeDasharray={`${stroke * 4} ${stroke * 3}`}
      />
      {cells.map((cell, i) => (
        <rect
          key={i}
          data-label-cell=""
          x={cell.x}
          y={cell.y}
          width={lw}
          height={lh}
          className={cn(cell.out ? 'fill-destructive/30 stroke-destructive' : 'fill-primary/15 stroke-primary')}
          strokeWidth={stroke}
        />
      ))}
    </svg>
  );
}

/** One number field of a profile (millimetres, points or a count). */
function NumberField({
  form,
  path,
  label,
  hint,
  step = 'any',
  readOnly,
  locked = false,
}: {
  form: UseFormReturn<CatalogFormValues, unknown, CatalogSettings>;
  path: `labelProfiles.${number}.${string}`;
  label: string;
  hint?: string;
  step?: string;
  readOnly: boolean;
  locked?: boolean;
}) {
  return (
    <Field label={label} hint={hint} error={ownError(errorAt(form.formState.errors, path))}>
      {(c) => (
        <Input
          {...c}
          type="number"
          inputMode="decimal"
          step={step}
          readOnly={locked}
          {...form.register(path as 'labelProfiles.0.cols', { valueAsNumber: true })}
          disabled={readOnly}
        />
      )}
    </Field>
  );
}

/**
 * One profile: its name, a one-line summary, the sheet preview and, once opened, every field. A saved profile starts
 * closed (twenty open profiles would be a very long page) and a new one open; one with an error is always open.
 */
function ProfileFieldset({
  form,
  index,
  readOnly,
  toggled,
  onToggle,
  canRemove,
  onRemove,
}: {
  form: UseFormReturn<CatalogFormValues, unknown, CatalogSettings>;
  index: number;
  readOnly: boolean;
  /** Opened or closed by hand, against its default. */
  toggled: boolean;
  onToggle(): void;
  canRemove: boolean;
  onRemove(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const fieldsId = useId();
  const { register, setValue, control } = form;
  const errors = form.formState.errors;
  const profile = useWatch({ control, name: `labelProfiles.${index}` });
  const p = `labelProfiles.${index}` as const;
  const typed = profile?.name.trim() ?? '';
  const name = typed === '' ? t('catalog.settings.labels.new') : typed;
  const custom = profile?.page.name === 'custom';
  const mm = new Intl.NumberFormat(locale === 'en' ? 'en-GB' : 'id-ID', { maximumFractionDigits: 1 });
  const pageError = errorAt(errors, `${p}.page`);
  const rowError = errorAt(errors, p);
  const textError = (path: string) => ownError(errorAt(errors, path));
  const hasErrors = errors.labelProfiles?.[index] !== undefined;
  const open = hasErrors || toggled === (profile?.locked ?? true);
  const cols = num(profile?.cols, 0);
  const rows = num(profile?.rows, 0);
  const page =
    profile === undefined
      ? ''
      : profile.page.name === 'custom'
        ? `${mm.format(num(profile.page.wMm))} × ${mm.format(num(profile.page.hMm))} mm`
        : profile.page.name;

  return (
    <fieldset className="grid min-w-0 gap-4 rounded-md border p-4">
      <legend className="px-1 text-sm font-bold">{name}</legend>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_11rem]">
        <div className="grid content-start gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {profile === undefined ? null : t('catalog.settings.labels.summary', { kind: t(`catalog.settings.labels.kind.${profile.kind}`), page, cols, rows })}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-controls={fieldsId}
              aria-label={t('catalog.settings.labels.details_of', { name })}
              disabled={hasErrors}
              onClick={onToggle}
            >
              <ChevronDownIcon aria-hidden="true" className={cn('transition-transform', open && 'rotate-180')} />
              {t('catalog.settings.labels.details')}
            </Button>
          </div>
          {open && (
            <div id={fieldsId} className="grid gap-4 sm:grid-cols-2">
              <Field label={t('catalog.settings.labels.id')} hint={profile?.locked ? t('catalog.settings.code_locked') : undefined} error={textError(`${p}.id`)}>
                {(c) => (
                  <Input {...c} className="font-mono" maxLength={32} autoComplete="off" spellCheck={false} readOnly={profile?.locked === true} {...register(`${p}.id`)} disabled={readOnly} />
                )}
              </Field>
              <Field label={t('catalog.settings.labels.name')} error={textError(`${p}.name`)}>
                {(c) => <Input {...c} maxLength={64} {...register(`${p}.name`)} disabled={readOnly} />}
              </Field>
              <Field label={t('catalog.settings.labels.kind')} error={textError(`${p}.kind`)}>
                {(c) => (
                  <select {...c} className={SELECT_CLASS} {...register(`${p}.kind`)} disabled={readOnly}>
                    {LABEL_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(`catalog.settings.labels.kind.${kind}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={t('catalog.settings.labels.page')} error={textError(`${p}.page.name`)}>
                {(c) => (
                  <select
                    {...c}
                    className={SELECT_CLASS}
                    {...register(`${p}.page.name`, {
                      onChange: (e: { target: { value: string } }) => {
                        const choice = e.target.value as PageChoice;
                        if (choice === 'custom') return;
                        setValue(`${p}.page.wMm`, LABEL_PAGE_MM[choice].w, { shouldDirty: true });
                        setValue(`${p}.page.hMm`, LABEL_PAGE_MM[choice].h, { shouldDirty: true });
                      },
                    })}
                    disabled={readOnly}
                  >
                    {PAGE_NAMES.map((page) => (
                      <option key={page} value={page}>
                        {`${page} (${mm.format(LABEL_PAGE_MM[page].w)} × ${mm.format(LABEL_PAGE_MM[page].h)} mm)`}
                      </option>
                    ))}
                    <option value="custom">{t('catalog.settings.labels.page.custom')}</option>
                  </select>
                )}
              </Field>
              <NumberField form={form} path={`${p}.page.wMm`} label={t('catalog.settings.labels.page_w')} readOnly={readOnly} locked={!custom} />
              <NumberField form={form} path={`${p}.page.hMm`} label={t('catalog.settings.labels.page_h')} readOnly={readOnly} locked={!custom} />
              {pageError !== undefined && (
                <p role="alert" className="text-meta font-semibold text-bad sm:col-span-2">
                  {t('catalog.settings.labels.page')}: {errorText(t, pageError)}
                </p>
              )}
              <NumberField form={form} path={`${p}.marginMm.t`} label={t('catalog.settings.labels.margin_t')} readOnly={readOnly} />
              <NumberField form={form} path={`${p}.marginMm.b`} label={t('catalog.settings.labels.margin_b')} readOnly={readOnly} />
              <NumberField form={form} path={`${p}.marginMm.l`} label={t('catalog.settings.labels.margin_l')} readOnly={readOnly} />
              <NumberField form={form} path={`${p}.marginMm.r`} label={t('catalog.settings.labels.margin_r')} readOnly={readOnly} />
              <NumberField form={form} path={`${p}.cols`} label={t('catalog.settings.labels.cols')} step="1" readOnly={readOnly} />
              <NumberField form={form} path={`${p}.rows`} label={t('catalog.settings.labels.rows')} step="1" readOnly={readOnly} />
              <NumberField form={form} path={`${p}.labelWMm`} label={t('catalog.settings.labels.label_w')} readOnly={readOnly} />
              <NumberField form={form} path={`${p}.labelHMm`} label={t('catalog.settings.labels.label_h')} readOnly={readOnly} />
              <NumberField form={form} path={`${p}.gapXMm`} label={t('catalog.settings.labels.gap_x')} readOnly={readOnly} />
              <NumberField form={form} path={`${p}.gapYMm`} label={t('catalog.settings.labels.gap_y')} readOnly={readOnly} />
              <NumberField form={form} path={`${p}.fontPt`} label={t('catalog.settings.labels.font_pt')} readOnly={readOnly} />
              <NumberField
                form={form}
                path={`${p}.titleMaxChars`}
                label={t('catalog.settings.labels.title_max')}
                hint={t('catalog.settings.labels.title_max_hint')}
                step="1"
                readOnly={readOnly}
              />
              <Field label={t('catalog.settings.labels.symbology')} error={textError(`${p}.symbology`)}>
                {(c) => (
                  <select
                    {...c}
                    className={SELECT_CLASS}
                    {...register(`${p}.symbology`, { setValueAs: (v: unknown) => (v === '' || v === null ? null : v) })}
                    disabled={readOnly}
                  >
                    <option value="">{t('catalog.settings.labels.symbology.default')}</option>
                    {BARCODE_SYMBOLOGIES.map((symbology) => (
                      <option key={symbology} value={symbology}>
                        {SYMBOLOGY_NAMES[symbology]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={t('catalog.settings.labels.header')} hint={t('catalog.settings.labels.header_hint')} error={textError(`${p}.header`)}>
                {(c) => <Input {...c} maxLength={64} {...register(`${p}.header`)} disabled={readOnly} />}
              </Field>
              <CheckField className="sm:col-span-2" label={t('catalog.settings.labels.show_library_name')} {...register(`${p}.showLibraryName`)} disabled={readOnly} />
              <CheckField className="sm:col-span-2" label={t('catalog.settings.labels.border')} {...register(`${p}.border`)} disabled={readOnly} />
            </div>
          )}
        </div>
        <div className="flex flex-col items-center gap-2">
          <SheetPreview profile={profile} label={t('catalog.settings.labels.preview', { name, cols, rows })} />
        </div>
      </div>
      {rowError !== undefined && (
        <p role="alert" className="text-meta font-semibold text-bad">
          {errorText(t, rowError)}
        </p>
      )}
      {!readOnly && (
        <div>
          <Button type="button" variant="outline" size="sm" disabled={!canRemove} onClick={onRemove}>
            {t('catalog.settings.labels.remove', { name })}
          </Button>
        </div>
      )}
    </fieldset>
  );
}

/** The symbologies by their product names (not translated). */
export const SYMBOLOGY_NAMES: Readonly<Record<(typeof BARCODE_SYMBOLOGIES)[number], string>> = Object.freeze({ code128: 'Code 128', code39: 'Code 39' });

export function LabelProfilesEditor({ form, readOnly }: { form: UseFormReturn<CatalogFormValues, unknown, CatalogSettings>; readOnly: boolean }) {
  const t = useT();
  const array = useFieldArray({ control: form.control, name: 'labelProfiles' });
  const [limited, setLimited] = useState(false);
  /** The profiles (by their field key) opened or closed by hand. */
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string): void =>
    setToggled((old) => {
      const next = new Set(old);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const add = (): void => {
    if (array.fields.length >= PROFILES_MAX) {
      setLimited(true);
      return;
    }
    setLimited(false);
    const taken = form.getValues('labelProfiles').map((p) => p.id);
    array.append(newProfile(freeCode('profil', array.fields.length + 1, taken)));
  };

  return (
    <div className="grid gap-4">
      {array.fields.map((field, i) => (
        <ProfileFieldset
          key={field.id}
          form={form}
          index={i}
          readOnly={readOnly}
          toggled={toggled.has(field.id)}
          onToggle={() => toggle(field.id)}
          canRemove={array.fields.length > 1}
          onRemove={() => {
            setLimited(false);
            array.remove(i);
          }}
        />
      ))}
      {!readOnly && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={add}>
            {t('catalog.settings.labels.add')}
          </Button>
        </div>
      )}
      <ListError
        limited={limited}
        error={errorAt(form.formState.errors, 'labelProfiles')}
        tooMany="catalog.settings.labels.too_many"
        tooFew="catalog.settings.labels.too_few"
        max={PROFILES_MAX}
      />
    </div>
  );
}
