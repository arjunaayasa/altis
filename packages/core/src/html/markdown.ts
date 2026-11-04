import { sanitizedHtml, type SafeHtml } from './sanitize.js';

// The Markdown subset of Halaman & Berita (spec §9.5, D2-20), clean-room, after the CommonMark and GFM rules for the
// constructs it keeps:
// - blocks: ATX headings, paragraphs (two trailing spaces or a backslash break a line), `-` `*` and `1.` lists
//   (nested by indentation, tight or loose, lazy continuation lines), `>` quotes, pipe tables, `---` `***` `___`
//   rules and fenced code (``` or ~~~);
// - inline: code spans, backslash escapes, `**` and `*` (CommonMark's delimiter algorithm), links
//   `[text](url "title")` and images `![alt](url "title")`; character references are kept for the sanitizer to read.
// Left out on purpose: setext headings, indented code, reference links, autolinks, raw HTML (escaped, as text) and
// `_` emphasis. Nesting stops at MAX_NESTING containers; deeper markers are text. Every scan is bounded, so the time
// is linear in the input.

const MAX_NESTING = 20;
/** A link destination or title longer than this is not one (the bound keeps a run of `[a](` linear). */
const MAX_DESTINATION = 2048;
const MAX_TITLE = 1024;
/** The empty cells a table may add to its short rows, per character of its source (keeps the output linear). */
const TABLE_PADDING_PER_CHARACTER = 4;

interface Block {
  readonly html: string;
  /** For a paragraph: its inline HTML, written without `<p>` in a tight list. */
  readonly inline: string | null;
}

interface Blocks {
  readonly blocks: Block[];
  /** Whether a blank line separates two of the blocks (a list item holding them makes the list loose). */
  readonly blankBetween: boolean;
}

