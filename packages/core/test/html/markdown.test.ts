import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/html/markdown.js';
import { sanitizedHtml } from '../../src/html/sanitize.js';

// The Markdown subset of Halaman & Berita (spec §9.5, D2-20; Phase 2 Task 8): headings # to ### as h2 to h4 (h1 is
// the page title), paragraphs, ** and *, links, images /files/<ulid>, - * and 1. lists, > quotes, pipe tables, ---,
// inline and fenced code. Raw HTML is escaped, and the output goes through sanitizedHtml.

const F = '01HZY3V0ZQ7M4K2B6S9T1W8XEA';
const md = (text: string): string => renderMarkdown(text);

describe('renderMarkdown: a whole page', () => {
  it('renders headings, emphasis, a nested list, a table, quotes and links with rel', () => {
    const page = [
      '# Tentang Kami',
      '',
      'Perpustakaan **ALTIS** buka *setiap* hari.',
      '',
      '## Layanan',
      '',
      '- Peminjaman',
      '  - Buku',
      '  - Majalah',
      '- Referensi',
      '',
      '1. Daftar',
      '2. Pinjam',
      '',
      '> Membaca adalah jendela dunia.',
      '',
      '| Hari | Jam |',
      '| --- | :-: |',
      '| Senin | 08.00-16.00 |',
      '| Sabtu | 08.00-12.00 |',
      '',
      'Kunjungi [situs kami](https://example.com/info "Info") atau [halaman ini](/halaman/a?b=1#c).',
      '',
      '---',
      '',
      `![Denah](/files/${F})`,
    ].join('\n');
    expect(md(page)).toBe(
      [
        '<h2>Tentang Kami</h2>',
        '<p>Perpustakaan <strong>ALTIS</strong> buka <em>setiap</em> hari.</p>',
        '<h3>Layanan</h3>',
        '<ul><li>Peminjaman<ul><li>Buku</li><li>Majalah</li></ul></li><li>Referensi</li></ul>',
        '<ol><li>Daftar</li><li>Pinjam</li></ol>',
        '<blockquote><p>Membaca adalah jendela dunia.</p></blockquote>',
        '<table><thead><tr><th>Hari</th><th>Jam</th></tr></thead><tbody><tr><td>Senin</td><td>08.00-16.00</td></tr>' +
          '<tr><td>Sabtu</td><td>08.00-12.00</td></tr></tbody></table>',
        '<p>Kunjungi <a href="https://example.com/info" rel="noopener nofollow" title="Info">situs kami</a> atau ' +
          '<a href="/halaman/a?b=1#c">halaman ini</a>.</p>',
        '<hr>',
        `<p><img src="/files/${F}" alt="Denah"></p>`,
      ].join('\n'),
    );
  });

  it('gives nothing for an empty or blank text', () => {
    expect(md('')).toBe('');
    expect(md('\n\n   \n\t\n')).toBe('');
  });
});

