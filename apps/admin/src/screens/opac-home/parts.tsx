import { OPAC_HOME_LANGS, brandRgb, type OpacHomeLang, type OpacHomeView } from '@altis/shared/api/opac-home';
import type { OpacAccent } from '@altis/shared/api/settings';
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode, type Ref } from 'react';
import { FileInput } from '@/components/file-input';
import { Field, TEXTAREA_CLASS } from '@/components/form-field';
import { StatusText } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT, type TKey } from '@/i18n';
import { uploadFile } from '@/lib/upload';
import { cn } from '@/lib/utils';
import { PHOTO_SOURCE_MAX_BYTES, PHOTO_SOURCE_TYPES, PhotoCropPanel, photoSourceOf, type PhotoSource } from './crop';
import type { HomeDraft, TextDraft } from './draft';

/**
 * What the tabs of OPAC › Halaman awal share: the editor they all write to (one draft of the whole content, held by
 * the screen so that it outlives a change of tab) and the small controls their forms are made of.
 */

/** The editor a tab works in. */
export interface HomeEditor {
  view: OpacHomeView;
  draft: HomeDraft;
  /** Changes the draft; `clear` names the body paths whose refusals no longer hold (a list whose rows moved). */
  edit(change: (draft: HomeDraft) => HomeDraft, clear?: readonly string[]): void;
  /** The refused fields of the last check, by body path. */
  errors: Readonly<Record<string, string>>;
  /** The message key of the field at `path`, if the last check refused it. */
  errorAt(path: string): TKey | undefined;
  /** Says `message` to screen readers (a row that moved, a row that went). */
  announce(message: string): void;
  /** While the page is being saved. */
  saving: boolean;
}

export const HomeEditorContext = createContext<HomeEditor | null>(null);

/** The editor of the screen the calling tab is part of. */
export function useHomeEditor(): HomeEditor {
  const editor = useContext(HomeEditorContext);
  if (editor === null) throw new Error('a tab of the home page editor outside its screen');
  return editor;
}

/** The colour of a slide's text panel per accent: the OPAC theme's header bar (a deep shade of the accent). */
export const ACCENT_COLORS: Readonly<Record<OpacAccent, string>> = {
  teal: '#003732',
  blue: '#182e4b',
  green: '#14361d',
  purple: '#352546',
  red: '#4b1d1b',
  slate: '#272e38',
};

/** The library colour of the draft when it is one, else the accent's. */
export function libraryColor(draft: Pick<HomeDraft, 'brand'>, view: Pick<OpacHomeView, 'accent'>): string {
  const typed = draft.brand.trim().toLowerCase();
  return brandRgb(typed) === null ? ACCENT_COLORS[view.accent] : typed;
}

export const fileSrc = (fileId: string): string => `/files/${encodeURIComponent(fileId)}`;

/** "12/90" under a text field. */
export function Counter({ value, max }: { value: string; max: number }) {
  const t = useT();
  return <p className="text-xs text-muted-foreground tabular-nums">{t('opacHome.counter', { count: [...value].length, max })}</p>;
}

/** A refusal under a control, in words. */
export function ControlError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="text-meta">
      <StatusText tone="bad">{children}</StatusText>
    </p>
  );
}

/** Checks a chosen file before the browser decodes it: an image of an accepted type, at most 8 MB. */
function sourceProblem(file: File, t: ReturnType<typeof useT>): string | null {
  if (!PHOTO_SOURCE_TYPES.includes(file.type)) return t('opacHome.photo.not_image');
  if (file.size > PHOTO_SOURCE_MAX_BYTES) return t('opacHome.photo.too_large', { size: (file.size / (1024 * 1024)).toFixed(1) });
  return null;
}

/**
 * A file input that decodes the chosen image, opens the crop panel under it, uploads the JPEG as `opac.home_photo` and
 * hands the upload's id to `onUploaded`. A file that is not an image, too large or unreadable is refused before
 * anything is sent. `error` is a refusal of the form itself (a slide that still has no photo).
 */
