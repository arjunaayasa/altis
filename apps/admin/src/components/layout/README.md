# Layout pieces (`@/components/layout`)

How an admin screen is put together. Every screen follows this guide; a screen that needs something it does not
cover adds the piece here first, with a test, instead of styling it by hand. Import from the folder's index:

```tsx
import { DenseTable, FilterField, FilterRow, PageHead, SelectionBar } from '@/components/layout';
```

In the examples, `things.*` keys stand for the screen's own i18n keys (every text in `id` and `en`).

| File | Pieces |
|---|---|
| `page-head.tsx` | `PageHead`, `BackLink`, `Section`, `SectionHead` |
| `filter-row.tsx` | `FilterRow`, `FilterField`, `FILTER_ROW` (the class, for a row drawn by hand) |
| `table.tsx` | `DenseTable`, `DenseColumn`, `TABLE` (the classes, for a table drawn by hand), `SkeletonTable`, `SKELETON_BAR` |
| `selection-bar.tsx` | `SelectionBar`, `SelectionAction` |
| `inline-panel.tsx` | `InlinePanel` |
| `more-menu.tsx` | `MoreMenu`, `MoreMenuItem`, `MoreMenuRule` |
| `states.tsx` | `EmptyState`, `LoadingState`, `ErrorState` |
| `callout.tsx` | `Callout`, `PageError` |
| `status.tsx` | `StatusText`, `Tag`, the tone classes `TONE_TEXT`, `TONE_SURFACE`, `TAG_TONE`, `TAG_SHAPE`, `LAYER` |
| `figures.tsx` | `StatStrip`, `FactList` |
| `form-section.tsx` | `FormSection`, `SideSection`, `FormBar`, `FORM_FULL` |
| `link-tabs.tsx` | `LinkTabs` |
| `steps.tsx` | `Steps` |
| `kbd.tsx`, `member-photo.tsx` | `Kbd`; `MemberPhoto`, `initials` |

The older shared components keep their props and already have this look: `DataTable` and `Pager`
(`components/data-table.tsx`, for TanStack tables), `Field`, `CheckField`, `SELECT_CLASS`, `TEXTAREA_CLASS`, `Badge`,
`Notice`, `ProblemAlert`, `RefetchProblem`, `RootError`, `NoticeAlert` (`components/form-field.tsx`),
`ConfirmDialog`, `JobProgress`, the shell banners, and the primitives in `components/ui` (button, input, tabs, ...).

## 1. The order of a screen

From top to bottom, leaving out what the screen does not have. The page itself is `<div className="grid gap-6">`
(24 px between its parts); the shell already gives the padding, the width limit and the `h1` focus.

