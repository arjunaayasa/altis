import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The icon rule of the admin (components/layout/README.md, "Icons"): icons from lucide-react may stand in the sidebar,
// in a button where they help, and beside a status; the words always stay next to an icon, a button that shows only an
// icon has an accessible name, and a decorative icon is hidden from screen readers (`aria-hidden="true"`). An icon never
// decorates a heading, a tab, a menu item or a summary figure, never sits on a coloured tile, and no emoji stands in
// for one. This test reads the sources of the screens, the install wizard and the shared components, as far as the
// source shows these things. The primitives of components/ui are left out: the mark of the chosen option in a list
// or a menu is the primitive's own indicator, not a decoration a screen adds.

const SRC = path.resolve(import.meta.dirname, '..', 'src');
const ROOTS = ['screens', 'install', 'components'];

const CHEVRONS = ['ChevronDown', 'ChevronUp', 'ChevronRight', 'ChevronsUpDown'];

/** `CheckIcon`, `LucideCheck` and `Check` are the same icon. */
const iconName = (imported: string) => imported.replace(/^Lucide/, '').replace(/Icon$/, '');

const BUTTONS = new Set(['Button', 'button', 'summary']);
const LINKS = new Set(['a', 'Link']);
const MENU_ITEMS = new Set(['MoreMenuItem', 'DropdownMenuItem', 'DropdownMenuCheckboxItem', 'DropdownMenuRadioItem', 'DropdownMenuSubTrigger', 'CommandItem']);
const TABS = new Set(['TabsTrigger']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend']);
/** Layout pieces whose `title` (or `label`) is drawn as a heading. */
const HEADING_PROPS = new Set(['PageHeader', 'PageHead', 'Section', 'SectionHead', 'FormSection', 'SideSection', 'InlinePanel', 'EmptyState', 'ErrorState', 'ConfirmDialog', 'Card', 'CardHead', 'SettingRow']);
/** Layout pieces whose `items` are summary figures. */
const FIGURE_PROPS = new Set(['StatRow', 'StatStrip']);
const ROLES: Record<string, string> = { button: 'button', menuitem: 'menu item', menuitemcheckbox: 'menu item', menuitemradio: 'menu item', tab: 'tab', heading: 'heading' };

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function tagOf(el: Opening): string {
  return el.tagName.getText();
}

function attr(el: Opening, name: string): string | true | undefined {
  for (const p of el.attributes.properties) {
    if (!ts.isJsxAttribute(p) || p.name.getText() !== name) continue;
    if (p.initializer === undefined) return true;
    if (ts.isStringLiteral(p.initializer)) return p.initializer.text;
    return ts.isJsxExpression(p.initializer) ? (p.initializer.expression?.getText() ?? true) : true;
  }
  return undefined;
}

/** What an element is, for this guard: a button, a menu item, a tab, a heading, or nothing of these. */
function kindOf(el: Opening): string | null {
  const tag = tagOf(el);
  const role = attr(el, 'role');
  if (typeof role === 'string' && ROLES[role] !== undefined) return ROLES[role];
  if (BUTTONS.has(tag)) return 'button';
  if (MENU_ITEMS.has(tag)) return 'menu item';
  if (TABS.has(tag)) return 'tab';
  if (HEADINGS.has(tag)) return 'heading';
  return null;
}

/** A control a chevron belongs in: a disclosure (`aria-expanded`), a combobox or a select's trigger. */
const opensSomething = (el: Opening) => attr(el, 'aria-expanded') !== undefined || attr(el, 'role') === 'combobox' || ['SelectTrigger', 'CollapsibleTrigger', 'DropdownMenuSubTrigger', 'summary'].includes(tagOf(el));

/** Whether an element says its own name to assistive technology. */
const named = (el: Opening) => attr(el, 'aria-label') !== undefined || attr(el, 'aria-labelledby') !== undefined;

/** A background class that paints a tile (`bg-ok-bg`, `bg-primary`), as far as a literal `className` shows it. */
const paintsTile = (el: Opening): boolean => {
  const classes = attr(el, 'className');
  return typeof classes === 'string' && /(^|[\s'"`])bg-(?!transparent|inherit|none)/.test(classes);
};

/** The guide's problems in one source file, as `file:line: what`. */
function iconProblems(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const problems: string[] = [];
  const at = (node: ts.Node, what: string) => problems.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${what}`);
  /** Local name → lucide's name. */
  const icons = new Map<string, string>();

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    if (from !== 'lucide-react' && !from.startsWith('lucide-react/')) continue;
    const clause = statement.importClause;
    if (from !== 'lucide-react' || clause === undefined || clause.name !== undefined) {
      at(statement, `imports ${from} other than by name; import the icons by name from lucide-react`);
      continue;
    }
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      at(statement, 'imports every lucide-react icon; import the ones drawn by name');
      continue;
    }
    for (const spec of bindings.elements) {
      const imported = (spec.propertyName ?? spec.name).getText();
      if (spec.isTypeOnly || statement.importClause?.isTypeOnly === true || !/^[A-Z]/.test(imported)) continue;
      icons.set(spec.name.getText(), iconName(imported));
    }
  }
  if (icons.size === 0) return problems;

  const isIcon = (node: ts.Node): boolean => (ts.isJsxSelfClosingElement(node) && icons.has(tagOf(node))) || (ts.isJsxElement(node) && icons.has(tagOf(node.openingElement)));
  /** Whether the element holds nothing but icons (no words, no expression, no other element). */
  const onlyIcons = (el: ts.JsxElement): boolean =>
    el.children.every((child) => isIcon(child) || (ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces) || (ts.isJsxExpression(child) && child.expression === undefined));

  const visit = (node: ts.Node): void => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && icons.has(tagOf(node))) {
      const name = icons.get(tagOf(node))!;
      const own = ts.isJsxOpeningElement(node) ? node.parent : node;
      // Decorative unless it says its own name: hidden from screen readers, the words beside it carry the meaning.
      if (attr(node, 'aria-hidden') !== 'true' && !named(node)) at(node, `icon ${name} is neither aria-hidden="true" nor named`);
      // The element right around it: a coloured tile, or a control that shows nothing but the icon.
      const box = own.parent;
      if (ts.isJsxElement(box) && onlyIcons(box)) {
        const kind = kindOf(box.openingElement);
        if (kind === null && !LINKS.has(tagOf(box.openingElement)) && paintsTile(box.openingElement)) at(node, `icon ${name} on a coloured tile (${tagOf(box.openingElement)})`);
        if ((kind === 'button' || LINKS.has(tagOf(box.openingElement))) && !named(box.openingElement) && !named(node)) at(node, `icon ${name} alone in a ${tagOf(box.openingElement)} without an accessible name`);
      }
      for (let up: ts.Node | undefined = own.parent; up !== undefined; up = up.parent) {
        if (ts.isJsxAttribute(up)) {
          const owner = up.parent.parent;
          if (['title', 'label'].includes(up.name.getText()) && HEADING_PROPS.has(tagOf(owner))) {
            at(node, `icon ${name} in the heading of ${tagOf(owner)}`);
            break;
          }
          if (up.name.getText() === 'items' && FIGURE_PROPS.has(tagOf(owner))) {
            at(node, `icon ${name} in a figure of ${tagOf(owner)}`);
            break;
          }
          continue;
        }
        if (!ts.isJsxElement(up)) continue;
        const kind = kindOf(up.openingElement);
        if (kind === null) continue;
        // In a button an icon may help; the checks above see to its name.
        if (kind === 'button') break;
        if (CHEVRONS.includes(name) && opensSomething(up.openingElement)) break;
        at(node, `icon ${name} inside a ${kind} (${tagOf(up.openingElement)})`);
        break;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('the icons of the screens, the install wizard and the shared components', () => {
  const files = ROOTS.flatMap((root) => sources(path.join(SRC, root))).filter((file) => !file.startsWith(path.join(SRC, 'components', 'ui') + path.sep));

  it('are hidden or named, named when alone in a control, never on a tile, in a heading, a tab, a menu item or a figure', () => {
    expect(files.length).toBeGreaterThan(150);
    const problems = files.flatMap((file) => iconProblems(path.relative(SRC, file), fs.readFileSync(file, 'utf8')));
    expect(problems).toEqual([]);
  });

  it('no emoji stands in for an icon, in the sources or in the texts of both languages', () => {
    const all = sources(SRC);
    const found = all.flatMap((file) => {
      const hit = /\p{Emoji_Presentation}/u.exec(fs.readFileSync(file, 'utf8'));
      return hit === null ? [] : [`${path.relative(SRC, file)}: ${hit[0]}`];
    });
    expect(found).toEqual([]);
  });

  it('the guard itself: what it refuses and what it lets through', () => {
    const check = (body: string) => iconProblems('x.tsx', `import { ChevronDownIcon, InfoIcon, LoaderCircleIcon, PlusIcon, PrinterIcon } from 'lucide-react';\n${body}`).map((p) => p.replace(/^x\.tsx:\d+: /, ''));
    expect(check('')).toEqual([]);
    // An icon helps a button, beside its words; a status icon beside the words of a result.
    expect(check('const a = <Button><PlusIcon aria-hidden="true" /> Tambah anggota</Button>;')).toEqual([]);
    expect(check('const a = <Button>{busy && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}Memproses…</Button>;')).toEqual([]);
    expect(check('const a = <div className="result"><InfoIcon aria-hidden="true" /><p>Siap memindai</p></div>;')).toEqual([]);
    expect(check('const a = <Button aria-expanded={open}><ChevronDownIcon aria-hidden="true" />Rincian</Button>;')).toEqual([]);
    // A button that shows only an icon says its name.
    expect(check('const a = <Button size="icon" aria-label={t("x.print")}><PrinterIcon aria-hidden="true" /></Button>;')).toEqual([]);
    expect(check('const a = <Button size="icon"><PrinterIcon aria-hidden="true" /></Button>;')).toEqual(['icon Printer alone in a Button without an accessible name']);
    expect(check('const a = <a href="/x"><PrinterIcon aria-hidden="true" /></a>;')).toEqual(['icon Printer alone in a a without an accessible name']);
    expect(check('const a = <button type="button"><PrinterIcon aria-hidden="true" /><span className="sr-only">Cetak</span></button>;')).toEqual([]);
    // A decorative icon is hidden from screen readers.
    expect(check('const a = <Button><PlusIcon /> Tambah</Button>;')).toEqual(['icon Plus is neither aria-hidden="true" nor named']);
    expect(check('const a = <p><InfoIcon aria-label="Informasi" /> Siap</p>;')).toEqual([]);
    // Never a decoration: a heading, a tab, a menu item, a figure, a coloured tile.
    expect(check('const a = <h2><InfoIcon aria-hidden="true" /> Judul</h2>;')).toEqual(['icon Info inside a heading (h2)']);
    expect(check('const a = <PageHeader title={<><InfoIcon aria-hidden="true" /> Judul</>} />;')).toEqual(['icon Info in the heading of PageHeader']);
    expect(check('const a = <Card title={<><InfoIcon aria-hidden="true" /> Judul</>} />;')).toEqual(['icon Info in the heading of Card']);
    expect(check('const a = <TabsTrigger value="a"><InfoIcon aria-hidden="true" />A</TabsTrigger>;')).toEqual(['icon Info inside a tab (TabsTrigger)']);
    expect(check('const a = <div role="tab"><InfoIcon aria-hidden="true" />A</div>;')).toEqual(['icon Info inside a tab (div)']);
    expect(check('const a = <MoreMenuItem onSelect={go}><span><InfoIcon aria-hidden="true" /></span>Ubah</MoreMenuItem>;')).toEqual(['icon Info inside a menu item (MoreMenuItem)']);
    expect(check('const a = <StatRow items={[{ key: "a", label: "Dipinjam", value: <><InfoIcon aria-hidden="true" /> 14</> }]} />;')).toEqual(['icon Info in a figure of StatRow']);
    expect(check('const a = <div><span className="grid size-9 place-items-center rounded-md bg-ok-bg"><InfoIcon aria-hidden="true" /></span><b>14</b></div>;')).toEqual(['icon Info on a coloured tile (span)']);
    expect(iconProblems('y.tsx', "import * as Icons from 'lucide-react';")).toEqual(['y.tsx:1: imports every lucide-react icon; import the ones drawn by name']);
    expect(iconProblems('y.tsx', "import Plus from 'lucide-react/icons/plus';")).toEqual(['y.tsx:1: imports lucide-react/icons/plus other than by name; import the icons by name from lucide-react']);
  });
});