export function PhotoUpload({
  label,
  size,
  error: formError,
  inputRef,
  className,
  onUploaded,
}: {
  label: string;
  size: { width: number; height: number };
  error?: string;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  onUploaded(fileId: string): void;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const [source, setSource] = useState<PhotoSource | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const error = problem ?? formError ?? null;

  const choose = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (input.current !== null) input.current.value = '';
    if (file === undefined) return;
    setProblem(null);
    const refused = sourceProblem(file, t);
    if (refused !== null) {
      setProblem(refused);
      return;
    }
    try {
      setSource(await photoSourceOf(file));
    } catch {
      setProblem(t('opacHome.photo.unreadable'));
    }
  };

  const save = async (jpeg: Blob): Promise<void> => {
    const { uploadId } = await uploadFile(jpeg, { context: 'opac.home_photo' });
    setSource(null);
    onUploaded(uploadId);
  };

  return (
    <div className={cn('grid gap-3', className)}>
      <div className="grid gap-1.5">
        <Label htmlFor={id} className="text-meta">
          {label}
        </Label>
        <FileInput
          ref={(node) => {
            input.current = node;
            if (typeof inputRef === 'function') inputRef(node);
            else if (inputRef !== undefined && inputRef !== null) inputRef.current = node;
          }}
          id={id}
          accept={PHOTO_SOURCE_TYPES.join(',')}
          aria-invalid={formError !== undefined && problem === null ? true : undefined}
          aria-describedby={error === null ? undefined : `${id}-error`}
          onChange={(e) => void choose(e)}
        />
        {error !== null && <ControlError id={`${id}-error`}>{error}</ControlError>}
      </div>
      {source !== null && (
        // Esc in the crop panel closes the panel, not a drawer it stands in.
        <div data-own-escape="">
          <PhotoCropPanel source={source} width={size.width} height={size.height} onCancel={() => setSource(null)} onSave={save} />
        </div>
      )}
    </div>
  );
}

/** A photo of the draft, or the box that says there is none. */
export function PhotoPreview({ fileId, alt, ratio, position, className }: { fileId: string | null; alt: string; ratio: 'aspect-video' | 'aspect-[4/3]'; position?: number; className?: string }) {
  const t = useT();
  if (fileId === null || fileId === '') {
    return <div className={cn('grid place-items-center rounded-md border border-dashed bg-layer text-sm text-muted-foreground', ratio, className)}>{t('opacHome.photo.none')}</div>;
  }
  return (
    <img
      src={fileSrc(fileId)}
      alt={alt === '' ? t('opacHome.photo.preview_alt') : alt}
      className={cn('w-full rounded-md border object-cover', ratio, className)}
      style={position === undefined ? undefined : { objectPosition: `50% ${position}%` }}
    />
  );
}

/**
 * A text in each language, side by side (one under the other on a narrow screen). `error` gives the refusal of a body
 * path: of the language's own text (`path.id`), or of the pair as a whole (`path`, shown on the Indonesian text).
 */
export function LangFields({
  path,
  label,
  value,
  max,
  rows = null,
  hint,
  error,
  className,
  onChange,
}: {
  path: string;
  label(lang: OpacHomeLang): string;
  value: TextDraft;
  max: number;
  /** Lines of a text area; null: one line. */
  rows?: number | null;
  hint?: string;
  error(path: string): TKey | undefined;
  className?: string;
  onChange(next: TextDraft): void;
}) {
  return (
    <div className={cn('grid gap-x-5 gap-y-4 sm:grid-cols-2', className)}>
      {OPAC_HOME_LANGS.map((lang) => (
        <Field key={lang} label={label(lang)} hint={lang === 'id' ? hint : undefined} error={error(`${path}.${lang}`) ?? (lang === 'id' ? error(path) : undefined)}>
          {(c) => (
            <>
              {rows === null ? (
                <Input {...c} lang={lang} value={value[lang]} maxLength={max} onChange={(e) => onChange({ ...value, [lang]: e.target.value })} />
              ) : (
                <textarea {...c} className={TEXTAREA_CLASS} rows={rows} lang={lang} value={value[lang]} maxLength={max} onChange={(e) => onChange({ ...value, [lang]: e.target.value })} />
              )}
              <Counter value={value[lang]} max={max} />
            </>
          )}
        </Field>
      ))}
    </div>
  );
}

/**
 * The buttons that move a row of a list up or down and take it out, for the keyboard as for the pointer. A row that
 * reaches an end of the list keeps the focus: it goes to the button that still works. `children` are the row's other
 * buttons, before the one that removes it. With `icons` the buttons show an icon alone, named by their labels.
 */
export function RowActions({
  index,
  count,
  labels,
  icons = false,
  disabled = false,
  onMove,
  onRemove,
  children,
  className,
}: {
  index: number;
  count: number;
  labels: { up: string; down: string; remove: string };
  icons?: boolean;
  disabled?: boolean;
  onMove(to: number): void;
  onRemove(): void;
  children?: ReactNode;
  className?: string;
}) {
  const t = useT();
  const up = useRef<HTMLButtonElement>(null);
  const down = useRef<HTMLButtonElement>(null);
  const pressed = useRef<'up' | 'down' | null>(null);
  useEffect(() => {
    if (pressed.current === null) return;
    const [own, other] = pressed.current === 'up' ? [up, down] : [down, up];
    pressed.current = null;
    if (own.current?.disabled === true) other.current?.focus();
    else own.current?.focus();
  });
  const move = (direction: 'up' | 'down'): void => {
    pressed.current = direction;
    onMove(direction === 'up' ? index - 1 : index + 1);
  };
  const look = icons ? ({ variant: 'ghost', size: 'icon' } as const) : ({ variant: 'outline', size: 'sm' } as const);
  return (
    <div className={cn('flex', icons ? 'gap-0.5' : 'gap-2', className)}>
      <Button ref={up} type="button" {...look} className={icons ? undefined : 'bg-background'} disabled={disabled || index === 0} aria-label={labels.up} title={icons ? labels.up : undefined} onClick={() => move('up')}>
        {icons ? <ArrowUpIcon aria-hidden="true" /> : t('opacHome.row.up')}
      </Button>
      <Button
        ref={down}
        type="button"
        {...look}
        className={icons ? undefined : 'bg-background'}
        disabled={disabled || index === count - 1}
        aria-label={labels.down}
        title={icons ? labels.down : undefined}
        onClick={() => move('down')}>
        {icons ? <ArrowDownIcon aria-hidden="true" /> : t('opacHome.row.down')}
      </Button>
      {children}
      <Button type="button" {...look} className={icons ? undefined : 'bg-background'} disabled={disabled} aria-label={labels.remove} title={icons ? labels.remove : undefined} onClick={onRemove}>
        {icons ? <Trash2Icon aria-hidden="true" /> : t('opacHome.row.remove')}
      </Button>
    </div>
  );
}

