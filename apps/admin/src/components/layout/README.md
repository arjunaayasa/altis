# Layout pieces (`@/components/layout`)

How an admin screen is put together. Every screen follows this guide; a screen that needs something it does not
cover adds the piece here first, with a test, instead of styling it by hand. Import from the folder's index:

```tsx
import { BulkBar, Card, DenseTable, FilterTabs, PageHeader, TableToolbar } from '@/components/layout';
```

The look in one paragraph: flat colours and no gradients; thin 1 px borders instead of shadows (a shadow only under
a menu, a drawer or a dialog); small corners (4 px controls, 6 px cards); one accent colour, everything else a
neutral grey; letter spacing 0; a dense 14 px base. The page lies on a light grey (`bg-page`) and its content sits
in white cards (`bg-background`).

In the examples, `things.*` keys stand for the screen's own i18n keys (every text in `id` and `en`).

| File | Pieces |
|---|---|
| `page-head.tsx` | `PageHeader` (`PageHead` is its older name), `BackLink`, `Section`, `SectionHead` |
| `card.tsx` | `Card`, `CardHead`, `CardBody`, `CARD` (the class of the box) |
| `figures.tsx` | `StatRow`, `StatStrip`, `FactList` |
| `filter-tabs.tsx` | `FilterTabs` |
| `table-toolbar.tsx` | `TableToolbar` |
| `filter-row.tsx` | `FilterRow`, `FilterField`, `FILTER_ROW` (the class, for a row drawn by hand) |
| `table.tsx` | `DenseTable`, `DenseColumn`, `TABLE` (the classes, for a table drawn by hand), `SkeletonTable`, `SKELETON_BAR` |
| `selection-bar.tsx` | `BulkBar` (`SelectionBar` is its older name), `SelectionAction` |
| `inline-panel.tsx` | `InlinePanel` |
| `editor-drawer.tsx` | `EditorDrawer` |
| `more-menu.tsx` | `MoreMenu`, `MoreMenuItem`, `MoreMenuRule` |
| `states.tsx` | `EmptyState`, `LoadingState`, `ErrorState` |
| `callout.tsx` | `Callout`, `PageError` |
| `status.tsx` | `StatusText`, `Tag`, the tone classes `TONE_TEXT`, `TONE_SURFACE`, `TAG_TONE`, `TAG_SHAPE`, `LAYER` |
| `form-section.tsx` | `FormSection`, `SideSection`, `FormBar`, `FORM_FULL` |
| `setting-row.tsx` | `SettingRow` |
| `save-bar.tsx` | `SaveBar` |
| `link-tabs.tsx` | `LinkTabs` |
| `steps.tsx` | `Steps` |
| `kbd.tsx`, `member-photo.tsx` | `Kbd`; `MemberPhoto`, `initials` |

The older shared components keep their props and already have this look: `DataTable` and `Pager`
(`components/data-table.tsx`, for TanStack tables), `Field`, `CheckField`, `SELECT_CLASS`, `TEXTAREA_CLASS`, `Badge`,
`Notice`, `ProblemAlert`, `RefetchProblem`, `RootError`, `NoticeAlert` (`components/form-field.tsx`),
`ConfirmDialog`, `JobProgress`, the shell banners, and the primitives in `components/ui` (button, input, tabs, ...).

## 1. The frame around a screen

The shell (`components/shell`) draws the frame; a screen only fills `<main>`.

- **Sidebar**, on the left, full height, a solid charcoal in both themes (`bg-side`): 240 px wide, the library's name
  (or its logo) in a 52 px row, then the navigation in three sections with plain labels (*Kerja harian*, *Koleksi*,
  *Situs & sistem*). Beranda is a link; every other entry is a group with an icon that opens its pages as text links
  (34 px group rows, 30 px page rows). The page shown is marked `aria-current="page"` and its group is open.
