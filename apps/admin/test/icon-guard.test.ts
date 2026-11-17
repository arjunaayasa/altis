import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The admin draws almost no icons (components/layout/README.md, "Icons"): the status of a scan result (a check, a
// cross, a triangle, an info sign), the notification bell, the chevron of a collapsible group or a select, the ⋯ of a
// row menu, the back arrow, and a spinner beside the words of a running action. Never in a button, a menu item, a tab
// or a heading. This test reads the sources of the screens and of the install wizard: every icon a file imports from
// lucide-react must be one of those, and an icon drawn inside a button, a menu item, a tab or a heading (as far as the
// source shows it) fails, except a chevron in the control it opens and a spinner in the button that works.

const SRC = path.resolve(import.meta.dirname, '..', 'src');
const ROOTS = ['screens', 'install'];

/** The icons of the guide, by lucide's name without `Icon` (older names of the same pictures too). */
const STATUS = ['Check', 'CircleCheck', 'CheckCircle', 'CheckCircle2', 'X', 'CircleX', 'XCircle', 'TriangleAlert', 'AlertTriangle', 'Info'];
const CHEVRONS = ['ChevronDown', 'ChevronUp', 'ChevronRight', 'ChevronsUpDown'];
const SPINNERS = ['LoaderCircle', 'Loader2', 'Loader'];
const ALLOWED = new Set([...STATUS, 'Bell', ...CHEVRONS, 'Ellipsis', 'MoreHorizontal', 'ArrowLeft', 'ChevronLeft', ...SPINNERS]);

/** `CheckIcon`, `LucideCheck` and `Check` are the same icon. */
const iconName = (imported: string) => imported.replace(/^Lucide/, '').replace(/Icon$/, '');

const BUTTONS = new Set(['Button', 'button', 'summary']);
const MENU_ITEMS = new Set(['MoreMenuItem', 'DropdownMenuItem', 'DropdownMenuCheckboxItem', 'DropdownMenuRadioItem', 'DropdownMenuSubTrigger', 'CommandItem']);
const TABS = new Set(['TabsTrigger']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend']);
/** Layout pieces whose `title` (or `label`) is drawn as a heading. */
const HEADING_PROPS = new Set(['PageHead', 'Section', 'SectionHead', 'FormSection', 'SideSection', 'InlinePanel', 'EmptyState', 'ErrorState', 'ConfirmDialog']);
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
const opensSomething = (el: Opening) => attr(el, 'aria-expanded') !== undefined || attr(el, 'role') === 'combobox' || ['SelectTrigger', 'CollapsibleTrigger', 'summary'].includes(tagOf(el));

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
      at(statement, 'imports every lucide-react icon; import the allowed ones by name');
      continue;
    }
    for (const spec of bindings.elements) {
      const imported = (spec.propertyName ?? spec.name).getText();
      if (spec.isTypeOnly || statement.importClause?.isTypeOnly === true || !/^[A-Z]/.test(imported)) continue;
      const name = iconName(imported);
      if (!ALLOWED.has(name)) at(spec, `icon ${imported} is not one the layout guide allows`);
      icons.set(spec.name.getText(), name);
    }
  }
  if (icons.size === 0) return problems;

  const visit = (node: ts.Node): void => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && icons.has(tagOf(node))) {
      const name = icons.get(tagOf(node))!;
      for (let up: ts.Node | undefined = ts.isJsxOpeningElement(node) ? node.parent.parent : node.parent; up !== undefined; up = up.parent) {
        if (ts.isJsxAttribute(up)) {
          const owner = up.parent.parent;
          if (['title', 'label'].includes(up.name.getText()) && HEADING_PROPS.has(tagOf(owner))) {
            at(node, `icon ${name} in the heading of ${tagOf(owner)}`);
            break;
          }
          continue;
        }
        if (!ts.isJsxElement(up)) continue;
        const kind = kindOf(up.openingElement);
        if (kind === null) continue;
        if (kind === 'button' && SPINNERS.includes(name)) break;
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

describe('the icons of the screens and the install wizard', () => {
  it('are only the ones the layout guide allows, never in a button, menu item, tab or heading', () => {
    const files = ROOTS.flatMap((root) => sources(path.join(SRC, root)));
    expect(files.length).toBeGreaterThan(100);
    const problems = files.flatMap((file) => iconProblems(path.relative(SRC, file), fs.readFileSync(file, 'utf8')));
    expect(problems).toEqual([]);
  });

  it('the guard itself: what it refuses and what it lets through', () => {
    const check = (body: string) => iconProblems('x.tsx', `import { ChevronDownIcon, InfoIcon, LoaderCircleIcon, PlusIcon } from 'lucide-react';\n${body}`).map((p) => p.replace(/^x\.tsx:\d+: /, ''));
    expect(check('')).toEqual(['icon PlusIcon is not one the layout guide allows']);
    const allowed = (body: string) => check(body).filter((p) => !p.startsWith('icon PlusIcon is not'));
    expect(allowed('const a = <Button><InfoIcon /> Info</Button>;')).toEqual(['icon Info inside a button (Button)']);
    expect(allowed('const a = <MoreMenuItem onSelect={go}><span><InfoIcon /></span>Ubah</MoreMenuItem>;')).toEqual(['icon Info inside a menu item (MoreMenuItem)']);
    expect(allowed('const a = <TabsTrigger value="a"><InfoIcon />A</TabsTrigger>;')).toEqual(['icon Info inside a tab (TabsTrigger)']);
    expect(allowed('const a = <h2><InfoIcon /> Judul</h2>;')).toEqual(['icon Info inside a heading (h2)']);
    expect(allowed('const a = <div role="tab"><InfoIcon /></div>;')).toEqual(['icon Info inside a tab (div)']);
    expect(allowed('const a = <PageHead title={<><InfoIcon /> Judul</>} />;')).toEqual(['icon Info in the heading of PageHead']);
    expect(allowed('const a = <Button asChild><Link to="/x">{() => <InfoIcon />}</Link></Button>;')).toEqual(['icon Info inside a button (Button)']);
    // A chevron in the control it opens, a spinner in the working button, a status icon beside a result's words.
    expect(allowed('const a = <Button aria-expanded={open}><ChevronDownIcon aria-hidden="true" />Rincian</Button>;')).toEqual([]);
    expect(allowed('const a = <Button role="combobox"><ChevronDownIcon /></Button>;')).toEqual([]);
    expect(allowed('const a = <Button>{busy && <LoaderCircleIcon className="animate-spin" />}Memproses…</Button>;')).toEqual([]);
    expect(allowed('const a = <div className="result"><InfoIcon aria-hidden="true" /><p>Siap memindai</p></div>;')).toEqual([]);
    expect(allowed('const a = <Button><ChevronDownIcon /></Button>;')).toEqual(['icon ChevronDown inside a button (Button)']);
    expect(iconProblems('y.tsx', "import * as Icons from 'lucide-react';")).toEqual(['y.tsx:1: imports every lucide-react icon; import the allowed ones by name']);
    expect(iconProblems('y.tsx', "import Plus from 'lucide-react/icons/plus';")).toEqual(['y.tsx:1: imports lucide-react/icons/plus other than by name; import the icons by name from lucide-react']);
  });
});
