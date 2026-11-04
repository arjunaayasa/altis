# UI primitives (`@/components/ui`)

The admin screens build on these primitives: Radix (`radix-ui`), `cmdk`, `class-variance-authority`, Tailwind and the
`cn()` helper of `@/lib/utils`. They are **adapted from [shadcn/ui](https://github.com/shadcn-ui/ui) (MIT) by
ALTIS**: their names, exports, props, `data-slot` attributes and Tailwind classes follow shadcn/ui's `new-york-v4`
components (`components.json` in `apps/admin` holds the matching shadcn configuration), so screens written against
the shadcn/ui API work with them.

Komponen dasar antarmuka admin, diadaptasi oleh ALTIS dari shadcn/ui (lisensi MIT). Nama, ekspor, dan props-nya
mengikuti shadcn/ui; pemberitahuan lisensinya ikut di `THIRD_PARTY_NOTICES.txt`.

## Licence and origin

| | |
|---|---|
| Upstream | <https://github.com/shadcn-ui/ui>, `apps/v4/registry/new-york-v4/ui/<name>.tsx` |
| Upstream commit | none pinned: the files were adapted by ALTIS, not copied from a recorded commit (Ruling R1b-2) |
| Licence | MIT, `LICENSE-shadcn-ui.txt` in this folder (the standard MIT text, `Copyright (c) 2023 shadcn`) |
| Notice | `VENDORED_NOTICES` in `tools/release/src/notices.ts`: every release's `THIRD_PARTY_NOTICES.txt` (the zip's and `public/`) lists `shadcn/ui components (apps/admin/src/components/ui)` with that text |

| File | Exports |
|---|---|
| `alert.tsx` | `Alert`, `AlertTitle`, `AlertDescription` |
| `button.tsx` | `Button`, `buttonVariants` |
| `checkbox.tsx` | `Checkbox` |
| `combobox.tsx` | `Combobox`, `ComboboxOption`, `ComboboxProps` (shadcn/ui's combobox example, Popover + Command, made a component) |
| `command.tsx` | `Command`, `CommandDialog`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandSeparator`, `CommandShortcut` |
| `dialog.tsx` | `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogClose`, `DialogOverlay`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription` |
| `dropdown-menu.tsx` | `DropdownMenu`, `DropdownMenuPortal`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuGroup`, `DropdownMenuLabel`, `DropdownMenuItem`, `DropdownMenuCheckboxItem`, `DropdownMenuRadioGroup`, `DropdownMenuRadioItem`, `DropdownMenuSeparator`, `DropdownMenuShortcut`, `DropdownMenuSub`, `DropdownMenuSubTrigger`, `DropdownMenuSubContent` |
| `input.tsx` | `Input` |
| `label.tsx` | `Label` |
| `popover.tsx` | `Popover`, `PopoverTrigger`, `PopoverContent`, `PopoverAnchor` |
| `select.tsx` | `Select`, `SelectGroup`, `SelectValue`, `SelectTrigger`, `SelectContent`, `SelectLabel`, `SelectItem`, `SelectSeparator`, `SelectScrollUpButton`, `SelectScrollDownButton` |
| `tabs.tsx` | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` |
| `tooltip.tsx` | `TooltipProvider`, `Tooltip`, `TooltipTrigger`, `TooltipContent` |

The Phase 2 files (checkbox, combobox, dropdown-menu, popover, select, tabs, tooltip; plan Task 4) were written by hand
in the same style, on the pinned `radix-ui` and `cmdk`, without downloading anything: no upstream commit is pinned for
them either.

ALTIS's adaptations, which any refreshed or added file must keep:

- the dialogs put their title and description inside `DialogContent` (Radix reports a dialog without one); the
  close button's screen-reader label is a prop (`closeLabel`, default `Tutup`), not a fixed English word;
- no `dangerouslySetInnerHTML` (lint, spec §7.4) and no inline `<style>`/`<script>`: the admin page runs under a
  nonce CSP, and Radix's scroll-lock style gets the nonce through `get-nonce` (`lib/nonce.ts`);
- imports point at `@/components/ui/<name>` and `@/lib/utils`, icons come from `lucide-react`, primitives from the
  pinned `radix-ui` and `cmdk` packages (no new dependency without its pin and licence check in `tools/release`).

## Refreshing or adding a component by hand

There is no shadcn CLI at build or run time, and nothing is fetched automatically. When a screen needs a newer
version of a primitive, or one that is not here yet (card, select, checkbox, table, tabs, ...):

1. Downloading from GitHub needs the owner's approval. With it, take the component's source from
   `apps/v4/registry/new-york-v4/ui/<name>.tsx` of <https://github.com/shadcn-ui/ui> at one chosen commit.
2. Check that the repository's `LICENSE` at that commit is still MIT with the same copyright line as
   `LICENSE-shadcn-ui.txt`; if the line changed, update the file (the release test checks its first lines).
3. Rewrite the registry's sibling imports `@/registry/new-york-v4/ui/<name>` to `@/components/ui/<name>`, apply the
   adaptations above, and add the file and its exports to the table.
4. Record the commit here, per file (for example `select.tsx: shadcn-ui/ui@<full commit hash>`); the files already
   here stay "no commit pinned".
5. Run `pnpm check && pnpm test` (the release test checks the shadcn/ui notice in `THIRD_PARTY_NOTICES.txt`).