interface ListMarker {
  readonly ordered: boolean;
  /** `-`, `*`, or `.` for an ordered list. */
  readonly marker: string;
  /** Whether the list can interrupt a paragraph: a bullet or `1.`, with content. */
  readonly interrupts: boolean;
  /** The column where the item's content starts. */
  readonly contentColumn: number;
  readonly content: string;
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** A character reference (left for the sanitizer to decode), or a character to escape. */
const TEXT_ESCAPE = /&(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)|[&<>"']/g;
const ASCII_PUNCTUATION = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');
const BACKSLASH_ESCAPE = /\\([!-/:-@[-`{-~])/g;
/** Characters the inline scanner stops at. */
const INLINE_SPECIAL = /[\\`![*\n]/g;
const UNICODE_SPACE = /\s/u;
const UNICODE_PUNCTUATION = /[\p{P}\p{S}]/u;

/** Text as HTML: `&`, `<`, `>`, `"` and `'` escaped, character references kept as written. */
function escapeText(text: string): string {
  return text.replace(TEXT_ESCAPE, (m) => (m.length > 1 ? m : ESCAPES[m]!));
}

/** Code as HTML: everything escaped, references included. */
function escapeCode(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function unescapeBackslashes(text: string): string {
  return text.replace(BACKSLASH_ESCAPE, '$1');
}

function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

function indentOf(line: string): number {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  return k;
}

/** Leading tabs as spaces (tab stops of 4), so indentation can be counted in columns. */
function expandIndent(line: string): string {
  let column = 0;
  let k = 0;
  for (; k < line.length; k++) {
    if (line[k] === ' ') column++;
    else if (line[k] === '\t') column += 4 - (column % 4);
    else break;
  }
  return column === k ? line : ' '.repeat(column) + line.slice(k);
}

function atxHeading(line: string): { level: number; text: string } | null {
  const m = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(line);
  if (m === null) return null;
  let text = line.slice(m[0].length).trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === 0) text = '';
  else if (end < text.length && (text[end - 1] === ' ' || text[end - 1] === '\t')) text = text.slice(0, end).trimEnd();
  return { level: m[1]!.length, text };
}

function isThematicBreak(line: string): boolean {
  const indent = indentOf(line);
  if (indent > 3) return false;
  const mark = line[indent];
  if (mark !== '-' && mark !== '*' && mark !== '_') return false;
  let count = 0;
  for (let k = indent; k < line.length; k++) {
    if (line[k] === mark) count++;
    else if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return count >= 3;
}

function fenceOpen(line: string): { indent: number; mark: string; length: number } | null {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (m === null) return null;
  const fence = m[2]!;
  if (fence[0] === '`' && m[3]!.includes('`')) return null;
  return { indent: m[1]!.length, mark: fence[0]!, length: fence.length };
}

function closesFence(line: string, fence: { mark: string; length: number }): boolean {
  const indent = indentOf(line);
  if (indent > 3) return false;
  let k = indent;
  while (k < line.length && line[k] === fence.mark) k++;
  return k - indent >= fence.length && isBlank(line.slice(k));
}

function isQuoteStart(line: string): boolean {
  return /^ {0,3}>/.test(line);
}

function listMarker(line: string): ListMarker | null {
  const m = /^( {0,3})([-*]|\d{1,9}\.)( *)(.*)$/.exec(line);
  if (m === null) return null;
  const [, indent, marker, spaces, rest] = m as unknown as [string, string, string, string, string];
  if (spaces === '' && rest !== '') return null;
  const ordered = marker.endsWith('.');
  const base = indent.length + marker.length;
  const empty = rest === '';
  const contentColumn = empty || spaces.length > 4 ? base + 1 : base + spaces.length;
  const content = empty ? '' : spaces.length > 4 ? ' '.repeat(spaces.length - 1) + rest : rest;
  return {
    ordered,
    marker: ordered ? '.' : marker,
    interrupts: !empty && (!ordered || Number(marker.slice(0, -1)) === 1),
    contentColumn,
    content,
  };
}

function sameList(a: ListMarker, b: ListMarker): boolean {
  return a.ordered === b.ordered && a.marker === b.marker;
}

/** A table row's cells: outer pipes dropped, split on `|`, `\|` read as a pipe, each cell trimmed. */
function tableCells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let k = 0; k < row.length; k++) {
    if (row[k] === '\\' && row[k + 1] === '|') {
      cell += '|';
      k++;
    } else if (row[k] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += row[k];
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableHeader(line: string, next: string | undefined): boolean {
  if (next === undefined || !line.includes('|') || !next.includes('|')) return false;
  const delimiters = tableCells(next);
  return delimiters.every((cell) => /^:?-+:?$/.test(cell)) && tableCells(line).length === delimiters.length;
}

/** Whether `line` starts a block other than a paragraph (at nesting `depth`). */
function startsBlock(line: string, depth: number): boolean {
  if (fenceOpen(line) !== null || atxHeading(line) !== null || isThematicBreak(line)) return true;
  return depth < MAX_NESTING && (isQuoteStart(line) || listMarker(line) !== null);
}

/** Whether `line` ends the paragraph above it (`next` is the line after it). */
function interruptsParagraph(line: string, next: string | undefined, depth: number): boolean {
  if (fenceOpen(line) !== null || atxHeading(line) !== null || isThematicBreak(line)) return true;
  if (depth < MAX_NESTING && (isQuoteStart(line) || listMarker(line)?.interrupts === true)) return true;
  return isTableHeader(line, next);
}

function joinBlocks(blocks: readonly Block[], tight: boolean): string {
  return blocks.map((block) => (tight && block.inline !== null ? block.inline : block.html)).join('');
}

/** The blocks of `lines`, at nesting `depth`. */
function parseBlocks(lines: readonly string[], depth: number): Blocks {
  const blocks: Block[] = [];
  let blankBetween = false;
  let blankPending = false;
  const add = (html: string, inline: string | null = null): void => {
    if (blankPending && blocks.length > 0) blankBetween = true;
    blankPending = false;
    blocks.push({ html, inline });
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      blankPending = true;
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence !== null) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i]!, fence)) {
        const text = lines[i]!;
        body.push(text.slice(Math.min(fence.indent, indentOf(text))));
        i++;
      }
      i++;
      add(`<pre><code>${escapeCode(body.map((text) => `${text}\n`).join(''))}</code></pre>`);
      continue;
    }
    const heading = atxHeading(line);
    if (heading !== null) {
      const tag = `h${Math.min(heading.level + 1, 4)}`;
      add(`<${tag}>${renderInline(heading.text)}</${tag}>`);
      i++;
      continue;
    }
    if (isThematicBreak(line)) {
      add('<hr>');
      i++;
      continue;
    }
    if (depth < MAX_NESTING && isQuoteStart(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const text = lines[i]!;
        const quoted = /^ {0,3}>/.exec(text);
        if (quoted !== null) {
          const rest = text.slice(quoted[0].length);
          inner.push(rest.startsWith(' ') ? rest.slice(1) : rest);
        } else if (!isBlank(text) && !isBlank(inner.at(-1) ?? '') && !startsBlock(text, depth)) {
          inner.push(text); // a lazy line continues the quoted paragraph
        } else {
          break;
        }
        i++;
      }
      add(`<blockquote>${joinBlocks(parseBlocks(inner, depth + 1).blocks, false)}</blockquote>`);
      continue;
    }
    const marker = depth < MAX_NESTING ? listMarker(line) : null;
    if (marker !== null) {
      const list = parseList(lines, i, marker, depth);
      add(list.html);
      i = list.next;
      continue;
    }
    if (isTableHeader(line, lines[i + 1])) {
      const header = tableCells(line);
      // Short rows are padded with empty cells, but never more of them than TABLE_PADDING_PER_CHARACTER per character
      // of the table's own lines: a row past that budget ends the table (and starts a paragraph), so a wide header over
      // many short rows cannot make the output grow faster than the text.
      let padding = TABLE_PADDING_PER_CHARACTER * (line.length + lines[i + 1]!.length + 2);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!, depth)) {
        const row = tableCells(lines[i]!);
        padding += TABLE_PADDING_PER_CHARACTER * (lines[i]!.length + 1) - Math.max(0, header.length - row.length);
        if (padding < 0) break;
        rows.push(row);
        i++;
      }
      const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
      const body = rows
        .map((row) => `<tr>${header.map((_, k) => `<td>${renderInline(row[k] ?? '')}</td>`).join('')}</tr>`)
        .join('');
      add(`<table><thead><tr>${head}</tr></thead>${body === '' ? '' : `<tbody>${body}</tbody>`}</table>`);
      continue;
    }
    const paragraph = [line.trimStart()];
    i++;
    while (i < lines.length && !isBlank(lines[i]!) && !interruptsParagraph(lines[i]!, lines[i + 1], depth)) {
      paragraph.push(lines[i]!.trimStart());
      i++;
    }
    const inline = renderInline(paragraph.join('\n').trimEnd());
    add(`<p>${inline}</p>`, inline);
  }
  return { blocks, blankBetween };
}

