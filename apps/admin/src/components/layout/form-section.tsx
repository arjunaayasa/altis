import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { InCardScope } from './card';

/** The classes of a field that takes the whole width of a {@link FormSection} (a name, an address, a note). */
export const FORM_FULL = 'sm:col-span-full';

/** The two columns of a part laid out side by side: the title column (200 px, 220 px on a wide screen), the content. */
const SIDE_COLUMNS = 'md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]';

/** The fields' columns of a {@link FormSection}: two, or three on a wide screen. */
const FIELD_COLUMNS = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-2 xl:grid-cols-3' } as const;

/** The title column of a part laid out side by side: an `h2` of 15 px and a sentence under it. */
function SideHead({ id, title, intro, introId }: { id: string; title: ReactNode; intro?: ReactNode; introId?: string }) {
  return (
    <div className="grid content-start gap-0.5">
      <h2 id={id} className="text-heading font-semibold">
        {title}
      </h2>
      {intro !== undefined && (
        <p id={introId} className="text-meta text-muted-foreground">
          {intro}
        </p>
      )}
    </div>
  );
}

/**
 * One part of a form: its title and a sentence on the left (above on a narrow screen), its fields on the right in two
 * columns (three on a wide screen, unless `columns={2}`: a form with a side column of its own), a thin rule above every
 * part but the first. Inside a `Card` the parts take the card's 16 px side padding. The fields are a fieldset named by the title; `disabled` turns them all off (a reader without
 * the right to change them). A part made of one list field that brings its own fieldset (a list of authors, of
 * identifiers) passes `list`: the content then stands as it is, one block under the other, with no second fieldset.
 * `introId` lets the sentence describe a control of the part.
 */
export function FormSection({
  title,
  intro,
  introId,
  disabled = false,
  columns = 3,
  list = false,
  className,
  children,
}: {
  title: string;
  intro?: ReactNode;
  introId?: string;
  disabled?: boolean;
  columns?: 2 | 3;
  list?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section data-slot="form-section" aria-labelledby={id} className={cn('grid gap-x-8 gap-y-3 px-4 py-5', SIDE_COLUMNS, className)}>
      <SideHead id={id} title={title} intro={intro} introId={introId} />
      {list ? (
        <div className="grid min-w-0 content-start gap-4">{children}</div>
      ) : (
        <fieldset disabled={disabled} className={cn('grid min-w-0 content-start gap-4', FIELD_COLUMNS[columns])}>
          <legend className="sr-only">{title}</legend>
          {children}
        </fieldset>
      )}
    </section>
  );
}

/**
 * A part of a page laid out like a {@link FormSection}: its title and a sentence on the left (above on a narrow
 * screen), anything on the right (a form of its own, a list, buttons, a panel); a thin rule above it when another part
 * of the page comes before it. For the parts of a page in its `grid gap-6` (settings groups, the profile, the tools of
 * a member page); the parts of one form are {@link FormSection}s.
 */
export function SideSection({ title, intro, className, children }: { title: string; intro?: ReactNode; className?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section data-slot="side-section" aria-labelledby={id} className={cn('grid min-w-0 gap-x-8 gap-y-3 px-4 py-5', SIDE_COLUMNS, className)}>
      <SideHead id={id} title={title} intro={intro} />
      <div className="grid min-w-0 content-start gap-4">
        <InCardScope>{children}</InCardScope>
      </div>
    </section>
  );
}

/**
 * The buttons at the end of a form, under a thin rule: the primary one first ("Simpan"), then "Batal", then a word on
 * the form's state ("Ada perubahan yang belum disimpan"). A long form whose buttons must stay in reach takes a
 * `SaveBar` instead.
 */
export function FormBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-slot="form-bar" className={cn('flex flex-wrap items-center gap-2 border-t pt-4', className)}>
      {children}
    </div>
  );
}
