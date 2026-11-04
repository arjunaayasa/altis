import { describe, expect, it } from 'vitest';
import { sanitizedHtml } from '../../src/html/sanitize.js';

// User HTML (spec §9.5, D2-20; Phase 2 Task 8): an allowlist sanitizer that rebuilds its output from tokens. These
// tests pin the exact output; xss.test.ts runs the K14 corpus, and markdown.test.ts the Markdown subset on top of it.

const F = '01HZY3V0ZQ7M4K2B6S9T1W8XEA';
const cp = (code: number): string => String.fromCharCode(code);
const REPLACEMENT = cp(0xfffd);
const COPY = cp(0xa9);
const NOT = cp(0xac);
const NOTIN = cp(0x2209);
const s = (html: string): string => sanitizedHtml(html);

describe('sanitizedHtml: the allowlist', () => {
  it('keeps every allowed tag, in lower case and with explicit end tags', () => {
    const html =
      '<h2>Judul</h2><h3>Sub</h3><h4>Kecil</h4>' +
      '<p>Teks <strong>tebal</strong> <em>miring</em> <u>garis</u> <s>coret</s> <code>kode</code><br>baris</p>' +
      '<blockquote><p>Kutipan</p></blockquote><ul><li>a</li></ul><ol><li>b</li></ol><pre>x  y</pre><hr>' +
      `<figure><img src="/files/${F}" alt="Denah"><figcaption>Denah lantai</figcaption></figure>` +
      '<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>' +
      '<p><a href="/halaman/tentang" title="Tentang">Tentang kami</a></p>';
    expect(s(html)).toBe(html);
    expect(s('<P><STRONG>Halo</STRONG><Br></P>')).toBe('<p><strong>Halo</strong><br></p>');
  });

  it('drops every attribute but href, src, alt and title', () => {
    expect(s('<p class="x" id="y" style="color:red" onclick="alert(1)" title="Judul" data-x="1">a</p>')).toBe(
      '<p title="Judul">a</p>',
    );
    expect(s(`<img src="/files/${F}" alt="x" width="10" title="t" onerror="alert(1)" loading="lazy">`)).toBe(
      `<img src="/files/${F}" alt="x" title="t">`,
    );
    expect(s('<a href="/x" target="_blank" rel="opener" title="t" download>a</a>')).toBe('<a href="/x" title="t">a</a>');
    // href and src only where they mean something; alt only on img.
    expect(s('<p href="/x" src="/y" alt="z">a</p>')).toBe('<p>a</p>');
    // The first of two equal attributes wins, as in a browser.
    expect(s('<a href="/a" HREF="/b" title="1" title="2">x</a>')).toBe('<a href="/a" title="1">x</a>');
  });

  it('drops any other tag and keeps its text, escaped', () => {
    expect(s('<span style="x">Halo</span> <font color="red">dunia</font>')).toBe('Halo dunia');
    expect(s('<marquee>Halo</marquee><sup>2</sup><blink>!</blink>')).toBe('Halo2!');
    expect(s('<textarea><b>x</b></textarea>')).toBe('&lt;b&gt;x&lt;/b&gt;');
    expect(s('<xmp><b>x</b> &amp;</xmp>')).toBe('&lt;b&gt;x&lt;/b&gt; &amp;amp;');
  });

  it('drops the content of script, style and the other elements a browser never shows', () => {
    expect(s('<p>a<script>alert(1)</script>b</p>')).toBe('<p>ab</p>');
    expect(s('<style>p{color:red}</style><p>a</p>')).toBe('<p>a</p>');
    expect(s('<title>T</title><noscript>N</noscript><iframe>I</iframe><noembed>E</noembed><noframes>F</noframes>Z')).toBe('Z');
    expect(s('<template><p>X</p><template>Y</template>W</template>Z')).toBe('Z');
    expect(s('<script>a</script b>c</script>')).toBe('c');
  });

  it('renames the old and the close tags it knows to allowed ones', () => {
    expect(s('<b>a</b><i>b</i><del>c</del><strike>d</strike><ins>e</ins>')).toBe(
      '<strong>a</strong><em>b</em><s>c</s><s>d</s><u>e</u>',
    );
    expect(s('<h1>A</h1><h5>B</h5><h6>C</h6>')).toBe('<h2>A</h2><h4>B</h4><h4>C</h4>');
    expect(s('<div>a</div><div>b</div><section>c</section>')).toBe('<p>a</p><p>b</p><p>c</p>');
    expect(s('<div><div>a</div>b</div>')).toBe('<p>a</p>b');
    expect(s('<table><tfoot><tr><td>x</td></tr></tfoot></table>')).toBe(
      '<table><tbody><tr><td>x</td></tr></tbody></table>',
    );
    expect(s('a</br>b')).toBe('a<br>b');
  });
});