/** The list whose first item is `lines[start]`: its HTML and the index of the first line after it. */
function parseList(lines: readonly string[], start: number, first: ListMarker, depth: number): { html: string; next: number } {
  const items: Blocks[] = [];
  let loose = false;
  let i = start;
  while (i < lines.length) {
    const item = listMarker(lines[i]!);
    if (item === null || !sameList(item, first) || isThematicBreak(lines[i]!)) break;
    const body = [item.content];
    i++;
    while (i < lines.length) {
      const text = lines[i]!;
      if (isBlank(text)) body.push('');
      else if (indentOf(text) >= item.contentColumn) body.push(text.slice(item.contentColumn));
      else if (body.at(-1) !== '' && !startsBlock(text, depth)) body.push(text.trimStart()); // a lazy line
      else break;
      i++;
    }
    let trailing = 0;
    while (body.length > 1 && body.at(-1) === '') {
      body.pop();
      trailing++;
    }
    const parsed = parseBlocks(body, depth + 1);
    if (parsed.blankBetween) loose = true;
    items.push(parsed);
    if (trailing > 0) {
      const next = i < lines.length ? listMarker(lines[i]!) : null;
      if (next !== null && sameList(next, first) && !isThematicBreak(lines[i]!)) {
        loose = true;
      } else {
        // The blank lines belong to the text around the list, which may be a loose item itself.
        i -= trailing;
        break;
      }
    }
  }
  const tag = first.ordered ? 'ol' : 'ul';
  return { html: `<${tag}>${items.map((item) => `<li>${joinBlocks(item.blocks, !loose)}</li>`).join('')}</${tag}>`, next: i };
}