1. `BackLink` (detail pages only; `search` brings back the list's own tab or kind), then `PageHead`: the `h1`, one
   sentence under it, the actions on the right. Pages of one part reached from the same place (the settings groups,
   the profile, jobs and schedules) put `LinkTabs` right under the head.
2. The outcome of the last action: `Notice` (success) or `PageError` (failure). Nothing else goes above the head.
3. `FilterRow` (lists), or `Tabs` then `FilterRow` when the tabs switch the list.
4. The data: `SelectionBar` with its inline panel, then the table; or `StatStrip`, `Section`s, a form in `FormSection`s.
5. Under a list: how many are shown and "Muat lebih banyak" (or `Pager`).

```tsx
<div className="grid gap-6">
  <PageHead
    title={t('things.title')}
    intro={t('things.intro')}
    actions={
      <>
        <Button asChild variant="outline"><Link to="/admin/things/import">{t('things.import')}</Link></Button>
        <Button asChild><Link to="/admin/things/new">{t('things.add')}</Link></Button>
      </>
    }
  />
  {notice !== null && <Notice kind="success">{notice}</Notice>}
  <FilterRow label={t('things.filters')} onSubmit={apply}>…</FilterRow>
  {list.isError && list.data === undefined ? (
    <ErrorState title={t('things.failed')} error={list.error} onRetry={() => void list.refetch()} />
  ) : list.data === undefined ? (
    <SkeletonTable label={t('shell.loading')} />
  ) : nothingAtAll ? (
    <EmptyState title={t('things.empty')} actions={<Button asChild><Link to="/admin/things/new">{t('things.add')}</Link></Button>}>
      <p>{t('things.empty_hint')}</p>
    </EmptyState>
  ) : (
    <div className="grid gap-3">
      <SelectionBar …>…</SelectionBar>
      <DenseTable …/>
    </div>
  )}
</div>
```

## 2. Page head and sections

`PageHead` holds **exactly one primary button** (`<Button>`, the default variant): the main action of the page.
Every other action in the head is `variant="outline"`; rare or dangerous ones go in a `MoreMenu` at the end. A page
without a main action has no primary button. A part of a page with its own heading is a `Section` (an `h2` of 16 px,
something small on the right of the heading, the content 12 px below).

```tsx
<Section title={t('things.by_subject')} aside={t('things.last_30_days')}>
  <SubjectBars … />
</Section>
```

A part of a page that reads better with its title on the left, like a form section (a settings group, a profile part,
a member's own data), is a `SideSection`: title and one sentence left, anything right (its own form, a list, buttons,
an inline panel), a thin rule above it when another part comes before it in the page's `grid gap-6`.

```tsx
<SideSection title={t('things.privacy')} intro={t('things.privacy_intro')}>
  <form noValidate aria-label={t('things.privacy')} onSubmit={save}>…</form>
</SideSection>
```

## 3. Filters

Every filter has a **visible label above it**; a placeholder is an example, never the label. `FilterRow` is a named
form: the search field (`wide`) first, then the selects. Enter in a typed field submits (`onSubmit`); a select applies
in its `onChange`. Buttons such as "Hapus saringan" go in `actions`, at the end of the row.

```tsx
<FilterRow label={t('members.filters')} onSubmit={apply} actions={filtered ? <Button variant="link" onClick={clear}>{t('members.filter.clear')}</Button> : undefined}>
  <FilterField wide label={t('members.filter.search')}>
    {(c) => <Input {...c} type="search" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />}
  </FilterField>
  <FilterField id={`${ids}-status`} label={t('members.filter.status')}>
    <select id={`${ids}-status`} className={SELECT_CLASS} value={draft.status} onChange={(e) => pick({ ...draft, status: e.target.value })}>…</select>
  </FilterField>
</FilterRow>
```

## 4. Tables

`DenseTable` for rows you hold in an array, `DataTable` for a TanStack table (its `alignRight` names the columns of
numbers), the `TABLE` classes only when neither fits (row focus, colspans). Every table has a caption (read by screen readers only), its header on the neutral layer,
rows 14 px with thin lines, digits in `tabular-nums` (already on every table). Numbers align right
(`className: 'text-right'`, `headClassName: 'text-right'`). The row's actions are a small `MoreMenu` in the last
column, whose header is `<span className="sr-only">{t('table.actions')}</span>`. A selected row has `bg-accent-soft`.
The empty row says why it is empty and gives the way out ("Hapus saringan"). A table is never put inside a card: it
has its own border.

```tsx
<DenseTable
  caption={t('things.caption')}
  columns={[
    { id: 'name', header: t('things.col.name'), cell: (r) => <Link to={`/admin/things/${r.id}`} className="font-semibold">{r.name}</Link> },
    { id: 'loans', header: t('things.col.count'), cell: (r) => r.count, className: 'text-right', headClassName: 'text-right' },
    { id: 'more', header: <span className="sr-only">{t('table.actions')}</span>, cell: (r) => <MoreMenu small label={t('things.more_named', { name: r.name })}>…</MoreMenu> },
  ]}
  rows={rows}
  rowKey={(r) => r.id}
  rowClassName={(r) => (selection.has(r.id) ? 'bg-accent-soft' : undefined)}
  empty={t('things.empty_filtered')}
/>
```

## 5. Selection bar and inline panel

While rows are selected, `SelectionBar` sits right above the table: the count, one button per bulk action, "Batal
pilih". A bulk action's button opens **its inline panel under the bar** (one at a time); the panel takes the focus,
Esc or Batal closes it and the focus goes back to the button. Give `focusAfter` (the "select all" box) so the focus
has a place to go when the bar disappears.

```tsx
<SelectionBar
  count={selected.length}
  label={t('members.tools.selected', { count: selected.length })}
  actions={[{ id: 'extend', label: t('members.tools.bulk.extend') }, { id: 'archive', label: t('members.tools.bulk.archive') }]}
  open={panel}
  onOpenChange={setPanel}
  onClear={() => { setPanel(null); clearSelection(); }}
  focusAfter={selectAllRef}>
  {panel === 'extend' && (
    <InlinePanel title={t('members.tools.bulk.panel_title', { action: t('members.tools.bulk.extend'), count })} onSubmit={submit} onCancel={() => setPanel(null)}>
      <Field label={t('members.tools.bulk.days')}>{(c) => <Input {...c} inputMode="numeric" />}</Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm">{t('members.tools.bulk.apply', { count })}</Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setPanel(null)}>{t('form.cancel')}</Button>
      </div>
    </InlinePanel>
  )}
</SelectionBar>
```

`InlinePanel` is also how a single record's non-destructive action opens (extend, suspend, a type's form, the
keyboard shortcuts): under the control that opened it, or at the top of the part it changes. Its title names the action
and its object; its buttons are `size="sm"`, the submit first.