describe('renderMarkdown: blocks', () => {
  it('# to ### are h2 to h4; #### and deeper stay h4; # needs a space after it', () => {
    expect(md('# Satu\n## Dua ##\n### Tiga\n#### Empat\n###### Enam\n#tagar\n####### tujuh')).toBe(
      '<h2>Satu</h2>\n<h3>Dua</h3>\n<h4>Tiga</h4>\n<h4>Empat</h4>\n<h4>Enam</h4>\n<p>#tagar\n####### tujuh</p>',
    );
  });

  it('paragraphs are separated by blank lines; two trailing spaces or a backslash break the line', () => {
    expect(md('Baris satu\nbaris dua  \nbaris tiga\\\n   baris empat\n\nParagraf dua')).toBe(
      '<p>Baris satu\nbaris dua<br>\nbaris tiga<br>\nbaris empat</p>\n<p>Paragraf dua</p>',
    );
  });

  it('lists: - and * bullets, 1. numbers, nesting, loose lists and lazy lines', () => {
    expect(md('* a\n* b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(md('1. a\n2. b\n10. c')).toBe('<ol><li>a</li><li>b</li><li>c</li></ol>');
    expect(md('- a\n\n- b')).toBe('<ul><li><p>a</p></li><li><p>b</p></li></ul>');
    expect(md('- a\n\n  lanjut\n- b')).toBe('<ul><li><p>a</p><p>lanjut</p></li><li><p>b</p></li></ul>');
    expect(md('- satu\nlanjut')).toBe('<ul><li>satu\nlanjut</li></ul>');
    expect(md('- a\n  1. b\n     - c')).toBe('<ul><li>a<ol><li>b<ul><li>c</li></ul></li></ol></li></ul>');
    expect(md('- a\n* b')).toBe('<ul><li>a</li></ul>\n<ul><li>b</li></ul>');
    expect(md('Teks\n- butir')).toBe('<p>Teks</p>\n<ul><li>butir</li></ul>');
    expect(md('Tahun\n2005. Terbit')).toBe('<p>Tahun\n2005. Terbit</p>');
    expect(md('-tanpa spasi')).toBe('<p>-tanpa spasi</p>');
  });

  it('nests up to 20 containers; deeper markers are text, and the deepest list still takes siblings', () => {
    const lines = Array.from({ length: 22 }, (_, d) => `${'  '.repeat(d)}- n${d}`);
    const html = md([...lines, `${'  '.repeat(19)}- sibling`].join('\n'));
    expect(html.split('<ul>').length - 1).toBe(20);
    expect(html).toContain('<li>n19\n- n20\n- n21</li><li>sibling</li>');
    expect(md(`${'>'.repeat(25)} x`)).toBe(`${'<blockquote>'.repeat(20)}<p>&gt;&gt;&gt;&gt;&gt; x</p>${'</blockquote>'.repeat(20)}`);
  });

  it('quotes nest, and a line without > continues the quoted paragraph', () => {
    expect(md('> Kutipan\n> baris dua\n>\n> > bersarang')).toBe(
      '<blockquote><p>Kutipan\nbaris dua</p><blockquote><p>bersarang</p></blockquote></blockquote>',
    );
    expect(md('> satu\ndua\n\ntiga')).toBe('<blockquote><p>satu\ndua</p></blockquote>\n<p>tiga</p>');
    expect(md('> - a\n> - b')).toBe('<blockquote><ul><li>a</li><li>b</li></ul></blockquote>');
  });

  it('pipe tables: header, alignment row ignored, \\| as a pipe, short rows padded, long rows cut', () => {
    expect(md('| Judul | Tahun |\n| --- | ---: |\n| Laskar Pelangi | 2005 |\n| Bumi \\| Manusia | 1980 | x |')).toBe(
      '<table><thead><tr><th>Judul</th><th>Tahun</th></tr></thead><tbody><tr><td>Laskar Pelangi</td><td>2005</td></tr>' +
        '<tr><td>Bumi | Manusia</td><td>1980</td></tr></tbody></table>',
    );
    expect(md('a | b\n--|--\n1\n\nsetelah')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td></td></tr></tbody></table>\n<p>setelah</p>',
    );
    expect(md('| *a* | `b` |\n|---|---|')).toBe(
      '<table><thead><tr><th><em>a</em></th><th><code>b</code></th></tr></thead></table>',
    );
    expect(md('Teks biasa | dengan pipa\n\n| a | b |\n| - |')).toBe(
      '<p>Teks biasa | dengan pipa</p>\n<p>| a | b |\n| - |</p>',
    );
  });

  it('pads short rows within a budget, so a wide header over many short rows cannot blow up the output', () => {
    // A sparse table of six columns pads every row.
    const sparse = md(`|a|b|c|d|e|f|\n|-|-|-|-|-|-|\n${'|x|\n'.repeat(100)}`);
    expect(sparse.split('<tr>').length - 1).toBe(101);
    expect(sparse.split('<td></td>').length - 1).toBe(500);
    // 1 000 columns over 1 000 one-letter rows would be a million cells: the table stops once its padding passes four
    // empty cells per character of its source, and the rows left over are a paragraph.
    const text = `${'| a '.repeat(1_000)}|\n${'|-'.repeat(1_000)}|\n${'x\n'.repeat(1_000)}`;
    const html = md(text);
    expect(html.length).toBeLessThan(40 * text.length);
    expect(html).toMatch(/^<table>.*<\/table>\n<p>x\nx\n/s);
  });

  it('--- *** and ___ are rules', () => {
    expect(md('a\n\n---\n\nb\n\n***\n\n_ _ _')).toBe('<p>a</p>\n<hr>\n<p>b</p>\n<hr>\n<hr>');
    expect(md('a\n---')).toBe('<p>a</p>\n<hr>');
  });

  it('fenced code keeps its text escaped, and an unclosed fence runs to the end', () => {
    expect(md("```js\nconst a = '<b>';\n\n  x\n```\nsetelah")).toBe(
      '<pre><code>const a = &#39;&lt;b&gt;&#39;;\n\n  x\n</code></pre>\n<p>setelah</p>',
    );
    expect(md('~~~~\n```\n*a*\n~~~~')).toBe('<pre><code>```\n*a*\n</code></pre>');
    expect(md('```\nterbuka')).toBe('<pre><code>terbuka\n</code></pre>');
    expect(md('  ```\n  a\n    b\n  ```')).toBe('<pre><code>a\n  b\n</code></pre>');
  });
});

describe('renderMarkdown: inline', () => {
  it('** is strong and * is em; unmatched or spaced stars stay as they are', () => {
    expect(md('**tebal** dan *miring*, ***keduanya***, 2 * 3 * 4, **belum')).toBe(
      '<p><strong>tebal</strong> dan <em>miring</em>, <em><strong>keduanya</strong></em>, 2 * 3 * 4, **belum</p>',
    );
    expect(md('*a **b** c*')).toBe('<p><em>a <strong>b</strong> c</em></p>');
    expect(md('**a *b* c**')).toBe('<p><strong>a <em>b</em> c</strong></p>');
    expect(md('a*b*c')).toBe('<p>a<em>b</em>c</p>');
  });

  it('links: title, local and absolute; a refused URL leaves the text', () => {
    expect(md('[ALTIS](https://example.com/a "Situs") dan [Tentang](/halaman/tentang) dan [jahat](javascript:alert(1))')).toBe(
      '<p><a href="https://example.com/a" rel="noopener nofollow" title="Situs">ALTIS</a> dan ' +
        '<a href="/halaman/tentang">Tentang</a> dan <a>jahat</a></p>',
    );
    expect(md('[Wiki](https://id.wikipedia.org/wiki/Perpustakaan_(umum))')).toBe(
      '<p><a href="https://id.wikipedia.org/wiki/Perpustakaan_(umum)" rel="noopener nofollow">Wiki</a></p>',
    );
    expect(md('[a **b**](<https://example.com/a b>)')).toBe(
      '<p><a href="https://example.com/a%20b" rel="noopener nofollow">a <strong>b</strong></a></p>',
    );
    expect(md('[x] tanpa tujuan, [y](belum ditutup')).toBe('<p>[x] tanpa tujuan, [y](belum ditutup</p>');
    expect(md('[a [b](/b) c](/a)')).toBe('<p><a href="/a">a [b](/b) c</a></p>');
  });

  it('images: /files/<ulid> only, alt and title kept', () => {
    expect(md(`![Sampul buku](/files/${F} "Sampul")\n\n![luar](https://example.com/x.png)`)).toBe(
      `<p><img src="/files/${F}" alt="Sampul buku" title="Sampul"></p>\n`,
    );
    expect(md(`[![Sampul](/files/${F})](/katalog/x)`)).toBe(
      `<p><a href="/katalog/x"><img src="/files/${F}" alt="Sampul"></a></p>`,
    );
  });

  it('characters the inline scanner stops at stay as they are when they start nothing', () => {
    expect(md('Halo! Apa kabar? ![bukan gambar] dan ! di akhir!')).toBe('<p>Halo! Apa kabar? ![bukan gambar] dan ! di akhir!</p>');
    expect(md('a \\ b \\q [c] *')).toBe('<p>a \\ b \\q [c] *</p>');
  });

  it('a line of prose comes out as its own text, character for character (500 random lines)', () => {
    const words = ['Perpustakaan', 'buka', 'Senin', 'jam', '08.00', 'Rp5.000', 'e-mail', "Jum'at", 'buku', 'x'];
    const marks = ['', '', '.', ',', '!', '?', ':', '"', "'", '(', ')', '/', '@', '%', '=', '+', '&', '<', '>', '~', '$'];
    const decode = (html: string): string =>
      html.replace(/&(amp|lt|gt|quot|#39);/g, (_, n: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[n]!);
    let seed = 7;
    const pick = <T,>(list: readonly T[]): T => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return list[seed % list.length]!;
    };
    for (let k = 0; k < 500; k++) {
      const line = Array.from({ length: 2 + (k % 9) }, () => pick(marks) + pick(words) + pick(marks)).join(' ');
      const html = md(`Kata ${line}`);
      expect(html.startsWith('<p>') && html.endsWith('</p>')).toBe(true);
      expect(decode(html.slice(3, -4))).toBe(`Kata ${line}`);
    }
  });

  it('inline code is escaped and literal', () => {
    expect(md('Pakai `<b>` dan ``a ` b`` dan `*x*`')).toBe(
      '<p>Pakai <code>&lt;b&gt;</code> dan <code>a ` b</code> dan <code>*x*</code></p>',
    );
    expect(md('`tidak ditutup')).toBe('<p>`tidak ditutup</p>');
  });

  it('raw HTML is escaped, not rendered', () => {
    expect(md('<script>alert(1)</script> <b>x</b>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;b&gt;x&lt;/b&gt;</p>');
    expect(md('<div>\n<p>a</p>\n</div>')).toBe('<p>&lt;div&gt;\n&lt;p&gt;a&lt;/p&gt;\n&lt;/div&gt;</p>');
  });

  it('backslash escapes and character references', () => {
    expect(md('\\*bukan miring\\* \\# \\[x\\](y) &copy; AT&T &#169; \\&copy;')).toBe(
      `<p>*bukan miring* # [x](y) ${String.fromCharCode(0xa9)} AT&amp;T ${String.fromCharCode(0xa9)} &amp;copy;</p>`,
    );
  });
});

describe('renderMarkdown: safety and limits', () => {
  it('its output is a fixed point of sanitizedHtml', () => {
    for (const text of [
      '# a\n\n- b\n  - c\n\n> d\n\n| e | f |\n|---|---|\n| g | h |',
      '```\n<pre>\n```\n\n    indented\n\n*a* **b** `c` [d](/e) ![f](/files/01HZY3V0ZQ7M4K2B6S9T1W8XEA)',
      '- \n- a\n\n1.\n\n>\n\n#',
    ]) {
      const html = md(text);
      expect(sanitizedHtml(html)).toBe(html);
    }
  });

  it.each([
    ['['.repeat(50_000)],
    ['*a'.repeat(30_000)],
    ['**a*'.repeat(15_000)],
    [`${'*'.repeat(400_000)}a${'*'.repeat(400_000)}`],
    ['`'.repeat(50_000)],
    ['` `` '.repeat(10_000)],
    [`${'>'.repeat(10_000)} x`],
    [`${'- '.repeat(10_000)}x`],
    [`${'  '.repeat(5_000)}- x`],
    ['![a]('.repeat(10_000)],
    ['[a]('.repeat(10_000)],
    [`[a](${'('.repeat(20_000)}`],
    [`${'| a '.repeat(5_000)}\n${'|-'.repeat(5_000)}`],
    [`a${' '.repeat(50_000)}b\nc`],
    [`#${' '.repeat(50_000)}x`],
    ['- a\n'.repeat(10_000)],
    ['kata \n'.repeat(60_000)],
    ['kata\n'.repeat(60_000)],
    ['> a\n'.repeat(10_000)],
  ])('a pathological text renders in linear time', (text) => {
    const started = Date.now();
    expect(typeof md(text)).toBe('string');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