/** The code spans of `text`: where each starts, where it ends and its content. */
function codeSpans(text: string): Map<number, { end: number; content: string }> {
  const runs: { start: number; length: number }[] = [];
  for (let k = 0; k < text.length; ) {
    if (text[k] === '\\') {
      k += 2;
    } else if (text[k] === '`') {
      const start = k;
      while (text[k] === '`') k++;
      runs.push({ start, length: k - start });
    } else {
      k++;
    }
  }
  // For each run, the next run of the same length: a code span pairs a run with it.
  const nextSame = new Array<number>(runs.length).fill(-1);
  const lastOfLength = new Map<number, number>();
  for (let k = runs.length - 1; k >= 0; k--) {
    nextSame[k] = lastOfLength.get(runs[k]!.length) ?? -1;
    lastOfLength.set(runs[k]!.length, k);
  }
  const spans = new Map<number, { end: number; content: string }>();
  for (let k = 0; k < runs.length; ) {
    const close = nextSame[k]!;
    if (close < 0) {
      k++;
      continue;
    }
    const open = runs[k]!;
    const end = runs[close]!;
    let content = text.slice(open.start + open.length, end.start).replace(/\n/g, ' ');
    if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
      content = content.slice(1, -1);
    }
    spans.set(open.start, { end: end.start + end.length, content });
    k = close + 1;
  }
  return spans;
}

/** Each `[` of `text` with its matching `]` (escaped brackets and code spans skipped). */
function bracketPairs(text: string, spans: ReadonlyMap<number, { end: number }>): Map<number, number> {
  const pairs = new Map<number, number>();
  const open: number[] = [];
  for (let k = 0; k < text.length; ) {
    const span = spans.get(k);
    if (span !== undefined) {
      k = span.end;
      continue;
    }
    if (text[k] === '\\') {
      k += 2;
      continue;
    }
    if (text[k] === '[') open.push(k);
    else if (text[k] === ']') {
      const at = open.pop();
      if (at !== undefined) pairs.set(at, k);
    }
    k++;
  }
  return pairs;
}

function skipSpace(text: string, k: number): number {
  while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
  return k;
}