/** An on/off switch named by `label` (its words stand beside it, or the label is all there is room for). */
export function Switch({ checked, label, disabled = false, id, describedBy, onChange }: { checked: boolean; label?: string; disabled?: boolean; id?: string; describedBy?: string; onChange(next: boolean): void }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className={cn(
        'relative h-5 w-[34px] flex-none rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-border-strong',
      )}
      onClick={() => onChange(!checked)}>
      <span aria-hidden="true" className={cn('absolute top-0.5 size-4 rounded-full bg-white transition-[left]', checked ? 'left-4' : 'left-0.5')} />
    </button>
  );
}

/** Two or three choices of one view as joined buttons; the one in use is pressed. */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { id: T; label: string }[]; onChange(next: T): void }) {
  return (
    <div role="group" aria-label={label} className="inline-flex overflow-hidden rounded-md border border-border-strong">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          className={cn(
            'h-7 border-l border-border-strong px-2.5 text-meta font-medium text-muted-foreground first:border-l-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
            option.id === value ? 'bg-layer-2 font-semibold text-foreground' : 'bg-background',
          )}
          onClick={() => onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A list of the form whose rows are added, moved and taken out: a fieldset named by `legend`, each row a box with its
 * fields (`children`) and its buttons, then the button that adds a row (off once the list is full). A row that moves
 * is announced, and when a row goes the focus moves to the add button. `update` changes the rows; it is told when the
 * rows' places changed, so that the refusals tied to those places are dropped.
 */
export function EditableList<T extends { key: number }>({
  legend,
  hint,
  rows,
  max,
  empty,
  addLabel,
  labels,
  create,
  update,
  children,
  className,
}: {
  legend: string;
  hint?: string;
  rows: readonly T[];
  max: number;
  empty: string;
  addLabel: string;
  labels(n: number): { up: string; down: string; remove: string };
  create(): T;
  update(change: (rows: T[]) => T[], placesChanged: boolean): void;
  /** The fields of one row; `set` changes the row. */
  children(row: T, index: number, set: (patch: Partial<T>) => void): ReactNode;
  className?: string;
}) {
  const t = useT();
  const { announce, saving } = useHomeEditor();
  const hintId = useId();
  const add = useRef<HTMLButtonElement>(null);
  return (
    <fieldset className={cn('grid gap-2', className)} aria-describedby={hint === undefined ? undefined : hintId}>
      <legend className="mb-2 text-meta font-semibold">{legend}</legend>
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {rows.length === 0 && <p className="text-sm text-muted-foreground">{empty}</p>}
      {rows.map((row, i) => (
        <div key={row.key} className="grid gap-3 rounded-md border bg-layer p-3">
          {children(row, i, (patch) => update((list) => list.map((x) => (x.key === row.key ? { ...x, ...patch } : x)), false))}
          <RowActions
            index={i}
            count={rows.length}
            disabled={saving}
            labels={labels(i + 1)}
            onMove={(to) => {
              update((list) => {
                const next = [...list];
                const [moving] = next.splice(i, 1);
                if (moving !== undefined) next.splice(to, 0, moving);
                return next;
              }, true);
              announce(t('opacHome.row.moved', { from: i + 1, to: to + 1 }));
            }}
            onRemove={() => {
              update((list) => list.filter((x) => x.key !== row.key), true);
              announce(t('opacHome.row.removed', { n: i + 1 }));
              setTimeout(() => add.current?.focus());
            }}
          />
        </div>
      ))}
      <div>
        <Button ref={add} type="button" size="sm" variant="outline" disabled={rows.length >= max || saving} onClick={() => update((list) => [...list, create()], false)}>
          {addLabel}
        </Button>
        {rows.length >= max && <span className="ml-2 text-xs text-muted-foreground">{t('opacHome.row.full', { max })}</span>}
      </div>
    </fieldset>
  );
}