## 6. When a dialog is allowed

Only these three, each with its existing component:

| Case | Component |
|---|---|
| Confirming an action that destroys or cannot simply be taken back (archive, delete, disable, reset) | `ConfirmDialog` |
| Confirming the password before a sensitive action | `ReauthDialog` (it opens by itself on `AUTH_REAUTH_REQUIRED`) |
| Showing a secret that is shown only once (a token, a recovery code, a new password) | `OneTimeSecretDialog` |

Everything else is an `InlinePanel` or a page of its own: forms, pickers, bulk actions, details, help, previews. A
destructive bulk action asks its question in words inside its panel, with a `variant="destructive"` submit.

```tsx
<ConfirmDialog open destructive title={t('members.archive.title', { name })} description={t('members.archive.body')} confirmLabel={t('members.action.archive_confirm')} onConfirm={archive} onClose={close} />
```

## 7. Tabs, figures, forms, steps

**Tabs** (`components/ui/tabs`) switch between views of the same object or list ("Data anggota", "Pinjaman aktif");
the arrow keys move between them. Add `WRAPPING_TABS` when they may wrap on a narrow screen. A count may follow a tab's
name in `text-faint`. Pages of a module are sidebar items, not tabs; the few pages of one sidebar item (the settings
groups) are `LinkTabs`, links with the current page underlined.

```tsx
<LinkTabs label={t('things.sections')} items={[{ to: '/admin/things', label: t('things.tab.list') }, { to: '/admin/things/schedules', label: t('things.tab.schedules') }]} />
```

```tsx
<Tabs value={tab} onValueChange={setTab}>
  <TabsList className={WRAPPING_TABS.list} aria-label={t('members.tabs.label')}>
    <TabsTrigger value="data" className={WRAPPING_TABS.trigger}>{t('things.tab.data')}</TabsTrigger>
    <TabsTrigger value="loans" className={WRAPPING_TABS.trigger}>{t('things.tab.loans')}</TabsTrigger>
  </TabsList>
  <TabsContent value="data">…</TabsContent>
</Tabs>
```

**StatStrip**: two to five figures side by side, each a label and a value; a tone only when the figure is a state
(overdue loans) and its label names it. `FactList` for label-value lines in a side panel.

```tsx
<StatStrip label={t('things.summary')} items={[{ key: 'loans', label: t('things.on_loan'), value: onLoan }, { key: 'late', label: t('things.late'), value: late, tone: late > 0 ? 'bad' : undefined }]} />
```