/** The `(destination "title")` part of a link starting at `k` (after `(`), or null when there is none. */
function linkTarget(text: string, k: number): { destination: string; title: string | null; end: number } | null {
  let i = skipSpace(text, k);
  let destination: string;
  if (text[i] === '<') {
    const from = i + 1;
    i = from;
    while (i < text.length && i - from <= MAX_DESTINATION && text[i] !== '>' && text[i] !== '<' && text[i] !== '\n') {
      i += text[i] === '\\' ? 2 : 1;
    }
    if (text[i] !== '>') return null;
    destination = text.slice(from, i);
    i++;
  } else {
    const from = i;
    let depth = 0;
    while (i < text.length && i - from <= MAX_DESTINATION) {
      const c = text[i]!;
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
      if (c === '(') depth++;
      if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    if (i - from > MAX_DESTINATION || depth !== 0) return null;
    destination = text.slice(from, i);
  }
  const afterDestination = i;
  i = skipSpace(text, i);
  let title: string | null = null;
  const quote = text[i];
  if (i > afterDestination && (quote === '"' || quote === "'" || quote === '(')) {
    const close = quote === '(' ? ')' : quote;
    const from = i + 1;
    let j = from;
    while (j < text.length && j - from <= MAX_TITLE && text[j] !== close) j += text[j] === '\\' ? 2 : 1;
    if (text[j] !== close) return null;
    title = unescapeBackslashes(text.slice(from, j));
    i = skipSpace(text, j + 1);
  }
  if (text[i] !== ')') return null;
  return { destination: unescapeBackslashes(destination), title, end: i + 1 };
}

/** A run of `*`: how many are left, what it can do, and the tags written around it. */
interface Delimiter {
  readonly index: number;
  readonly length: number;
  count: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
  /** Its start tags, innermost first (written in reverse: a later pair is an outer one). */
  readonly openTags: string[];
  readonly closeTags: string[];
  previous: Delimiter | null;
  next: Delimiter | null;
}

/** CommonMark's "process emphasis" for `*`: pairs closers with openers, `**` as strong and `*` as em. */
function processEmphasis(delimiters: Delimiter[]): void {
  delimiters.forEach((d, k) => {
    d.previous = delimiters[k - 1] ?? null;
    d.next = delimiters[k + 1] ?? null;
  });
  const remove = (d: Delimiter): void => {
    if (d.previous !== null) d.previous.next = d.next;
    if (d.next !== null) d.next.previous = d.previous;
  };
  // For each kind of closer, the index below which no opener can match it (keeps the search linear).
  const bottom = new Map<string, number>();
  let closer = delimiters[0] ?? null;
  while (closer !== null) {
    if (!closer.canClose) {
      closer = closer.next;
      continue;
    }
    const key = `${closer.length % 3}${closer.canOpen ? 'o' : ''}`;
    const floor = bottom.get(key) ?? -1;
    let opener = closer.previous;
    while (opener !== null && opener.index > floor) {
      const both = opener.canClose || closer.canOpen;
      const multipleOfThree = (opener.length + closer.length) % 3 === 0 && !(opener.length % 3 === 0 && closer.length % 3 === 0);
      if (opener.canOpen && !(both && multipleOfThree)) break;
      opener = opener.previous;
    }
    if (opener !== null && opener.index > floor) {
      const used = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
      const tag = used === 2 ? 'strong' : 'em';
      opener.count -= used;
      closer.count -= used;
      opener.openTags.push(`<${tag}>`); // not unshift, which is quadratic on a long run
      closer.closeTags.push(`</${tag}>`);
      opener.next = closer; // the delimiters between them stay text
      closer.previous = opener;
      if (opener.count === 0) remove(opener);
      if (closer.count === 0) {
        const next = closer.next;
        remove(closer);
        closer = next;
      }
    } else {
      bottom.set(key, closer.previous?.index ?? -1);
      const next = closer.next;
      if (!closer.canOpen) remove(closer);
      closer = next;
    }
  }
}

/** The inline HTML of `text` (a paragraph, a heading or a cell). Inside a link, `[` starts no other link. */
function renderInline(text: string, inLink = false): string {
  const spans = codeSpans(text);
  const brackets = bracketPairs(text, spans);
  const parts: (string | Delimiter)[] = [];
  const delimiters: Delimiter[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer !== '') parts.push(escapeText(buffer));
    buffer = '';
  };
  const link = (open: number): (NonNullable<ReturnType<typeof linkTarget>> & { close: number }) | null => {
    const close = brackets.get(open);
    if (close === undefined || text[close + 1] !== '(') return null;
    const target = linkTarget(text, close + 2);
    return target === null ? null : { ...target, close };
  };
  let i = 0;
  while (i < text.length) {
    INLINE_SPECIAL.lastIndex = i;
    const special = INLINE_SPECIAL.exec(text);
    const at = special === null ? text.length : special.index;
    buffer += text.slice(i, at);
    i = at;
    if (i >= text.length) break;
    const c = text[i]!;
    if (c === '\\') {
      const escaped = text[i + 1];
      if (escaped === '\n') {
        flush();
        parts.push('<br>\n');
        i += 2;
      } else if (escaped !== undefined && ASCII_PUNCTUATION.has(escaped)) {
        flush();
        parts.push(escapeCode(escaped));
        i += 2;
      } else {
        buffer += c;
        i++;
      }
    } else if (c === '`') {
      const span = spans.get(i);
      if (span !== undefined) {
        flush();
        parts.push(`<code>${escapeCode(span.content)}</code>`);
        i = span.end;
      } else {
        while (text[i] === '`') buffer += text[i++];
      }
    } else if (c === '!' && text[i + 1] === '[') {
      const image = link(i + 1);
      if (image === null) {
        buffer += c;
        i++;
      } else {
        flush();
        const alt = escapeText(unescapeBackslashes(text.slice(i + 2, image.close)));
        const title = image.title === null ? '' : ` title="${escapeText(image.title)}"`;
        parts.push(`<img src="${escapeText(image.destination)}" alt="${alt}"${title}>`);
        i = image.end;
      }
    } else if (c === '[') {
      const target = inLink ? null : link(i);
      if (target === null) {
        buffer += c;
        i++;
      } else {
        flush();
        const title = target.title === null ? '' : ` title="${escapeText(target.title)}"`;
        parts.push(`<a href="${escapeText(target.destination)}"${title}>${renderInline(text.slice(i + 1, target.close), true)}</a>`);
        i = target.end;
      }
    } else if (c === '*') {
      let end = i;
      while (text[end] === '*') end++;
      const before = i > 0 ? text[i - 1]! : ' ';
      const after = end < text.length ? text[end]! : ' ';
      const spaceBefore = UNICODE_SPACE.test(before);
      const spaceAfter = UNICODE_SPACE.test(after);
      const punctuationBefore = UNICODE_PUNCTUATION.test(before);
      const punctuationAfter = UNICODE_PUNCTUATION.test(after);
      const leftFlanking = !spaceAfter && (!punctuationAfter || spaceBefore || punctuationBefore);
      const rightFlanking = !spaceBefore && (!punctuationBefore || spaceAfter || punctuationAfter);
      flush();
      const delimiter: Delimiter = {
        index: delimiters.length,
        length: end - i,
        count: end - i,
        canOpen: leftFlanking,
        canClose: rightFlanking,
        openTags: [],
        closeTags: [],
        previous: null,
        next: null,
      };
      parts.push(delimiter);
      delimiters.push(delimiter);
      i = end;
    } else if (c === '\n') {
      // A line end: two or more spaces before it make a hard break, otherwise a soft one.
      let spaces = 0;
      while (spaces < buffer.length && buffer[buffer.length - 1 - spaces] === ' ') spaces++;
      buffer = buffer.slice(0, buffer.length - spaces);
      if (spaces >= 2) {
        flush();
        parts.push('<br>\n');
      } else {
        buffer += '\n';
        flush(); // one line at a time, so the trailing-space count never rereads a long buffer
      }
      i++;
    } else {
      // A `!` that starts no image.
      buffer += c;
      i++;
    }
  }
  flush();
  processEmphasis(delimiters);
  return parts
    .map((part) => (typeof part === 'string' ? part : part.closeTags.join('') + '*'.repeat(part.count) + part.openTags.reverse().join('')))
    .join('');
}

/**
 * The Markdown subset of Halaman & Berita (spec §9.5) as HTML: headings `#`–`###` (h2–h4; h1 is the page title),
 * paragraphs, `**` and `*`, links, images `![alt](/files/<ulid>)`, `-` `*` and `1.` lists, `>` quotes, pipe tables,
 * `---`, inline and fenced code. Raw HTML in the text is escaped, and the output goes through {@link sanitizedHtml}.
 */
export function renderMarkdown(md: string): SafeHtml {
  const lines = md.replace(/\r\n?/g, '\n').split('\n').map(expandIndent);
  return sanitizedHtml(parseBlocks(lines, 0).blocks.map((block) => block.html).join('\n'));
}