- **Collapsed** (the button at the sidebar's foot; remembered in this browser): 56 px, icons only. Each icon keeps
  its name (a tooltip, and the accessible name); a group opens a menu with its pages, so the keyboard reaches every
  page.
- **Under 1024 px** the sidebar is a drawer (272 px) opened by the menu button of the top bar: a modal dialog with a
  scrim, the focus inside it, closed by Escape, the scrim, its close button or a change of page, and the focus goes
  back to the menu button.
- **Top bar**, 52 px: where the user is (group › page), the command search (Ctrl K / ⌘K), today's date, the
  notifications and the user menu (profile, theme, language, sign out).
- **Content**: 24 px padding (16 px on a narrow screen), at most 1400 px wide. A change of page moves the focus to
  the new page's `h1`.

A new page gets its place in the sidebar by an entry in `lib/nav.ts` (its group decides the icon and the section).

## 2. The order of a screen

From top to bottom, leaving out what the screen does not have. The page itself is `<div className="grid gap-4">`
(16 px between its parts).

1. `BackLink` (detail pages only; `search` brings back the list's own tab or kind), then `PageHeader`: the `h1`
   (21 px), one sentence under it, the actions on the right. Pages of one part reached from the same place (the
   settings groups, the profile, jobs and schedules) put `LinkTabs` right under the header.
2. The outcome of the last action: `Notice` (success) or `PageError` (failure). Nothing else goes above the header.
3. A dashboard-like page: `StatRow`, then `Card`s in a grid.
4. A list: `FilterTabs` (the saved filters, with counts), then one `Card` holding the `TableToolbar`, the `BulkBar`
   while rows are selected, the table, and its foot (how many are shown, `Pager`). A list with several labelled
   filters may keep a `FilterRow` above the card instead of a toolbar.
5. A form: `FormSection`s in a `Card`, closed by a `FormBar` or, for a long form, a `SaveBar`.
6. A settings page: titled `Card`s of `SettingRow`s.

```tsx
<div className="grid gap-4">
  <PageHeader
    title={t('things.title')}
    description={t('things.intro')}
    actions={
      <>
        <Button asChild variant="outline"><Link to="/admin/things/import"><UploadIcon aria-hidden="true" />{t('things.import')}</Link></Button>
        <Button asChild><Link to="/admin/things/new"><PlusIcon aria-hidden="true" />{t('things.add')}</Link></Button>
      </>
    }
  />
  {notice !== null && <Notice kind="success">{notice}</Notice>}
  <FilterTabs label={t('things.views')} value={view} onChange={setView} items={[{ id: 'all', label: t('things.view.all'), count: total }, { id: 'draft', label: t('things.view.draft'), count: drafts }]} />
  {list.isError && list.data === undefined ? (
    <ErrorState title={t('things.failed')} error={list.error} onRetry={() => void list.refetch()} />
  ) : list.data === undefined ? (
    <SkeletonTable label={t('shell.loading')} />
  ) : nothingAtAll ? (
    <Card>
      <EmptyState title={t('things.empty')} actions={<Button asChild><Link to="/admin/things/new">{t('things.add')}</Link></Button>}>
        <p>{t('things.empty_hint')}</p>
      </EmptyState>
    </Card>
  ) : (
    <Card label={t('things.caption')}>
      <TableToolbar label={t('things.tools')}>
        <Input type="search" aria-label={t('things.search')} placeholder={t('things.search_example')} className="max-w-[420px] min-w-[220px] flex-1" />
      </TableToolbar>
      <BulkBar …>…</BulkBar>
      <DenseTable …/>
    </Card>
  )}
</div>
```

## 2a. Page header, cards and sections

`PageHeader` holds **exactly one primary button** (`<Button>`, the default variant): the main action of the page.
Every other action in the header is `variant="outline"`; rare or dangerous ones go in a `MoreMenu` at the end. A page
without a main action has no primary button. The title carries no icon and nothing stands above it.

A **`Card`** is the box of one part of a page: a white surface, a 1 px border, 6 px corners, no shadow. With `title`
it is a region named by its head (an `h2` of 15 px, a short line under it, `aside` on the right for a legend, a link
or a small button). Its children run edge to edge, so a toolbar, a table, `SettingRow`s and `FormSection`s line up
with its border; plain content goes in a `CardBody` (16 px padding). Cards are 16 px apart and never nested.

```tsx
<Card title={t('things.by_subject')} description={t('things.last_30_days')} aside={<Link to="/admin/reports">{t('things.report')}</Link>}>
  <CardBody><SubjectBars … /></CardBody>
</Card>
```

**Nothing lies bare on the page.** Outside a `Card`, these parts draw their own card (rules of `src/index.css` on
their `data-slot`, and `Section` by its context): a run of `FormSection`s (one card, a rule between the sections; the
`FormBar` after it is the card's foot), a `SideSection`, a `Section`, a `FilterRow`, an `EmptyState`, and any form or
section that starts with a `SectionHead` or an `h2`. Inside a `Card` they draw no box. A small form or a note drawn
by hand takes the `PANEL` class; a region with a heading id of its own takes `CARD`, `CARD_HEAD` and `CARD_TITLE`.

A part of a page that needs a heading is a `Section` (an `h2` of 15 px, something small on the right of
the heading, the content 12 px below).

A part that reads better with its title on the left, like a form section (a profile part, a member's own data), is a
`SideSection`: title and one sentence left, anything right (its own form, a list, buttons, an inline panel), a thin
rule above it when another part comes before it.

```tsx
<SideSection title={t('things.privacy')} intro={t('things.privacy_intro')}>
  <form noValidate aria-label={t('things.privacy')} onSubmit={save}>…</form>
</SideSection>
```

## 3. Filters

**`FilterTabs`** are the saved views of a list, as underlined tabs with counts ("Semua 28", "Tanpa sampul 3"), right
above the list's card. A tab with `to` is a link (the view lives in the address; the one in use is
`aria-current="page"`), a tab without one is a button (`aria-pressed`) that calls `onChange`. One line; it scrolls
sideways on a narrow screen.

```tsx
<FilterTabs label={t('things.views')} value={status} items={[{ id: 'all', label: t('things.view.all'), count: 28, to: '/admin/things' }, { id: 'draft', label: t('things.view.draft'), count: 1, to: '/admin/things', search: { status: 'draft' } }]} />
```

**`TableToolbar`** is the row of controls inside the card, above the table: the search field, then filter buttons;
`actions` are pushed to the right. A filter button that is in use takes the accent (`border-primary bg-primary-soft
text-accent-text`). Every control has an accessible name: a search field whose placeholder is only an example takes
an `aria-label`.

**`FilterRow`** is for a list with several labelled filters: every filter has a **visible label above it**; a
placeholder is an example, never the label. It is a named form: the search field (`wide`) first, then the selects.
Enter in a typed field submits (`onSubmit`); a select applies in its `onChange`. Buttons such as "Hapus saringan" go
in `actions`, at the end of the row.

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
numbers), the `TABLE` classes only when neither fits (row focus, colspans). Every table has a caption (read by
screen readers only), a header 34 px high on the neutral layer (`bg-layer-2`, 12.5 px), rows 40 px high with thin
lines between them, one line of text per row where the data allows, digits in `tabular-nums` (already on every
table). Numbers align right (`className: 'text-right'`, `headClassName: 'text-right'`). The row's actions are a small
`MoreMenu` in the last column, whose header is `<span className="sr-only">{t('table.actions')}</span>`. A selected
row has `bg-primary-soft`. The empty row says why it is empty and gives the way out ("Hapus saringan").

A table stands on its own (it has its own border) or **directly inside a `Card`**, under the card's head or its
`TableToolbar`: there it drops its border and runs edge to edge. The foot of a list (the count, `Pager`) goes under
the table in the same card, in a `border-t px-4 py-2.5` row.

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
  rowClassName={(r) => (selection.has(r.id) ? 'bg-primary-soft' : undefined)}
  empty={t('things.empty_filtered')}
/>
```

## 5. Bulk bar and inline panel

While rows are selected, `BulkBar` sits right above the table (inside the card, between the toolbar and the table,
or on its own above a table without a card): a tinted row with the count, one button per bulk action, "Batal
pilih". A bulk action's button opens **its inline panel under the bar** (one at a time); the panel takes the focus,
Esc or Batal closes it and the focus goes back to the button. Give `focusAfter` (the "select all" box) so the focus
has a place to go when the bar disappears.

```tsx
<BulkBar
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
</BulkBar>
```

`InlinePanel` is also how a single record's non-destructive action opens (extend, suspend, a type's form, the
keyboard shortcuts): under the control that opened it, or at the top of the part it changes. Its title names the action
and its object; its buttons are `size="sm"`, the submit first.

## 6. When a dialog is allowed

Only these four, each with its existing component:

| Case | Component |
|---|---|
| Confirming an action that destroys or cannot simply be taken back (archive, delete, disable, reset) | `ConfirmDialog` |
| Confirming the password before a sensitive action | `ReauthDialog` (it opens by itself on `AUTH_REAUTH_REQUIRED`) |
| Showing a secret that is shown only once (a token, a recovery code, a new password) | `OneTimeSecretDialog` |
| Editing one item of a list that is part of a larger form, when the item has too many fields for a row (a slide of the home page: photo, texts in two languages, button, dates) | `EditorDrawer` |

Everything else is an `InlinePanel` or a page of its own: forms, pickers, bulk actions, details, help, previews. A
destructive bulk action asks its question in words inside its panel, with a `variant="destructive"` submit.

**`EditorDrawer`** is a panel on the right of the window (at most 880 px, the whole width on a phone), over the
scrim: the item's name as its heading and one sentence under it, the fields in two columns (one on a narrow screen),
and a foot with the item's switch on the left, then Batal and the submit. It is a modal dialog: the focus stays
inside, Esc and the close button leave without keeping the changes, a click on the scrim does nothing, and the focus
goes back to the button that opened it. Its submit **applies the item to the page's draft**; nothing is sent to the
server until the page's own Save, and the sentence under the heading says so. It is not for a record with a page of
its own, for a confirmation, or for anything a row or an `InlinePanel` can hold.

```tsx
<EditorDrawer
  open
  title={t('things.item.edit', { n })}
  description={t('things.item.applies_on_save')}
  closeLabel={t('things.item.close')}
  onSubmit={apply}
  onClose={cancel}
  footer={
    <>
      <Button type="button" variant="ghost" className="ml-auto" onClick={cancel}>{t('form.cancel')}</Button>
      <Button type="submit">{t('things.item.done')}</Button>
    </>
  }>
  <div className="grid content-start gap-4">…</div>
  <div className="grid content-start gap-4">…</div>
</EditorDrawer>
```

```tsx
<ConfirmDialog open destructive title={t('members.archive.title', { name })} description={t('members.archive.body')} confirmLabel={t('members.action.archive_confirm')} onConfirm={archive} onClose={close} />
```

## 7. Tabs, figures, forms, steps

**Tabs** (`components/ui/tabs`) switch between views of the same object or list ("Data anggota", "Pinjaman aktif");
the arrow keys move between them. Add `WRAPPING_TABS` when they may wrap on a narrow screen. Pages of a group are
sidebar items, not tabs; the few pages of one sidebar item (the settings groups) are `LinkTabs`, links with the
current page underlined (`side`: a list down the left of the content on a wide screen, for a part with many pages); the saved views of a list are `FilterTabs` (section 3). A tab never carries an icon.

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

**`StatRow`**: the summary of a page, one card of up to four cells with thin rules between them (two per row on a
narrow screen). Each cell is a label, a figure (24 px) and a **factual note** under it: what the figure counts, where
it comes from, or a link to its list. The figure is plain: no icon, no colour, no trend arrow, no percentage chip,
no sparkline. A comparison is shown only when the product really records it.

```tsx
<StatRow label={t('things.today')} items={[{ key: 'loans', label: t('things.loans_today'), value: 14, note: t('things.members_n', { n: 9 }) }, { key: 'late', label: t('things.late'), value: 7, note: <Link to="/admin/layanan/terlambat">{t('things.see_list')}</Link> }]} />
```

**`StatStrip`**: smaller figures inside a part of a page (a member's four counts), each a label and a value; a tone
only when the figure is a state (overdue loans) and its label names it. `FactList` for label-value lines in a side
panel.

```tsx
<StatStrip label={t('things.summary')} items={[{ key: 'loans', label: t('things.on_loan'), value: onLoan }, { key: 'late', label: t('things.late'), value: late, tone: late > 0 ? 'bad' : undefined }]} />
```

**Forms** are split into `FormSection`s (title and one sentence in a 220 px column on the left, fields on the right
in two or three columns; a field that needs the whole width takes `FORM_FULL`), usually inside one `Card`, each field
a `Field` with its label above, its error under the control, then its hint. A form with a side column of its own (the record editor's cover) takes `columns={2}`; a part made of
one list field that brings its own fieldset (authors, identifiers) takes `list`, and `introId` lets the sentence
describe that list. The buttons end the form in a `FormBar`: the submit first, then Batal, then the unsaved-changes
word. A long form takes a **`SaveBar`** instead: it stays at the bottom of the window, with the state of the form on
the left (`tone="bad"` for what keeps it from being saved, announced as an alert) and the buttons on the right, the
primary one last. It is the last thing of the screen.

```tsx
<SaveBar message={isDirty ? t('things.unsaved') : undefined}>
  <Button asChild variant="outline"><Link to="/admin/things">{t('form.cancel')}</Link></Button>
  <Button type="submit" disabled={isSubmitting}>{t(isSubmitting ? 'form.saving' : 'form.save')}</Button>
</SaveBar>
```

**Settings** are titled `Card`s of **`SettingRow`s**: the setting's name and one sentence on the left, its control on
the right (at most 320 px; under the text on a narrow screen), a thin rule between rows. Pass the control as a
function and the row links it: the name is its label, the sentence its description.

```tsx
<Card title={t('things.identity')}>
  <SettingRow title={t('things.name')} description={t('things.name_hint')}>{(c) => <Input {...c} {...register('name')} />}</SettingRow>
  <SettingRow title={t('things.logo')} description={t('things.logo_hint')}><Link to="/admin/opac/identitas">{t('things.logo_link')}</Link></SettingRow>
</Card>
```

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
| Nothing exists yet | `EmptyState`: a heading, one sentence, the buttons that fix it; no picture and no icon |
| Filters match nothing | the table stays; its empty row says so and offers "Hapus saringan" |
| An action failed | `PageError` / `ProblemAlert` above the content; a field's error on its `Field` |
| An action succeeded | `Notice kind="success"` |

```tsx
<ErrorState title={t('members.list.failed')} error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
```

## 9. Status is never colour alone

Green (`ok`), amber (`warn`) and red (`bad`) mean a state and nothing else, and every coloured state carries its word:
a `Tag` ("Ditangguhkan"), a `StatusText` ("Terlambat 3 hari"), a callout's title, a notice. A highlighted row also has
its word in a cell; a red figure has a label that names it. A status may carry a small icon before its word (a
check, a warning triangle); the word still says it. Neutral carries everything else. The accent (`primary`,
`primary-soft`, `accent-text`) is only for the primary button, the active item, the selected row, focus and links.

```tsx
<StatusText tone={daysLate > 14 ? 'bad' : 'warn'}>{t('things.days_late', { n: daysLate })}</StatusText>
```

## 10. Icons

Icons are used sparingly, and only where they help someone find or recognise something:

1. **in the sidebar**: one icon per group and for Beranda (they are what is left when the sidebar is collapsed);
2. **in a button, where it helps**: before the words of a page's main actions ("+ Tambah anggota", "Cetak label"),
   in the controls of the top bar, the chevron of a control that opens something, the ⋯ of a row menu, the back
   arrow, a spinner beside the words of a running action;
3. **for a status**: before the word of a state, a result or an error message.

The rules that go with them:

- **The words stay.** An icon never replaces a label: the text stands next to it. A button that shows only an icon
  (the top bar, a row's ⋯, a close button) has an accessible name (`aria-label`) and, where there is room for doubt,
  a tooltip.
- **Decorative icons are hidden** from screen readers: `aria-hidden="true"` on every icon whose words are beside it.
- **No icon tiles.** No icon on a coloured or tinted square, and no icon decorating a card, a heading, a tab, a menu
  item, a table head, an empty state or a summary figure.
- **Never an emoji** in place of an icon.
- An icon is from `lucide-react`, imported by name, 16 px (17 px in the sidebar's rows, 14 px in a small button),
  stroke 2, in the colour of its text (a status icon in its status colour).

The test `test/icon-guard.test.ts` reads the screens, the install wizard and the shared components: it fails on an
icon that is neither hidden nor named, on an icon alone in a button or link without a name, on an icon on a coloured
tile, in a heading, a tab, a menu item or a figure of `StatRow`/`StatStrip`, and on an emoji anywhere in the sources.

```tsx
<Button><PlusIcon aria-hidden="true" />{t('members.add')}</Button>
<Button variant="ghost" size="icon" aria-label={t('things.print')}><PrinterIcon aria-hidden="true" /></Button>
<Tag tone="ok"><CheckIcon aria-hidden="true" />{t('things.shown')}</Tag>
```

## 11. Sizes, spacing and type

Sizes: sidebar 240 px (56 px collapsed, 272 px as a drawer); top bar 52 px; content padding 24 px (16 px narrow),
at most 1400 px wide; controls 34 px high (`h-8.5`), small ones 28 px (`h-7`, `size="sm"`); table head 34 px, table
row 40 px; a tag 22 px.

Radius: **4 px for controls** (`rounded-md`: buttons, inputs, selects, tags, menus' items), **6 px for cards**
(`rounded-lg`: cards, tables, callouts' boxes, menus), 3 px (`rounded-sm`) for a key cap or a count. Nothing is
rounder, except a switch and the round initials of the user.

Spacing follows a 4 / 8 px grid: 16 px (`gap-4`) between cards and the parts of a page; 12 px (`gap-3`) inside a
part; 16 px between form fields; 8 px (`gap-2`) between buttons; 2–4 px between a title and its sentence. Card head
`px-4 py-3`, card body `p-4`, table cells `px-3` (16 px at the card's edge), callouts `px-3.5 py-3`. Text blocks stay
under `max-w-[76ch]`; forms under `max-w-5xl`.

Type: one family (Plus Jakarta Sans, with the system fonts behind it), letter spacing 0 everywhere, line height 1.45
for text and 1.25–1.3 for headings; weights 400 (text), 500 (menus, tabs), 600 (labels, buttons, card titles) and
700 (the page title, figures). These sizes only:

| Size | Class | For |
|---|---|---|
| 12 px | `text-xs` | hints, counts in the sidebar |
| 12.5 px | `text-fine` | table heads, tags |
| 13 px | `text-meta` | field labels, secondary lines, small buttons |
| 13.5 px | `text-ui` | buttons, the top bar, the sidebar's page links |
| 14 px | `text-sm` | the base: body, tables |
| 15 px | `text-heading` | a card's title, the `h2` of a section or form section |
| 21 px | `text-title` | the page's `h1` |
| 24 px | `text-2xl` | a summary figure |

`tracking-*` classes are not used: the wide steps are switched off in the stylesheet.

Colours come from the tokens only (`bg-page`, `bg-background`, `bg-layer`, `bg-layer-2`, `border`,
`border-border-strong`, `text-muted-foreground`, `text-faint`, `bg-primary-soft`, the tones above, `bg-series-1` and
`bg-series-2` for the two series of a chart, the `side*` colours inside the sidebar only); they switch with the
theme by themselves, so no `dark:` override, no hex value, no `text-red-600`, no `bg-black/50` (dialog backdrops use
`bg-(--scrim)`).

```tsx
<p className="text-meta text-muted-foreground">{t('members.list.shown_all', { count })}</p>
```

## 12. Do not

- use gradients anywhere (buttons, cards, banners, the sidebar, backgrounds), blur or glass effects, or shadows other
  than `shadow-pop` on menus, drawers and dialogs;
- put text above a heading (a small label or kicker over the `h1` or an `h2`), or write labels in spaced capitals;
- give a card, row or callout a thick coloured side border (`border-l-4` and the like);
- put an icon on a coloured tile, or line up rows of cards that each have an icon and a title;
- decorate a big number (an icon beside it, a coloured tile, a trend arrow, a percentage chip, a sparkline);
- greet the user with a coloured welcome banner, or fill space with pictures, floating badges or ornaments;
- nest cards, or round anything more than 6 px (but a switch and the user's initials);
- open a dialog or a drawer for anything that is not in section 6;
- add a second primary button to a page header;
- use a colour without its word, or a placeholder instead of a label;
- use an emoji as an icon.