**Forms** are split into `FormSection`s (title and one sentence left, fields right in two or three columns; a field
that needs the whole width takes `FORM_FULL`), each field a `Field` with its label above, its error under the control,
then its hint. A form with a side column of its own (the record editor's cover) takes `columns={2}`; a part made of
one list field that brings its own fieldset (authors, identifiers) takes `list`, and `introId` lets the sentence
describe that list. The buttons end the form in a `FormBar`: the submit first, then Batal, then the unsaved-changes word.

```tsx
<form noValidate onSubmit={submit}>
  <FormSection title={t('members.form.contact')} intro={t('members.form.contact_intro')} disabled={!canManage}>
    <Field label={t('members.field.email')} error={errors.email}>{(c) => <Input {...c} type="email" {...register('email')} />}</Field>
    <Field label={t('members.field.address')} error={errors.address} className={FORM_FULL}>{(c) => <textarea {...c} className={TEXTAREA_CLASS} {...register('address')} />}</Field>
  </FormSection>
  <FormBar>
    <Button type="submit" disabled={isSubmitting}>{t(isSubmitting ? 'form.saving' : 'form.save')}</Button>
    <Button asChild variant="outline"><Link to="/admin/anggota">{t('form.cancel')}</Link></Button>
    {isDirty && <StatusText tone="warn">{t('members.form.unsaved')}</StatusText>}
  </FormBar>
</form>
```

**Steps**: numbered steps only where the order is information (an import wizard); one step's content at a time, its
Back and Next buttons in a `FormBar`.

```tsx
<Steps steps={[t('members.import.step.file'), t('members.import.step.mapping'), t('members.import.step.dry_run'), t('members.import.step.result')]} current={step} label={t('members.import.steps')} doneLabel={t('members.import.step_done')} />
```

**Links that look like buttons**: a route is `<Button asChild variant="outline"><Link …/></Button>`; a plain `<a>` (a
download, a file opened in a new tab) takes `className={buttonVariants({ variant: 'outline', size: 'sm' })}`, whose
classes are already merged, so the outline keeps its border.

## 8. States

| State | Piece |
|---|---|
| First load of a table | `SkeletonTable` |
| First load of anything else | `LoadingState` |
| First load failed | `ErrorState` (what failed, why, "Coba lagi") in the content's place |
| Data on screen, its refresh failed | `RefetchProblem` (the data stays) |
| Nothing exists yet | `EmptyState`: a heading, one sentence, the buttons that fix it |
| Filters match nothing | the table stays; its empty row says so and offers "Hapus saringan" |
| An action failed | `PageError` / `ProblemAlert` above the content; a field's error on its `Field` |
| An action succeeded | `Notice kind="success"` |

```tsx
<ErrorState title={t('members.list.failed')} error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
```

## 9. Status is never colour alone

Green (`ok`), amber (`warn`) and red (`bad`) mean a state and nothing else, and every coloured state carries its word:
a `Tag` ("Ditangguhkan"), a `StatusText` ("Terlambat 3 hari"), a callout's title, a notice. A highlighted row also has
its word in a cell; a red figure has a label that names it. Neutral carries everything else. The accent (`primary`,
`accent-soft`, `accent-text`) is only for the primary button, the active item, the selected row, focus and links.

```tsx
<StatusText tone={daysLate > 14 ? 'bad' : 'warn'}>{t('things.days_late', { n: daysLate })}</StatusText>
```

## 10. Icons

Icons appear in exactly these places, and nowhere else:

1. the status icon at the start of a result or callout, where the shared component draws it (the desk's scan result;
   `Callout`, `PageError`, `Notice` and the banners draw none, so a screen adds none);
2. the notification bell;
3. the chevron of a collapsible group or of a select;
4. the ⋯ of a row or page-head menu (`MoreMenu`);
5. the back arrow (`BackLink`);
6. a spinner beside the words of a running action ("Memproses…").

Never in buttons, menu items, tabs, cards, headings, table cells or empty states; a chevron or a spinner sits in the
control it belongs to (a disclosure button with `aria-expanded`, a combobox, a button while it works). Never an emoji.
An icon is `lucide-react`, 16 px, stroke 2, `aria-hidden="true"`: the words next to it carry the meaning. The test
`test/icon-guard.test.ts` reads the screens and the install wizard: it fails on an icon outside this list, and on one
inside a button, menu item, tab or heading.

```tsx
<MoreMenu small label={t('members.action.more_named', { name })}>…</MoreMenu> {/* the ⋯ icon is the menu's own */}
```

## 11. Spacing and type

Spacing, in Tailwind steps: 24 px (`gap-6`) between the parts of a page; 12 px (`gap-3`) inside a part and between
filters; 16–20 px (`gap-y-4 gap-x-5`) between form fields; 8 px (`gap-2`) between buttons. Panels `p-4`, callouts
`px-3.5 py-3`, table cells `px-3 py-2.5`. Text blocks stay under `max-w-[75ch]`; forms under `max-w-5xl`.

Type: one family, weights 400 / 600 / 700, and these sizes only:

| Size | Class | For |
|---|---|---|
| 12 px | `text-xs` | table heads, tags, hints |
| 13 px | `text-meta` | field labels, secondary lines, small buttons |
| 14 px | `text-sm` | the base: body, tables, buttons |
| 16 px | `text-base` | `h2` of a section or form section |
| 20 px | `text-xl` | the page's `h1` |
| 24 px | `text-2xl` | a dashboard figure only |

Colours come from the tokens only (`bg-layer`, `bg-layer-2`, `border`, `border-border-strong`, `text-muted-foreground`,
`text-faint`, the tones above); they switch with the theme by themselves, so no `dark:` override, no hex value, no
`text-red-600`, no `bg-black/50` (dialog backdrops use `bg-(--scrim)`).

```tsx
<p className="text-meta text-muted-foreground">{t('members.list.shown_all', { count })}</p>
```

## 12. Do not

- put text above a heading (a small label or kicker over the `h1` or an `h2`);
- use gradients, blur or glass effects, or shadows other than `shadow-pop` on menus and dialogs;
- give a card, row or callout a thick coloured side border (`border-l-4` and the like);
- line up rows of cards that each have an icon and a title;
- decorate a big number (an icon beside it, a coloured tile, a trend arrow, a badge on it);
- wrap a table, a filter row or a form section in a card, or nest cards;
- open a dialog for anything that is not in section 6;
- add a second primary button to a page head;
- use a colour without its word, or a placeholder instead of a label.