describe('sanitizedHtml: structure', () => {
  it('closes unclosed tags', () => {
    expect(s('<p><strong>Halo')).toBe('<p><strong>Halo</strong></p>');
    expect(s('<ul><li>a<li>b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(s('<blockquote><p>a')).toBe('<blockquote><p>a</p></blockquote>');
    expect(s('<table><tr><td>a<td>b<tr><td>c')).toBe(
      '<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></tbody></table>',
    );
  });

  it('drops end tags that close nothing, and mends crossed ones', () => {
    expect(s('</p></div>a</strong></table>')).toBe('a');
    expect(s('<strong><em>a</strong>b</em>')).toBe('<strong><em>a</em></strong>b');
    expect(s('<ul><li><table><tr><td>a</li>b</td></tr></table></li></ul>')).toBe(
      '<ul><li><table><tbody><tr><td>ab</td></tr></tbody></table></li></ul>',
    );
  });

  it('a block closes the paragraph, heading or inline elements around it', () => {
    expect(s('<p>a<ul><li>b</li></ul>c</p>')).toBe('<p>a</p><ul><li>b</li></ul>c');
    expect(s('<h2>a<p>b</p></h2>')).toBe('<h2>a</h2><p>b</p>');
    expect(s('<h2>a<h3>b</h3>')).toBe('<h2>a</h2><h3>b</h3>');
    expect(s('<strong>a<blockquote>b</blockquote>c</strong>')).toBe('<strong>a</strong><blockquote>b</blockquote>c');
    expect(s('<p>a<p>b')).toBe('<p>a</p><p>b</p>');
  });

  it('puts text and stray parts where they belong', () => {
    expect(s('<li>a</li><li>b</li>c')).toBe('<ul><li>a</li><li>b</li></ul>c');
    expect(s('<ul>teks<li>b</li></ul>')).toBe('<ul><li>teks</li><li>b</li></ul>');
    expect(s('<ol><p>a</p></ol>')).toBe('<ol><li><p>a</p></li></ol>');
    expect(s('<table>teks</table>')).toBe('<table><tbody><tr><td>teks</td></tr></tbody></table>');
    expect(s('<table><td>a</td></table>')).toBe('<table><tbody><tr><td>a</td></tr></tbody></table>');
    expect(s('<tr><td>a</td></tr><thead><th>b</th></thead>')).toBe('ab');
    expect(s('<figcaption>a</figcaption><figure>b<p>c<figcaption>d</figcaption></figure>')).toBe(
      'a<figure>b<p>c</p><figcaption>d</figcaption></figure>',
    );
  });

  it('drops white space between rows, cells and items, and elements left empty, but keeps empty cells', () => {
    expect(s('<table>\n <tr>\n  <td>a</td>\n </tr>\n</table>')).toBe('<table><tbody><tr><td>a</td></tr></tbody></table>');
    expect(s('<ul>\n  <li>a</li>\n</ul>')).toBe('<ul><li>a</li></ul>');
    expect(s('<p></p><strong></strong><ul><li></li></ul><a href="/x"></a><table></table>')).toBe('');
    expect(s('<p> </p>')).toBe('<p> </p>');
    expect(s('<table><tr><td></td><td>x</td></tr></table>')).toBe(
      '<table><tbody><tr><td></td><td>x</td></tr></tbody></table>',
    );
  });

  it('never puts a link inside a link', () => {
    expect(s('<a href="/a">x<a href="/b">y</a></a>')).toBe('<a href="/a">x</a><a href="/b">y</a>');
    expect(s('<a href="/a"><strong>x<a href="/b">y')).toBe('<a href="/a"><strong>x</strong></a><a href="/b">y</a>');
  });

  it('keeps the first line feed of a pre the way a browser reads it', () => {
    // A browser drops one line feed right after <pre>; the output adds it back when the text starts with one.
    expect(s('<pre>\nx</pre>')).toBe('<pre>x</pre>');
    expect(s('<pre>\n\nx</pre>')).toBe('<pre>\n\nx</pre>');
    expect(s('<pre><!-- c -->\nx</pre>')).toBe('<pre>\n\nx</pre>');
  });

  it('caps the nesting depth', () => {
    const out = s(`${'<blockquote>'.repeat(10_000)}x`);
    const depth = out.split('<blockquote>').length - 1;
    expect(depth).toBeGreaterThan(50);
    expect(depth).toBeLessThanOrEqual(100);
    expect(out.split('</blockquote>').length - 1).toBe(depth);
    expect(out).toContain('x');
    expect(s(out)).toBe(out);
  });
});

describe('sanitizedHtml: text', () => {
  it('escapes text, and &lt;script&gt; stays text', () => {
    expect(s('a < b & c > d "e" \'f\'')).toBe('a &lt; b &amp; c &gt; d &quot;e&quot; &#39;f&#39;');
    expect(s('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(s('&#60;script&#62;')).toBe('&lt;script&gt;');
  });

  it('decodes character references: named and numeric, with or without the semicolon', () => {
    expect(s('&copy; &#169; &#xA9; &#xa9 &copy 2026 &amp; &AMP &notit; &notin; &unknown; &hellip;&mdash;')).toBe(
      `${COPY} ${COPY} ${COPY} ${COPY} ${COPY} 2026 &amp; &amp; ${NOT}it; ${NOTIN} &amp;unknown; ${cp(0x2026)}${cp(0x2014)}`,
    );
    // HTML's numeric rules: 0, surrogates and values past U+10FFFF are U+FFFD; 0x80-0x9F are read as Windows-1252.
    expect(s('&#0;|&#xD800;|&#x110000;|&#150;|&#x80;')).toBe(
      `${REPLACEMENT}|${REPLACEMENT}|${REPLACEMENT}|${cp(0x2013)}|${cp(0x20ac)}`,
    );
  });

  it('in an attribute, a reference without semicolon followed by a letter, digit or = stays as written', () => {
    expect(s('<a href="/cari?q=1&copy=2&amp;x=3">a</a>')).toBe('<a href="/cari?q=1&amp;copy=2&amp;x=3">a</a>');
    expect(s('<a title="&copy 2026 &copyx &lt3 &lt;3">a</a>')).toBe(
      `<a title="${COPY} 2026 &amp;copyx &amp;lt3 &lt;3">a</a>`,
    );
    // In text the same reference is decoded.
    expect(s('&copyx &lt3')).toBe(`${COPY}x &lt;3`);
  });

  it('removes NUL and control characters, unifies line ends and replaces lone surrogates', () => {
    const NUL = String.fromCharCode(0);
    const SOH = String.fromCharCode(1);
    const DEL = String.fromCharCode(0x7f);
    const lone = String.fromCharCode(0xd800);
    expect(s(`a${NUL}b\r\nc\rd${SOH}e${DEL}f${lone}g\tf\fh`)).toBe(`ab\nc\ndef${REPLACEMENT}g\tf\fh`);
    expect(s(`<p title="a${SOH}b">${SOH}</p>`)).toBe('');
    expect(s(`<p title="a${SOH}b">x</p>`)).toBe('<p title="ab">x</p>');
  });

  it('drops comments, doctypes, CDATA and processing instructions', () => {
    expect(s('<!DOCTYPE html><!-- c -->a<![CDATA[x]]>b<?php echo 1 ?>c<!-->d<!--->e<!-- x --!>f')).toBe('abcdef');
    expect(s('a<!-- unclosed <p>b</p>')).toBe('a');
  });

  it('reads a < that starts no tag as text, and drops a tag cut off by the end of input', () => {
    expect(s('a <3 b <> c')).toBe('a &lt;3 b &lt;&gt; c');
    expect(s('a</>b</ x>c')).toBe('abc');
    expect(s('a</')).toBe('a&lt;/');
    expect(s('a<p title="x')).toBe('a');
    expect(s('a<p')).toBe('a');
  });
});

describe('sanitizedHtml: href (S7)', () => {
  const link = (href: string): string => s(`<a href="${href}">x</a>`);

  it('keeps a local link as it is, and http, https and mailto links normalised with rel="noopener nofollow"', () => {
    expect(link('/halaman/a?b=1#c')).toBe('<a href="/halaman/a?b=1#c">x</a>');
    expect(link('  /halaman/a  ')).toBe('<a href="/halaman/a">x</a>');
    expect(link('halaman/a')).toBe('<a href="/halaman/a">x</a>');
    expect(link('/a/../b/./c')).toBe('<a href="/b/c">x</a>');
    expect(link('#atas')).toBe('<a href="#atas">x</a>');
    expect(link('?q=1')).toBe('<a href="/?q=1">x</a>');
    expect(link('https://example.com/a b')).toBe('<a href="https://example.com/a%20b" rel="noopener nofollow">x</a>');
    expect(link('HTTP://Example.COM')).toBe('<a href="http://example.com/" rel="noopener nofollow">x</a>');
    expect(link('https://example.com/?a=1&amp;b=2')).toBe(
      '<a href="https://example.com/?a=1&amp;b=2" rel="noopener nofollow">x</a>',
    );
    expect(link('mailto:pustaka@example.com')).toBe('<a href="mailto:pustaka@example.com" rel="noopener nofollow">x</a>');
    expect(link('MAILTO:Pustaka@Example.com')).toBe('<a href="mailto:Pustaka@Example.com" rel="noopener nofollow">x</a>');
    expect(link('/x\t/y')).toBe('<a href="/x/y">x</a>');
  });

  it.each([
    ['//evil.example'],
    ['/\\evil.example'],
    ['\\\\evil.example'],
    ['\\/evil.example'],
    ['/\t/evil.example'],
    ['/.//evil.example'],
    ['/x/..//evil.example'],
    ['jav&#x09;ascript:alert(1)'],
    ['java\nscript:alert(1)'],
    ['&#106;avascript:alert(1)'],
    [' javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['javascript&colon;alert(1)'],
    ['&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A;alert(1)'],
    ['http:evil.example'],
    ['https:evil.example'],
    ['https:/evil.example'],
    ['http://user:pw@evil.example/'],
    ['vbscript:msgbox(1)'],
    ['data:text/html,x'],
    ['ftp://example.com/'],
    ['file:///etc/passwd'],
    ['https://'],
    [''],
    ['   '],
  ])('refuses %j: the link keeps its text and loses the href', (href) => {
    expect(link(href)).toBe('<a>x</a>');
  });
});

describe('sanitizedHtml: img src', () => {
  const img = (src: string): string => s(`<img src="${src}" alt="a">`);

  it('keeps /files/<ulid>, normalised', () => {
    expect(img(`/files/${F}`)).toBe(`<img src="/files/${F}" alt="a">`);
    expect(img(`/files/./${F}`)).toBe(`<img src="/files/${F}" alt="a">`);
    expect(img(`&#47;files&#47;${F}`)).toBe(`<img src="/files/${F}" alt="a">`);
    expect(img(` /files/${F} `)).toBe(`<img src="/files/${F}" alt="a">`);
  });

  it.each([
    [`/files/${F}/../x`],
    [`/files/${F.toLowerCase()}`],
    [`/files/${F}?x=1`],
    [`/files/${F}#x`],
    [`/files/${F}X`],
    [`/files/${'I'.repeat(26)}`],
    [`https://evil.example/files/${F}`],
    [`https://x.invalid/files/${F}`],
    [`//evil.example/files/${F}`],
    ['data:image/png;base64,AAAA'],
    ['javascript:alert(1)'],
    ['https://example.com/x.png'],
    [''],
  ])('drops an img whose src is %j', (src) => {
    expect(img(src)).toBe('');
  });

  it('drops an img without src', () => {
    expect(s('<p>a<img alt="x">b</p>')).toBe('<p>ab</p>');
  });
});

describe('sanitizedHtml: idempotent and fast', () => {
  it.each([
    ['<p>a<ul><li>b</li></ul>c</p>'],
    ['<table>x<tr><td>a<p>b</table>'],
    ['<pre>\n\nx</pre>'],
    ['<li>a</li><li>b</li>c'],
    ['<a href="/a?x=1&amp;y=2#z">a</a><a href="halaman">b</a><a href="#">c</a>'],
    ['&amp;amp; &lt;&gt; &quot; \' &nbsp;'],
    ['<div><div>a</div>b</div><b><i>x</b>y</i>'],
  ])('sanitizedHtml(sanitizedHtml(%j)) === sanitizedHtml(it)', (html) => {
    const once = s(html);
    expect(s(once)).toBe(once);
  });

  it.each([
    ['<a href="'.repeat(20_000)],
    ['<!--'.repeat(20_000)],
    ['<'.repeat(200_000)],
    ['&'.repeat(200_000)],
    ['&#'.repeat(100_000)],
    ['<p '.repeat(50_000)],
    [`<script>${'</'.repeat(100_000)}`],
    [`<a ${'b '.repeat(100_000)}>`],
    ['<ul><li>'.repeat(20_000)],
    ['<table><tr><td>'.repeat(20_000)],
    ['<b>'.repeat(50_000) + 'x'],
    [`<a href="a${' '.repeat(200_000)}b" title="a${' '.repeat(200_000)}b">x</a>`],
    [`<img src="a${' '.repeat(200_000)}b" alt="x">`],
  ])('handles a pathological input in linear time', (html) => {
    const started = Date.now();
    const out = s(html);
    expect(typeof out).toBe('string');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
